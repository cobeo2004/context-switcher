# Context Switcher

An Orca plugin that hands a conversation from one coding agent to another (Claude, Codex, Pi, Cursor, and others through a lossy screen capture), carrying the context forward the way T3 Code does.

v0.1.0 is being built in five PRs. This one (PR1) ships the core:

- `src/types.ts`: the canonical turn model, rows, and constants (4096-character hard cap, marker format).
- `src/store.ts`: the SQLite store at `~/.context-switcher/context.sqlite` (`node:sqlite`, WAL, `PRAGMA user_version` migrations, dir `0700`, DB `0600`). Threads, sessions, turns, hand-offs. A session joins another thread only through a bound hand-off marker. The delta for a target is everything not yet delivered to it (coverage, no watermark).
- `src/context.ts`: `buildContext` selects whole turns in T3 order (last user, last assistant, first user, then newest back) under the character budget (at most 4096, Orca's plugin limit) and renders the package. An oversized last user turn is carried as a head + tail excerpt; any other turn that does not fit is skipped whole. The footer names `thread-read --handoff <id>` for the omitted turns.
- `src/cliSource.ts`: the `thread-read` CLI. The worker installs it at `~/.context-switcher/bin/thread-read.mjs`:
  `node ~/.context-switcher/bin/thread-read.mjs <threadId> [--after <n>] [--limit <n>]` (exit 2: unknown thread, 64: bad args; `CONTEXT_SWITCHER_DB` overrides the DB path).
- `src/worker.ts`: opens the store, prunes threads idle longer than `retentionDays`, sweeps stale hand-offs every 60 s, installs the CLI, answers `diag`.
- `src/panel.tsx`: a placeholder panel until the switch flow lands.

**Settings note.** The hand-off budget setting is `budgetChars` (integer, default 4096, min 1024, max 4096). It replaces `budgetBytes` outright: nothing read `budgetBytes` and the plugin is unreleased, so a stored `budgetBytes` value is ignored.

Nothing stores tool output, file contents or reasoning.

## Develop

```sh
npm ci              # dev tools only; the plugin itself has no runtime dependencies
npm run verify      # CI's verify job plus the security scans; mutation and CodeQL are separate (see AGENTS.md)
orca plugin dev watch .
```
