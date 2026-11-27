import { zstdDecompressSync } from 'node:zlib'
import { SessionNotFound, UnsupportedFormat, type Adapter, type CanonicalTurn, type Cursor, type ParseResult } from '../types'
import { anchorOf, newer } from './claude'
import { locate } from './locate'
import { scanMarkers } from './marker'

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const recs = (v: unknown) => (Array.isArray(v) ? v.filter(isRec) : [])
const texts = (v: unknown) => recs(v).flatMap((b) => (/^text$/i.test(str(b['type']) ?? '') ? (str(b['text']) ?? []) : []))

// [RS] Q3: harness-injected user messages that start with these are not the human's words.
const INJECTED = /^(# AGENTS\.md|<task>|<skill>|<external_codex_apps_open_page>)/
const MIN_CLI = '0.159.0' // §3 decision 3

/** `item_completed` item → canonical turn. Reasoning and every `*_output`/`unified_diff` field are never read (R10). */
function itemTurn(it: Rec, nativeId: string, at: number): CanonicalTurn | undefined {
  switch (it['type']) {
    case 'AgentMessage':
      return { nativeId, kind: 'assistant', text: texts(it['content']).join('\n'), at }
    case 'CommandExecution': {
      const c = it['command']
      const text = Array.isArray(c) ? c.filter((p) => typeof p === 'string').join(' ') : (str(c) ?? '')
      return { nativeId, kind: 'command', text, at }
    }
    case 'FileChange':
      return { nativeId, kind: 'file_change', text: '', paths: recs(it['changes']).flatMap((c) => str(c['path']) ?? []), at }
    case 'McpToolCall':
      return { nativeId, kind: 'tool_call', text: '', tool: `${str(it['server']) ?? ''}/${str(it['tool']) ?? ''}`, at }
    default:
      return undefined
  }
}

async function parse(src: Parameters<Adapter['parse']>[0], path: string, cursor: Cursor | null): Promise<ParseResult> {
  const st = await src.stat(path)
  if (st === null) throw new SessionNotFound(`codex: ${path} is gone`)
  // ponytail: a .zst is decompressed whole on every parse; it is a finished rollout, so this runs about once.
  const zst = path.endsWith('.zst') ? zstdDecompressSync(await src.read(path)) : undefined
  const read = async (from: number) => (zst === undefined ? src.read(path, from) : zst.subarray(from))
  const total = zst?.length ?? st.size
  // FileId recovery: another file (the .jsonl → .zst swap included) or a shrink ⇒ full re-parse; stem ids keep it idempotent.
  const keep =
    cursor?.kind === 'offset' &&
    cursor.file.path === path &&
    cursor.file.dev === st.dev &&
    cursor.file.ino === st.ino &&
    st.size >= cursor.file.size &&
    total >= cursor.offset
  let base = keep ? cursor.offset - Math.min(cursor.offset, 256) : 0
  let buf = await read(base)
  // The anchor catches a same-inode rewrite that did not shrink the file.
  const anchored = keep && buf.length >= cursor.offset - base && anchorOf(buf.subarray(0, cursor.offset - base)) === cursor.anchor
  if (!anchored && base > 0) [base, buf] = [0, await read(0)]
  const start = anchored ? cursor.offset : 0
  const end = buf.lastIndexOf(0x0a) + 1 // a partial last line stays unread until its '\n' lands
  const lines = new TextDecoder()
    .decode(buf.subarray(start - base, end))
    .split('\n')
    .slice(0, -1)

  const stem = path.replace(/^.*[/\\]/, '').replace(/\.jsonl(\.zst)?$/, '')
  const turns: CanonicalTurn[] = []
  const users: { nativeId: string; rawText: string }[] = []
  const dropped = new Set<CanonicalTurn>()
  let cwd: string | undefined
  let first = start === 0
  lines.forEach((line, i) => {
    if (line.trim() === '') return
    const bad = (detail: string) => new UnsupportedFormat('codex', `line ${i + 1} after byte ${start}: ${detail}`)
    let r: unknown
    try {
      r = JSON.parse(line)
    } catch {
      throw bad('not JSON')
    }
    if (!isRec(r) || typeof r['ordinal'] !== 'number') throw bad('ordinal is not a number')
    const p = isRec(r['payload']) ? r['payload'] : {}
    if (first) {
      first = false
      if (r['type'] !== 'session_meta') throw bad('first record is not session_meta')
      if (typeof p['id'] !== 'string') throw bad('session_meta payload.id is not a string')
      const v = str(p['cli_version'])
      if (v === undefined || newer(MIN_CLI, v)) throw bad(`cli_version ${String(p['cli_version'])} is older than ${MIN_CLI}`)
      cwd = str(p['cwd'])
    }
    const it = p['item']
    if (r['type'] !== 'event_msg' || p['type'] !== 'item_completed' || !isRec(it)) return // turns only from item_completed
    const nativeId = `${stem}#${r['ordinal']}`
    const ts = Date.parse(str(r['timestamp']) ?? '')
    const at = Number.isNaN(ts) ? 0 : ts
    if (it['type'] !== 'UserMessage') {
      const t = itemTurn(it, nativeId, at)
      if (t !== undefined) turns.push(t)
      return
    }
    const rawText = texts(it['content']).join('\n')
    const turn: CanonicalTurn = { nativeId, kind: 'user', text: rawText, at }
    users.push({ nativeId, rawText })
    if (it['role'] === 'developer' || INJECTED.test(rawText.trimStart())) dropped.add(turn)
    turns.push(turn)
  })

  // §0.2 rule 2: markers come first, over every raw user message read, before the filter drops any of them.
  const markers = scanMarkers(users)
  const marked = new Map(markers.map((h) => [h.nativeId, h.handoffId]))
  const out = turns.filter((t) => {
    const handoffId = marked.get(t.nativeId)
    if (handoffId === undefined) return !dropped.has(t)
    t.handoffId = handoffId // a marker record is emitted whatever the filter says
    return true
  })
  return {
    turns: out,
    cursor: {
      kind: 'offset',
      file: { path, dev: st.dev, ino: st.ino, size: st.size },
      offset: base + end,
      anchor: anchorOf(buf.subarray(Math.max(0, end - 256), end))
    },
    formatVersion: codex.formatVersion,
    markers,
    ...(cwd === undefined ? {} : { cwd })
  }
}

export const codex: Adapter = {
  agent: 'codex',
  formatVersion: 'codex-rollout-ordinal-1',
  locate: (src, q) => locate('codex', src, q),
  parse
}
