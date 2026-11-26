import { assert, test } from 'orca/testing'
import fc from 'fast-check'
import { buildContext, buildFromTurns, planDigest, renderTurn, selectTurns } from './context'
import type { Store } from './store'
import { HARD_CAP, type CanonicalTurn, type TurnKind, type HandoffId, type ThreadId } from './types'

const must = <T>(value: T | undefined): T => {
  assert.ok(value !== undefined)
  return value
}

const H = 'h_11111111-1111-1111-1111-111111111111' as HandoffId
const T = 't_11111111-1111-1111-1111-111111111111' as ThreadId
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
// Shrinking a 3000-line screen takes minutes; report the seed instead. FC_SHRINK=1 shrinks locally.
fc.configureGlobal({
  numRuns: Number(process.env['FC_RUNS'] ?? 200),
  endOnFailure: process.env['FC_SHRINK'] !== '1',
  ...(process.env['FC_SEED'] ? { seed: Number(process.env['FC_SEED']) } : {})
})

// Text biased to the edges that broke before: newlines, astral pairs (2 code units), 2-byte UTF-8.
const unit = fc.constantFrom('x', 'y', ' ', '\n', 'é', '😀')
const text = (max: number) => fc.string({ unit, maxLength: max })
const kind = fc.constantFrom<TurnKind>('user', 'assistant', 'command', 'file_change', 'tool_call')
const turnArb = fc.record({
  kind,
  text: fc.oneof({ weight: 4, arbitrary: text(200) }, { weight: 1, arbitrary: fc.string({ unit, maxLength: 6000, size: 'max' }) }),
  paths: fc.option(fc.array(fc.string({ unit: fc.constantFrom('a', '/', '.'), maxLength: 12 }), { maxLength: 3 }), { nil: undefined })
})
const turnsArb = fc.array(turnArb, { maxLength: 40 })
const budgetArb = fc.oneof(fc.constant(4096), fc.integer({ min: 1024, max: 6000 }))
const toCanonical = (ts: { kind: TurnKind; text: string; paths?: string[] | undefined }[]): CanonicalTurn[] =>
  ts.map((t, i) => ({ nativeId: `n${i}`, kind: t.kind, text: t.text, at: 0, ...(t.paths ? { paths: t.paths } : {}) }))
const viaStore = (turns: CanonicalTurn[], budget: number) =>
  buildContext({ eligibleTurns: () => turns.map((t, i) => ({ ...t, id: i + 1, ord: i + 1, agent: 'claude' })) } as unknown as Store, {
    threadId: T,
    handoffId: H,
    target: { agent: 'codex' },
    budget,
    purpose: 'switch'
  })

test('prop: stored digest ≤ cap, selected ∪ omitted = eligible, no lone surrogates', () => {
  fc.assert(
    fc.property(turnsArb, budgetArb, (raw, budget) => {
      const turns = toCanonical(raw)
      const pkg = viaStore(turns, budget)
      assert.ok(pkg.text.length <= Math.min(budget, HARD_CAP))
      assert.equal(pkg.selected + pkg.omitted, turns.length)
      const sel = pkg.selectedTurnIds
      const omi = pkg.omittedTurnIds
      assert.deepEqual(
        [...sel, ...omi].sort((a, b) => a - b),
        turns.map((_, i) => i + 1)
      )
      assert.equal(LONE.test(pkg.text), false)
    })
  )
})

test('prop: selectTurns picks sorted unique indices whose cost fits the envelope', () => {
  const header = (s: number) => `H ${s}`
  const footer = (_s: number, o: number) => `F ${o}`
  fc.assert(
    fc.property(turnsArb, fc.integer({ min: 0, max: 5000 }), (raw, budget) => {
      const turns = toCanonical(raw)
      const picked = selectTurns(turns, budget, header, footer)
      picked.forEach((v, i) => {
        assert.ok(v >= 0 && v < turns.length && (i === 0 || v > (picked[i - 1] ?? -1)))
      })
      const cost = picked.reduce((a, i) => a + renderTurn(must(turns[i])).length + 1, 0)
      const n = turns.length
      assert.ok(picked.length === 0 || cost <= budget - header(n).length - footer(n, n).length - 4)
    })
  )
})

test('prop: planDigest excerpt keeps whole surrogate pairs and only cuts the last user turn', () => {
  const header = () => 'H'
  const footer = () => 'F'
  fc.assert(
    fc.property(turnsArb, fc.integer({ min: 1024, max: 4096 }), (raw, budget) => {
      const turns = toCanonical(raw)
      const { picked, excerpt } = planDigest(turns, budget, header, footer)
      if (!excerpt) return
      assert.equal(excerpt.index, turns.map((t) => t.kind).lastIndexOf('user'))
      assert.equal(picked.includes(excerpt.index), false)
      assert.equal(LONE.test(excerpt.head) || LONE.test(excerpt.tail), false)
      const full = must(turns[excerpt.index]).text
      assert.ok(full.startsWith(excerpt.head) && full.endsWith(excerpt.tail))
      assert.equal(excerpt.cut, full.length - excerpt.head.length - excerpt.tail.length)
    })
  )
})

// A screen: many short lines (the reservation boundary is hit often) or a few with one wide line (the n≈3544 shape).
const screenArb = fc.oneof(
  fc.array(fc.string({ unit: fc.constantFrom('x', 'é', '😀'), maxLength: 4 }), { minLength: 1, maxLength: 3000, size: 'max' }),
  fc
    .tuple(
      fc.string({ unit: fc.constantFrom('o', 'é', '😀'), maxLength: 20 }),
      fc.integer({ min: 3000, max: 4100 }),
      fc.string({ unit: fc.constantFrom('L', 'é'), minLength: 1, maxLength: 8 })
    )
    .map(([a, n, z]) => [a, 'x'.repeat(n), z]),
  fc.string({ unit: fc.constantFrom('x', 'é'), maxLength: 6000, size: 'max' }).map((s) => [s])
)

test('prop: lossy capture keeps the newest lines that fit and counts the rest honestly', () => {
  fc.assert(
    fc.property(screenArb, budgetArb, (lines, budget) => {
      const cap = Math.min(budget, HARD_CAP)
      const capture = lines.join('\n')
      const pkg = buildFromTurns([{ nativeId: 'n', kind: 'assistant', text: capture, at: 0 }], {
        threadId: T,
        handoffId: H,
        sourceAgent: 'claude',
        budget,
        lossy: true
      })
      assert.ok(pkg.text.length <= cap)
      assert.equal(LONE.test(pkg.text), false)
      const label = /Screen capture: newest (\d+) of (\d+) lines\n([^]*)\n\nOmitted \d+ earlier screen lines/.exec(pkg.text)
      const footer = /Omitted (\d+) earlier screen lines/.exec(pkg.text)
      assert.ok(footer, 'lossy footer present')
      if (pkg.selected === 1) {
        assert.ok(label, 'a carried capture is labelled')
        const m = Number(label[1])
        assert.equal(Number(label[2]), lines.length)
        assert.equal(label[3], lines.slice(-m).join('\n'))
        assert.equal(Number(footer[1]), lines.length - m)
        // Maximal: one more (older) line would not fit. Counters change width: label m → m+1, footer M−m → M−m−1.
        const next = lines[lines.length - m - 1]
        if (next !== undefined) {
          const grow =
            next.length +
            1 +
            String(m + 1).length -
            String(m).length -
            (String(lines.length - m).length - String(lines.length - m - 1).length)
          assert.ok(pkg.text.length + grow + 1 > cap, `line ${m + 1} would also fit`)
        }
      } else {
        assert.equal(Number(footer[1]), lines.length, 'a dropped capture omits every line')
        // Dropped only if even the newest line cannot fit: the empty package plus that one block exceeds the cap.
        const newest = `Assistant: Screen capture: newest 1 of ${lines.length} lines\n${lines[lines.length - 1] ?? ''}`
        const footerShrink = String(lines.length).length - String(lines.length - 1).length
        assert.ok(pkg.text.length + 2 + newest.length + 1 - footerShrink > cap, `newest line would fit (len ${pkg.text.length})`)
      }
    })
  )
})
