import { DatabaseSync } from 'node:sqlite'
import { open, readdir, stat } from 'node:fs/promises'
import type { SessionSource, SqliteReader } from '../types'

const missing = (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')

/** R7: every adapter read, files and foreign SQLite, goes through here. Read-only by type (node.d.ts) and by lint (E3). */
export class LocalSessionSource implements SessionSource {
  async list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir)
    } catch (e) {
      if (missing(e)) return []
      throw e
    }
  }

  async dirs(dir: string): Promise<string[]> {
    try {
      // Dirent.isDirectory() is false for a symlink, so a link out of the tree is never entered.
      return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch (e) {
      if (missing(e)) return []
      throw e
    }
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number; dev: number; ino: number } | null> {
    try {
      const { size, mtimeMs, dev, ino } = await stat(path)
      return { size, mtimeMs, dev, ino }
    } catch (e) {
      if (missing(e)) return null
      throw e
    }
  }

  async read(path: string, from = 0): Promise<Uint8Array> {
    const h = await open(path, 'r')
    try {
      const buf = new Uint8Array(Math.max(0, (await h.stat()).size - from))
      const { bytesRead } = await h.read(buf, 0, buf.length, from)
      return buf.subarray(0, bytesRead)
    } finally {
      await h.close()
    }
  }

  /** One read transaction = one WAL snapshot of the live DB; no copy of the file or its -wal. */
  withSqliteSnapshot<T>(path: string, fn: (q: SqliteReader) => T): Promise<T> {
    return Promise.resolve().then(() => {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        db.exec('BEGIN')
        const result = fn({ all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[] })
        db.exec('COMMIT')
        return result
      } finally {
        db.close()
      }
    })
  }
}
