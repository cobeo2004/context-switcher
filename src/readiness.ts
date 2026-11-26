// §0.6 readiness detector, ported from the P2 probe (fixes F3, F7, F8, F10). Pure: no host calls.

export interface ReadinessProfile {
  minDelayMs: number // never ready before t0 + minDelayMs
  quietMs: number // masked tail unchanged this long; may overlap minDelayMs
  pollMs: number
  tailLines: number
  timeoutMs: number
  landMs: number // rule L landing/submission window (F6), used by deliver
  submitKey?: string // F4: sent as its own sendText after the text, for an editor that keeps a multi-line paste
  idle: RegExp // required: the masked input-ready prompt
  busy: RegExp | null
  blockers: readonly RegExp[]
}

/** One poll: `at` is ms on the same clock as `t0`; `masked` is `mask(lines, tailLines)`. */
export interface Frame {
  at: number
  masked: string
}

/** The newest `agent.status.changed` for this terminal, including events before `t0` (F10). */
export interface StatusSeen {
  state: string
  receivedAt: number
}

export interface DetectorState {
  profile: ReadinessProfile
  t0: number
  prev: string | null // masked text of the last changed frame; null before the first poll
  lastChange: number
}

export type Verdict = { kind: 'wait' } | { kind: 'ready' } | { kind: 'timeout' } | { kind: 'blocked'; index: number }

/** Newest `tailLines` lines, trailing whitespace stripped, every letter → `a`, every digit → `0`, the rest kept. */
export function mask(lines: readonly string[], tailLines: number): string {
  // F8: drop trailing blank rows first, or a TUI drawn above a blank screen tail reads as blank.
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--
  return lines
    .slice(Math.max(0, end - tailLines), end)
    .map((l) =>
      l
        .replace(/\s+$/u, '')
        .replace(/\p{L}/gu, 'a')
        .replace(/\p{Nd}/gu, '0')
    )
    .join('\n')
}

export function initDetector(profile: ReadinessProfile, t0: number): DetectorState {
  return { profile, t0, prev: null, lastChange: t0 }
}

const WAIT: Verdict = { kind: 'wait' }

/**
 * Ready at the first poll with t ≥ t0 + minDelayMs, t ≥ lastChange + quietMs and the idle pattern matching.
 * A busy pattern or a `working` status vetoes and restarts the quiet window; statuses never make ready.
 */
export function step(s: DetectorState, frame: Frame, status: StatusSeen | null): { state: DetectorState; verdict: Verdict } {
  const p = s.profile
  const prev = s.prev ?? frame.masked // first poll: prev = frame, lastChange = t0
  const keep = (verdict: Verdict) => ({ state: { ...s, prev }, verdict })
  const reset = (next: string) => ({ state: { ...s, prev: next, lastChange: frame.at }, verdict: WAIT })
  if (frame.at - s.t0 >= p.timeoutMs) return keep({ kind: 'timeout' })
  const blocker = p.blockers.findIndex((re) => re.test(frame.masked))
  if (blocker >= 0) return keep({ kind: 'blocked', index: blocker })
  if (frame.masked.trim() === '') return reset(prev)
  if (frame.masked !== prev) return reset(frame.masked)
  if (p.busy?.test(frame.masked) === true) return reset(prev)
  if (status?.state === 'working') return reset(prev) // F10: whatever its receivedAt
  if (frame.at - s.t0 < p.minDelayMs || frame.at - s.lastChange < p.quietMs || !p.idle.test(frame.masked)) return keep(WAIT)
  return keep({ kind: 'ready' })
}

// Masked patterns recorded in P2 (results.live.md). Launch timeout = max(30 s, 2 × slowest ready 5.8 s).
const TRUST = [/^[\s│┃|]*[>❯›] 0\. /mu] // `❯ 1. Yes, proceed`, masked
const base = { minDelayMs: 1500, quietMs: 1500, pollMs: 250, tailLines: 40, timeoutMs: 30_000, landMs: 10_000, blockers: TRUST }
const RESUME_TIMEOUT_MS = 45_000 // max(45 s, 2 × slowest resume 4.3 s), for the history redraw

// ponytail: idle matches the agent's recorded frame shape, not who drew it. A custom shell prompt that draws
// ─ rules around `❯` (claude) or two rules (pi) reads as ready; no recording shows one. Rule L's not_landed resend
// covers a lost send (F9). Upgrade path: require a frame change since t0 if one is ever recorded.
export const PROFILES: Readonly<Record<string, ReadinessProfile>> = {
  claude: { ...base, idle: /^─{10,}\n❯(?:\s[^\n]*)?\n─{10,}$/mu, busy: /^\S a+… \(0+a/mu }, // F11 spinner `✻ Thinking… (3s)`
  codex: { ...base, idle: /^› [^\n]*\n {2}\? a+ a+$/mu, busy: null },
  pi: { ...base, idle: /^─{10,}\n─{10,}$/mu, busy: null, submitKey: '\r' } // F7: empty editor between two rules
}

/** `null` for an agent P2 did not record: it is not a `sendText` target. */
export function profileFor(agent: string, resume = false): ReadinessProfile | null {
  const p = Object.hasOwn(PROFILES, agent) ? PROFILES[agent] : undefined
  if (p === undefined) return null
  return resume ? { ...p, timeoutMs: RESUME_TIMEOUT_MS } : p
}
