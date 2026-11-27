import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { codex } from './codex'
import { LocalSessionSource } from './sessionSource'
import { openStore } from '../store'
import { UnsupportedFormat, type CanonicalTurn, type Cursor } from '../types'

const src = new LocalSessionSource()
const FIXTURES = 'src/sources/fixtures/codex' // orca plugin test runs from the repo root
const H = 'h_11111111-2222-4333-8444-555555555555'
const T = 't_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MARKER = `[context-switcher handoff ${H} thread ${T}]`
const AT = '2026-01-01T00:00:00.000Z'

const line = (r: Record<string, unknown>) => JSON.stringify({ timestamp: AT, ...r }) + '\n'
const meta = (cli_version: unknown = '0.159.0') => line({ ordinal: 0, type: 'session_meta', payload: { id: 's', cwd: '/w', cli_version } })
const item = (ordinal: number, it: Record<string, unknown>) =>
  line({ ordinal, type: 'event_msg', payload: { type: 'item_completed', item: { id: `i${ordinal}`, ...it } } })
const user = (ordinal: number, text: string, extra: Record<string, unknown> = {}) =>
  item(ordinal, { type: 'UserMessage', content: [{ type: 'text', text }], ...extra })
const appendFileSync = (p: string, s: string) => {
  writeFileSync(p, readFileSync(p, 'utf8') + s)
} // same inode

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-codex-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const withFile = (body: string, fn: (path: string) => Promise<void>) =>
  withDir(async (dir) => {
    const path = join(dir, 'rollout-x.jsonl')
    writeFileSync(path, body)
    await fn(path)
  })
const parse = (path: string, cursor: Cursor | null = null) => codex.parse(src, path, cursor)
const ids = (ts: CanonicalTurn[]) => ts.map((t) => t.nativeId)
const rejects = async (body: string, detail: RegExp) =>
  withFile(body, async (p) => {
    const e: unknown = await parse(p).catch((err: unknown) => err)
    assert.ok(e instanceof UnsupportedFormat, `expected UnsupportedFormat, got ${String(e)}`)
    assert.match(e.detail, detail)
  })

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const kinds: Record<string, string> = {
  probe: 'user assistant user assistant user assistant tool_call tool_call tool_call assistant',
  synthetic: 'user user command file_change tool_call assistant user assistant'
}
for (const name of ['probe', 'synthetic'])
  test(`fixture ${name}: .jsonl and .jsonl.zst give the same turns, in expected.json order`, async () => {
    const plain = await parse(join(FIXTURES, name, 'session.jsonl'))
    const zst = await parse(join(FIXTURES, name, 'session.jsonl.zst'))
    assert.deepEqual(zst.turns, plain.turns)
    assert.deepEqual(zst.markers, plain.markers)
    assert.equal(zst.cursor.kind === 'offset' && zst.cursor.offset, plain.cursor.kind === 'offset' && plain.cursor.offset)
    assert.deepEqual(
      plain.turns.map((t) => t.kind),
      kinds[name]?.split(' ')
    )
    const raw = readFileSync(join(FIXTURES, name, 'session.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
    const ordinalOf = new Map<unknown, unknown>()
    for (const l of raw) {
      const r: unknown = JSON.parse(l)
      const it = isRec(r) && isRec(r['payload']) ? r['payload']['item'] : undefined
      if (isRec(r) && isRec(it)) ordinalOf.set(it['id'], r['ordinal'])
    }
    const v: unknown = JSON.parse(readFileSync(join(FIXTURES, name, 'expected.json'), 'utf8'))
    const expected =
      isRec(v) && Array.isArray(v['turns'])
        ? v['turns'].map((t: unknown) => isRec(t) && `session#${String(ordinalOf.get(t['nativeId']))}`)
        : []
    const pos = ids(plain.turns).map((id) => expected.indexOf(id))
    assert.ok(
      pos.every((x, i) => x >= 0 && x > (pos[i - 1] ?? -1)),
      `${name}: every turn is an expected.json item, in order`
    )
    assert.equal(plain.markers.length, plain.turns.filter((t) => t.handoffId !== undefined).length)
  })

test('fixture synthetic: exact turns; the # AGENTS.md marker record is emitted, other injections dropped', async () => {
  const r = await parse(join(FIXTURES, 'synthetic', 'session.jsonl'))
  assert.deepEqual(
    r.turns.map((t) => [t.nativeId, t.kind, t.text, t.tool ?? '', (t.paths ?? []).join(), t.handoffId ?? '']),
    [
      ['session#1', 'user', r.turns[0]?.text ?? '', '', '', 'h_00000000-0000-4000-8000-0000000000b1'],
      ['session#4', 'user', 'adipiscing sed ipsum adipis', '', '', ''],
      ['session#6', 'command', 'amet sit adipi', '', '', ''],
      ['session#7', 'file_change', '', '', 'eiusmod sed dolor adipis', ''],
      ['session#8', 'tool_call', '', 'sed amet elit am/ipsum consecte', '', ''],
      ['session#9', 'assistant', 'consectetur adipiscin', '', '', ''],
      ['session#12', 'user', 'elit sed ipsum sed amet adipiscing', '', '', ''],
      ['session#13', 'assistant', 'ipsum eiusmod sed sit a', '', '', '']
    ]
  )
  assert.match(r.turns[0]?.text ?? '', /^# AGENTS\.md/)
  assert.deepEqual(
    r.markers.map((m) => [m.nativeId, m.userRecordIndex]),
    [['session#1', 0]]
  )
  assert.equal(r.formatVersion, 'codex-rollout-ordinal-1')
  assert.equal(r.cwd, 'do amet consectetu')
  assert.equal(r.turns[1]?.at, Date.parse('2026-01-01T00:00:04.000Z'))
})

test('ingest from the .jsonl cursor, then swap to .jsonl.zst → 0 new turns', () =>
  withDir(async (dir) => {
    const raw = readFileSync(join(FIXTURES, 'synthetic', 'session.jsonl'))
    const plain = join(dir, 'rollout-a.jsonl')
    writeFileSync(plain, raw)
    const store = openStore(join(dir, 'context.sqlite'))
    const key = { agent: 'codex', nativeId: 's' }
    const first = await parse(plain)
    assert.equal(store.ingestParse(key, first, { workspaceId: 'ws' }, 1).inserted, 8)
    rmSync(plain)
    const zst = join(dir, 'rollout-a.jsonl.zst')
    writeFileSync(zst, zstdCompressSync(raw))
    const again = await parse(zst, first.cursor)
    assert.deepEqual(ids(again.turns), ids(first.turns)) // identity changed: full re-parse, same stem ids
    assert.equal(store.ingestParse(key, again, { workspaceId: 'ws' }, 2).inserted, 0)
    assert.deepEqual((await parse(zst, again.cursor)).turns, [])
  }))

test('no unified_diff, stdout, aggregated output or reasoning text reaches any turn', () =>
  withFile(
    meta() +
      item(1, { type: 'CommandExecution', command: ['git', 'status'], aggregated_output: 'STDOUT-SECRET', stdout: 'STDOUT-SECRET' }) +
      item(2, {
        type: 'FileChange',
        changes: [
          { path: '/a.ts', unified_diff: 'DIFF-SECRET' },
          { path: '/b.ts', kind: 'add' }
        ]
      }) +
      item(3, { type: 'Reasoning', summary: [{ type: 'text', text: 'REASON-SECRET' }] }) +
      item(4, { type: 'McpToolCall', server: 'gh', tool: 'search', arguments: { q: 'ARG-SECRET' }, result: 'OUT-SECRET' }) +
      line({ ordinal: 5, type: 'event_msg', payload: { type: 'exec_command_output_delta', chunk: 'STDOUT-SECRET' } }) +
      line({ ordinal: 6, type: 'response_item', payload: { type: 'function_call_output', output: 'OUT-SECRET' } }),
    async (p) => {
      const { turns } = await parse(p)
      assert.deepEqual(turns, [
        { nativeId: 'rollout-x#1', kind: 'command', text: 'git status', at: Date.parse(AT) },
        { nativeId: 'rollout-x#2', kind: 'file_change', text: '', paths: ['/a.ts', '/b.ts'], at: Date.parse(AT) },
        { nativeId: 'rollout-x#4', kind: 'tool_call', text: '', tool: 'gh/search', at: Date.parse(AT) }
      ])
      assert.ok(!JSON.stringify(turns).includes('SECRET'))
    }
  ))

test('user filter: <task>, <skill>, <external_codex_apps_open_page>, # AGENTS.md and developer role are dropped', () =>
  withFile(
    meta() +
      user(1, 'kept') +
      user(2, '<task>x</task>') +
      user(3, '<skill>x</skill>') +
      user(4, '<external_codex_apps_open_page>x') +
      user(5, '# AGENTS.md rules') +
      user(6, 'dev', { role: 'developer' }) +
      item(7, { type: 'UserMessage', content: [{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) +
      item(8, { type: 'AgentMessage', content: [{ type: 'Text', text: 'hi' }], phase: 'final_answer' }),
    async (p) => {
      const { turns, markers } = await parse(p)
      assert.deepEqual(
        turns.map((t) => `${t.nativeId}=${t.kind}:${t.text}`),
        ['rollout-x#1=user:kept', 'rollout-x#7=user:a\nb', 'rollout-x#8=assistant:hi']
      )
      assert.deepEqual(markers, [])
    }
  ))

test('marker inside an # AGENTS.md-prefixed message is detected and its turn emitted', () =>
  withFile(meta() + user(1, `# AGENTS.md\n<INSTRUCTIONS>${MARKER}</INSTRUCTIONS>`), async (p) => {
    const r = await parse(p)
    assert.deepEqual(r.markers, [{ handoffId: H, threadId: T, nativeId: 'rollout-x#1', userRecordIndex: 0 }])
    assert.equal(r.turns[0]?.handoffId, H)
  }))

test('markers, unread batch: seven user messages then a marker in the 8th after the cursor → one hit', () =>
  withFile(meta() + user(1, 'before'), async (p) => {
    const first = await parse(p)
    for (let i = 2; i <= 8; i++) appendFileSync(p, user(i, `ordinary ${i}`))
    appendFileSync(p, user(9, `<task>${MARKER}</task>`))
    const r = await parse(p, first.cursor)
    assert.deepEqual(r.markers, [{ handoffId: H, threadId: T, nativeId: 'rollout-x#9', userRecordIndex: 7 }])
    assert.equal(r.turns.length, 8)
    assert.equal(r.turns.at(-1)?.handoffId, H)
  }))

test('cursor: a partial last line is not consumed; the next parse yields only the appended turns', () => {
  const b = user(2, 'two')
  return withFile(meta() + user(1, 'one') + b.slice(0, 20), async (p) => {
    const first = await parse(p)
    assert.deepEqual(ids(first.turns), ['rollout-x#1'])
    appendFileSync(p, b.slice(20))
    const second = await parse(p, first.cursor)
    assert.deepEqual(ids(second.turns), ['rollout-x#2'])
    assert.equal(second.cwd, undefined)
    assert.deepEqual((await parse(p, second.cursor)).turns, [])
  })
})

test('cursor: a truncated file re-parses in full with the same ids', () =>
  withFile(meta() + user(1, 'one') + user(2, 'two'), async (p) => {
    const first = await parse(p)
    writeFileSync(p, meta() + user(1, 'one'))
    assert.deepEqual(ids((await parse(p, first.cursor)).turns), ['rollout-x#1'])
  }))

for (const extra of ['', user(3, 'extra')])
  test(`cursor anchor: a same-inode rewrite ${extra === '' ? 'at the same size' : 'with growth'} re-parses in full`, () =>
    withFile(meta() + user(1, 'one'), async (p) => {
      const first = await parse(p)
      writeFileSync(p, meta() + user(2, 'owt') + extra)
      assert.deepEqual(ids((await parse(p, first.cursor)).turns), extra === '' ? ['rollout-x#2'] : ['rollout-x#2', 'rollout-x#3'])
    }))

for (const field of ['ino', 'dev'] as const)
  test(`cursor: a replaced file (other ${field}) is re-parsed in full`, () =>
    withFile(meta() + user(1, 'one'), async (p) => {
      const first = await parse(p)
      appendFileSync(p, user(2, 'two'))
      const c = first.cursor
      const moved: Cursor = c.kind === 'offset' ? { ...c, file: { ...c.file, [field]: c.file[field] + 1 } } : c
      assert.deepEqual(ids((await parse(p, moved)).turns), ['rollout-x#1', 'rollout-x#2'])
      assert.deepEqual(ids((await parse(p, first.cursor)).turns), ['rollout-x#2'])
    }))

test('UnsupportedFormat: a record without a numeric ordinal', () =>
  rejects(meta() + line({ type: 'event_msg', payload: {} }), /line 2 .*: ordinal/))
test('UnsupportedFormat: a string ordinal', () => rejects(meta() + line({ ordinal: '1', type: 'x' }), /ordinal/))
test('UnsupportedFormat: the first record is not session_meta', () => rejects(user(0, 'x'), /line 1 .*not session_meta/))
test('UnsupportedFormat: session_meta without an id', () =>
  rejects(line({ ordinal: 0, type: 'session_meta', payload: { cli_version: '0.159.0' } }), /payload\.id/))
for (const v of ['0.158.9', '0.99.0', 7]) test(`UnsupportedFormat: cli_version ${String(v)}`, () => rejects(meta(v), /cli_version/))
test('cli_version 0.200.1 and 1.0.0 parse', async () => {
  for (const v of ['0.200.1', '1.0.0'])
    await withFile(meta(v) + user(1, 'x'), async (p) => {
      assert.equal((await parse(p)).turns.length, 1)
    })
})
test('UnsupportedFormat: a line that is not JSON', () => rejects(meta() + '{oops\n', /line 2 .*: not JSON/))
test('blank lines and unknown record or item types are skipped', () =>
  withFile(
    meta() + '\n' + line({ ordinal: 1, type: 'turn_context', payload: {} }) + item(2, { type: 'WebSearch' }) + user(3, 'x'),
    async (p) => {
      assert.deepEqual(ids((await parse(p)).turns), ['rollout-x#3'])
    }
  ))
