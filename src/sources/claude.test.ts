import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claude } from './claude'
import { LocalSessionSource } from './sessionSource'
import { UnsupportedFormat, type CanonicalTurn, type Cursor } from '../types'

const src = new LocalSessionSource()
const FIXTURES = 'src/sources/fixtures/claude' // orca plugin test runs from the repo root
const bytes = (s: string) => new TextEncoder().encode(s).length
const appendFileSync = (p: string, s: string) => {
  writeFileSync(p, readFileSync(p, 'utf8') + s)
} // same inode
const H = 'h_11111111-2222-4333-8444-555555555555'
const T = 't_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MARKER = `[context-switcher handoff ${H} thread ${T}]`

const rec = (type: 'user' | 'assistant', uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, uuid, version: '2.1.0', timestamp: '2026-01-01T00:00:00.000Z', message: { role: type, content }, ...extra }) + '\n'
const user = (uuid: string, text: string, extra: Record<string, unknown> = {}) => rec('user', uuid, text, extra)

async function withFile(body: string, fn: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-claude-'))
  try {
    const path = join(dir, 's.jsonl')
    writeFileSync(path, body)
    await fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const parse = (path: string, cursor: Cursor | null = null) => claude.parse(src, path, cursor)
const ids = (ts: CanonicalTurn[]) => ts.map((t) => t.nativeId)
const rejects = async (body: string, detail: RegExp) =>
  withFile(body, async (p) => {
    const e: unknown = await parse(p).catch((err: unknown) => err)
    assert.ok(e instanceof UnsupportedFormat, `expected UnsupportedFormat, got ${String(e)}`)
    assert.match(e.detail, detail)
  })

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
/** expected.json record ids, in file order. */
const expectedIds = (name: string): unknown[] => {
  const v: unknown = JSON.parse(readFileSync(join(FIXTURES, name, 'expected.json'), 'utf8'))
  if (!isRec(v) || !Array.isArray(v['turns'])) throw new Error(`${name}: bad expected.json`)
  return v['turns'].map((t: unknown) => isRec(t) && t['nativeId'])
}
/** Every string under `thinking` blocks and `tool_result` content in the raw file: none may reach a turn (R10). */
const forbidden = (raw: string) => {
  const out: string[] = []
  const walk = (v: unknown, keep: boolean): void => {
    if (typeof v === 'string' && keep && v.length > 3) out.push(v)
    if (Array.isArray(v)) for (const x of v) walk(x, keep)
    else if (isRec(v))
      for (const [k, x] of Object.entries(v)) walk(x, keep || k === 'thinking' || v['type'] === 'tool_result' || k === 'toolUseResult')
  }
  for (const line of raw.split('\n').filter(Boolean)) walk(JSON.parse(line), false)
  return out
}

const names = readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
  .filter((e) => e.name === 'session.jsonl')
  .map((e) => e.parentPath.split('/').at(-1) ?? '')
assert.equal(names.length, 4)
// From expected.json record IDs and the corresponding session.jsonl blocks: thinking and tool results are omitted.
const fixtureKinds: Record<string, string> = {
  'probe-launch': 'user assistant',
  'probe-resume':
    'user assistant user assistant user command assistant command assistant command assistant user assistant user assistant user assistant',
  'probe-resume2': 'user assistant user assistant assistant user assistant user assistant user assistant user assistant',
  synthetic: 'user user user assistant tool_call file_change command user assistant'
}
for (const name of names) {
  test(`fixture ${name}: turns follow expected.json records in order, kinds match, no thinking or tool output`, async () => {
    const path = join(FIXTURES, name, 'session.jsonl')
    const { turns, cursor, markers } = await parse(path)
    const kinds = turns.map((t) => t.kind)
    assert.deepEqual(kinds, fixtureKinds[name]?.split(' '), `${name}: canonical count and kinds`)
    const order = expectedIds(name)
    const pos = turns.map((t) => order.indexOf(t.nativeId.split('#')[0]))
    assert.ok(
      pos.every((x, i) => x >= 0 && x >= (pos[i - 1] ?? 0)),
      `${name}: record order`
    )
    const raw = readFileSync(path, 'utf8')
    for (const s of forbidden(raw)) for (const t of turns) assert.ok(!t.text.includes(s), `${t.nativeId} carries tool output/thinking`)
    assert.equal(cursor.kind === 'offset' && cursor.offset, bytes(raw))
    assert.equal(markers.length, turns.filter((t) => t.handoffId !== undefined).length)
  })
}

test('fixture synthetic: exact canonical turns; isMeta and <command-message> markers are emitted, other injections dropped', async () => {
  const r = await parse(join(FIXTURES, 'synthetic', 'session.jsonl'))
  const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`
  assert.deepEqual(
    r.turns.map((t) => [t.nativeId, t.kind, t.tool ?? '', t.handoffId ?? '']),
    [
      [`${id('02')}#0`, 'user', '', `h_${id('a1')}`],
      [`${id('04')}#0`, 'user', '', `h_${id('a2')}`],
      [`${id('06')}#0`, 'user', '', `h_${id('a3')}`],
      [`${id('0b')}#0`, 'assistant', '', ''],
      [`${id('0c')}#0`, 'tool_call', 'Read', ''],
      [`${id('0f')}#0`, 'file_change', 'Edit', ''],
      [`${id('13')}#0`, 'command', 'Bash', ''],
      [`${id('19')}#0`, 'user', '', ''],
      [`${id('1a')}#0`, 'assistant', '', '']
    ]
  )
  assert.deepEqual(
    r.markers.map((m) => [m.nativeId, m.userRecordIndex]),
    [
      [`${id('02')}#0`, 0],
      [`${id('04')}#0`, 1],
      [`${id('06')}#0`, 3]
    ]
  )
  assert.equal(r.formatVersion, 'claude-jsonl@2.1.0')
  assert.equal(r.cwd, 'do amet consectetu')
  assert.equal(r.turns[0]?.at, Date.parse('2026-01-01T00:00:00.000Z'))
})

test('assistant blocks: Bash → command line, Read → tool_call path, Write → file_change, other tools name only, thinking dropped', () =>
  withFile(
    rec('assistant', 'a', [
      { type: 'thinking', thinking: 'secret reasoning' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/r.ts' } },
      { type: 'tool_use', name: 'Write', input: { file_path: '/w.ts', content: 'body' } },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'x', file_path: '/g' } },
      { type: 'text', text: 'done' }
    ]) + rec('assistant', 'b', [{ type: 'tool_use', name: 'Read' }], { timestamp: 'never' }),
    async (p) => {
      const { turns } = await parse(p)
      assert.deepEqual(turns, [
        { nativeId: 'a#1', kind: 'command', text: 'ls -la', tool: 'Bash', at: Date.parse('2026-01-01T00:00:00.000Z') },
        { nativeId: 'a#2', kind: 'tool_call', text: '', tool: 'Read', at: Date.parse('2026-01-01T00:00:00.000Z'), paths: ['/r.ts'] },
        { nativeId: 'a#3', kind: 'file_change', text: '', tool: 'Write', at: Date.parse('2026-01-01T00:00:00.000Z'), paths: ['/w.ts'] },
        { nativeId: 'a#4', kind: 'tool_call', text: '', tool: 'Grep', at: Date.parse('2026-01-01T00:00:00.000Z') },
        { nativeId: 'a#5', kind: 'assistant', text: 'done', at: Date.parse('2026-01-01T00:00:00.000Z') },
        { nativeId: 'b#0', kind: 'tool_call', text: '', tool: 'Read', at: 0 }
      ])
    }
  ))

test('user filter: sidechain, compact summary, tool results, non-human origin and injected prefixes are dropped', () =>
  withFile(
    user('k1', 'kept', { origin: { kind: 'human' } }) +
      user('s', 'side', { isSidechain: true }) +
      user('c', 'compact', { isCompactSummary: true }) +
      user('t', 'tool', { toolUseResult: 'x' }) +
      rec('user', 'tr', [{ type: 'tool_result', content: 'out' }]) +
      user('o', 'bot', { origin: { kind: 'task' } }) +
      user('n', '<task-notification>x') +
      user('l', ' <local-command-stdout>x') +
      user('m', '<command-name>x') +
      rec('user', 'k2', [{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    async (p) => {
      const { turns, markers } = await parse(p)
      assert.deepEqual(
        turns.map((t) => `${t.nativeId}=${t.text}`),
        ['k1#0=kept', 'k2#1=a\nb']
      )
      assert.deepEqual(markers, [])
    }
  ))

test('cursor: a partial last line is not consumed; the next parse yields only the appended turns', () => {
  const [a, b] = [user('u1', 'one'), user('u2', 'two')]
  return withFile(a + b.slice(0, 20), async (p) => {
    const first = await parse(p)
    assert.deepEqual(ids(first.turns), ['u1#0'])
    assert.equal(first.cursor.kind === 'offset' && first.cursor.offset, bytes(a))
    appendFileSync(p, b.slice(20))
    const second = await parse(p, first.cursor)
    assert.deepEqual(ids(second.turns), ['u2#0'])
    const third = await parse(p, second.cursor)
    assert.deepEqual(third.turns, [])
    assert.equal(third.formatVersion, 'claude-jsonl')
  })
})

test('cursor: a truncated file (size < cursor size) is re-parsed in full with the same native ids', () =>
  withFile(user('u1', 'one') + user('u2', 'two'), async (p) => {
    const first = await parse(p)
    writeFileSync(p, user('u1', 'one')) // same inode, shorter
    const again = await parse(p, first.cursor)
    assert.deepEqual(ids(again.turns), ['u1#0'])
  }))

for (const extra of ['', user('more', 'extra')])
  test(`cursor: same-inode rewrite ${extra === '' ? 'at the same size' : 'with growth'} re-parses in full`, () =>
    withFile(user('old', 'one'), async (p) => {
      const first = await parse(p)
      const replacement = user('new', 'two') + extra
      assert.equal(bytes(user('old', 'one')), bytes(user('new', 'two')))
      writeFileSync(p, replacement)
      assert.deepEqual(ids((await parse(p, first.cursor)).turns), extra === '' ? ['new#0'] : ['new#0', 'more#0'])
    }))

test('cursor: truncation after a partial tail re-parses a longer replacement', () =>
  withFile(user('old', 'one') + 'x'.repeat(1000), async (p) => {
    const first = await parse(p)
    const replacement = user('new', 'two, longer than the consumed old record')
    assert.ok(bytes(replacement) > bytes(user('old', 'one')))
    writeFileSync(p, replacement)
    const again = await parse(p, first.cursor)
    assert.deepEqual(ids(again.turns), ['new#0'])
  }))

// node.d.ts (protected) has no rename, so a replacement is a cursor whose inode or device no longer matches the file.
for (const field of ['ino', 'dev'] as const)
  test(`cursor: a replaced file (other ${field}, same path) is re-parsed in full`, () =>
    withFile(user('u1', 'one'), async (p) => {
      const first = await parse(p)
      appendFileSync(p, user('u2', 'two'))
      const c = first.cursor
      const moved: Cursor = c.kind === 'offset' ? { ...c, file: { ...c.file, [field]: c.file[field] + 1 } } : c
      assert.deepEqual(ids((await parse(p, moved)).turns), ['u1#0', 'u2#0'])
      assert.deepEqual(ids((await parse(p, first.cursor)).turns), ['u2#0'])
    }))

test('markers, unread batch: six ordinary user records then a marker after the cursor → one hit on the 7th', () =>
  withFile(user('u0', 'before'), async (p) => {
    const first = await parse(p)
    for (let i = 1; i <= 6; i++) appendFileSync(p, user(`n${i}`, `ordinary ${i}`))
    appendFileSync(p, user('n7', `<system-reminder>${MARKER}</system-reminder>`, { isMeta: true }))
    const r = await parse(p, first.cursor)
    assert.deepEqual(r.markers, [{ handoffId: H, threadId: T, nativeId: 'n7#0', userRecordIndex: 6 }])
    assert.equal(r.turns.length, 7)
    assert.equal(r.turns.at(-1)?.handoffId, H)
    assert.equal(r.turns.filter((t) => t.handoffId !== undefined).length, 1)
  }))

test('version 3.0.0 with known structure parses to the same turns as the 2.x fixture', async () => {
  const raw = readFileSync(join(FIXTURES, 'synthetic', 'session.jsonl'), 'utf8')
  const base = await parse(join(FIXTURES, 'synthetic', 'session.jsonl'))
  await withFile(raw.replaceAll('"version":"2.1.0"', '"version":"3.0.0"'), async (p) => {
    const r = await parse(p)
    assert.deepEqual(r.turns, base.turns)
    assert.equal(r.formatVersion, 'claude-jsonl@3.0.0')
  })
})

test('formatVersion names the newest version seen', () =>
  withFile(
    user('a', 'x', { version: '2.10.1' }) + user('b', 'y', { version: '2.9.9' }) + user('c', 'z', { version: '2.10' }),
    async (p) => {
      assert.equal((await parse(p)).formatVersion, 'claude-jsonl@2.10.1')
    }
  ))

test('UnsupportedFormat: message.content is a number', () =>
  rejects(user('ok', 'fine') + rec('user', 'u', 42), /^line 2 after byte 0: message\.content/))
test('UnsupportedFormat: a user record without message', () =>
  rejects(JSON.stringify({ type: 'user', uuid: 'u', version: '2.1.0' }) + '\n', /line 1 .*: message is not an object/))
test('UnsupportedFormat: an empty version', () => rejects(user('u', 'x', { version: '' }), /line 1 .*: version/))
test('UnsupportedFormat: a missing version', () => rejects(user('u', 'x', { version: undefined }), /: version/))
test('UnsupportedFormat: a non-string uuid', () => rejects(rec('assistant', 'u', 'x', { uuid: 7 }), /: uuid/))
test('UnsupportedFormat: role does not match the record type', () =>
  rejects(
    JSON.stringify({ type: 'user', uuid: 'u', version: '1', message: { role: 'assistant', content: 'x' } }) + '\n',
    /message\.role is not user/
  ))
test('UnsupportedFormat: a content block without a string type', () =>
  rejects(rec('assistant', 'u', [{ type: 'text' }, { text: 'x' }]), /block/))
test('UnsupportedFormat: a content block that is not an object', () => rejects(rec('assistant', 'u', ['x']), /block/))
test('UnsupportedFormat: a line that is not JSON', () => rejects(user('a', 'x') + '{oops\n', /line 2 .*: not JSON/))
test('unknown record types and blank lines are skipped', () =>
  withFile('{"type":"system","content":7}\n\n"str"\n' + user('u', 'x'), async (p) => {
    assert.deepEqual(ids((await parse(p)).turns), ['u#0'])
  }))
