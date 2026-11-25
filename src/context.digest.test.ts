import { assert, test } from 'orca/testing'
import { buildContext, buildFromTurns, planDigest, renderTurn, selectTurns } from './context'
import type { Store } from './store'
import type { CanonicalTurn } from './types'

const H = 'h_11111111-1111-1111-1111-111111111111'
const opts = { threadId: 't_11111111-1111-1111-1111-111111111111', handoffId: H, sourceAgent: 'claude', budget: 4096, lossy: false }
const turn = (kind: CanonicalTurn['kind'], text: string, i = 0): CanonicalTurn => ({ nativeId: `n${i}`, kind, text, at: 0 })
const rows = (turns: CanonicalTurn[]) => turns.map((t, i) => ({ ...t, id: i + 1, ord: i + 1, agent: 'claude' }))
const stored = (turns: CanonicalTurn[], budget = 4096) =>
  buildContext({ eligibleTurns: () => rows(turns) } as unknown as Store, { threadId: opts.threadId, handoffId: H, target: { agent: 'codex' }, budget, purpose: 'switch' })
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const none = () => ''

test('lossy capture retains newest lines at the budget boundary', () => {
  for (let n = 3530; n <= 3560; n++) {
    const lines = ['old', 'x'.repeat(n), 'LATEST']
    const pkg = buildFromTurns([turn('assistant', lines.join('\n'))], { ...opts, lossy: true })
    assert.equal(pkg.selected, 1, `n=${n}`)
    assert.ok(pkg.text.includes('LATEST'), `n=${n}`)
    assert.ok(pkg.text.length <= 4096, `n=${n}`)
    const match = /Screen capture: newest (\d+) of (\d+) lines\n([^]*?)\n\n/.exec(pkg.text)
    assert.ok(match, `n=${n}`)
    const m = Number(match[1])
    assert.equal(Number(match[2]), lines.length, `n=${n}`)
    assert.equal(match[3], lines.slice(-m).join('\n'), `n=${n}`)
  }
})

test('single-line lossy capture that cannot fit is dropped and counted honestly', () => {
  const pkg = buildFromTurns([turn('assistant', 'x'.repeat(5000))], { ...opts, lossy: true })
  assert.equal(pkg.selected, 0)
  assert.ok(pkg.text.includes('Omitted 1 earlier screen lines; screen captures are not stored.'), pkg.text)
  assert.ok(pkg.text.length <= 4096, String(pkg.text.length))
})

test('single-line lossy capture that fits is labelled with its line count', () => {
  const pkg = buildFromTurns([turn('assistant', 'LATEST')], { ...opts, lossy: true })
  assert.equal(pkg.selected, 1)
  assert.ok(pkg.text.includes('Screen capture: newest 1 of 1 lines'), pkg.text)
  assert.ok(pkg.text.includes('LATEST'), pkg.text)
})

test('cap is in characters: 2-byte text fills 4096 chars, more than a byte cap would allow', () => {
  const turns = Array.from({ length: 60 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', 'é'.repeat(500), i))
  const pkg = buildFromTurns(turns, opts)
  assert.ok(pkg.text.length <= 4096, String(pkg.text.length))
  assert.ok(pkg.bytes > 4096, String(pkg.bytes))
  // Char-based expectation: envelope measured from the rendered package, every turn costs the same.
  const cost = renderTurn(turns[0]).length + 1
  const body = pkg.selected * cost - 1
  const envelope = pkg.text.length - body - 4
  assert.equal(pkg.selected, Math.floor((4096 - envelope - 4 + 1) / cost))
  assert.ok(pkg.selected * (cost + 500) > 4096) // a byte rule could not have selected this many
})

test('astral text never leaves a lone surrogate, also when the excerpt cut lands inside a pair', () => {
  for (const lead of ['', 'a']) {
    const text = `${lead}${'😀'.repeat(5000)}`
    for (let budget = 400; budget <= 4096; budget += 37) {
      const plan = planDigest([turn('user', text)], budget, none, none)
      if (!plan.excerpt) continue
      const { head, tail, cut } = plan.excerpt
      assert.ok(!LONE.test(head) && !LONE.test(tail), `lead=${lead} budget=${budget}`)
      assert.equal(cut, text.length - head.length - tail.length)
    }
    const pkg = buildFromTurns([turn('user', text), turn('assistant', '😀 done', 1)], opts)
    assert.ok(pkg.text.length <= 4096)
    assert.ok(!LONE.test(pkg.text))
  }
})

test('rule E: an oversized last user turn is excerpted head + tail with the true cut count', () => {
  const big = `HEAD-MARK ${'q'.repeat(19_980)} TAIL-MARK`
  const turns = [turn('user', 'first ask', 0), turn('assistant', 'early answer', 1), turn('user', big, 2), turn('assistant', 'LAST-ASSIST', 3)]
  const pkg = stored(turns)
  assert.ok(pkg.text.length <= 4096, String(pkg.text.length))
  assert.ok(pkg.text.includes('HEAD-MARK'))
  assert.ok(pkg.text.includes('TAIL-MARK'))
  const k = Number(/\[… (\d+) chars cut …\]/.exec(pkg.text)?.[1])
  const head = /: (HEAD-MARK q*)\n\[…/.exec(pkg.text)![1]
  const tail = /chars cut …\]\n(q* TAIL-MARK)\n/.exec(pkg.text)![1]
  assert.equal(k, big.length - head.length - tail.length)
  assert.ok(pkg.text.includes(`User (excerpt: ${big.length} chars, cut ${k}; full text via the command below): `))
  assert.ok(pkg.omittedTurnIds!.includes(3))
  assert.ok(!pkg.selectedTurnIds.includes(3))
  assert.ok(pkg.selectedTurnIds.includes(4)) // last assistant fits in the remaining 40 %
  assert.ok(pkg.text.includes('Assistant: LAST-ASSIST'))
  assert.equal(pkg.selected, pkg.selectedTurnIds.length)
  assert.equal(pkg.omitted, turns.length - pkg.selected)
  assert.ok(pkg.text.indexOf('TAIL-MARK') < pkg.text.indexOf('LAST-ASSIST')) // ord position
})

test('rule E floor: room below EXCERPT_MIN skips the turn whole', () => {
  assert.deepEqual(planDigest([turn('user', 'x'.repeat(1000))], 200, none, none), { picked: [] })
})

test('selector contract unchanged: protected input still [0, 3, 4], planDigest agrees when the last user fits', () => {
  const turns = [
    { kind: 'user', text: 'u0' }, { kind: 'assistant', text: 'a1' }, { kind: 'user', text: 'u2' },
    { kind: 'assistant', text: 'a3' }, { kind: 'user', text: 'u4' }, { kind: 'command', text: 'c5' }
  ] as const
  const cost = (i: number) => renderTurn(turns[i]).length + 1
  const budget = cost(4) + cost(3) + cost(0) + 4
  assert.deepEqual(selectTurns(turns, budget, none, none), [0, 3, 4])
  assert.deepEqual(planDigest(turns, budget, none, none), { picked: [0, 3, 4] })
  for (const b of [budget, 30, 100, 4096]) assert.deepEqual(planDigest(turns, b, none, none), { picked: selectTurns(turns, b, none, none) })
})

test('other oversized turns are still skipped whole', () => {
  const pkg = stored([turn('user', 'ask', 0), turn('user', `OLD ${'x'.repeat(9000)}`, 1), turn('assistant', `BIG ${'x'.repeat(9000)}`, 2), turn('user', 'last ask', 3)])
  assert.ok(!pkg.text.includes('xxxxxxxxxx'))
  assert.ok(!pkg.text.includes('excerpt:'))
  assert.deepEqual(pkg.omittedTurnIds, [2, 3])
})

test('footers: --handoff command, lossy without command, DB unavailable', () => {
  assert.ok(stored([turn('user', 'hi')]).text.includes(`Read them with: node ~/.context-switcher/bin/thread-read.mjs --handoff ${H}`))
  assert.ok(buildFromTurns([turn('user', 'hi')], opts).text.includes('Omitted 0 turns; the history database is unavailable, so they cannot be read back.'))
  const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}`)
  const lossy = buildFromTurns([turn('assistant', lines.join('\n'))], { ...opts, lossy: true })
  assert.ok(lossy.text.length <= 4096)
  assert.ok(lossy.text.endsWith('line-2999\n\n' + lossy.text.split('\n\n').pop()))
  assert.ok(!lossy.text.includes('\nline-0\n'))
  const m = Number(/Screen capture: newest (\d+) of 3000 lines/.exec(lossy.text)?.[1])
  assert.ok(m > 0 && m < 3000)
  assert.ok(lossy.text.includes(`Omitted ${3000 - m} earlier screen lines; screen captures are not stored.`))
  assert.ok(!lossy.text.includes('thread-read'))
})
