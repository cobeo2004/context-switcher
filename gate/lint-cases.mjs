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
  }
]
