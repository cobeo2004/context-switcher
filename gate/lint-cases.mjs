// Lint policy fixtures. Each case is linted alone (ESLint lintText at `path`) and must report exactly `expect`
// (rule ids; 'inline-config' = the noInlineConfig warning). `expect: []` is a good control: any diagnostic fails it.
const pre = `export declare function save(): Promise<void>\nexport declare const anyValue: unknown\nexport declare const maybe: { id: string } | undefined\n`
const ts = (body) => `${pre}${body}\n`

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
