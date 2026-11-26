import { assert, test } from 'orca/testing'
import { confirmOnScreen, deliverText, type DeliverHost, type StatusEvent } from './deliver'
import { PROFILES } from './readiness'

const RULE = '─'.repeat(30)
const IDLE = [RULE, '❯ ', RULE]
const MARKER = '[context-switcher handoff h_0123456789ab'
const TEXT = `${MARKER} t_x]\nline two, ünïcode ✓\n`
const TYPED = [RULE, `❯ ${MARKER} t_x]`, RULE]
const SPIN = ['✻ Thinking… (3s)', ...IDLE]
const LAND_MS = PROFILES['claude']?.landMs ?? 0

interface Sent {
  at: number
  text: string
  enter: boolean
}
type Screen = (t: number, sent: readonly Sent[]) => string[]
const ev = (state: string, receivedAt: number): StatusEvent => ({ terminalId: 'T', state, receivedAt })
const firstAt = (sent: readonly Sent[]) => sent[0]?.at ?? Infinity

/** A fake terminal on a fake clock: `sleep` advances time, then `events(t, sent)` is the event log so far. */
function fake(
  screen: Screen = () => IDLE,
  o: { events?: (t: number, sent: readonly Sent[]) => StatusEvent[]; accepted?: boolean; truncated?: boolean; readErrors?: Error[] } = {}
) {
  let t = 0
  const sent: Sent[] = []
  const events: StatusEvent[] = []
  const errors = [...(o.readErrors ?? [])]
  const host: DeliverHost = {
    now: () => t,
    sleep: (ms) => {
      t += ms
      events.splice(0, events.length, ...(o.events?.(t, sent) ?? []))
      return Promise.resolve()
    },
    read: () => {
      const e = errors.shift()
      return e ? Promise.reject(e) : Promise.resolve({ lines: screen(t, sent), truncated: o.truncated ?? false })
    },
    sendText: (_id, text, enter) => {
      sent.push({ at: t, text, enter })
      return Promise.resolve({ accepted: o.accepted ?? true })
    }
  }
  events.push(...(o.events?.(0, sent) ?? []))
  return { host, sent, events, now: () => t }
}
const run = (f: ReturnType<typeof fake>, agent = 'claude') =>
  deliverText(f.host, { terminalId: 'T', text: TEXT, marker: MARKER, agent, t0: 0, events: f.events })

test('replayed done ignored: no send until frames settle and the idle prompt is quiet', async () => {
  const f = fake((t, s) => (t < 3000 ? [`drawing ${'#'.repeat(t / 250)}`] : s.length ? TYPED : IDLE), { events: () => [ev('done', 60)] })
  const r = await run(f)
  assert.equal(r.outcome, 'in_input')
  assert.equal(f.sent.length, 1)
  assert.ok(firstAt(f.sent) >= 4500, `sent at ${firstAt(f.sent)}`)
})

test('busy terminal: zero sends while working for 20 s, then exactly one after quietMs of idle', async () => {
  const f = fake((t, s) => (t < 20_000 ? IDLE : s.length ? TYPED : IDLE), {
    events: (t) => [ev('working', -100), ...(t >= 20_000 ? [ev('done', 20_000)] : [])]
  })
  await run(f)
  assert.equal(f.sent.length, 1)
  assert.ok(firstAt(f.sent) >= 21_250, `sent at ${firstAt(f.sent)}`)
})

test('one send: exactly one sendText, enter:true, byte-identical text; submitted by a fresh working', async () => {
  const f = fake((_t, s) => (s.length ? TYPED : IDLE), {
    events: (t, s) => (t >= firstAt(s) + 700 ? [ev('working', firstAt(s) + 700)] : [])
  })
  const r = await run(f)
  assert.deepEqual(r, { outcome: 'submitted', sends: 1 })
  assert.deepEqual(f.sent, [{ at: 1500, text: TEXT, enter: true }])
})

test('position is not proof: marker at the top of a 30-line screen, no working → in_input', async () => {
  const tall = [`❯ ${MARKER} t_x]`, ...Array.from({ length: 28 }, (_, i) => `  line ${i}`), RULE]
  const r = await run(fake((_t, s) => (s.length ? tall : IDLE)))
  assert.deepEqual(r, { outcome: 'in_input', sends: 1 })
})

test('in input: marker permanently visible, no working, clock past landMs → in_input, sends 1', async () => {
  const f = fake((_t, s) => (s.length ? TYPED : IDLE))
  const r = await run(f)
  assert.deepEqual(r, { outcome: 'in_input', sends: 1 })
  assert.deepEqual(f.sent, [{ at: 1500, text: TEXT, enter: true }])
  assert.ok(f.now() >= firstAt(f.sent) + LAND_MS)
})

test('F11: spinner frames after the send, no event → submitted', async () => {
  const r = await run(fake((_t, s) => (s.length ? SPIN : IDLE)))
  assert.deepEqual(r, { outcome: 'submitted', sends: 1 })
})

test('late landing at resend check never sends twice', async () => {
  let reads = 0
  const f = fake((_t, s) => (s.length && ++reads >= 21 ? TYPED : IDLE))
  assert.deepEqual(await run(f), { outcome: 'in_input', sends: 1 })
  assert.equal(f.sent.length, 1)
})

test('confirmation does not treat an existing spinner as fresh', async () => {
  const f = fake(() => [MARKER, ...SPIN])
  assert.equal(await confirmOnScreen(f.host, { terminalId: 'T', marker: MARKER, tSend: 0, events: f.events, agent: 'claude' }), 'in_input')
  assert.equal(f.now(), 60_000)
})

test('pi submit key refusal or error returns refused', async () => {
  for (const throws of [false, true]) {
    const f = fake((_t, s) => (s.length ? [RULE, MARKER, RULE] : [RULE, RULE]))
    const send = f.host.sendText.bind(f.host)
    f.host.sendText = async (id, text, enter) => {
      if (text === '\r') {
        if (throws) throw new Error('refused')
        return { accepted: false }
      }
      return send(id, text, enter)
    }
    assert.deepEqual(await run(f, 'pi'), { outcome: 'refused', sends: 1 })
  }
})

test('stale event: a working before tSend and no frame change → exactly one resend', async () => {
  const f = fake((_t, s) => (s.length > 1 ? TYPED : IDLE), {
    events: (t, s) => [ev('working', 100), ev('done', 200), ...(s[1] && t >= s[1].at + 500 ? [ev('working', s[1].at + 500)] : [])]
  })
  const r = await run(f)
  assert.deepEqual(r, { outcome: 'submitted', sends: 2 })
  assert.equal(f.sent.length, 2)
})

test('not landed twice → not_landed, sends 2, never 3', async () => {
  const f = fake()
  const r = await run(f)
  assert.deepEqual(r, { outcome: 'not_landed', sends: 2 })
  assert.equal(f.sent.length, 2)
})

test('F9: a marker already on screen before readiness is not landing proof', async () => {
  const echoed = [`$ ${MARKER}`, ...IDLE]
  const f = fake(() => echoed)
  const r = await run(f)
  assert.deepEqual(r, { outcome: 'not_landed', sends: 2 })
})

test('errors: accepted:false → refused, no resend; timeout and blocked → sends 0; no profile → refused', async () => {
  const no = fake(() => IDLE, { accepted: false })
  assert.deepEqual(await run(no), { outcome: 'refused', sends: 1 })
  assert.equal(no.sent.length, 1)
  assert.deepEqual(await run(fake(() => [''])), { outcome: 'timeout', sends: 0 })
  const trust = fake(() => ['│ ❯ 1. Yes, proceed', '│   2. No, exit'])
  assert.deepEqual(await run(trust), { outcome: 'blocked', sends: 0 })
  const none = fake()
  assert.deepEqual(await run(none, 'opencode'), { outcome: 'refused', sends: 0 })
  assert.equal(none.sent.length + none.now(), 0)
})

test('F4: pi gets a separate "\\r" sendText after the text', async () => {
  const PI = [RULE, RULE]
  const f = fake((_t, s) => (s.length ? [RULE, MARKER, RULE] : PI), {
    events: (t, s) => (t > firstAt(s) ? [ev('working', firstAt(s) + 1)] : [])
  })
  const r = await run(f, 'pi')
  assert.deepEqual(r, { outcome: 'submitted', sends: 1 })
  assert.deepEqual(
    f.sent.map((s) => [s.text, s.enter]),
    [
      [TEXT, true],
      ['\r', false]
    ]
  )
})

test('F2: terminal.read retries consent errors (≤ 40), other errors throw', async () => {
  const consent = () => new Error('consent_required: plugin is not enabled with current consent')
  const ok = fake(() => [''], { readErrors: Array.from({ length: 40 }, consent) })
  assert.deepEqual(await run(ok), { outcome: 'timeout', sends: 0 })
  await assert.rejects(run(fake(() => [''], { readErrors: Array.from({ length: 41 }, consent) })), /consent/)
  await assert.rejects(run(fake(() => [''], { readErrors: [new Error('terminal not found')] })), /not found/)
})

const confirm = (f: ReturnType<typeof fake>, agent = 'codex') =>
  confirmOnScreen(f.host, { terminalId: 'T', marker: MARKER, tSend: 0, events: f.events, agent })

test('confirmOnScreen: marker + fresh working on the 4th poll → delivered', async () => {
  const f = fake((t) => (t >= 6000 ? TYPED : IDLE), { events: (t) => (t >= 6000 ? [ev('working', 5000)] : []) })
  assert.equal(await confirm(f), 'delivered')
  assert.equal(f.now(), 6000)
})

test('confirmOnScreen: marker at the top of a full screen or permanently in the input, no working → in_input at 60 s', async () => {
  const top = fake(() => [MARKER, ...Array.from({ length: 39 }, () => 'text')])
  assert.equal(await confirm(top), 'in_input')
  const stuck = fake(() => TYPED, { events: () => [ev('working', -1)] })
  assert.equal(await confirm(stuck), 'in_input')
  assert.equal(stuck.now(), 60_000)
})

test('confirmOnScreen: never → not_seen at 60 s; truncated and wrapped reads still searched; F11 spinner → delivered', async () => {
  const never = fake()
  assert.equal(await confirm(never), 'not_seen')
  assert.equal(never.now(), 60_000)
  assert.equal(await confirm(fake(() => TYPED, { truncated: true, events: () => [ev('working', 1)] })), 'delivered')
  const wrapped = [MARKER.slice(0, 20), MARKER.slice(20)] // the terminal wrapped the marker across two rows
  assert.equal(await confirm(fake(() => wrapped, { events: () => [ev('working', 1)] })), 'delivered')
  assert.equal(
    await confirm(
      fake((t) => (t >= 2000 ? [MARKER, ...SPIN] : TYPED)),
      'claude'
    ),
    'delivered'
  )
})

test('resend wait: a fresh spinner while waiting for readiness is submission proof (F11), never in_input', async () => {
  // Idle through the landing window; a replayed old `working` vetoes the resend; the spinner then shows and clears.
  const spinFrom = LAND_MS + 2000
  const f = fake((t) => (t >= spinFrom && t < spinFrom + 1500 ? SPIN : IDLE), {
    events: (t, s) => (s.length > 0 && t >= LAND_MS + 1500 ? [t >= spinFrom + 1500 ? ev('done', spinFrom + 1500) : ev('working', 100)] : [])
  })
  const r = await run(f)
  assert.deepEqual(r, { outcome: 'submitted', sends: 1 })
  assert.equal(f.sent.length, 1)
})
