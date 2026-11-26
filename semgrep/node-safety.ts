import { exec, execFile, execSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import * as cp from 'node:child_process'
import { MIGRATION_1 } from './store'
declare const db: { prepare(s: string): unknown; exec(s: string): void }
declare const id: string
declare const externalValue: string
declare const MIGRATION_2: string
const USER_INPUT = externalValue
const opts = { mode: 0o600 }

// ruleid: cs-no-shell-exec
exec(`git log ${id}`)
// ruleid: cs-no-shell-exec
execSync('ls')
// ruleid: cs-no-shell-exec
cp.exec('ls')
// ruleid: cs-no-shell-exec
spawn('ls', [id], { shell: true })
// ruleid: cs-no-shell-exec
spawnSync('ls', [id], { stdio: 'inherit', shell: '/bin/sh' })
// ok: cs-no-shell-exec
execFile('git', ['log', id])
// ok: cs-no-shell-exec
spawn('git', ['log'], { shell: false })
// ok: cs-no-shell-exec
spawn('ls', [id], { stdio: 'inherit' })

// ruleid: cs-sql-built-by-string
db.prepare(`SELECT * FROM turns WHERE id = '${id}'`)
// ruleid: cs-sql-built-by-string
db.prepare(`SELECT * FROM turns WHERE id = '${USER_INPUT}'`)
// ruleid: cs-sql-built-by-string
db.exec('DELETE FROM turns WHERE id = ' + id)
// ruleid: cs-sql-built-by-string, cs-sql-migration-outside-store
db.exec(`${MIGRATION_1}\nDELETE FROM turns WHERE id = '${id}';`)
// ruleid: cs-sql-built-by-string
db.exec(`${USER_INPUT}\nPRAGMA user_version = 1;`)
// ok: cs-sql-built-by-string
db.prepare('SELECT * FROM turns WHERE id = ?')
// ok: cs-sql-built-by-string
// ruleid: cs-sql-migration-outside-store
db.exec(`${MIGRATION_1}\nPRAGMA user_version = 1;`)
// ok: cs-sql-built-by-string
// ruleid: cs-sql-migration-outside-store
db.exec(`${MIGRATION_2}\nPRAGMA user_version = 2;`)

// ruleid: cs-fs-private-mode
writeFileSync('/x', 'data')
// ruleid: cs-fs-private-mode
writeFileSync('/x', 'data', { mode: 0o666 })
// ruleid: cs-fs-private-mode
writeFileSync('/x', 'data', opts)
// ruleid: cs-fs-private-mode
fs.writeFileSync('/x', 'private')
// ruleid: cs-fs-private-mode
fs.mkdirSync('/x', { recursive: true, mode: 0o755 })
// ruleid: cs-fs-private-mode
mkdirSync('/x', { recursive: true })
// ruleid: cs-fs-private-mode
mkdirSync('/x', { recursive: true, mode: 0o600 })
// ruleid: cs-fs-private-mode
chmodSync('/x', 0o644)
// ruleid: cs-fs-private-mode
fs.chmodSync('/x', 0o755)
// ruleid: cs-fs-private-mode
writeFileSync('/x', 'data', { mode: 0o600, ...opts })
// ruleid: cs-fs-private-mode
writeFileSync('/x', 'data', { ...opts, mode: 0o600 })
// ruleid: cs-fs-private-mode
fs.mkdirSync('/x', { recursive: true, mode: 0o700, ...opts })
// ruleid: cs-fs-private-mode
writeFileSync('/x', 'data', { mode: 0o600, [key]: 0o666 })
// ruleid: cs-fs-private-mode
mkdirSync('/x', { recursive: true, mode: 0o700, [key]: 0o777 })
// ok: cs-fs-private-mode
writeFileSync('/x', 'data', { mode: 0o600 })
// ok: cs-fs-private-mode
writeFileSync('/x/bin/cli.mjs', 'data', { mode: 0o700 })
// ok: cs-fs-private-mode
fs.writeFileSync('/x', 'data', { mode: 0o600 })
// ok: cs-fs-private-mode
mkdirSync('/x', { recursive: true, mode: 0o700 })
// ok: cs-fs-private-mode
chmodSync('/x', 0o700)
// ok: cs-fs-private-mode
fs.chmodSync('/x', 0o600)

// ruleid: cs-json-parse-cast
const a = JSON.parse(id) as string[]
// ok: cs-json-parse-cast
const b: unknown = JSON.parse(id)
