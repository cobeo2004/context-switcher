---
summary: Orca 1.4.272 plugin host limits that shape hand-off delivery: 4096-char text cap, lost launch prompts, resume readiness
paths: src/worker.ts, orca-plugin.json
updated: 217a803
---

# Orca plugin host limits (measured 2026-11-26, Orca 1.4.272)

What the plugin API allows is narrower than the `orca` CLI. Evidence: `.sstack/runs/context-switcher-20261125-2223/probe/results.md` (git-ignored run folder).

## Text cap: 4096 characters
- `agent.launch.prompt`, `terminal.sendText.text` and `terminal.create.command` are capped at 4096 characters by the host schema (`PLUGIN_HOST_TEXT_MAX_LENGTH`, in Orca's `out/shared/plugins/workers/plugin-host-api-workspace-methods.js`). 4097 → `invalid_params`.
- The `orca agent launch --prompt` CLI has no such cap (33 KB arrived intact), so CLI tests do not predict plugin behaviour.

## Launch prompts are dropped
- `agent.launch({prompt})` returns a terminal at once, but the prompt is sent before the agent CLI is running and is discarded: `orca plugin logs <key>` shows `the prompt did not reach <term>: agent_launch_terminal_not_running_agent`. Seen for claude, codex, pi, cursor, antigravity.
- What works: launch with no prompt, wait until the TUI is idle, then `terminal.sendText` (≤ 4096): delivered to claude, codex, pi, antigravity. **Not cursor**: typed text never reaches `cursor-agent`'s input.

## Resume readiness
- `agent.resume` emits a `done` status event within ~60–200 ms that replays the session's last state; it does not mean the TUI is ready. A `sendText` at that moment is lost.
- Resuming a session that already runs in an Orca terminal returned `started:true` and a new terminal.

## Other facts
- The worker runs Electron's Node (v24.22.1) with `node:sqlite`; `process.execPath` is `Orca Helper.app`, so the CLI lives at `/Applications/Orca.app/Contents/Resources/bin/orca` (not relative to execPath). `orca plugin open <key> --panel <id>` from the worker works with that path.
- Background work started by a request keeps running after the 30 s invoke limit.
- `agents.list` has `sessionId: null` until an agent finishes a turn; `agent.status.changed` events carry it from the first `working`.

Related: [context-store](context-store.md).
