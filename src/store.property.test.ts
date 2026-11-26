import { assert, test } from 'orca/testing'
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './store'
import type { CanonicalTurn, HandoffStatus, HandoffId, ParseResult } from './types'

// Same knobs as context.property.test.ts: Orca runs each test file in its own process, so each file sets its own seed.
fc.configureGlobal({
  numRuns: Number(process.env['FC_RUNS'] ?? 50),
  endOnFailure: process.env['FC_SHRINK'] !== '1',
  ...(process.env['FC_SEED'] ? { seed: Number(process.env['FC_SEED']) } : {})
})
const STATUSES: HandoffStatus[] = ['draft', 'pending', 'delivered', 'unconfirmed', 'failed', 'expired']
const WS = { workspaceId: 'ws1', terminalId: 'term1' }
const parse = (turns: CanonicalTurn[], activeNativeIds?: string[]): ParseResult => ({
  turns,
  cursor: { kind: 'offset', file: { path: '/x', dev: 1, ino: 1, size: 1 }, offset: 1 },
  formatVersion: 't',
  markers: [],
  ...(activeNativeIds ? { activeNativeIds } : {})
})

// Each hand-off: target B or C, a status, and per eligible turn 0 = not covered, 1 = carried, 2 = omitted.
const handoffArb = fc.record({
  toB: fc.boolean(),
  status: fc.constantFrom(...STATUSES),
  cover: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 13, maxLength: 13 })
})
const worldArb = fc.record({
  aActive: fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
  cCount: fc.integer({ min: 0, max: 6 }),
  handoffs: fc.array(handoffArb, { maxLength: 4 })
})

test('prop: eligibleTurns excludes exactly the turns carried by a hand-off delivered to the target', () => {
  fc.assert(
    fc.property(worldArb, ({ aActive, cCount, handoffs }) => {
      const dir = mkdtempSync(join(tmpdir(), 'cs-prop-'))
      const s = openStore(join(dir, 'cs', 'context.sqlite'))
      try {
        const mk = (p: string, n: number): CanonicalTurn[] =>
          Array.from({ length: n }, (_, i) => ({ nativeId: `${p}${i}`, kind: 'user', text: `${p}${i}`, at: 0 }))
        const aTurns = mk('A', aActive.length)
        const thread = s.ingestParse(
          { agent: 'claude', nativeId: 'A' },
          parse(
            aTurns,
            aTurns.filter((_, i) => aActive[i]).map((t) => t.nativeId)
          ),
          WS,
          1
        ).threadId
        assert.ok(thread)
        const join_ = (agent: string, id: string, turns: CanonicalTurn[]) => {
          const hid = `h_join_${agent}` as HandoffId
          s.createDraft(
            {
              id: hid,
              thread_id: thread,
              source_session_id: null,
              source_agent: 'claude',
              target_agent: agent,
              target_session_id: null,
              target_terminal_id: 'term1',
              workspace_id: 'ws1',
              strategy: 'launch'
            },
            {
              text: 'x',
              bytes: 1,
              mode: 'full',
              selectedTurnIds: [],
              omittedTurnIds: [],
              selected: 0,
              omitted: 0,
              coveredFromOrd: null,
              coveredToOrd: null,
              lossy: false,
              threadReadCommand: ''
            },
            1
          )
          s.setHandoffStatus(hid, 'pending', null, 1)
          const r = s.ingestParse(
            { agent, nativeId: id },
            { ...parse(turns), markers: [{ handoffId: hid, threadId: thread, nativeId: `${id}0`, userRecordIndex: 0 }] },
            WS,
            2
          )
          assert.equal(r.threadId, thread)
          assert.ok(r.sessionId !== null)
          return r.sessionId
        }
        const b = join_('codex', 'B', mk('B', 1))
        const c = join_('pi', 'C', mk('C', cCount))
        const all = s.threadTurns(thread, 0, 1000)
        const eligibleAll = all.filter((t) => t.source === 'conversation' && t.active === 1).map((t) => t.id)
        handoffs.forEach((h, k) => {
          const id = `h_${k}` as HandoffId
          const carried = eligibleAll.filter((_, i) => h.cover[i] === 1)
          const omitted = eligibleAll.filter((_, i) => h.cover[i] === 2)
          s.createDraft(
            {
              id,
              thread_id: thread,
              source_session_id: null,
              source_agent: 'claude',
              target_agent: h.toB ? 'codex' : 'pi',
              target_session_id: h.toB ? b : c,
              target_terminal_id: 'term1',
              workspace_id: 'ws1',
              strategy: 'resume'
            },
            {
              text: 'x',
              bytes: 1,
              mode: 'delta',
              selectedTurnIds: carried,
              omittedTurnIds: omitted,
              selected: carried.length,
              omitted: omitted.length,
              coveredFromOrd: null,
              coveredToOrd: null,
              lossy: false,
              threadReadCommand: ''
            },
            3
          )
          if (h.status !== 'draft') s.setHandoffStatus(id, h.status, null, 3)
        })
        for (const [target, toB] of [
          [b, true],
          [c, false]
        ] as const) {
          const delivered = new Set(
            handoffs.flatMap((h) => (h.toB === toB && h.status === 'delivered' ? eligibleAll.filter((_, i) => h.cover[i] === 1) : []))
          )
          const expected = all
            .filter((t) => t.source === 'conversation' && t.active === 1 && t.session_id !== target && !delivered.has(t.id))
            .map((t) => t.id)
          assert.deepEqual(
            s.eligibleTurns(thread, target).map((t) => t.id),
            expected
          )
        }
      } finally {
        s.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  )
})
