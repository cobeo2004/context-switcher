// Lint policy fixtures. Each case is linted alone (ESLint lintText at `path`) and must report exactly `expect`
// (rule ids; 'inline-config' = the noInlineConfig warning). `expect: []` is a good control: any diagnostic fails it.
const pre = `export declare function save(): Promise<void>\nexport declare const anyValue: unknown\nexport declare const maybe: { id: string } | undefined\n`
const ts = (body) => `${pre}${body}\n`
const DB = `import { DatabaseSync } from 'node:sqlite'\nconst db = new DatabaseSync('/x', { readOnly: true })`

export default [
  // Type-aware policy rules (virtual gate/*.ts files use the default project).
  { name: 'floating promise', path: 'gate/c.ts', code: ts('save()'), expect: ['@typescript-eslint/no-floating-promises'] },
  { name: 'awaited promise', path: 'gate/c.ts', code: ts('await save()'), expect: [] },
  {
    name: 'orca/testing test() is a known-safe call',
    path: 'gate/c.ts',
    code: `import { assert, test } from 'orca/testing'\ntest('t', () => { assert.ok(true) })\n`,
    expect: []
  },
  {
    name: 'as any',
    path: 'gate/c.ts',
    code: ts('export const x = String(anyValue as any)'),
    expect: ['@typescript-eslint/no-explicit-any']
  },
  { name: 'unknown narrowed', path: 'gate/c.ts', code: ts("export const x = typeof anyValue === 'string' ? anyValue : ''"), expect: [] },
  {
    name: 'non-null assertion in production',
    path: 'gate/c.ts',
    code: ts('export const id = maybe!.id'),
    expect: ['@typescript-eslint/no-non-null-assertion']
  },
  {
    name: 'non-null assertion in tests',
    path: 'src/zz.test.ts',
    code: ts('export const id = maybe!.id'),
    expect: ['@typescript-eslint/no-non-null-assertion']
  },
  {
    name: 'non-null assertion narrowed in tests',
    path: 'src/zz.test.ts',
    code: ts("import { assert } from 'node:assert/strict'\nassert.ok(maybe)\nexport const id = maybe.id"),
    expect: []
  },
  { name: 'optional chain', path: 'gate/c.ts', code: ts('export const id = maybe?.id'), expect: [] },
  { name: 'console', path: 'gate/c.ts', code: ts("console.log('x')"), expect: ['no-console'] },
  { name: '@ts-ignore', path: 'gate/c.ts', code: ts('// @ts-ignore\nexport const n = 1'), expect: ['@typescript-eslint/ban-ts-comment'] },
  {
    name: '@ts-expect-error with a reason',
    path: 'gate/c.ts',
    code: ts('// @ts-expect-error -- string is not a number here\nexport const n: number = "1"'),
    expect: []
  },
  { name: 'eqeqeq', path: 'gate/c.ts', code: ts('export const b = anyValue == null'), expect: ['eqeqeq'] },
  {
    name: 'value import of a type',
    path: 'gate/c.ts',
    code: `import { HandoffStatus } from '../src/types'\nexport const s: HandoffStatus = 'draft'\n`,
    expect: ['@typescript-eslint/consistent-type-imports']
  },
  {
    name: 'type-only import',
    path: 'gate/c.ts',
    code: `import type { HandoffStatus } from '../src/types'\nexport const s: HandoffStatus = 'draft'\n`,
    expect: []
  },
  {
    name: 'non-exhaustive switch over a union',
    path: 'gate/c.ts',
    code: `type S = 'a' | 'b' | 'c'\nexport function f(s: S): number {\n  switch (s) {\n    case 'a': return 1\n    case 'b': return 2\n    default: return 0\n  }\n}\n`,
    expect: ['@typescript-eslint/switch-exhaustiveness-check']
  },
  {
    name: 'exhaustive switch',
    path: 'gate/c.ts',
    code: `type S = 'a' | 'b'\nexport function f(s: S): number {\n  switch (s) {\n    case 'a': return 1\n    case 'b': return 2\n  }\n}\n`,
    expect: []
  },
  // D7 noInlineConfig: every inline form is inert, and the underlying error still fires.
  {
    name: 'eslint-disable with a reason',
    path: 'gate/c.ts',
    code: ts("// eslint-disable-next-line no-console -- reason\nconsole.log('x')"),
    expect: ['inline-config', 'no-console']
  },
  {
    name: 'eslint rule: off config comment',
    path: 'gate/c.ts',
    code: ts("/* eslint no-console: off -- reason */\nconsole.log('x')"),
    expect: ['inline-config', 'no-console']
  },
  {
    name: 'disable of a safety rule',
    path: 'gate/c.ts',
    code: ts('// eslint-disable-next-line @typescript-eslint/no-floating-promises -- trying to sneak past\nsave()'),
    expect: ['inline-config', '@typescript-eslint/no-floating-promises']
  },

  // E3 boundaries: path-scoped, not type-aware.
  {
    name: 'sqlite outside store',
    path: 'src/context.ts',
    code: `import { DatabaseSync } from 'node:sqlite'\nexport { DatabaseSync }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'sqlite in store',
    path: 'src/store.ts',
    code: `import { DatabaseSync } from 'node:sqlite'\nexport { DatabaseSync }\n`,
    expect: []
  },
  {
    name: 'sqlite in a test',
    path: 'src/zz.test.ts',
    code: `import { DatabaseSync } from 'node:sqlite'\nexport { DatabaseSync }\n`,
    expect: []
  },
  { name: 'dynamic import', path: 'src/context.ts', code: `export const m = import('node:sqlite')\n`, expect: ['no-restricted-syntax'] },
  {
    name: 'child_process outside proc',
    path: 'src/worker.ts',
    code: `import { execFile } from 'node:child_process'\nexport { execFile }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'bare child_process',
    path: 'src/context.ts',
    code: `import { execFile } from 'child_process'\nexport { execFile }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'exec in proc',
    path: 'src/proc.ts',
    code: `import { exec } from 'node:child_process'\nexport { exec }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'execFile in proc',
    path: 'src/proc.ts',
    code: `import { execFile } from 'node:child_process'\nexport { execFile }\n`,
    expect: []
  },
  {
    name: 'spawnSync in a test',
    path: 'src/zz.test.ts',
    code: `import { spawnSync } from 'node:child_process'\nexport { spawnSync }\n`,
    expect: []
  },
  {
    name: 'orca/worker outside worker',
    path: 'src/context.ts',
    code: `import { orca } from 'orca/worker'\nexport { orca }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'orca/worker in a test',
    path: 'src/zz.test.ts',
    code: `import { orca } from 'orca/worker'\nexport { orca }\n`,
    expect: ['no-restricted-imports']
  },
  { name: 'orca/worker in worker', path: 'src/worker.ts', code: `import { orca } from 'orca/worker'\nexport { orca }\n`, expect: [] },
  {
    name: 'orca UI outside panel',
    path: 'src/store.ts',
    code: `import { Text } from 'orca'\nexport { Text }\n`,
    expect: ['no-restricted-imports']
  },
  { name: 'orca UI in panel', path: 'src/panel.tsx', code: `import { Text } from 'orca'\nexport { Text }\n`, expect: [] },
  { name: 'orca/testing in a test', path: 'src/zz.test.ts', code: `import { test } from 'orca/testing'\nexport { test }\n`, expect: [] },
  {
    name: 'unlisted fs write API',
    path: 'src/store.ts',
    code: `import { appendFileSync } from 'node:fs'\nexport { appendFileSync }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'fs namespace import',
    path: 'src/store.ts',
    code: `import * as fs from 'node:fs'\nexport { fs }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'fs/promises',
    path: 'src/worker.ts',
    code: `import { writeFile } from 'node:fs/promises'\nexport { writeFile }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'sqlite in sessionSource (read-only foreign DBs)',
    path: 'src/sources/sessionSource.ts',
    code: `import { DatabaseSync } from 'node:sqlite'\nexport const db = new DatabaseSync('/x', { readOnly: true })\n`,
    expect: []
  },
  {
    name: 'sqlite in another source',
    path: 'src/sources/claude.ts',
    code: `import { DatabaseSync } from 'node:sqlite'\nexport { DatabaseSync }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'fs/promises read outside sessionSource',
    path: 'src/sources/claude.ts',
    code: `import { readdir } from 'node:fs/promises'\nexport { readdir }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'fs/promises allowlisted name outside sessionSource',
    path: 'src/context.ts',
    code: `import { existsSync } from 'node:fs/promises'\nexport { existsSync }\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'fs/promises reads in sessionSource',
    path: 'src/sources/sessionSource.ts',
    code: `import { open, readdir, stat } from 'node:fs/promises'\nexport class S {\n  stat(p: string) {\n    return stat(p)\n  }\n  dirs(p: string) {\n    return readdir(p, { withFileTypes: true })\n  }\n  async read(p: string) {\n    const h = await open(p, 'r')\n    await h.stat()\n  }\n}\n`,
    expect: []
  },
  // sessionSource.ts read-only call shapes (review PR4a): each evasion below once passed lint and Semgrep.
  ...[
    ['sqlite import renamed', `import { DatabaseSync as DB } from 'node:sqlite'\nexport const db = new DB('/x', { readOnly: true })`],
    [
      'sqlite constructor value alias',
      `import { DatabaseSync } from 'node:sqlite'\nconst DB = DatabaseSync\nexport const db = new DB('/x')`
    ],
    [
      'sqlite namespace import',
      `import * as sqlite from 'node:sqlite'\nexport const db = new sqlite.DatabaseSync('/x', { readOnly: true })`,
      2
    ],
    ['sqlite default import', `import sqlite from 'node:sqlite'\nexport { sqlite }`],
    ['sqlite re-export', `export { DatabaseSync } from 'node:sqlite'`, 3],
    ['sqlite export star', `export * from 'node:sqlite'`],
    ['sqlite no options', `import { DatabaseSync } from 'node:sqlite'\nexport const db = new DatabaseSync('/x')`],
    ['sqlite readOnly: false', `import { DatabaseSync } from 'node:sqlite'\nexport const db = new DatabaseSync('/x', { readOnly: false })`],
    [
      "sqlite readOnly: 'true'",
      `import { DatabaseSync } from 'node:sqlite'\nexport const db = new DatabaseSync('/x', { readOnly: 'true' })`
    ],
    [
      'sqlite options variable',
      `import { DatabaseSync } from 'node:sqlite'\nconst o = { readOnly: true }\nexport const db = new DatabaseSync('/x', o)`
    ],
    [
      'sqlite spread after',
      `import { DatabaseSync } from 'node:sqlite'\ndeclare const o: object\nexport const db = new DatabaseSync('/x', { readOnly: true, ...o })`
    ],
    [
      'sqlite spread before',
      `import { DatabaseSync } from 'node:sqlite'\ndeclare const o: object\nexport const db = new DatabaseSync('/x', { ...o, readOnly: true })`
    ],
    [
      'sqlite computed key',
      `import { DatabaseSync } from 'node:sqlite'\nconst readOnly = 'x'\nexport const db = new DatabaseSync('/x', { [readOnly]: true })`
    ],
    [
      'sqlite shorthand',
      `import { DatabaseSync } from 'node:sqlite'\nconst readOnly = false\nexport const db = new DatabaseSync('/x', { readOnly })`
    ],
    [
      'sqlite spread arguments',
      `import { DatabaseSync } from 'node:sqlite'\ndeclare const a: [string]\nexport const db = new DatabaseSync(...a)`
    ],
    ['open flag via as', `import { open } from 'node:fs/promises'\nexport const h = open('/x', 'w' as 'r')`],
    ['open flag variable', `import { open } from 'node:fs/promises'\nconst f = 'r'\nexport const h = open('/x', f)`],
    ['open flag w', `import { open } from 'node:fs/promises'\nexport const h = open('/x', 'w')`],
    ['open no flag', `import { open } from 'node:fs/promises'\nexport const h = open('/x')`],
    ['open spread arguments', `import { open } from 'node:fs/promises'\ndeclare const a: [string, 'r']\nexport const h = open(...a)`],
    ['open value alias', `import { open } from 'node:fs/promises'\nconst o = open\nexport const h = o('/x', 'w')`],
    ['open via .call', `import { open } from 'node:fs/promises'\nexport const h = open.call(null, '/x', 'w')`],
    ['open import renamed', `import { open as o } from 'node:fs/promises'\nexport const h = o('/x', 'w')`],
    ['open renamed to stat', `import { open as stat } from 'node:fs/promises'\nexport const h = stat('/x', 'w')`],
    ['readdir value alias', `import { readdir } from 'node:fs/promises'\nexport const r = readdir`],
    ['stat import renamed', `import { stat as s } from 'node:fs/promises'\nexport const r = s('/x')`],
    ['fs/promises export star', `export * from 'node:fs/promises'`, 1, ['no-restricted-imports']],
    // Capability recovery from a permitted value (review2 PR4a): each passed lint, TypeScript and Semgrep.
    ['sqlite db.constructor', `${DB}\nconst C = db.constructor as new (p: string) => unknown\nexport const w = new C('/x')`],
    ['sqlite new db.constructor', `${DB}\nexport const w = new (db.constructor as new (p: string) => unknown)('/x')`],
    ["sqlite db['constructor']", `${DB}\nexport const w = new (db['constructor'] as new (p: string) => unknown)('/x')`],
    ['sqlite db[`constructor`]', `${DB}\nexport const w = db[\`constructor\`]`],
    ['sqlite destructured constructor', `${DB}\nexport const { constructor: C } = db`],
    ['sqlite DatabaseSync.prototype', `import { DatabaseSync } from 'node:sqlite'\nexport const p = DatabaseSync.prototype`, 2],
    ['sqlite __proto__', `${DB}\nexport const p = (db as unknown as { __proto__: unknown }).__proto__`, 2],
    ['Reflect.construct', `${DB}\nexport const w = Reflect.construct(Object, [db])`],
    ['Reflect.apply', `${DB}\nexport const w = Reflect.apply(Object, null, [db])`],
    ['Object.getPrototypeOf', `${DB}\nexport const p = Object.getPrototypeOf(db)`],
    [
      'globalThis getBuiltinModule',
      `const p = globalThis as unknown as { process: { getBuiltinModule(s: string): { 'writeFileSync': (p: string) => void } } }\nexport const bad = () => p.process.getBuiltinModule('node:fs').writeFileSync('/x')`,
      5
    ],
    [
      'handle truncate via assertion',
      `import { open } from 'node:fs/promises'\nexport async function f() {\n  const h = await open('/x', 'r')\n  await (h as unknown as { truncate(n: number): Promise<void> }).truncate(0)\n}`,
      2
    ],
    [
      'handle chmod via assertion',
      `import { open } from 'node:fs/promises'\nexport async function f() {\n  const h = await open('/x', 'r')\n  await (h as unknown as { chmod(m: number): Promise<void> }).chmod(0o666)\n}`,
      2
    ]
  ].map(([name, code, n = 1, extra = []]) => ({
    name: `sessionSource: ${name}`,
    path: 'src/sources/sessionSource.ts',
    code: `${code}\n`,
    expect: [...extra, ...Array.from({ length: n }, () => 'no-restricted-syntax')]
  })),
  {
    name: 'fs/promises write in sessionSource',
    path: 'src/sources/sessionSource.ts',
    code: `import { writeFile } from 'node:fs/promises'\nexport { writeFile }\n`,
    expect: ['no-restricted-imports', ...Array.from({ length: 5 }, () => 'no-restricted-syntax')]
  },
  {
    name: 'fs/promises namespace in sessionSource',
    path: 'src/sources/sessionSource.ts',
    code: `import * as fsp from 'node:fs/promises'\nexport { fsp }\n`,
    expect: ['no-restricted-imports', 'no-restricted-syntax']
  },
  {
    name: 'sync fs write in sessionSource',
    path: 'src/sources/sessionSource.ts',
    code: `import { writeFileSync } from 'node:fs'\nexport function f(p: string) {\n  writeFileSync(p, '', { mode: 0o600 })\n}\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'listed fs calls',
    path: 'src/store.ts',
    code: `import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'\nexport function f(p: string) {\n  mkdirSync(p, { recursive: true, mode: 0o700 })\n  if (!existsSync(p)) writeFileSync(p, '', { mode: 0o600 })\n  chmodSync(p, 0o600)\n}\n`,
    expect: []
  },
  {
    name: 'mkdtempSync in a test',
    path: 'src/zz.test.ts',
    code: `import { mkdtempSync } from 'node:fs'\nexport { mkdtempSync }\n`,
    expect: []
  },
  {
    name: 'fs write function as a value',
    path: 'src/store.ts',
    code: `import { writeFileSync } from 'node:fs'\nconst wf = writeFileSync\nexport function f(p: string) {\n  wf(p, '')\n}\n`,
    expect: ['no-restricted-syntax']
  },
  {
    name: 'fs write function via .call',
    path: 'src/store.ts',
    code: `import * as fs from 'node:fs'\nexport function f(p: string) {\n  fs.mkdirSync.call(fs, p, { mode: 0o777 })\n}\n`,
    expect: ['no-restricted-imports', 'no-restricted-syntax']
  },
  {
    name: 'duplicate mode key hidden from tsc',
    path: 'src/store.ts',
    code: `import { writeFileSync } from 'node:fs'\nexport function f(p: string) {\n  // @ts-expect-error -- duplicate key on purpose here\n  writeFileSync(p, '', { mode: 0o600, mode: 0o666 })\n}\n`,
    expect: ['no-dupe-keys']
  },
  {
    name: 'fs write function .call on a named import',
    path: 'src/store.ts',
    code: `import { writeFileSync } from 'node:fs'\nexport function f(p: string) {\n  writeFileSync.call(undefined, p, '', { mode: 0o600 })\n}\n`,
    expect: ['no-restricted-syntax']
  },
  { name: '.mts file in src', path: 'src/zz.mts', code: 'export const a = 1\n', expect: ['no-restricted-syntax'] },
  { name: '.js file in src', path: 'src/zz.js', code: 'export const a = 1\n', expect: ['no-restricted-syntax'] },
  {
    name: 'production imports a test file',
    path: 'src/store.ts',
    code: `import { x } from './zz.test'\nexport const y = x\n`,
    expect: ['no-restricted-imports']
  },
  {
    name: 'renamed fs write import',
    path: 'src/store.ts',
    code: `import { writeFileSync as w } from 'node:fs'\nexport function f(p: string) {\n  w(p, '', { mode: 0o666 })\n}\n`,
    expect: ['no-restricted-syntax']
  }
]
