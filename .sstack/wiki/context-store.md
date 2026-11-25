---
summary: Why the hand-off delta uses per-hand-off coverage, not an ord watermark; store file locations and modes
paths: src/store.ts, src/context.ts, src/cliSource.ts, src/types.ts
updated: 217a803
---

# Context store

The SQLite store lives at `~/.context-switcher/context.sqlite` (dir 0700, DB and WAL/SHM 0600), with the `thread-read` CLI written to `~/.context-switcher/bin/thread-read.mjs`. Tests override the path; never run `orca plugin check .` or `test` against the real HOME — use `HOME=$(mktemp -d)`, as `.sstack/project.toml` does.

## Delta = coverage, not watermark
- `ord` is assigned at **ingest** time, so turns from different agents interleave in ingest order. A watermark like "turns with `ord` > the target session's highest `ord`" loses a turn another agent wrote while the target was also active (reproduced: A:2 ingested between B:1 and B:2 never reaches B).
- So each hand-off records exactly which turns it carried (`handoff_turns`). The delta for target session S is every active conversation turn not authored by S and not carried by a *delivered* hand-off to S (`eligibleTurns` in `src/store.ts`). Turns from failed / unconfirmed hand-offs, and omitted turns, stay eligible.

## Package bounds
- The hand-off package is a digest of at most `min(budgetChars, 4096)` characters, counted with `String.length` (UTF-16 code units, the unit Orca's host checks); `bytes` still records the UTF-8 size. A budget smaller than the header + footer throws `RangeError`. Why 4096: [orca-plugin-host-limits](orca-plugin-host-limits.md).
- `selectTurns` keeps whole turns only. The one exception is rule E in `planDigest`: an oversized **last user turn** is carried as a marked head + tail excerpt, and its id stays in `omittedTurnIds` so `thread-read --handoff <id>` prints it whole.
- Lossy screen captures (one captured turn, nothing stored) keep their newest whole lines; when not even one line fits, the capture is dropped and the footer still counts the omitted lines honestly.

## Native ids
- Never use content-addressed ids (Cursor blob sha256) as `native_id`: identical messages would collapse. Use position (DAG parent + index), Pi `entryId#index`.
