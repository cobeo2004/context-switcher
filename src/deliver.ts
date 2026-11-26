// §0.6 rule L delivery, ported from the P2 probe's loop (F2, F4, F6, F9, F11). The host is injected: worker.ts adapts
// `terminal.read` / `terminal.sendText` and the clock into these callbacks.
import { initDetector, mask, profileFor, step, type ReadinessProfile, type StatusSeen, type Verdict } from './readiness'

export interface DeliverHost {
  read(terminalId: string): Promise<{ lines: readonly string[]; truncated: boolean }>
  sendText(terminalId: string, text: string, enter: boolean): Promise<{ accepted: boolean }>
  now(): number
  sleep(ms: number): Promise<void>
}

/** An `agent.status.changed` payload as the worker's fan-out keeps it, in arrival order. */
export interface StatusEvent {
  terminalId?: string | null
  state: string
  receivedAt: number
}

export type DeliverOutcome = 'submitted' | 'in_input' | 'not_landed' | 'timeout' | 'blocked' | 'refused'

const LAND_POLL_MS = 500
const CONSENT_RETRY_MS = 250
const CONSENT_RETRIES = 40 // F2: consent_required for up to ~2.5 s after agent.launch
const CONFIRM_POLL_MS = 2000
const CONFIRM_MS = 60_000

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function read(host: DeliverHost, terminalId: string, tailLines: number) {
  for (let retries = 0; ; retries++) {
    try {
      const { lines } = await host.read(terminalId)
      const raw = lines.join('\n')
      // A marker the terminal wrapped across rows is found by the join without newlines.
      return { masked: mask(lines, tailLines), has: (m: string) => raw.includes(m) || lines.join('').includes(m) }
    } catch (e) {
      if (retries >= CONSENT_RETRIES || !messageOf(e).includes('consent')) throw e
      await host.sleep(CONSENT_RETRY_MS)
    }
  }
}
type Screen = Awaited<ReturnType<typeof read>>

function newestStatus(events: readonly StatusEvent[], terminalId: string): StatusSeen | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.terminalId === terminalId) return { state: e.state, receivedAt: e.receivedAt }
  }
  return null
}
const freshWorking = (events: readonly StatusEvent[], terminalId: string, tSend: number) =>
  events.some((e) => e.terminalId === terminalId && e.state === 'working' && e.receivedAt > tSend)

interface Target {
  terminalId: string
  events: readonly StatusEvent[]
}

async function waitReady(
  host: DeliverHost,
  p: ReadinessProfile,
  o: Target,
  t0: number,
  observe?: (screen: Screen) => void
): Promise<{ kind: Exclude<Verdict['kind'], 'wait'>; screen: Screen }> {
  let s = initDetector(p, t0)
  for (;;) {
    const at = host.now()
    const screen = await read(host, o.terminalId, p.tailLines)
    observe?.(screen)
    const out = step(s, { at, masked: screen.masked }, newestStatus(o.events, o.terminalId)) // F10: any receivedAt
    s = out.state
    const { kind } = out.verdict
    if (kind !== 'wait') return { kind, screen }
    await host.sleep(p.pollMs)
  }
}

/** Rule L.1 and L.4 after one accepted send: submitted, still in the input, or never landed. */
async function land(host: DeliverHost, p: ReadinessProfile, o: Target & { marker: string }, pre: Screen, tSend: number) {
  const markerBefore = pre.has(o.marker) // F9: screen text from before readiness is never proof
  let clearBusy = p.busy?.test(pre.masked) !== true
  let landed = false
  for (;;) {
    await host.sleep(LAND_POLL_MS)
    const screen = await read(host, o.terminalId, p.tailLines)
    // Submission proof: a fresh working event, or the busy pattern after the send (F11; the ready frame had none).
    const busy = p.busy?.test(screen.masked) === true
    if (freshWorking(o.events, o.terminalId, tSend) || (clearBusy && busy)) return 'submitted'
    if (!busy) clearBusy = true
    landed ||= screen.masked !== pre.masked || (!markerBefore && screen.has(o.marker))
    if (host.now() - tSend >= p.landMs) return landed ? 'in_input' : 'not_landed' // F6: per-profile window
  }
}

/** Waits for readiness, sends once, confirms landing; at most one resend, and only when nothing changed. */
export async function deliverText(
  host: DeliverHost,
  o: Target & { text: string; marker: string; agent: string; t0: number; resume?: boolean }
): Promise<{ outcome: DeliverOutcome; sends: 0 | 1 | 2 }> {
  const p = profileFor(o.agent, o.resume === true)
  if (p === null) return { outcome: 'refused', sends: 0 }
  const first = await waitReady(host, p, o, o.t0)
  if (first.kind !== 'ready') return { outcome: first.kind, sends: 0 }
  let pre = first.screen
  for (const sends of [1, 2] as const) {
    if (!(await host.sendText(o.terminalId, o.text, true)).accepted) return { outcome: 'refused', sends }
    const tSend = host.now()
    if (p.submitKey !== undefined) {
      try {
        if (!(await host.sendText(o.terminalId, p.submitKey, false)).accepted) return { outcome: 'refused', sends }
      } catch {
        return { outcome: 'refused', sends }
      }
    }
    const outcome = await land(host, p, o, pre, tSend)
    if (outcome !== 'not_landed' || sends === 2) return { outcome, sends }
    // L.2: resend only into the same idle frame with no veto; anything else re-runs the detector.
    const now = await read(host, o.terminalId, p.tailLines)
    if (freshWorking(o.events, o.terminalId, tSend) || p.busy?.test(now.masked) === true) return { outcome: 'submitted', sends }
    if (now.masked !== pre.masked || (!pre.has(o.marker) && now.has(o.marker))) return { outcome: 'in_input', sends }
    const status = newestStatus(o.events, o.terminalId)
    const still = now.masked === pre.masked && p.idle.test(now.masked) && p.busy?.test(now.masked) !== true && status?.state !== 'working'
    if (still) continue
    // `now` matched no busy pattern (line above), so any busy frame seen while waiting is fresh (F11).
    const evidence = { changed: false, busy: false }
    const again = await waitReady(host, p, o, host.now(), (screen) => {
      evidence.changed ||= screen.masked !== pre.masked || (!pre.has(o.marker) && screen.has(o.marker))
      evidence.busy ||= p.busy?.test(screen.masked) === true
    })
    if (freshWorking(o.events, o.terminalId, tSend) || evidence.busy) return { outcome: 'submitted', sends }
    if (evidence.changed) return { outcome: 'in_input', sends }
    if (again.kind !== 'ready') return { outcome: again.kind, sends }
    pre = again.screen
  }
  return { outcome: 'not_landed', sends: 2 }
}

/** Non-adapter confirmation: the marker on screen and a fresh working (or busy frame, F11). Position is never used. */
export async function confirmOnScreen(
  host: DeliverHost,
  o: Target & { marker: string; tSend: number; agent: string }
): Promise<'delivered' | 'in_input' | 'not_seen'> {
  const p = profileFor(o.agent)
  let seen = false
  let busy = false
  let clearBusy = false
  for (;;) {
    const screen = await read(host, o.terminalId, p?.tailLines ?? 40)
    seen ||= screen.has(o.marker)
    const matchesBusy = p?.busy?.test(screen.masked) === true
    busy ||= clearBusy && matchesBusy
    if (!matchesBusy) clearBusy = true
    if (seen && (busy || freshWorking(o.events, o.terminalId, o.tSend))) return 'delivered'
    if (host.now() - o.tSend >= CONFIRM_MS) return seen ? 'in_input' : 'not_seen'
    await host.sleep(CONFIRM_POLL_MS)
  }
}
