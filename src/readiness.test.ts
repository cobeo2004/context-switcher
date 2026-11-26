import { assert, test } from 'orca/testing'
import { open } from 'node:fs/promises'
import { PROFILES, initDetector, mask, profileFor, step, type ReadinessProfile, type StatusSeen, type Verdict } from './readiness'

const IDLE = '│ ❯                    │'
const profile = (o: Partial<ReadinessProfile> = {}): ReadinessProfile => ({
  minDelayMs: 1500,
  quietMs: 1500,
  pollMs: 250,
  tailLines: 40,
  timeoutMs: 30_000,
  landMs: 10_000,
  idle: /^│ ❯ +│$/mu,
  busy: null,
  blockers: [/^[\s│]*❯ 0\. /mu],
  ...o
})

/** Replays screens (raw lines per poll every 250 ms from t0 = 0); returns the first non-wait verdict and its time. */
function replay(
  p: ReadinessProfile,
  screen: (at: number) => string[],
  status: (at: number) => StatusSeen | null = () => null
): { at: number; verdict: Verdict } {
  let s = initDetector(p, 0)
  for (let at = 0; at <= p.timeoutMs; at += 250) {
    const out = step(s, { at, masked: mask(screen(at), p.tailLines) }, status(at))
    s = out.state
    if (out.verdict.kind !== 'wait') return { at, verdict: out.verdict }
  }
  return { at: -1, verdict: { kind: 'wait' } }
}

type Entry = { at: number; masked: string } | { at: number; status: string }
const isEntry = (e: unknown): e is Entry =>
  typeof e === 'object' &&
  e !== null &&
  'at' in e &&
  typeof e.at === 'number' &&
  (('masked' in e && typeof e.masked === 'string') || ('status' in e && typeof e.status === 'string'))

// ponytail: path is relative to the plugin root, where `orca plugin test .` runs; node.d.ts has no readFileSync or import.meta.url.
async function load(name: string): Promise<[string, Entry[]]> {
  const f = await open(`src/readiness.frames/${name}.json`, 'r')
  try {
    const buf = new Uint8Array((await f.stat()).size)
    await f.read(buf, 0, buf.length, 0)
    const raw: unknown = JSON.parse(new TextDecoder().decode(buf))
    if (!Array.isArray(raw) || !raw.every(isEntry)) throw new Error(`bad recording ${name}`)
    return [name, raw]
  } finally {
    await f.close()
  }
}
const NAMES = ['claude-a', 'codex-a', 'pi-a', 'antigravity-a', 'claude-b', 'codex-b', 'pi-fR', 'claude-i2-run1', 'claude-i2']
const RECORDINGS = new Map(await Promise.all(NAMES.map(load)))

/** Replays a P2 recording (times are ms from t0 = 0). `step` gets the newest status so far, including events before t0 (F10). */
function replayRecorded(p: ReadinessProfile, name: string): { at: number; kind: Verdict['kind'] }[] {
  let s = initDetector(p, 0)
  let status: StatusSeen | null = null
  const verdicts: { at: number; kind: Verdict['kind'] }[] = []
  for (const e of must(RECORDINGS.get(name))) {
    if ('status' in e) status = { state: e.status, receivedAt: e.at }
    else {
      const out = step(s, e, status)
      s = out.state
      verdicts.push({ at: e.at, kind: out.verdict.kind })
    }
  }
  return verdicts
}

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing')
  return v
}

/** The first non-wait verdict is `ready`, within one poll of the time P2 recorded. */
function assertReadyAt(p: ReadinessProfile, name: string, recordedMs: number) {
  const first = must(replayRecorded(p, name).find((v) => v.kind !== 'wait'))
  assert.equal(first.kind, 'ready', name)
  assert.ok(Math.abs(first.at - recordedMs) <= p.pollMs, `${name}: ready at ${String(first.at)}, recorded ${String(recordedMs)}`)
}

test('mask: newest tailLines, trailing space stripped, letters → a, digits → 0, the rest kept', () => {
  assert.equal(mask(['old line', 'Hello World 42   ', '│ ❯ é9 │'], 2), 'aaaaa aaaaa 00\n│ ❯ a0 │')
  assert.equal(mask(['Working 12s'], 40), mask(['Working 13s'], 40))
  assert.equal(mask(['x', 'Ready ❯', '', '   ', ''], 1), 'aaaaa ❯') // F8: trailing blank rows dropped before the tail
  assert.equal(mask(['', '  '], 40), '')
})

test('launch: P2 claude-a and codex-a → ready at the recorded time ±1 poll', () => {
  assertReadyAt(must(profileFor('claude')), 'claude-a', 4025)
  assertReadyAt(must(profileFor('codex')), 'codex-a', 3816)
})

test('antigravity startup is not a recorded idle screen', () => {
  assert.equal(profileFor('antigravity'), null)
  for (const p of Object.values(PROFILES)) {
    assert.ok(replayRecorded(p, 'antigravity-a').every((v) => v.kind !== 'ready'))
  }
})

test('launch: pi-a was ready on the shell prompt; the F7 pi profile waits; pi-fR (pi drawn) → ready at 1550', () => {
  const pi = must(profileFor('pi'))
  assert.ok(replayRecorded(pi, 'pi-a').every((v) => v.kind === 'wait'))
  assertReadyAt(pi, 'pi-fR', 1550)
})

test('stable shell prompts time out for every agent', () => {
  for (const agent of ['claude', 'codex', 'pi']) {
    const p = must(profileFor(agent))
    for (const prompt of ['❯ claude', '❯ codex', '❯ agy', '~/a/b on main ❯', '%', '$']) {
      assert.deepEqual(
        replay(p, () => [prompt]),
        { at: p.timeoutMs, verdict: { kind: 'timeout' } },
        `${agent}: ${prompt}`
      )
    }
  }
})

test('known ceiling: a shell prompt drawing the agent’s ─ rules reads as ready (pinned, see PROFILES)', () => {
  const rule = '─'.repeat(60)
  for (const [agent, lines] of [
    ['claude', [rule, '❯ claude', rule]],
    ['pi', [rule, rule, '❯ pi']]
  ] as const) {
    const p = must(profileFor(agent))
    assert.deepEqual(
      replay(p, () => [...lines]),
      { at: 1500, verdict: { kind: 'ready' } },
      agent
    )
  }
})

test('resume: P2 claude-b, codex-b → wait through the history redraw, ready once it settles', () => {
  for (const [agent, name, readyMs] of [
    ['claude', 'claude-b', 4277],
    ['codex', 'codex-b', 3020]
  ] as const) {
    const p = must(profileFor(agent, true))
    assert.equal(p.timeoutMs, 45_000)
    const vs = replayRecorded(p, name)
    assert.ok(
      vs.slice(0, -2).every((v) => v.kind === 'wait'),
      name
    )
    assertReadyAt(p, name, readyMs)
  }
})

test('timing (overlap rule): stable idle from t0, minDelay = quiet = 1500 → ready at 1500, not 3000', () => {
  assert.deepEqual(
    replay(profile(), () => [IDLE]),
    { at: 1500, verdict: { kind: 'ready' } }
  )
})

test('timing: minDelay 3000, quiet 1500 → ready at 3000', () => {
  assert.deepEqual(
    replay(profile({ minDelayMs: 3000 }), () => [IDLE]),
    { at: 3000, verdict: { kind: 'ready' } }
  )
})

test('timing: a change at 1000 with both 1500 → ready at 2500', () => {
  assert.deepEqual(
    replay(profile(), (at) => (at < 1000 ? ['booting', IDLE] : [IDLE])),
    { at: 2500, verdict: { kind: 'ready' } }
  )
})

test('blank frames for the whole timeout → timeout', () => {
  assert.deepEqual(
    replay(profile({ timeoutMs: 5000 }), () => ['', '   ']),
    { at: 5000, verdict: { kind: 'timeout' } }
  )
})

test('busy counter: Working 12s → 13s is identical once masked, no idle match → timeout, never ready', () => {
  const r = replay(profile({ timeoutMs: 5000 }), (at) => [`Working ${12 + Math.floor(at / 1000)}s`])
  assert.deepEqual(r, { at: 5000, verdict: { kind: 'timeout' } })
})

test('digit mask matters: idle prompt plus a changing token counter → ready', () => {
  assert.deepEqual(
    replay(profile(), (at) => [`tokens ${10_000 + at}`, IDLE]),
    { at: 1500, verdict: { kind: 'ready' } }
  )
})

test('animated non-digit change every 200 ms → timeout', () => {
  const glyphs = ['⠋', '⠙', '⠹', '⠸']
  const r = replay(profile({ timeoutMs: 5000 }), (at) => [glyphs[Math.floor(at / 200) % 4] ?? '⠋', IDLE])
  assert.deepEqual(r, { at: 5000, verdict: { kind: 'timeout' } })
})

test('idle required: stable frame not matching idle → timeout; matching → ready', () => {
  assert.equal(replay(profile({ timeoutMs: 5000 }), () => ['just text']).verdict.kind, 'timeout')
  assert.equal(replay(profile(), () => ['just text', IDLE]).verdict.kind, 'ready')
})

test('busy veto (pattern): idle-looking frame matching busy waits; ready a full quietMs after busy stops matching', () => {
  const p = profile({ busy: /^aaa aa aaaaaaaaa$/mu, timeoutMs: 5000 }) // masked 'esc to interrupt'
  assert.equal(replay(p, () => ['esc to interrupt', IDLE]).verdict.kind, 'timeout')
  assert.deepEqual(
    replay(p, (at) => (at < 2000 ? ['esc to interrupt', IDLE] : [IDLE])),
    { at: 3500, verdict: { kind: 'ready' } }
  )
  const claude = must(must(PROFILES['claude']).busy)
  assert.ok(claude.test(mask(['✻ Thinking… (3s)', '❯'], 40)))
  assert.ok(!claude.test(mask(['✻ Worked for 3s', '❯'], 40)))
})

test('busy veto (event): working holds until a later done, then ready after quietMs; done alone never readies a non-idle frame', () => {
  const working = (at: number): StatusSeen => (at < 3000 ? { state: 'working', receivedAt: 10 } : { state: 'done', receivedAt: 3000 })
  assert.deepEqual(
    replay(profile(), () => [IDLE], working),
    { at: 4250, verdict: { kind: 'ready' } }
  )
  const done = (): StatusSeen => ({ state: 'done', receivedAt: 60 })
  assert.equal(replay(profile({ timeoutMs: 5000 }), () => ['history redraw'], done).verdict.kind, 'timeout')
})

test('busy veto (event, F10): a working event received before t0 still vetoes', () => {
  const early = (): StatusSeen => ({ state: 'working', receivedAt: -1600 })
  assert.equal(replay(profile({ timeoutMs: 5000 }), () => [IDLE], early).verdict.kind, 'timeout')
  // P2 run 1 i2: Claude busy at resume (working at −1464 ms), recorded ready at 6342 ms, done only at 6772 ms.
  assert.ok(replayRecorded(must(profileFor('claude', true)), 'claude-i2-run1').every((v) => v.kind === 'wait'))
  // Re-probe i2: same shape, done at 4386 ms → ready once the screen settles.
  assertReadyAt(must(profileFor('claude', true)), 'claude-i2', 6049)
})

test('started:false shapes: drawn idle → ready at max(min, quiet); busy + working → timeout; trust dialog → blocked', () => {
  assert.deepEqual(
    replay(profile({ minDelayMs: 1000, quietMs: 2000 }), () => ['history', IDLE]),
    { at: 2000, verdict: { kind: 'ready' } }
  )
  const working = (): StatusSeen => ({ state: 'working', receivedAt: 1 })
  assert.equal(replay(profile({ timeoutMs: 5000 }), () => ['Working 12s', IDLE], working).verdict.kind, 'timeout')
  assert.equal(replay(profile(), () => ['history', 'Do you trust this folder?', '❯ 1. Yes, proceed']).verdict.kind, 'blocked')
})

test('blocker: a stable trust-dialog frame → blocked at the first poll, before quietMs', () => {
  const r = replay(must(profileFor('claude')), () => ['Do you trust this folder?', '❯ 1. Yes, proceed', '  2. No'])
  assert.deepEqual(r, { at: 0, verdict: { kind: 'blocked', index: 0 } })
})

test('no profile: opencode and inherited keys → null; every profile has an idle pattern', () => {
  assert.equal(profileFor('opencode'), null)
  assert.equal(profileFor('toString'), null)
  assert.deepEqual(Object.keys(PROFILES).sort(), ['claude', 'codex', 'pi'])
  assert.equal(must(profileFor('claude')).timeoutMs, 30_000)
})
