// Fixture anonymiser (plan row 4.3). Usage: node scripts/anonymise.ts --agent claude|codex|pi --in <file> --out <dir>
// Value allow-list per format: structural values are kept, ids remapped, other strings made synthetic, unknown keys
// dropped. Prints counts only, never source text.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { MARKER_RE } from '../src/types.ts'

type Rec = Record<string, unknown>
/**
 * A value allow-list. Every key not listed is dropped, at any depth. Numbers, booleans and null pass. Strings by role:
 * enum: verbatim only if in LITERALS; id: remapped deterministically; text: synthetic, fixed wrappers kept;
 * scalar: a version or ISO timestamp (shifted) kept in shape, anything else synthetic. Objects and arrays are walked.
 */
type Role = 'enum' | 'id' | 'text' | 'scalar'
interface Spec {
  keys: Record<string, Role>
  turn: (r: Rec) => { nativeId: string; kind: string } | null
}

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const words = (s: string) => s.split(' ')
const str = (v: unknown) => (typeof v === 'string' ? v : null)
function roles(r: Record<Role, string>): Record<string, Role> {
  const out: Record<string, Role> = {}
  for (const role of ['enum', 'id', 'text', 'scalar'] as const) for (const k of words(r[role])) out[k] = role
  return out
}

// Record, role and content types, item kinds and built-in tool names the adapters switch on. Nothing private.
const LITERALS = new Set(
  words(
    'user assistant system summary developer human message text thinking redacted_thinking tool_use tool_result image ' +
      'session_meta event_msg response_item turn_context compacted item_completed UserMessage AgentMessage CommandExecution ' +
      'FileChange McpToolCall Reasoning commentary final_answer completed failed in_progress add update delete ' +
      'session model_change thinking_level_change compaction branch_summary toolCall toolResult ' +
      'Bash Read Edit MultiEdit Write Grep Glob Task TodoWrite WebFetch WebSearch bash read edit write shell apply_patch'
  )
)

// ponytail: keys are matched by name at any depth, not by full path. Narrow enough for these formats; switch to paths if a
// name ever means free text in one place and structure in another.
const SPECS: Record<string, Spec> = {
  claude: {
    keys: roles({
      enum: 'type role kind subtype name',
      id: 'uuid parentUuid sessionId id tool_use_id leafUuid',
      scalar: 'isMeta isSidechain isCompactSummary version timestamp is_error',
      text: 'message content origin text thinking cwd gitBranch input summary toolUseResult command file_path path old_string new_string pattern description'
    }),
    turn: (r) => {
      const [type, uuid] = [str(r['type']), str(r['uuid'])]
      return (type === 'user' || type === 'assistant') && uuid !== null ? { nativeId: uuid, kind: type } : null
    }
  },
  codex: {
    keys: roles({
      enum: 'type role name status phase',
      id: 'id call_id turn_id',
      scalar: 'ordinal cli_version timestamp',
      text: 'payload item content summary text message instructions base_instructions user_instructions cwd arguments output command input changes path server tool'
    }),
    // ponytail: item shape is from the plan (turns only from event_msg/item_completed); confirm against crosscheck.ts in PR4b-2.
    turn: (r) => {
      const p = r['payload']
      const item = isRec(p) && p['type'] === 'item_completed' ? p['item'] : null
      if (r['type'] !== 'event_msg' || !isRec(item)) return null
      const nativeId = str(item['id']) ?? (typeof r['ordinal'] === 'number' ? String(r['ordinal']) : null)
      return nativeId === null ? null : { nativeId, kind: str(item['type']) ?? 'unknown' }
    }
  },
  pi: {
    keys: roles({
      enum: 'type role name toolName',
      id: 'id parentId toolCallId',
      scalar: 'version timestamp isError',
      text: 'message content text thinking cwd arguments summary'
    }),
    turn: (r) => {
      const m = r['message']
      const [id, role] = [str(r['id']), isRec(m) ? str(m['role']) : null]
      return r['type'] === 'message' && id !== null && role !== null ? { nativeId: id, kind: role } : null
    }
  }
}

const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor']
const originals: string[] = []
const sha = (v: string) => createHash('sha256').update(v).digest('hex')

/** Same input, same output: the words are seeded from sha256(value), and the length matches. Records the original. */
function synth(value: string): string {
  if (value !== '') originals.push(value)
  let seed = parseInt(sha(value).slice(0, 8), 16)
  let out = ''
  while (out.length < value.length) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    out = `${out} ${WORDS[(seed >>> 16) % WORDS.length] ?? 'x'}`.trimStart()
  }
  return out.slice(0, value.length)
}

// Per-run map, original -> synthetic, in order of first sight: distinct ids never collide, references (parentUuid,
// parentId) map through the same table, and no part of the original survives, whatever its shape.
const ids = new Map<string, string>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
let next = 0
function remapId(id: string): string {
  const seen = ids.get(id)
  if (seen !== undefined) return seen
  let out: string
  do {
    const n = (++next).toString(16) // from 1, so no output has a leading zero to pad and collide with
    out = UUID.test(id) ? `00000000-0000-4000-8000-${n.padStart(12, '0')}` : n.padStart(id.length, '0')
  } while (out === id) // a counter that happens to equal the original is skipped; each one is used once
  ids.set(id, out)
  return out
}

const VERSION = /^\d+(?:\.\d+){1,3}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const BASE = Date.UTC(2026, 0, 1)
let shift: number | null = null // the first timestamp seen lands on BASE; order and gaps are kept

function scalar(s: string): string {
  if (VERSION.test(s)) return s
  if (!ISO.test(s)) return synth(s)
  const t = Date.parse(s)
  shift ??= t - BASE
  return new Date(t - shift).toISOString()
}

// The only text kept verbatim: hand-off markers and the fixed wrappers the adapters' injected-content filters test for.
const WRAPPERS = [
  ...words('system-reminder command-name command-message local-command-stdout task-notification task skill user_query').flatMap((t) => [
    `<${t}>`,
    `</${t}>`
  ]),
  '<external_codex_apps_open_page>',
  '# AGENTS.md'
]
const PRESERVE = new RegExp([MARKER_RE.source, ...WRAPPERS.map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))].join('|'), 'g')

function anonText(s: string): string {
  let out = ''
  let at = 0
  for (const m of s.matchAll(PRESERVE)) {
    out += synth(s.slice(at, m.index)) + m[0]
    at = m.index + m[0].length
  }
  return out + synth(s.slice(at))
}

function value(role: Role, v: unknown, spec: Spec): unknown {
  if (Array.isArray(v)) return v.map((x) => value(role, x, spec))
  if (isRec(v)) return pick(v, spec)
  if (typeof v !== 'string') return v
  if (role === 'id') return remapId(v)
  if (role === 'enum') return LITERALS.has(v) ? v : synth(v)
  return role === 'scalar' ? scalar(v) : anonText(v)
}

/** Allow-list walk: unknown keys are dropped at every depth, including under allowed parents. */
function pick(v: Rec, spec: Spec): Rec {
  const out: Rec = {}
  for (const [k, x] of Object.entries(v)) {
    const role = Object.hasOwn(spec.keys, k) ? spec.keys[k] : undefined
    if (role !== undefined) out[k] = value(role, x, spec)
  }
  return out
}

/** Our own errors, whose messages are fixed text plus a line number. Every other message may quote a path or value. */
class InputError extends Error {}

function parseLines(text: string): Rec[] {
  return text.split('\n').flatMap((line, i) => {
    if (line.trim() === '') return []
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      throw new InputError(`line ${i + 1}: not JSON`) // JSON.parse's own message quotes the source text
    }
    if (!isRec(v)) throw new InputError(`line ${i + 1}: not a JSON object`)
    return [v]
  })
}

/** Up to 50 random originals of >= 12 chars, merged into the sentinel file (0600, outside the repo) that check-fixtures reads. */
function writeSentinels(): number {
  const dir = join(homedir(), '.context-switcher')
  const file = join(dir, 'fixture-sentinels.txt')
  const lines = originals.flatMap((s) => s.split('\n').map((l) => l.trim())).filter((l) => l.length >= 12)
  const picked = [...new Set(lines)].sort(() => Math.random() - 0.5).slice(0, 50)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700) // mkdir's mode does not apply to a directory that already exists
  const old = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  writeFileSync(file, [...new Set([...old, ...picked])].filter((l) => l !== '').join('\n') + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return picked.length
}

if (import.meta.main) {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const [agent, inPath, outDir] = [arg('--agent'), arg('--in'), arg('--out')]
  const spec = agent !== undefined && Object.hasOwn(SPECS, agent) ? SPECS[agent] : undefined
  if (agent === 'cursor') {
    console.error('anonymise: cursor: not supported yet (store.db fixtures come with plan row 6.1, after spike 6.0)')
    process.exitCode = 2
  } else if (spec === undefined || inPath === undefined || outDir === undefined) {
    console.error('usage: node scripts/anonymise.ts --agent claude|codex|pi --in <file> --out <dir>')
    process.exitCode = 2
  } else {
    try {
      const zst = inPath.endsWith('.zst')
      const raw = readFileSync(inPath)
      const records = parseLines(new TextDecoder().decode(zst ? zstdDecompressSync(raw) : raw))
      const anon = records.map((r) => pick(r, spec))
      const turns = anon.flatMap((r) => spec.turn(r) ?? []) // from the output, so the ids are the remapped ones
      const body = new TextEncoder().encode(anon.map((r) => JSON.stringify(r)).join('\n') + '\n')
      mkdirSync(outDir, { recursive: true, mode: 0o755 })
      // A fixed name: the source basename can carry a client or session name.
      writeFileSync(join(outDir, zst ? 'session.jsonl.zst' : 'session.jsonl'), zst ? zstdCompressSync(body) : body, { mode: 0o644 })
      writeFileSync(join(outDir, 'expected.json'), JSON.stringify({ agent, count: turns.length, turns }, null, 2) + '\n', { mode: 0o644 })
      console.log(`anonymise: ${records.length} records, ${turns.length} turns, ${writeSentinels()} sentinels`)
    } catch (e) {
      // Node's own messages quote the input path; print only its code, if it is an upper-case constant like ENOENT.
      const code = isRec(e) && typeof e['code'] === 'string' && /^[A-Z0-9_]+$/.test(e['code']) ? e['code'] : 'failed'
      console.error(`anonymise: ${e instanceof InputError ? e.message : code}`)
      process.exitCode = 1
    }
  }
}
