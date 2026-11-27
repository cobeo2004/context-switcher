import { createHash } from 'node:crypto'
import { SessionNotFound, UnsupportedFormat, type Adapter, type CanonicalTurn, type Cursor, type FileId, type ParseResult } from '../types'
import { locate } from './locate'
import { scanMarkers } from './marker'

type Rec = Record<string, unknown>
export function anchorOf(bytes: Uint8Array): string {
  const hash = createHash('md5')
  Reflect.apply(hash.update.bind(hash), undefined, [bytes])
  return hash.update('').digest('hex')
}
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

// [RS] Q3: harness-injected user records that start with these are not the human's words.
const INJECTED = /^<(task-notification|command-name|command-message|local-command-stdout)>/

const parts = (v: string) => v.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0)
export const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** Plan row 5.1 / PR4 locator table: `claude-jsonl`, structural (no pinned major). Throws naming the line and field. */
function check(r: Rec, where: string): { uuid: string; version: string; content: string | Rec[] } {
  const bad = (field: string) => new UnsupportedFormat('claude', `${where}: ${field}`)
  const { uuid, version, message: m } = r
  if (typeof uuid !== 'string') throw bad('uuid is not a string')
  if (typeof version !== 'string' || version === '') throw bad('version is missing or empty')
  if (!isRec(m)) throw bad('message is not an object')
  if (m['role'] !== r['type']) throw bad(`message.role is not ${String(r['type'])}`)
  const c = m['content']
  if (typeof c === 'string') return { uuid, version, content: c }
  if (!Array.isArray(c)) throw bad('message.content is neither a string nor an array')
  const blocks = c.filter(isRec)
  if (blocks.length !== c.length || blocks.some((b) => typeof b['type'] !== 'string'))
    throw bad('message.content has a block without a string type')
  return { uuid, version, content: blocks }
}

function assistantTurn(b: Rec, nativeId: string, at: number): CanonicalTurn | undefined {
  if (b['type'] === 'text') return { nativeId, kind: 'assistant', text: str(b['text']) ?? '', at }
  if (b['type'] !== 'tool_use') return undefined // thinking, redacted_thinking, …: never stored (R10)
  const tool = str(b['name']) ?? ''
  const input = isRec(b['input']) ? b['input'] : {}
  const path = str(input['file_path'])
  const paths = path === undefined ? {} : { paths: [path] }
  if (tool === 'Bash') return { nativeId, kind: 'command', text: str(input['command']) ?? '', tool, at }
  if (tool === 'Read') return { nativeId, kind: 'tool_call', text: '', tool, at, ...paths }
  if (tool === 'Edit' || tool === 'Write') return { nativeId, kind: 'file_change', text: '', tool, at, ...paths }
  return { nativeId, kind: 'tool_call', text: '', tool, at }
}

async function parse(src: Parameters<Adapter['parse']>[0], path: string, cursor: Cursor | null): Promise<ParseResult> {
  const st = await src.stat(path)
  if (st === null) throw new SessionNotFound(`claude: ${path} is gone`)
  // A shrink below either the observed size or consumed offset requires a full re-parse.
  const keep =
    cursor?.kind === 'offset' &&
    cursor.file.dev === st.dev &&
    cursor.file.ino === st.ino &&
    st.size >= cursor.file.size &&
    st.size >= cursor.offset
  const anchorLength = keep ? Math.min(cursor.offset, 256) : 0
  const anchorBytes = keep ? await src.read(path, cursor.offset - anchorLength) : new Uint8Array()
  const start =
    keep && anchorBytes.length >= anchorLength && anchorOf(anchorBytes.subarray(0, anchorLength)) === cursor.anchor ? cursor.offset : 0
  // ponytail: stat and read are two calls; a replace between them is caught by the next parse's FileId check.
  const bytes = await src.read(path, start)
  const end = bytes.lastIndexOf(0x0a) + 1 // a partial last line stays unread until its '\n' lands
  const lines = new TextDecoder().decode(bytes.subarray(0, end)).split('\n').slice(0, -1)

  const turns: CanonicalTurn[] = []
  const users: { nativeId: string; rawText: string }[] = []
  const dropped = new Set<CanonicalTurn>()
  let version: string | undefined
  let cwd: string | undefined
  lines.forEach((line, i) => {
    if (line.trim() === '') return
    const where = `line ${i + 1} after byte ${start}`
    let r: unknown
    try {
      r = JSON.parse(line)
    } catch {
      throw new UnsupportedFormat('claude', `${where}: not JSON`)
    }
    if (!isRec(r) || (r['type'] !== 'user' && r['type'] !== 'assistant')) return // unknown record types are skipped
    const { uuid, version: v, content } = check(r, where)
    if (version === undefined || newer(v, version)) version = v
    cwd = str(r['cwd']) ?? cwd
    const ts = Date.parse(str(r['timestamp']) ?? '')
    const at = Number.isNaN(ts) ? 0 : ts
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    if (r['type'] === 'assistant') {
      blocks.forEach((b, k) => {
        const t = assistantTurn(b, `${uuid}#${k}`, at)
        if (t !== undefined) turns.push(t)
      })
      return
    }
    const k = Math.max(0, blocks.map((b) => b['type']).indexOf('text'))
    const rawText = blocks.flatMap((b) => (b['type'] === 'text' ? (str(b['text']) ?? []) : [])).join('\n')
    const origin = r['origin']
    const filtered =
      r['isMeta'] === true ||
      r['isSidechain'] === true ||
      r['isCompactSummary'] === true ||
      r['toolUseResult'] !== undefined ||
      blocks.some((b) => b['type'] === 'tool_result') ||
      (isRec(origin) && origin['kind'] !== 'human') ||
      INJECTED.test(rawText.trimStart())
    const turn: CanonicalTurn = { nativeId: `${uuid}#${k}`, kind: 'user', text: rawText, at }
    users.push({ nativeId: turn.nativeId, rawText })
    if (filtered) dropped.add(turn)
    turns.push(turn)
  })

  // §0.2 rule 2: markers come first, over every raw user record read, before the filter drops any of them.
  const markers = scanMarkers(users)
  const marked = new Map(markers.map((h) => [h.nativeId, h.handoffId]))
  const out = turns.filter((t) => {
    const handoffId = marked.get(t.nativeId)
    if (handoffId === undefined) return !dropped.has(t)
    t.handoffId = handoffId // a marker record is emitted whatever the filter says
    return true
  })
  const file: FileId = { path, dev: st.dev, ino: st.ino, size: st.size }
  return {
    turns: out,
    cursor: {
      kind: 'offset',
      file,
      offset: start + end,
      anchor: anchorOf((await src.read(path, Math.max(0, start + end - 256))).subarray(0, Math.min(start + end, 256)))
    },
    formatVersion: version === undefined ? claude.formatVersion : `${claude.formatVersion}@${version}`,
    markers,
    ...(cwd === undefined ? {} : { cwd })
  }
}

export const claude: Adapter = {
  agent: 'claude',
  formatVersion: 'claude-jsonl',
  locate: (src, q) => locate('claude', src, q),
  parse
}
