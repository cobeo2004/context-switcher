import { assert, test } from 'orca/testing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './store'
import { buildContext, buildFromTurns, planDigest, renderTurn, selectTurns } from './context'
import type { CanonicalTurn, HandoffId, ThreadId } from './types'

const H1 = 'h_11111111-1111-1111-1111-111111111111' as HandoffId
const T1 = 't_11111111-1111-1111-1111-111111111111' as ThreadId
const none = () => ''
const opts = { threadId: T1, handoffId: H1, sourceAgent: 'claude', budget: 4096, lossy: false }
const turn = (nativeId: string, kind: CanonicalTurn['kind'], text: string, extra: Partial<CanonicalTurn> = {}): CanonicalTurn => ({
  nativeId,
  kind,
  text,
  at: 0,
  ...extra
})
const user = (text: string) => ({ kind: 'user' as const, text })
const ten = 'xxxxxxxxxx'

test('renderTurn: stored paths that are not a string array are dropped, non-string entries filtered', () => {
  assert.equal(renderTurn({ kind: 'file_change', text: '', paths: '["a","b"]' }), 'File change: a, b')
  assert.equal(renderTurn({ kind: 'file_change', text: '', paths: '["a",1,null,"c"]' }), 'File change: a, c')
  assert.equal(renderTurn({ kind: 'file_change', text: '', paths: '{"a":1}' }), 'File change: ')
  assert.equal(renderTurn({ kind: 'file_change', text: '', paths: '"abc"' }), 'File change: ')
  assert.equal(renderTurn({ kind: 'file_change', text: '', paths: ['a', 'b'] }), 'File change: a, b')
})

test('renderTurn: a tool call names its tool (unknown when absent) and appends paths only when there are some', () => {
  assert.equal(renderTurn({ kind: 'tool_call', text: '' }), 'Tool: unknown')
  assert.equal(renderTurn({ kind: 'tool_call', text: '', tool: 'Read' }), 'Tool: Read')
  assert.equal(renderTurn({ kind: 'tool_call', text: '', tool: 'Read', paths: ['a', 'b'] }), 'Tool: Read a, b')
  assert.equal(renderTurn({ kind: 'tool_call', text: '', paths: ['a'] }), 'Tool: unknown a')
})

test('selectTurns: the last user turn is tried first, even when it is not the newest', () => {
  const turns = [user(ten), { kind: 'command' as const, text: ten }, user(ten), { kind: 'command' as const, text: ten }]
  assert.deepEqual(selectTurns(turns, 21, none, none), [2])
})

test('selectTurns: after the last user (and assistant) the first user turn is tried, before the newest-first sweep', () => {
  const cmd = { kind: 'command' as const, text: ten }
  assert.deepEqual(selectTurns([cmd, user(ten), cmd, user(ten), cmd], 44, none, none), [1, 3])
})

test('selectTurns: the newest-first sweep reaches the oldest turn', () => {
  const cmd = { kind: 'command' as const, text: ten }
  assert.deepEqual(selectTurns([cmd, cmd], 44, none, none), [0, 1])
})

test('planDigest: a last user turn that exactly fits the envelope is carried whole, one char more is excerpted', () => {
  const text = 'x'.repeat(1000) // renders as 1000 + 'User: ' + the joining newline = 1007; remaining = budget - 4
  const fits = planDigest([user(text)], 1011, none, none)
  assert.equal(fits.excerpt, undefined)
  assert.deepEqual(fits.picked, [0])
  const over = planDigest([user(text)], 1010, none, none)
  assert.ok(over.excerpt)
  assert.deepEqual(over.picked, [])
})

test('planDigest: an excerpt needs at least 120 chars of room', () => {
  const text = 'x'.repeat(400)
  const edge = planDigest([user(text)], 357, none, none)
  assert.ok(edge.excerpt)
  assert.equal(edge.excerpt.head.length, 80)
  assert.equal(edge.excerpt.tail.length, 40)
  assert.equal(planDigest([user(text)], 355, none, none).excerpt, undefined)
})

test('planDigest: head and tail fill the budget exactly, including when the cut count loses a digit', () => {
  const e = planDigest([user('x'.repeat(1000))], 1010, none, none).excerpt
  assert.ok(e)
  assert.deepEqual([e.head.length, e.tail.length, e.cut], [341, 170, 489])
  const big = planDigest([user('y'.repeat(12000))], 2000, none, none).excerpt
  assert.ok(big)
  assert.deepEqual([big.head.length, big.tail.length, big.cut], [734, 366, 10900])
})

test('planDigest: an excerpt never splits a surrogate pair at either end', () => {
  const text = '😀'.repeat(500)
  const seen: string[] = []
  for (let budget = 600; budget < 612; budget++) {
    const e = planDigest([user(text)], budget, none, none).excerpt
    assert.ok(e)
    assert.equal(/[\uD800-\uDBFF]$/.test(e.head), false)
    assert.equal(/^[\uDC00-\uDFFF]/.test(e.tail), false)
    seen.push(`${e.head.length}/${e.tail.length}`)
  }
  assert.deepEqual(seen, [
    '176/88',
    '178/88',
    '178/88',
    '178/88',
    '178/88',
    '178/88',
    '180/88',
    '180/88',
    '180/90',
    '180/90',
    '180/90',
    '182/90'
  ])
})

test('planDigest: the other turns get what the excerpt leaves over', () => {
  const asst = (c: string) => ({ kind: 'assistant' as const, text: c.repeat(30) })
  const r = planDigest([user('x'.repeat(1000)), asst('a'), asst('b'), asst('c')], 1010, none, none)
  assert.ok(r.excerpt)
  assert.deepEqual(r.picked, [1, 2, 3])
})

test('budget errors name their cause', () => {
  assert.throws(() => buildFromTurns([], { ...opts, budget: 512 }), /Context budget must be finite and at least 1024/)
  assert.throws(() => buildFromTurns([], { ...opts, budget: Infinity }), /Context budget must be finite and at least 1024/)
})

test('an envelope exactly as long as the budget is accepted, one char more is refused', () => {
  const base = buildFromTurns([], { ...opts, budget: 4096 }).text.length
  const agent = (len: number) => 'a'.repeat(len)
  const pad = 1024 - base + opts.sourceAgent.length
  const exact = buildFromTurns([], { ...opts, sourceAgent: agent(pad), budget: 1024 })
  assert.equal(exact.text.length, 1024)
  assert.throws(
    () => buildFromTurns([], { ...opts, sourceAgent: agent(pad + 1), budget: 1024 }),
    /Context budget is too small for the envelope/
  )
})

test('buildFromTurns: in-memory packages carry no ids, are full mode, and give no read-back command', () => {
  const stored = buildFromTurns([turn('1', 'user', 'hello'), turn('2', 'assistant', 'hi')], opts)
  assert.equal(stored.mode, 'full')
  assert.equal(stored.lossy, false)
  assert.deepEqual(stored.selectedTurnIds, [])
  assert.deepEqual(stored.omittedTurnIds, [])
  assert.equal(stored.coveredFromOrd, null)
  assert.equal(stored.coveredToOrd, null)
  assert.equal(stored.threadReadCommand, '')
  const lossy = buildFromTurns([turn('1', 'assistant', 'one\ntwo')], { ...opts, lossy: true })
  assert.equal(lossy.mode, 'full')
  assert.equal(lossy.lossy, true)
  assert.deepEqual(lossy.selectedTurnIds, [])
  assert.deepEqual(lossy.omittedTurnIds, [])
  assert.equal(lossy.threadReadCommand, '')
})

test('lossy capture: only a lone input turn, or a lone assistant turn beside filtered hand-off turns, is a screen capture', () => {
  const lossy = { ...opts, lossy: true }
  const capture = (turns: CanonicalTurn[], o = lossy) => buildFromTurns(turns, o).text.includes('Screen capture: newest')
  const handoff = turn('h', 'assistant', 'carried', { handoffId: H1 })
  assert.equal(capture([turn('1', 'user', 'lone')]), true)
  assert.equal(capture([turn('1', 'assistant', 'lone')]), true)
  assert.equal(capture([handoff, turn('1', 'assistant', 'lone')]), true)
  assert.equal(capture([handoff, turn('1', 'user', 'lone')]), false)
  assert.equal(capture([turn('1', 'assistant', 'a'), turn('2', 'assistant', 'b')]), false)
  assert.equal(capture([]), false)
  assert.equal(capture([turn('1', 'assistant', 'lone')], opts), false)
  const text = buildFromTurns([handoff, turn('1', 'user', 'lone')], lossy).text
  assert.ok(text.includes('User: lone'))
  assert.ok(text.includes('Source: screen capture, lossy.'))
})

test('lossy capture that fits no line leaves no blank body: header and footer are one blank line apart', () => {
  const r = buildFromTurns([turn('1', 'assistant', 'z'.repeat(5000))], { ...opts, lossy: true, budget: 1024 })
  assert.equal(r.selected, 0)
  assert.equal(r.text.split('\n\n').length, 2)
})

test('buildContext: ids, ords and the read-back command follow what was carried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-gaps-'))
  const store = openStore(join(dir, 'context.sqlite'))
  try {
    const turns = Array.from({ length: 12 }, (_, i) => turn(`n${i}`, i % 2 === 0 ? 'user' : 'assistant', `turn-${i} ${'w'.repeat(600)}`))
    const threadId = store.ingestParse(
      { agent: 'claude', nativeId: 's1' },
      { turns, cursor: { kind: 'offset', file: { path: '/x', dev: 1, ino: 1, size: 1 }, offset: 1 }, formatVersion: 'v', markers: [] },
      { workspaceId: 'ws1' },
      1
    ).threadId
    assert.ok(threadId)
    const input = { threadId, target: { agent: 'codex' }, budget: 2048, purpose: 'switch' as const, handoffId: H1 }
    const pkg = buildContext(store, input)
    const all = store.threadTurns(threadId, 0, 100)
    const ordOf = (id: number) => all.find((t) => t.id === id)?.ord
    assert.equal(all.length, 12)
    assert.ok(pkg.selected > 0 && pkg.omitted > 0)
    assert.equal(pkg.selectedTurnIds.length, pkg.selected)
    assert.equal(pkg.omittedTurnIds.length, pkg.omitted)
    assert.deepEqual(
      [...pkg.selectedTurnIds, ...pkg.omittedTurnIds].sort((a, b) => a - b),
      all.map((t) => t.id)
    )
    const ords = pkg.selectedTurnIds.map((id) => ordOf(id))
    assert.equal(pkg.coveredFromOrd, Math.min(...ords.map(Number)))
    assert.equal(pkg.coveredToOrd, Math.max(...ords.map(Number)))
    assert.equal(pkg.threadReadCommand, `node ~/.context-switcher/bin/thread-read.mjs --handoff ${H1}`)
    assert.ok(pkg.text.includes('Context hand-off from claude'))
    // An empty thread has no source agent to name.
    const empty = buildContext(store, { ...input, threadId: 't_22222222-2222-2222-2222-222222222222' as ThreadId })
    assert.ok(empty.text.includes('Context hand-off from unknown'))
    assert.equal(empty.coveredFromOrd, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
