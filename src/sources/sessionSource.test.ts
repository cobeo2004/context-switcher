import { assert, test } from 'orca/testing'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalSessionSource } from './sessionSource'

const src = new LocalSessionSource()

async function inTmp(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-src-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('stat returns size, mtime, dev and ino; a missing path is null', () =>
  inTmp(async (dir) => {
    const p = join(dir, 'a.jsonl')
    writeFileSync(p, 'hello')
    const s = statSync(p)
    assert.deepEqual(await src.stat(p), { size: 5, mtimeMs: s.mtimeMs, dev: s.dev, ino: s.ino })
    assert.equal(await src.stat(join(dir, 'nope')), null)
    assert.equal(await src.stat(join(p, 'under-a-file')), null)
  }))

test('read returns the bytes from an offset to EOF', () =>
  inTmp(async (dir) => {
    const p = join(dir, 'a.jsonl')
    writeFileSync(p, 'line1\nline2\n')
    assert.equal(new TextDecoder().decode(await src.read(p)), 'line1\nline2\n')
    assert.equal(new TextDecoder().decode(await src.read(p, 6)), 'line2\n')
    assert.equal((await src.read(p, 99)).length, 0)
    await assert.rejects(src.read(join(dir, 'nope')), /ENOENT/)
  }))

test('list names a dir’s entries; a missing dir is []', () =>
  inTmp(async (dir) => {
    writeFileSync(join(dir, 'b'), '')
    writeFileSync(join(dir, 'a'), '')
    assert.deepEqual((await src.list(dir)).sort(), ['a', 'b'])
    assert.deepEqual(await src.list(join(dir, 'nope')), [])
  }))

test('withSqliteSnapshot: a concurrent writer never changes what one fn sees, and every ref resolves', () =>
  inTmp(async (dir) => {
    const path = join(dir, 'store.db')
    const writer = new DatabaseSync(path)
    try {
      writer.exec(`PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO blobs VALUES ('b0', x'00'); INSERT INTO meta VALUES ('0', 'b0');`)
      const insert = writer.prepare('INSERT INTO blobs VALUES (?, ?)')
      const point = writer.prepare("UPDATE meta SET value = ? WHERE key = '0'")
      for (let i = 1; i <= 20; i++) {
        const seen = await src.withSqliteSnapshot(path, (q) => {
          const root = q.all("SELECT value FROM meta WHERE key = '0'")
          const count = q.all('SELECT count(*) AS n FROM blobs')
          insert.run(`b${i}`, new Uint8Array([i]))
          point.run(`b${i}`)
          assert.deepEqual(q.all("SELECT value FROM meta WHERE key = '0'"), root)
          assert.deepEqual(q.all('SELECT count(*) AS n FROM blobs'), count)
          const ref = root[0]?.['value']
          assert.equal(typeof ref, 'string')
          assert.equal(q.all('SELECT id FROM blobs WHERE id = ?', String(ref)).length, 1)
          return ref
        })
        assert.equal(seen, `b${i - 1}`) // the previous loop's commit is visible to the next snapshot
      }
    } finally {
      writer.close()
    }
  }))

test('withSqliteSnapshot is read-only and rejects with fn’s error', () =>
  inTmp(async (dir) => {
    const path = join(dir, 'store.db')
    const w = new DatabaseSync(path)
    w.exec('CREATE TABLE t (x)')
    w.close()
    await assert.rejects(
      src.withSqliteSnapshot(path, (q) => q.all('INSERT INTO t VALUES (1) RETURNING x')),
      /readonly/
    )
    await assert.rejects(
      src.withSqliteSnapshot(path, () => {
        throw new Error('boom')
      }),
      /boom/
    )
    assert.equal(await src.withSqliteSnapshot(path, (q) => q.all('SELECT count(*) AS n FROM t')[0]?.['n']), 0)
    await assert.rejects(src.withSqliteSnapshot(join(dir, 'missing.db'), () => 1))
  }))
