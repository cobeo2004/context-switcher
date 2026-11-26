import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// E3: one owner per capability. A later block for the same files replaces the rule, so each owner lists the bans it keeps.
const BANS = {
  sqlite: {
    name: 'node:sqlite',
    message: 'Only src/store.ts (our DB) and src/sources/sessionSource.ts (foreign DBs, read-only) open SQLite (E3). Add a method there.'
  },
  childProcess: { name: 'node:child_process', message: 'Only src/proc.ts runs processes, with execFile (E3).' },
  hostWorker: { name: 'orca/worker', message: 'Only src/worker.ts talks to the Orca host (E3). Pass plain values or callbacks in.' },
  hostUi: { name: 'orca', message: 'Orca UI/host imports belong in the panel (src/panel*.tsx) (E3).' }
}
// Production fs is an allowlist: writes go through the three calls Semgrep cs-fs-private-mode checks. Add a name here (reviewed) when a reader needs it.
const FS_ALLOW = {
  regex: '^node:fs$',
  importNamePattern: '^(?!(chmodSync|existsSync|mkdirSync|readdirSync|readFileSync|statSync|writeFileSync)$)',
  message: 'fs call outside the allowlist in eslint.config.mjs (E3, cs-fs-private-mode).'
}
const FS_WRITE = '/^(writeFileSync|mkdirSync|chmodSync)$/'
const LEGACY = [{ group: ['child_process', 'fs', 'fs/*'], message: 'Use the node: prefix; the boundary rules match node:* names.' }]
const NO_TEST_IMPORTS = { group: ['**/*.test', '**/*.test.*'], message: 'Production code may not import test files.' }
// Async fs reads have one owner, which may only read: no node:fs at all, and node:fs/promises open/readdir/stat
// (node.d.ts types `open` as 'r' only, with a handle that cannot write).
const FS_PROMISES = { regex: '^node:fs/promises$', message: 'Only src/sources/sessionSource.ts reads files with node:fs/promises (E3).' }
const SOURCE_FS = [
  { regex: '^node:fs$', message: 'src/sources/sessionSource.ts reads through node:fs/promises only (E3).' },
  {
    regex: '^node:fs/promises$',
    importNamePattern: '^(?!(open|readdir|stat)$)',
    message: 'src/sources/sessionSource.ts may only open (read), readdir and stat (E3).'
  }
]
const SYNTAX = [
  { selector: 'ImportExpression', message: 'No dynamic import() (E3 boundaries check static imports).' },
  // cs-fs-private-mode (Semgrep) checks calls only, so the write functions may not escape as values.
  {
    selector: `Identifier[name=${FS_WRITE}]:not(CallExpression > .callee, ImportSpecifier > .imported, ImportSpecifier > .local, MemberExpression > .property, TSDeclareFunction > .id)`,
    message:
      'Call writeFileSync/mkdirSync/chmodSync directly (no aliases, .call/.bind or re-exports), so cs-fs-private-mode can check the mode.'
  },
  ...['writeFileSync', 'mkdirSync', 'chmodSync'].map((name) => ({
    selector: `ImportSpecifier[imported.name="${name}"]:not([local.name="${name}"])`,
    message: `Import ${name} under its own name, so cs-fs-private-mode (Semgrep) can see the calls.`
  })),
  {
    selector: `MemberExpression[property.name=${FS_WRITE}]:not(CallExpression > .callee)`,
    message:
      'Call writeFileSync/mkdirSync/chmodSync directly (no aliases, .call/.bind or re-exports), so cs-fs-private-mode can check the mode.'
  }
]
// ponytail: lint enforces the obvious shapes below; a deliberate evasion (string concatenation, eval-like tricks) is
// out of scope, as for cs-fs-private-mode. The boundary a reviewer checks is the literal read-only open in this file.
// sessionSource.ts is read-only by call shape, not by name: imports keep their own names, the three capabilities are
// only ever called (never aliased or re-exported), DatabaseSync gets exactly a literal { readOnly: true } and open
// exactly the literal 'r', so the OS refuses writes on the handle.
const SAME_NAME = (names) => names.map((n) => `[imported.name="${n}"][local.name="${n}"]`).join(', ')
const SOURCE_SYNTAX = [
  ...SYNTAX,
  {
    selector: `ImportDeclaration[source.value="node:sqlite"] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier, ImportSpecifier:not(${SAME_NAME(['DatabaseSync'])}))`,
    message: "Import only { DatabaseSync } from 'node:sqlite', under its own name (E3 read-only)."
  },
  {
    selector: `ImportDeclaration[source.value="node:fs/promises"] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier, ImportSpecifier:not(${SAME_NAME(['open', 'readdir', 'stat'])}))`,
    message: "Import open/readdir/stat from 'node:fs/promises' under their own names (E3 read-only)."
  },
  {
    selector: ':matches(ExportNamedDeclaration, ExportAllDeclaration)[source.value=/^node:(sqlite|fs\\/promises)$/]',
    message: 'Do not re-export node:sqlite or node:fs/promises (E3 read-only).'
  },
  {
    selector: 'Identifier[name="DatabaseSync"]:not(NewExpression > .callee, ImportSpecifier > .imported, ImportSpecifier > .local)',
    message: 'Use DatabaseSync only as `new DatabaseSync(path, { readOnly: true })` (no aliases or re-exports).'
  },
  {
    selector:
      'NewExpression[callee.name="DatabaseSync"]:not([arguments.length=2][arguments.1.type="ObjectExpression"][arguments.1.properties.length=1][arguments.1.properties.0.type="Property"][arguments.1.properties.0.computed=false][arguments.1.properties.0.shorthand=false][arguments.1.properties.0.kind="init"][arguments.1.properties.0.key.name="readOnly"][arguments.1.properties.0.value.raw="true"])',
    message: 'Open foreign SQLite as `new DatabaseSync(path, { readOnly: true })`, literally (E3).'
  },
  {
    selector:
      'Identifier[name=/^(open|readdir|stat)$/]:not(CallExpression > .callee, ImportSpecifier > .imported, ImportSpecifier > .local, MemberExpression[computed=false] > .property, MethodDefinition[computed=false] > .key)',
    message: 'Call open/readdir/stat directly (no aliases, .call/.bind or re-exports), so the open flag stays checkable.'
  },
  // A permitted value must not hand back an unrestricted capability: db.constructor is a writable DatabaseSync, and
  // globalThis.process.getBuiltinModule('node:fs') or a handle's truncate/chmod (via `as`) skip the import rules.
  ...[
    [
      'constructor|prototype|__proto__|Reflect|getPrototypeOf|setPrototypeOf',
      'No .constructor/.prototype/Reflect/getPrototypeOf in sessionSource.ts: they recover a writable DatabaseSync from the read-only one (E3 read-only boundary).'
    ],
    [
      'globalThis|global|process|require|getBuiltinModule|truncate|chmod|chown|utimes|write|writev|writeFile|appendFile',
      'No globals or handle writes in sessionSource.ts: reads go only through the imported open/readdir/stat and the read-only DatabaseSync (E3 read-only boundary).'
    ]
  ].map(([names, message]) => ({
    selector: `:matches(Identifier[name=/^(${names})$/], Literal[value=/^(${names})$/], TemplateElement[value.cooked=/^(${names})$/])`,
    message
  })),
  {
    selector: `CallExpression[callee.name="open"]:not([arguments.length=2][arguments.1.type="Literal"][arguments.1.value="r"])`,
    message: "Call open(path, 'r') with the literal flag 'r' (no variable, `as` or spread): the OS then refuses writes."
  }
]
const restrictFs = (fs, keys, extra) => [
  'error',
  { paths: [...keys.map((k) => BANS[k]), ...extra], patterns: [...LEGACY, ...fs, NO_TEST_IMPORTS] }
]
const restrict = (keys, ...extra) => restrictFs([FS_ALLOW, FS_PROMISES], keys, extra)

export default defineConfig(
  { ignores: ['.orca/**', '.sstack/**', '.omc/**', 'node_modules/**', '.stryker-tmp/**', 'reports/**', 'semgrep/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['gate/*.ts'], defaultProject: 'tsconfig.json' },
        tsconfigRootDir: import.meta.dirname
      }
    },
    // D7: no inline eslint comments of any form; an exception lives in this protected file.
    linterOptions: { noInlineConfig: true, reportUnusedInlineConfigs: 'off' },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true }
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-explicit-any': ['error', { fixToUnknown: false, ignoreRestArgs: false }],
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'orca/testing', name: 'test' }] }
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true, minimumDescriptionLength: 10 }
      ],
      'no-console': 'error',
      eqeqeq: 'error',
      'no-dupe-keys': 'error' // typescript-eslint turns it off; a @ts-expect-error could hide TS1117
    }
  },
  {
    files: ['src/**/*.{ts,tsx}', 'gate/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(['sqlite', 'childProcess', 'hostWorker', 'hostUi']),
      'no-restricted-syntax': ['error', ...SYNTAX]
    }
  },
  { files: ['src/store.ts'], rules: { 'no-restricted-imports': restrict(['childProcess', 'hostWorker', 'hostUi']) } },
  {
    files: ['src/sources/sessionSource.ts'],
    rules: {
      'no-restricted-imports': restrictFs(SOURCE_FS, ['childProcess', 'hostWorker', 'hostUi'], []),
      'no-restricted-syntax': ['error', ...SOURCE_SYNTAX]
    }
  },
  { files: ['src/worker.ts'], rules: { 'no-restricted-imports': restrict(['sqlite', 'childProcess', 'hostUi']) } },
  {
    files: ['src/panel*.tsx', 'src/panel.check.ts'],
    rules: { 'no-restricted-imports': restrict(['sqlite', 'childProcess', 'hostWorker']) }
  },
  {
    files: ['src/proc.ts'],
    rules: {
      'no-restricted-imports': restrict(['sqlite', 'hostWorker', 'hostUi'], {
        name: 'node:child_process',
        allowImportNames: ['execFile'],
        message: 'execFile only (argument array, no shell).'
      })
    }
  },
  // Tests may open a DB (store.migration.test.ts builds a v1 DB), spawn the thread-read CLI and make temp dirs; they still cannot reach the host.
  { files: ['src/**/*.test.{ts,tsx}'], rules: { 'no-restricted-imports': ['error', { paths: [BANS.hostWorker] }] } },
  // The E3 blocks and Semgrep cover .ts/.tsx only, so no other script type may live in src/.
  {
    files: ['src/**/*.{mts,cts,js,mjs,cjs,jsx}'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'Program', message: 'src/ holds only .ts and .tsx files (E3 and Semgrep check those).' }
      ]
    }
  },
  { files: ['**/*.d.ts'], rules: { 'no-var': 'off' } },
  { files: ['**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
  { files: ['scripts/**'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } }, rules: { 'no-console': 'off' } }
)
