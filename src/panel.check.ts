// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
import { defineCheck, type CheckScenario } from 'orca/testing'

type Requests = NonNullable<CheckScenario['requests']>
const req = (r: Requests): Requests => r

const claude = { terminalId: 'term_claude', agent: 'claude', sessionId: 's_1', supported: true, stateStartedAt: 1 }
const targets = [
  { agent: 'claude', label: 'Claude', resumable: true, deliverable: true },
  { agent: 'codex', label: 'Codex', resumable: true, deliverable: true },
  { agent: 'cursor', label: 'Cursor', resumable: false, deliverable: true }
]
const pkg = (omitted: number) => ({
  text: '[context-switcher handoff h_x thread t_x]\nUser asked for a refactor.',
  bytes: 60,
  mode: 'full' as const,
  selectedTurnIds: [],
  omittedTurnIds: [],
  selected: 4,
  omitted,
  coveredFromOrd: 1,
  coveredToOrd: 4,
  lossy: false,
  threadReadCommand: 'node thread-read.mjs t_x'
})
const state = (over: { remote?: boolean; sources?: (typeof claude)[] } = {}) =>
  req({
    'switch.state': {
      workspace: { id: 'ws', name: 'demo', remote: over.remote ?? false },
      sources: over.sources ?? [claude],
      defaultSource: (over.sources ?? [claude])[0]?.terminalId ?? null,
      targets
    }
  })
const preview = (omitted: number, sent?: string) =>
  req({
    'switch.preview': {
      ok: true,
      handoffId: 'h_1',
      pkg: pkg(omitted),
      sent: sent ?? pkg(omitted).text,
      strategy: 'launch',
      expiresAt: 2
    }
  })
const settled = (status: 'failed' | 'unconfirmed' | 'expired', inInput: boolean, error?: string): CheckScenario => ({
  requests: {
    ...state(),
    ...preview(0),
    ...req({ 'handoff.get': { status, inInput, strategy: 'launch', bytes: 60, chars: 60, ...(error ? { error } : {}) } })
  },
  persisted: { plugin: { 'switch.status': { handoffId: 'h_0', status, inInput, ...(error ? { error } : {}) } } }
})

export default defineCheck({
  noAgent: { requests: state({ sources: [] }) },
  oneClaude: { requests: { ...state(), ...preview(0) } },
  lossySource: {
    requests: {
      ...state(),
      ...req({
        'switch.preview': (input) =>
          input.lossy
            ? { ok: true, handoffId: 'h_2', pkg: { ...pkg(0), lossy: true }, sent: pkg(0).text, strategy: 'launch', expiresAt: 2 }
            : { ok: false, code: 'unsupported_format', message: 'This session format is not supported.', lossyAvailable: true }
      })
    }
  },
  overCap: { requests: { ...state(), ...preview(12) } },
  remote: { requests: state({ remote: true }) },
  failed: settled('failed', false, 'Codex did not become ready in time'),
  unconfirmed: settled('unconfirmed', false),
  expired: settled('expired', false),
  inInput: settled('unconfirmed', true),
  cursorPointer: {
    requests: {
      ...state(),
      ...preview(5, '[context-switcher handoff h_x thread t_x] run: node thread-read.mjs --handoff h_x --full')
    }
  }
})
