// R21 cross-check (plan row 4.4).
// Usage: node scripts/crosscheck.ts --agent claude|codex|pi [--session <probe id> --orca <orca_session_id>] [--fixture <dir>]
// Reads only the P2 probe sessions below. Compares the native file's user/assistant sequence with `orca agent read --json`
// (roles, order, text after whitespace normalisation) and its raw record kinds with a fixture's expected.json.
// Prints counts and verdicts only, never text. Exit 0 all compared and equal, 1 mismatch, 2 usage, 3 orca side unreadable.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { MARKER_RE } from '../src/types.ts'

type Rec = Record<string, unknown>
type Agent = 'claude' | 'codex' | 'pi'
interface Msg {
  role: 'user' | 'assistant'
  text: string
}

// The P2 probe sessions: probe prompts only, never the user's own work. Nothing else is ever opened.
const PROBES: Record<Agent, string[]> = {
  claude: ['0720d4c3-f12c-464c-abd9-183082395b0b', '7f479cbb-606e-4400-8d82-2b424d0afb8c', '40a4a25c-ddaf-446e-af41-3044d72e9169'],
  codex: ['01a21734-ab9b-7e72-b774-62e5cff3d6d6'],
  pi: ['01a21734-9c6b-77c2-bd62-26191b247616']
}
// Which fixture holds which probe (src/sources/fixtures/<agent>/<case>).
const FIXTURE: Record<string, string> = {
  '0720d4c3-f12c-464c-abd9-183082395b0b': 'probe-launch',
  '7f479cbb-606e-4400-8d82-2b424d0afb8c': 'probe-resume',
  '40a4a25c-ddaf-446e-af41-3044d72e9169': 'probe-resume2',
  '01a21734-ab9b-7e72-b774-62e5cff3d6d6': 'probe',
  '01a21734-9c6b-77c2-bd62-26191b247616': 'probe'
}

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const WRAPPED =
  /^\s*(?:<(?:task-notification|command-name|command-message|local-command-stdout|task|skill|external_codex_apps_open_page)>|# AGENTS\.md)/

/** Exact filename match under the agent's root; names only, no other file is opened. */
function locate(agent: Agent, id: string): string | null {
  const [root, hit] =
    agent === 'claude'
      ? [join(homedir(), '.claude', 'projects'), (n: string) => n === `${id}.jsonl`]
      : agent === 'codex'
        ? [
            join(homedir(), '.codex', 'sessions'),
            (n: string) => n.startsWith('rollout-') && (n.endsWith(`-${id}.jsonl`) || n.endsWith(`-${id}.jsonl.zst`))
          ]
        : [join(homedir(), '.pi', 'agent', 'sessions'), (n: string) => n.endsWith(`_${id}.jsonl`)]
  if (!existsSync(root)) return null
  const e = readdirSync(root, { recursive: true, withFileTypes: true }).find((x) => x.isFile() && hit(x.name))
  return e === undefined ? null : join(e.parentPath, e.name)
}

function records(file: string): Rec[] {
  const raw = readFileSync(file)
  return new TextDecoder()
    .decode(file.endsWith('.zst') ? zstdDecompressSync(raw) : raw)
    .split('\n')
    .flatMap((l) => {
      if (l.trim() === '') return []
      const v: unknown = JSON.parse(l)
      return isRec(v) ? [v] : []
    })
}

const texts = (content: unknown, type: string) =>
  typeof content === 'string' ? [content] : arr(content).flatMap((b) => (isRec(b) && b['type'] === type ? (str(b['text']) ?? []) : []))

/** Raw record kinds, the same rule as anonymise.ts `turn`, so they line up with expected.json. */
function rawKinds(agent: Agent, rs: Rec[]): string[] {
  return rs.flatMap((r) => {
    if (agent === 'claude') return (r['type'] === 'user' || r['type'] === 'assistant') && str(r['uuid']) !== null ? [r['type']] : []
    if (agent === 'codex') {
      const p = r['payload']
      const item = isRec(p) && p['type'] === 'item_completed' ? p['item'] : null
      return r['type'] === 'event_msg' && isRec(item) ? [str(item['type']) ?? 'unknown'] : []
    }
    const m = r['message']
    const role = isRec(m) ? str(m['role']) : null
    return r['type'] === 'message' && str(r['id']) !== null && role !== null ? [role] : []
  })
}

/** The user/assistant sequence per the plan's PR5 predicates (approximation; the adapters own the real rules). */
function messages(agent: Agent, rs: Rec[]): { msgs: Msg[]; markers: number } {
  const msgs: Msg[] = []
  let markers = 0
  const user = (t: string, filtered: boolean) => {
    const marked = MARKER_RE.test(t)
    if (marked) markers++
    if (marked || (!filtered && !WRAPPED.test(t))) msgs.push({ role: 'user', text: t })
  }
  if (agent === 'claude')
    for (const r of rs) {
      const m = r['message']
      if (!isRec(m)) continue
      if (r['type'] === 'assistant') for (const t of texts(m['content'], 'text')) msgs.push({ role: 'assistant', text: t })
      if (r['type'] !== 'user') continue
      const origin = r['origin']
      const toolResult = arr(m['content']).some((b) => isRec(b) && b['type'] === 'tool_result') || r['toolUseResult'] !== undefined
      const nonHuman = isRec(origin) && origin['kind'] !== 'human'
      const filtered = r['isMeta'] === true || r['isSidechain'] === true || r['isCompactSummary'] === true || toolResult || nonHuman
      const t = texts(m['content'], 'text').join('\n')
      if (t !== '') user(t, filtered)
    }
  if (agent === 'codex')
    for (const r of rs) {
      const p = r['payload']
      const item = isRec(p) && p['type'] === 'item_completed' ? p['item'] : null
      if (r['type'] !== 'event_msg' || !isRec(item)) continue
      if (item['type'] === 'UserMessage') user(texts(item['content'], 'text').join('\n'), false)
      if (item['type'] === 'AgentMessage') for (const t of texts(item['content'], 'Text')) msgs.push({ role: 'assistant', text: t })
    }
  if (agent === 'pi') {
    // Active branch: the parent chain from the last entry.
    const byId = new Map(rs.flatMap((r) => (str(r['id']) === null ? [] : [[String(r['id']), r] as const])))
    const chain: Rec[] = []
    for (let r = rs.at(-1); r !== undefined; r = byId.get(str(r['parentId']) ?? '')) chain.unshift(r)
    for (const r of chain) {
      const m = r['message']
      if (r['type'] !== 'message' || !isRec(m)) continue
      if (m['role'] === 'user') user(texts(m['content'], 'text').join('\n'), false)
      if (m['role'] === 'assistant') for (const t of texts(m['content'], 'text')) msgs.push({ role: 'assistant', text: t })
    }
  }
  return { msgs, markers }
}

/** Runs orca with an argument array and no shell. */
function execOrca(args: string[]): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile('orca', args, { encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null ? stdout : null)
    })
  })
}
/** `orca agent read --json`: {ok, result: {entries: [{kind:'message', role, text} | {kind:'tool', …}], limited}}. */
async function orcaRead(orcaId: string): Promise<{ msgs: Msg[]; limited: boolean } | null> {
  const stdout = await execOrca(['agent', 'read', orcaId, '--json', '--limit', '100'])
  if (stdout === null) return null
  let v: unknown
  try {
    v = JSON.parse(stdout)
  } catch {
    return null
  }
  const res = isRec(v) && v['ok'] === true ? v['result'] : null
  if (!isRec(res)) return null
  const msgs = arr(res['entries']).flatMap((e): Msg[] => {
    if (!isRec(e) || e['kind'] !== 'message') return []
    const [role, text] = [e['role'], str(e['text'])]
    return (role === 'user' || role === 'assistant') && text !== null ? [{ role, text }] : []
  })
  return { msgs, limited: res['limited'] === true }
}

/** Does `orca agent list --json` name this native session anywhere? (Checked by id only; nothing is printed.) */
async function listNames(id: string): Promise<boolean> {
  const stdout = await execOrca(['agent', 'list', '--json'])
  return stdout?.includes(id) === true
}

const count = (ms: Msg[], role: Msg['role']) => ms.filter((m) => m.role === role).length

export function compare(native: Msg[], orca: Msg[], limited = false): string {
  const counts = `native ${native.length}, orca ${orca.length}`
  // Nothing to compare is never a pass: a session with no messages means the wrong file or a broken parse.
  if (orca.length === 0 || native.length === 0) return `MISMATCH counts ${counts}`
  // Only an explicitly limited reply may omit the older native prefix; it must still leave at least one message.
  if ((!limited && native.length !== orca.length) || orca.length > native.length) return `MISMATCH counts ${counts}`
  const tail = limited ? native.slice(native.length - orca.length) : native
  const bad = orca.findIndex((m, i) => {
    const n = tail[i]
    return n?.role !== m.role || norm(n.text) !== norm(m.text)
  })
  return bad < 0 ? 'equal' : `MISMATCH at ${(limited ? native.length - orca.length : 0) + bad} (${counts})`
}

function run(agent: Agent, ids: string[], orcaId: string | undefined, fixtures: string | undefined): Promise<number> {
  return runInner(agent, ids, orcaId, fixtures)
}

async function runInner(agent: Agent, ids: string[], orcaId: string | undefined, fixtures: string | undefined): Promise<number> {
  let [mismatch, unreadable] = [false, false]
  const fail = (c: 1 | 3) => (c === 1 ? (mismatch = true) : (unreadable = true))
  console.log(`crosscheck: agent ${agent}, ${ids.length} probe session(s)`)
  for (const id of ids) {
    const file = locate(agent, id)
    if (file === null) {
      console.log(`  ${id}: native file not found`)
      fail(1)
      continue
    }
    const rs = records(file)
    const kinds = rawKinds(agent, rs)
    const { msgs, markers } = messages(agent, rs)
    console.log(
      `  ${id}: ${rs.length} records, ${kinds.length} user/assistant records, native sequence ${msgs.length} (user ${count(msgs, 'user')}, assistant ${count(msgs, 'assistant')}), ${markers} marker records`
    )
    if (fixtures !== undefined) {
      const caseName = FIXTURE[id] ?? ''
      const exp = join(fixtures, agent, caseName, 'expected.json')
      const v: unknown = existsSync(exp) ? JSON.parse(readFileSync(exp, 'utf8')) : null
      const turns = isRec(v) ? arr(v['turns']).map((t) => (isRec(t) ? str(t['kind']) : null)) : null
      const ok = isRec(v) && v['count'] === kinds.length && JSON.stringify(turns) === JSON.stringify(kinds)
      console.log(
        `    fixture ${agent}/${caseName}: expected.json count ${isRec(v) ? String(v['count']) : 'missing'}, kinds ${ok ? 'equal' : 'MISMATCH'}`
      )
      if (!ok) fail(1)
    }
    if (orcaId === undefined) {
      console.log(
        `    orca: ${(await listNames(id)) ? 'listed, pass --orca <orca_session_id> to compare' : 'not named by `orca agent list --json`; no orca_session_id to read'}`
      )
      fail(3)
      continue
    }
    const o = await orcaRead(orcaId)
    if (o === null) {
      console.log('    orca: `orca agent read` failed or returned no result')
      fail(3)
      continue
    }
    const verdict = compare(msgs, o.msgs, o.limited)
    console.log(
      `    orca: ${o.msgs.length} messages (user ${count(o.msgs, 'user')}, assistant ${count(o.msgs, 'assistant')})${o.limited ? ', limited' : ''}, sequence ${verdict}`
    )
    if (verdict !== 'equal') fail(1)
  }
  return mismatch ? 1 : unreadable ? 3 : 0
}

if (import.meta.main) {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const [agent, session, orca] = [arg('--agent'), arg('--session'), arg('--orca')]
  const known = agent === 'claude' || agent === 'codex' || agent === 'pi'
  const ids = known ? PROBES[agent].filter((id) => session === undefined || id === session) : []
  // One orca session is one native session, so --orca needs --session; ids outside PROBES are refused.
  if (!known || ids.length === 0 || (orca !== undefined && session === undefined)) {
    console.error(
      'usage: node scripts/crosscheck.ts --agent claude|codex|pi [--session <probe id> --orca <orca_session_id>] [--fixture <dir>]'
    )
    process.exitCode = 2
  } else {
    try {
      process.exitCode = await run(agent, ids, orca, arg('--fixture'))
    } catch {
      console.error('crosscheck: failed') // fixed text: Node's messages can quote paths or source text
      process.exitCode = 1
    }
  }
}
