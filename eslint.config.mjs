import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// E3: one owner per capability. A later block for the same files replaces the rule, so each owner lists the bans it keeps.
const BANS = {
  sqlite: { name: 'node:sqlite', message: 'Only src/store.ts opens the database (E3). Add a store method instead.' },
  childProcess: { name: 'node:child_process', message: 'Only src/proc.ts runs processes, with execFile (E3).' },
  hostWorker: { name: 'orca/worker', message: 'Only src/worker.ts talks to the Orca host (E3). Pass plain values or callbacks in.' },
  hostUi: { name: 'orca', message: 'Orca UI/host imports belong in the panel (src/panel*.tsx) (E3).' }
}
// Production fs is an allowlist: writes go through the three calls Semgrep cs-fs-private-mode checks. Add a name here (reviewed) when a reader needs it.
const FS_ALLOW = {
  group: ['node:fs'],
  importNamePattern: '^(?!(chmodSync|existsSync|mkdirSync|readdirSync|readFileSync|statSync|writeFileSync)$)',
  message: 'fs call outside the allowlist in eslint.config.mjs (E3, cs-fs-private-mode).'
}
const FS_WRITE = '/^(writeFileSync|mkdirSync|chmodSync)$/'
const LEGACY = [{ group: ['child_process', 'fs', 'fs/*'], message: 'Use the node: prefix; the boundary rules match node:* names.' }]
const NO_TEST_IMPORTS = { group: ['**/*.test', '**/*.test.*'], message: 'Production code may not import test files.' }
const restrict = (keys, ...extra) => [
  'error',
  { paths: [...keys.map((k) => BANS[k]), ...extra], patterns: [...LEGACY, FS_ALLOW, NO_TEST_IMPORTS] }
]

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
      'no-restricted-syntax': [
        'error',
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
    }
  },
  { files: ['src/store.ts'], rules: { 'no-restricted-imports': restrict(['childProcess', 'hostWorker', 'hostUi']) } },
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
