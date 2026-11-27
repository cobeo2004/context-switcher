import { assert, test } from 'orca/testing'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'

// Synthetic inputs only, and every run gets a temp HOME: the real ~/.claude, ~/.codex and ~/.pi are never read.
const script = (name: string) => new URL(`./${name}`, import.meta.url).pathname
const temp = (tag: string) => mkdtempSync(join(tmpdir(), `cs-fx-${tag}-`))
const run = (home: string, name: string, ...args: string[]) =>
  spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } })
const utf8 = (s: string) => new TextEncoder().encode(s)
const hex = (s: string) => Array.from(utf8(s), (b) => b.toString(16).padStart(2, '0')).join('')
const pbString = (no: number, bytes: Uint8Array) => new Uint8Array([(no << 3) | 2, bytes.length, ...bytes])

function storeDb(dir: string, blob: Uint8Array, meta: string) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'store.db'))
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO blobs VALUES (?, ?)').run('b1', blob)
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('0', meta)
  db.close()
}

test('a home path inside a .jsonl.zst is reported with its file and decode path, never the value', () => {
  const home = temp('home')
  const fx = temp('tree')
  mkdirSync(join(fx, 'codex'))
  writeFileSync(join(fx, 'codex', 'rollout.jsonl.zst'), zstdCompressSync(utf8(`{"cwd":"${home}/proj"}\n`)), { mode: 0o600 })
  const r = run(home, 'check-fixtures.ts', fx)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /codex\/rollout\.jsonl\.zst: zstd/)
  assert.ok(!r.stderr.includes(home) && !r.stdout.includes(home))
})

test('a username inside a nested protobuf string field of a store.db blob is reported', () => {
  const home = temp('home')
  const fx = temp('tree')
  const { username } = userInfo()
  storeDb(join(fx, 'cursor', 'c1'), pbString(1, pbString(2, utf8(`by ${username}`))), hex('{"latestRootBlobId":"b1"}'))
  const r = run(home, 'check-fixtures.ts', fx)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /cursor\/c1\/store\.db: blobs\[\d+\]\.data pb\.1\.2/)
})

test('a sentinel inside hex meta is reported', () => {
  const home = temp('home')
  const fx = temp('tree')
  mkdirSync(join(home, '.context-switcher'))
  writeFileSync(join(home, '.context-switcher', 'fixture-sentinels.txt'), 'planted-sentinel-0451\n', { mode: 0o600 })
  storeDb(fx, utf8('clean blob'), hex('{"latestRootBlobId":"b1","note":"planted-sentinel-0451"}'))
  const r = run(home, 'check-fixtures.ts', fx)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /store\.db: meta\[\d+\]\.value hex/)
  assert.ok(!r.stderr.includes('planted-sentinel-0451'))
})

test('a clean tree passes', () => {
  const home = temp('home')
  const fx = temp('tree')
  writeFileSync(join(fx, 'a.jsonl'), '{"type":"user","text":"lorem ipsum"}\n', { mode: 0o600 })
  writeFileSync(join(fx, 'b.jsonl.zst'), zstdCompressSync(utf8('{"type":"assistant"}\n')), { mode: 0o600 })
  storeDb(join(fx, 'c'), pbString(1, utf8('dolor sit amet')), hex('{"latestRootBlobId":"b1"}'))
  const r = run(home, 'check-fixtures.ts', fx)
  assert.equal(r.status, 0, r.stderr)
})

const SENTINEL = 'planted-secret-0451'
function withSentinel() {
  const home = temp('home')
  mkdirSync(join(home, '.context-switcher'))
  writeFileSync(join(home, '.context-switcher', 'fixture-sentinels.txt'), `${SENTINEL}\n`, { mode: 0o600 })
  return home
}

test('escaped, encoded and mixed-case hits are reported (review probes)', () => {
  const home = withSentinel()
  const p = `${home}/private`
  const probes = [
    `{"cwd":"${p.replaceAll('/', '\\/')}"}`,
    `{"cwd":"${p.replace(/[a-z]/, (c) => `\\u00${c.charCodeAt(0).toString(16)}`)}"}`,
    `{"cwd":"${encodeURIComponent(p)}"}`,
    `{"cwd":"${p.toUpperCase()}"}`,
    '{"n":"planted-\\u0073ecret-0451"}',
    '{"n":"planted%2Dsecret%2D0451"}',
    '{"n":"planted-\\\\u0073ecret-0451"}'
  ]
  probes.forEach((probe, i) => {
    const fx = temp('tree')
    writeFileSync(join(fx, `p${i}.jsonl`), `${probe}\n`, { mode: 0o600 })
    const r = run(home, 'check-fixtures.ts', fx)
    assert.equal(r.status, 1, `probe ${i} passed`)
  })
})

test('a needle in a table, column or file name is reported by index, never printed', () => {
  const home = withSentinel()
  const fx = temp('tree')
  const db = new DatabaseSync(join(fx, 'store.db'))
  db.exec(`CREATE TABLE "${SENTINEL}" ("${SENTINEL}-col" TEXT); INSERT INTO "${SENTINEL}" VALUES ('x')`)
  db.close()
  writeFileSync(join(fx, `${SENTINEL}.jsonl`), '{}\n', { mode: 0o600 })
  const r = run(home, 'check-fixtures.ts', fx)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /file#\d+: name/)
  assert.match(r.stderr, /store\.db: table#0 name/)
  assert.match(r.stderr, /store\.db: table#0 col#0 name/)
  assert.ok(!r.stderr.includes(SENTINEL) && !r.stdout.includes(SENTINEL))
})

test('a missing or non-directory root fails with fixed text, never its path (review 2 probe)', () => {
  const home = temp('home')
  const file = join(home, `${SENTINEL}.txt`)
  writeFileSync(file, 'x', { mode: 0o600 })
  for (const root of [join(home, SENTINEL), file]) {
    const r = run(home, 'check-fixtures.ts', root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /check-fixtures: cannot read the needles or the fixture dir\n/)
    assert.ok(!r.stderr.includes(SENTINEL) && !r.stdout.includes(SENTINEL))
  }
})
