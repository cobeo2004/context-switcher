import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

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
      eqeqeq: 'error'
    }
  },
  { files: ['src/**/*.test.{ts,tsx}'], rules: { '@typescript-eslint/no-non-null-assertion': 'off' } },
  { files: ['**/*.d.ts'], rules: { 'no-var': 'off' } },
  { files: ['**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
  { files: ['scripts/**'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } }, rules: { 'no-console': 'off' } }
)
