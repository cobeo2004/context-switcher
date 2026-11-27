// Leak checker for committed fixtures (plan row 4.3). Usage: node scripts/check-fixtures.ts <dir>
// Exits 1 naming each file and decode path that holds a private string. Never prints the matched value.
// Not covered (review 2): base64, a needle split across lines, and zstd nested inside a blob or field.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { fields } from '../src/sources/protobuf.ts'

// Read at run time, never stored or printed. Matching is case-insensitive.
// ponytail: a very short username or hostname fails loud on false hits; that is the safe side.
function needles(): string[] {
  const email = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8' }).stdout
  const file = join(homedir(), '.context-switcher', 'fixture-sentinels.txt')
  const sentinels = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  return [homedir(), userInfo().username, hostname(), email, ...sentinels].map((s) => s.trim().toLowerCase()).filter((s) => s !== '')
}

const UTF8 = new TextDecoder('utf-8')
const LATIN1 = new TextDecoder('latin1')
const HEX = /^(?:[0-9a-f]{2})+$/i
const MAX_DEPTH = 32

const unJson = (s: string) =>
  s.replace(/\\(?:u([0-9a-f]{4})|(.))/gis, (_m, u: string | undefined, c: string) =>
    u === undefined ? c : String.fromCharCode(parseInt(u, 16))
  )
const unUrl = (s: string) =>
  s.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m)
    } catch {
      return m // a partial UTF-8 sequence; the other views still see the bytes
    }
  })

/** Case-insensitive, and after undoing JSON escapes (`\/`, `\u0069`) and URL encoding, repeated for nested layers. */
function hits(text: string, ns: string[]): boolean {
  let t = text
  for (let round = 0; round < 4; round++) {
    const lower = t.toLowerCase()
    if (ns.some((n) => lower.includes(n))) return true
    const next = unUrl(unJson(t))
    if (next === t) return false
    t = next
  }
  return false // ponytail: 4 layers of escaping; deeper is not a format any adapter writes
}

const tryFields = (bytes: Uint8Array) => {
  try {
    return fields(bytes)
  } catch {
    return [] // not protobuf
  }
}

/**
 * Decode paths of one byte string that hold a needle: the bytes as UTF-8 and latin1, then each protobuf len-delimited
 * field, recursively. Reports the deepest hit only, since an outer hit that a nested field explains adds nothing.
 */
function scanBytes(bytes: Uint8Array, path: string, ns: string[], pb = ''): string[] {
  const nested =
    pb.split('.').length > MAX_DEPTH
      ? []
      : tryFields(bytes).flatMap((f) => (f.wire === 2 && f.value.length > 0 ? scanBytes(f.value, path, ns, `${pb}.${f.no}`) : []))
  if (nested.length > 0) return nested
  return [UTF8.decode(bytes), LATIN1.decode(bytes)].some((t) => hits(t, ns)) ? [pb === '' ? path : `${path} pb${pb}`] : []
}

function scanValue(v: unknown, path: string, ns: string[]): string[] {
  if (v instanceof Uint8Array) return scanBytes(v, path, ns)
  if (typeof v !== 'string') return []
  const decoded = HEX.test(v) ? Uint8Array.from(v.match(/../g) ?? [], (h) => parseInt(h, 16)) : null
  return [...scanBytes(new TextEncoder().encode(v), path, ns), ...(decoded ? scanBytes(decoded, `${path} hex`, ns) : [])]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function scanDb(file: string, ns: string[]): string[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    // A table or column name that holds a needle is a leak itself, and is shown by index so it is never printed.
    const label = (name: string, kind: string, i: number) => (hits(name, ns) ? `${kind}#${i}` : name)
    return tables.flatMap((t, ti) => {
      if (!isRecord(t) || typeof t['name'] !== 'string') return []
      const name = t['name']
      const table = label(name, 'table', ti)
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      const cols = rows[0] !== undefined && isRecord(rows[0]) ? Object.keys(rows[0]) : []
      const names = [
        ...(table === name ? [] : [`${table} name`]),
        ...cols.flatMap((c, ci) => (hits(c, ns) ? [`${table} col#${ci} name`] : []))
      ]
      const cells = rows.flatMap((row, i) =>
        isRecord(row) ? Object.entries(row).flatMap(([col, v], ci) => scanValue(v, `${table}[${i}].${label(col, 'col', ci)}`, ns)) : []
      )
      return [...names, ...cells]
    })
  } finally {
    db.close()
  }
}

/** Every file is scanned raw (so SQLite free pages and -wal files count too), plus its decoded form. */
function scanFile(file: string, ns: string[]): string[] {
  const raw = readFileSync(file)
  const hits = scanBytes(raw, 'raw', ns)
  if (file.endsWith('.zst')) hits.push(...scanBytes(zstdDecompressSync(raw), 'zstd', ns))
  if (file.endsWith('store.db')) hits.push(...scanDb(file, ns))
  return hits
}

/** Prints one line per leak and returns the count. Throws only on the needles or the root, whose messages quote paths. */
function scanTree(dir: string): number {
  const ns = needles()
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  let leaks = 0
  files.forEach((e, i) => {
    const file = join(e.parentPath, e.name)
    const rel = relative(dir, file)
    const shown = hits(rel, ns) ? `file#${i}` : rel // a file name that holds a needle is shown by index
    let found: string[]
    try {
      found = [...(shown === rel ? [] : ['name']), ...scanFile(file, ns)]
    } catch {
      found = ['unreadable'] // the error message may quote source paths, so it is not printed; fail closed
    }
    for (const path of found) {
      leaks++
      console.error(`LEAK ${shown}: ${path}`)
    }
  })
  console.log(`check-fixtures: ${files.length} files, ${ns.length} needles, ${leaks} leaks`)
  return leaks
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (dir === undefined) {
    console.error('usage: node scripts/check-fixtures.ts <dir>')
    process.exitCode = 2
  } else {
    try {
      process.exitCode = scanTree(dir) > 0 ? 1 : 0
    } catch {
      console.error('check-fixtures: cannot read the needles or the fixture dir') // fixed text: Node's message quotes the path
      process.exitCode = 1
    }
  }
}
