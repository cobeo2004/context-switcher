import { assert, test } from 'orca/testing'
import { buildContext, buildFromTurns } from './context'
import { openStore } from './store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const turns = [{ nativeId: 'a', kind: 'user' as const, text: 'hello', at: 0 }]
const opts = { threadId: 't_11111111-1111-1111-1111-111111111111', handoffId: 'h_11111111-1111-1111-1111-111111111111', sourceAgent: 'claude', budget: 1024, lossy: false }

test('context budgets reject an envelope that cannot fit and non-finite values', () => {
  for (const budget of [512, 0, 1, NaN, Infinity, -Infinity]) {
    assert.throws(() => buildFromTurns(turns, { ...opts, budget }), (error) => error instanceof RangeError)
  }
  assert.ok(buildFromTurns(turns, opts).text.length <= 1024)
  assert.ok(buildFromTurns(turns, { ...opts, budget: 100000 }).text.length <= 4096)
})

test('stored context rejects a budget smaller than its envelope', () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'cs-budget-')), 'context.sqlite'))
  try {
    assert.throws(() => buildContext(store, { threadId: opts.threadId, handoffId: opts.handoffId, target: { agent: 'codex' }, budget: 512, purpose: 'switch' }), (error) => error instanceof RangeError)
  } finally {
    store.close()
  }
})
