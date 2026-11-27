import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Synthetic inputs only, and every run gets a temp HOME: the real ~/.claude, ~/.codex and ~/.pi are never read.
const script = (name: string) => new URL(`./${name}`, import.meta.url).pathname
const temp = (tag: string) => mkdtempSync(join(tmpdir(), `cs-fx-${tag}-`))
const run = (home: string, name: string, ...args: string[]) =>
  spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } })

test('anonymise: claude jsonl round trip keeps record count and kinds, and the output passes check-fixtures', () => {
  const home = temp('home')
  const work = temp('work')
  const marker = '[context-switcher handoff h_11111111-1111-1111-1111-111111111111 thread t_22222222-2222-2222-2222-222222222222]'
  const secret = 'a private sentence nobody should ever see in a fixture'
  const lines = [
    `{"type":"summary","summary":"${secret}","leafUuid":"u2"}`,
    `{"type":"user","uuid":"u1","parentUuid":null,"version":"2.1.0","cwd":"${home}/proj","gitBranch":"feature/secret-branch","message":{"role":"user","content":"${marker} ${secret}"}}`,
    `{"type":"assistant","uuid":"u2","parentUuid":"u1","version":"2.1.0","requestId":"req_private","message":{"role":"assistant","content":[{"type":"text","text":"${secret}"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cat ${home}/.ssh/id_rsa"}}]}}`
  ]
  const src = join(work, 'session.jsonl')
  writeFileSync(src, lines.join('\n') + '\n', { mode: 0o600 })
  const out = join(work, 'out')

  const r = run(home, 'anonymise.ts', '--agent', 'claude', '--in', src, '--out', out)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(![secret, home].some((s) => r.stdout.includes(s) || r.stderr.includes(s)))
  const sentinels = join(home, '.context-switcher', 'fixture-sentinels.txt')
  assert.equal(statSync(sentinels).mode & 0o777, 0o600)
  const planted = readFileSync(sentinels, 'utf8').split('\n')
  assert.ok(planted.some((l) => secret.includes(l) && l.length >= 12))

  const check = run(home, 'check-fixtures.ts', out)
  assert.equal(check.status, 0, check.stderr)
  const text = readFileSync(join(out, 'session.jsonl'), 'utf8')
  assert.ok(!text.includes('requestId') && text.includes(marker))
  const kinds = text
    .trim()
    .split('\n')
    .map((l) => /"type":"(\w+)"/.exec(l)?.[1])
  assert.deepEqual(kinds, ['summary', 'user', 'assistant'])
  const expected = readFileSync(join(out, 'expected.json'), 'utf8')
  const [, u1, u2] = text
    .trim()
    .split('\n')
    .map((l) => /"(?:uuid|leafUuid)":"([^"]+)"/.exec(l)?.[1])
  assert.ok(u1 !== 'u1' && u2 !== 'u2', 'ids are remapped')
  const turns = [
    { nativeId: u1, kind: 'user' },
    { nativeId: u2, kind: 'assistant' }
  ]
  assert.deepEqual(JSON.parse(expected), { agent: 'claude', count: 2, turns })

  const cursor = run(home, 'anonymise.ts', '--agent', 'cursor', '--in', src, '--out', out)
  assert.equal(cursor.status, 2)
  assert.match(cursor.stderr, /cursor: not supported yet/)
})

test('anonymise: only enumerated values, known keys, fixed wrappers and remapped ids survive (review probes)', () => {
  const home = temp('home')
  const work = temp('work')
  const ts = '2025-03-04T05:06:07.000Z'
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const lines = [
    `{"type":"user","uuid":"${uuid}","version":"2.1.0","timestamp":"${ts}","message":{"role":"user","content":"<system-reminder>x</system-reminder><private-client> # AGENTS.md"}}`,
    `{"type":"assistant","uuid":"aaaa-private","parentUuid":"${uuid}","version":"2.1.0","message":{"role":"assistant","model":"private-model","content":[{"type":"tool_use","id":"toolu_01Private","name":"private-client-tool","input":{"/home/private-user/secret.txt":"replace this private text","command":"ls"}},{"type":"text","text":"hi","private-key":"v"}]}}`
  ]
  const src = join(work, 'session.jsonl')
  writeFileSync(src, lines.join('\n') + '\n', { mode: 0o600 })
  const out = join(work, 'out')
  assert.equal(run(home, 'anonymise.ts', '--agent', 'claude', '--in', src, '--out', out).status, 0)
  const text = readFileSync(join(out, 'session.jsonl'), 'utf8')
  for (const leak of [
    'private-client',
    'private-user',
    'secret.txt',
    'private-model',
    'private-key',
    'aaaa-private',
    'toolu_01Private',
    uuid,
    ts
  ])
    assert.ok(!text.includes(leak), leak)
  assert.ok(
    ['<system-reminder>', '</system-reminder>', '# AGENTS.md', '"version":"2.1.0"', '"type":"tool_use"', '"command":'].every((s) =>
      text.includes(s)
    )
  )
  const [u, a] = text
    .trim()
    .split('\n')
    .map((l) => /"uuid":"([^"]+)"/.exec(l)?.[1])
  assert.ok(u !== undefined && text.includes(`"parentUuid":"${u}"`), 'parent link kept')
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const expected: unknown = JSON.parse(readFileSync(join(out, 'expected.json'), 'utf8'))
  assert.deepEqual(expected, {
    agent: 'claude',
    count: 2,
    turns: [
      { nativeId: u, kind: 'user' },
      { nativeId: a, kind: 'assistant' }
    ]
  })
  const again = join(work, 'again')
  run(home, 'anonymise.ts', '--agent', 'claude', '--in', src, '--out', again)
  assert.equal(readFileSync(join(again, 'session.jsonl'), 'utf8'), text, 'deterministic')
})

test('anonymise: a missing input prints the error code, not its path', () => {
  const home = temp('home')
  const missing = join(home, 'private-dir', 'nope.jsonl')
  const r = run(home, 'anonymise.ts', '--agent', 'pi', '--in', missing, '--out', join(home, 'out'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /anonymise: ENOENT/)
  assert.ok(!r.stderr.includes('private-dir'))
})

test('anonymise: distinct ids stay distinct, every id is remapped, and the output name is fixed (review 2 probes)', () => {
  const home = temp('home')
  const work = temp('work')
  const lines = [
    '{"type":"user","sessionId":"1","uuid":"03","message":{"role":"user","content":"a"}}',
    '{"type":"assistant","uuid":"09","parentUuid":"03","message":{"role":"assistant","content":"b"}}',
    '{"type":"user","uuid":"客户-秘密","parentUuid":"09","sessionId":"---","message":{"role":"user","content":"c"}}'
  ]
  const src = join(work, 'private-client-0451.jsonl')
  writeFileSync(src, lines.join('\n') + '\n', { mode: 0o600 })
  const out = join(work, 'out')
  const r = run(home, 'anonymise.ts', '--agent', 'claude', '--in', src, '--out', out)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(
    readdirSync(out, { recursive: true, withFileTypes: true })
      .map((e) => e.name)
      .sort(),
    ['expected.json', 'session.jsonl']
  )
  const text = readFileSync(join(out, 'session.jsonl'), 'utf8')
  for (const leak of ['"1"', '"03"', '"09"', '客户', '秘密', '"---"']) assert.ok(!text.includes(leak), leak)
  const rows = text.trim().split('\n')
  const uuids = rows.map((l) => /"uuid":"([^"]*)"/.exec(l)?.[1])
  const parents = rows.map((l) => /"parentUuid":"([^"]*)"/.exec(l)?.[1])
  assert.equal(new Set(uuids).size, 3, 'distinct ids stay distinct')
  assert.deepEqual(parents, [undefined, uuids[0], uuids[1]], 'references map through the same table')
  const expected = readFileSync(join(out, 'expected.json'), 'utf8')
  assert.equal(new Set([...expected.matchAll(/"nativeId": "([^"]*)"/g)].map((m) => m[1])).size, 3)
})
