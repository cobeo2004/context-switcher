# Agents: how this repo's gate works

Every rule below is checked by a machine. This file says why, and where each check lives. Don't restate rules elsewhere.

## Run

- `npm ci` once, then `npm run verify`. It is CI's `verify` job plus the zizmor, gitleaks and OSV scans, with the same
  pinned commands (`scripts/scan.sh`). Set `GH_TOKEN=$(gh auth token)` to include zizmor's online audits.
- CodeQL and dependency review run only on GitHub.
- Touching `src/` or a test? Run `npm run mutation` before the PR (about 7 min locally, 16 on CI). CI runs it as the
  required `mutation` check whenever `src/`, a test or the tooling changes, and fails below `thresholds.break` (94).
  It leaves out `src/threadRead.handoff.test.ts`, which spawns the CLI and kills no mutant the other tests miss (score
  identical with and without it). If store behaviour ever gets its only assertion there, drop that `ignorePatterns` entry.
- A failing property prints a seed. Replay: `FC_SEED=<seed> FC_SHRINK=1 HOME=$(mktemp -d) orca plugin test .`

## Where each rule lives

| forbidden                                                                                                                                                                                                                                                                                                                                       | enforced by                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `any`, `!` (non-null assertion, tests included), floating promises, `@ts-ignore`, `==`, console (allowed in `scripts/`)                                                                                                                                                                                                                         | ESLint (`eslint.config.mjs`)                                             |
| any inline `eslint-disable` / `/* eslint … */` comment                                                                                                                                                                                                                                                                                          | ESLint `noInlineConfig`: exceptions go in the config, which needs review |
| In production (tests may use `node:sqlite`, `node:child_process` and fs; `orca/worker` and dynamic `import()` stay banned there too): `node:sqlite` outside `store.ts`; `node:child_process` outside `proc.ts` (execFile only); `orca/worker` outside `worker.ts`; `orca` outside the panel; fs calls outside the allowlist; dynamic `import()` | ESLint `no-restricted-imports` / `no-restricted-syntax`                  |
| shell exec, `JSON.parse(…) as T`; in production also SQL built from strings and fs writes without a literal private mode (tests: `semgrep/test-sql.yml`)                                                                                                                                                                                        | Semgrep (`semgrep/`); `nosemgrep` is ignored                             |
| unchecked index access, loose optional props, unused code paths                                                                                                                                                                                                                                                                                 | `tsconfig.json` flags                                                    |
| dead files, exports, dependencies; new `@public` tags                                                                                                                                                                                                                                                                                           | knip; `gate/public-exports.txt`                                          |
| unformatted code                                                                                                                                                                                                                                                                                                                                | Prettier                                                                 |
| weaker tests                                                                                                                                                                                                                                                                                                                                    | Stryker mutation score; property tests are protected                     |

The ESLint and Semgrep rules carry fixtures (`gate/lint-cases.mjs`, `semgrep/*.ts`) that `verify` runs, bad and good.

## Don'ts the tools can't see

- Never `npm install` without `.npmrc` (`bin-links=false`): `.bin` symlinks break `orca plugin inspect`.
- Never `orca plugin inspect .` or install from a working tree with `node_modules` (over the 2000-entry limit).
  Releases come from git HEAD (`npm run orca:release`).
- `src/cliSource.ts` is the second, read-only DB reader by design; its `node:sqlite` import is inside a string.
- The gate configs, `orca-plugin.json`, `src/node.d.ts`, the property tests and the mutation-gap tests are protected (`.sstack/project.toml`): changing them needs a human.
