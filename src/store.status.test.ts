import { assert, test } from 'orca/testing'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type IngestContext, type Store } from './store'
import {
  DRAFT_TTL_MS,
  type CanonicalTurn,
  type ContextPackage,
  type HandoffId,
  type HandoffStatus,
  type ParseResult,
  type SessionId,
  type ThreadId
} from './types'

const T0 = 1_700_000_000_000
const H1 = 'h_11111111-1111-1111-1111-111111111111' as HandoffId
const WS: IngestContext = { workspaceId: 'ws1', terminalId: 'term1' }

function withStore(fn: (s: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cs-status-'))
  const s = openStore(join(dir, 'cs', 'context.sqlite'))
  try {
    fn(s)
  } finally {
    s.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
const turn = (nativeId: string): CanonicalTurn => ({ nativeId, kind: 'user', text: nativeId, at: T0 })
const parse = (turns: CanonicalTurn[], markers: ParseResult['markers'] = []): ParseResult => ({
  turns,
  cursor: { kind: 'offset', file: { path: '/x.jsonl', dev: 1, ino: 1, size: 10 }, offset: 10 },
  formatVersion: 'test-v1',
  markers
})
const marker = (handoffId: HandoffId, threadId: string) => ({
  handoffId,
  threadId: threadId as ThreadId,
  nativeId: 'm#0',
  userRecordIndex: 0
})
const pkg: ContextPackage = {
  text: 'pkg',
  bytes: 3,
  mode: 'full',
  selectedTurnIds: [],
  omittedTurnIds: [],
  selected: 0,
  omitted: 0,
  coveredFromOrd: null,
  coveredToOrd: null,
  lossy: false,
  threadReadCommand: 'node x'
}
function must<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined)
  return value
}
/** A source thread (claude) plus a draft for it aimed at codex; `over` changes the draft's fields. */
function setup(s: Store, over: { target_terminal_id?: string | null; target_session_id?: SessionId | null } = {}, now = T0) {
  const threadId = must(s.ingestParse({ agent: 'claude', nativeId: 'A' }, parse([turn('a0')]), WS, now).threadId)
  s.createDraft(
    {
      id: H1,
      thread_id: threadId,
      source_session_id: null,
      source_agent: 'claude',
      target_agent: 'codex',
      target_session_id: null,
      target_terminal_id: 'term1',
      workspace_id: 'ws1',
      strategy: 'launch',
      ...over
    },
    pkg,
    now
  )
  return threadId
}
const statusOf = (s: Store, id: string) =>
  (s.db.prepare('SELECT status FROM handoffs WHERE id = ?').get(id) as { status: string } | undefined)?.status
const threadUpdatedAt = (s: Store, id: string) =>
  (s.db.prepare('SELECT updated_at FROM threads WHERE id = ?').get(id) as { updated_at: number }).updated_at

test('claimDraft names every outcome', () => {
  withStore((s) => {
    assert.equal(s.claimDraft('h_missing' as HandoffId, T0), 'missing')
    setup(s)
    assert.equal(s.claimDraft(H1, T0), 'claimed')
    assert.equal(s.claimDraft(H1, T0), 'already_run') // pending
    for (const status of ['delivered', 'unconfirmed', 'failed'] as const) {
      s.setHandoffStatus(H1, status, null, T0)
      assert.equal(s.claimDraft(H1, T0), 'already_run')
    }
  })
})

test('claimDraft: an expired draft reports expired, and stays expired', () => {
  withStore((s) => {
    setup(s)
    assert.equal(s.claimDraft(H1, T0 + DRAFT_TTL_MS), 'expired')
    assert.equal(statusOf(s, H1), 'expired')
    assert.equal(s.claimDraft(H1, T0), 'expired') // the row is expired now, even for an earlier clock
    assert.equal(statusOf(s, H1), 'expired')
  })
})

test('a failed transaction rolls back, rethrows, and leaves the store usable', () => {
  withStore((s) => {
    const threadId = setup(s)
    const dup = () => {
      s.createDraft(
        {
          id: H1,
          thread_id: threadId,
          source_session_id: null,
          source_agent: 'claude',
          target_agent: 'codex',
          target_session_id: null,
          target_terminal_id: null,
          workspace_id: 'ws1',
          strategy: 'launch'
        },
        pkg,
        T0
      )
    }
    assert.throws(dup, /UNIQUE|PRIMARY|constraint/i)
    assert.equal(s.claimDraft(H1, T0), 'claimed')
  })
})

test('close releases the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-status-'))
  try {
    const s = openStore(join(dir, 'context.sqlite'))
    s.close()
    assert.throws(() => s.userVersion())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('openStore tightens an existing database file to 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-status-'))
  try {
    const path = join(dir, 'cs', 'context.sqlite')
    mkdirSync(join(dir, 'cs'))
    writeFileSync(path, '')
    chmodSync(path, 0o644)
    openStore(path).close()
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ingest: counts inserted turns, no warnings without markers, and touches the thread clock', () => {
  withStore((s) => {
    const first = s.ingestParse({ agent: 'claude', nativeId: 'A' }, parse([turn('a0'), turn('a1'), turn('a2')]), WS, T0)
    assert.equal(first.inserted, 3)
    assert.deepEqual(first.warnings, [])
    const threadId = must(first.threadId)
    assert.equal(threadUpdatedAt(s, threadId), T0)
    const second = s.ingestParse({ agent: 'claude', nativeId: 'A' }, parse([turn('a0'), turn('a1'), turn('a2'), turn('a3')]), WS, T0 + 5000)
    assert.equal(second.inserted, 1)
    assert.equal(threadUpdatedAt(s, threadId), T0 + 5000)
  })
})

test('createDraft touches the thread clock', () => {
  withStore((s) => {
    const threadId = setup(s, {}, T0)
    s.db.prepare('DELETE FROM handoffs').run()
    s.createDraft(
      {
        id: H1,
        thread_id: threadId,
        source_session_id: null,
        source_agent: 'claude',
        target_agent: 'codex',
        target_session_id: null,
        target_terminal_id: null,
        workspace_id: 'ws1',
        strategy: 'launch'
      },
      pkg,
      T0 + 7000
    )
    assert.equal(threadUpdatedAt(s, threadId), T0 + 7000)
  })
})

/** Does a fresh codex session carrying the marker join the source thread? */
function joins(over: Parameters<typeof setup>[1], status: HandoffStatus, ctx: IngestContext = WS, markerThread?: string) {
  let result: { bound: boolean; warnings: string[] } = { bound: false, warnings: [] }
  withStore((s) => {
    const source = setup(s, over)
    s.setHandoffStatus(H1, status, null, T0)
    const r = s.ingestParse({ agent: 'codex', nativeId: 'C1' }, parse([turn('c0')], [marker(H1, markerThread ?? source)]), ctx, T0)
    result = { bound: r.threadId === source, warnings: r.warnings }
  })
  return result
}

test('a marker binds only a pending or unconfirmed hand-off', () => {
  assert.equal(joins({}, 'pending').bound, true)
  assert.equal(joins({}, 'unconfirmed').bound, true)
  for (const status of ['draft', 'delivered', 'failed', 'expired'] as const) assert.equal(joins({}, status).bound, false)
})

test('a marker naming another thread does not bind', () => {
  assert.equal(joins({}, 'pending', WS, 't_99999999-9999-9999-9999-999999999999').bound, false)
})

test('terminal binding: a terminal on both sides must match, an unset terminal on either side does not block', () => {
  assert.equal(joins({}, 'pending', { workspaceId: 'ws1', terminalId: 'term-other' }).bound, false)
  assert.equal(joins({ target_terminal_id: null }, 'pending', { workspaceId: 'ws1', terminalId: 'term-other' }).bound, true)
  assert.equal(joins({}, 'pending', { workspaceId: 'ws1' }).bound, true)
  assert.equal(joins({}, 'pending', { workspaceId: 'ws1', terminalId: null }).bound, true)
  assert.equal(joins({}, 'pending', { workspaceId: 'ws1', terminalId: 'term1' }).bound, true)
})

test('a marker that does not bind warns, naming the hand-off, agent and session', () => {
  const r = joins({}, 'draft')
  assert.deepEqual(r.warnings, [`marker ${H1} in codex session C1 does not bind; starting a new thread`])
  assert.deepEqual(joins({}, 'pending').warnings, [])
})

test('a marker for an unknown hand-off does not bind and does not throw, new or existing session', () => {
  withStore((s) => {
    const unknown = marker('h_00000000-0000-0000-0000-000000000000' as HandoffId, 't_00000000-0000-0000-0000-000000000000')
    const created = s.ingestParse({ agent: 'codex', nativeId: 'C1' }, parse([turn('c0')], [unknown]), WS, T0)
    assert.equal(created.warnings.length, 1)
    s.ingestParse({ agent: 'codex', nativeId: 'C1' }, parse([turn('c0')], [unknown]), WS, T0) // existing session: must not throw
  })
})

test('an existing session is delivered only by a binding marker whose hand-off targets that session', () => {
  const run = (status: HandoffStatus, targetsSession: boolean, markerThread?: string): string | undefined => {
    let out: string | undefined
    withStore((s) => {
      const sid = must(s.ingestParse({ agent: 'codex', nativeId: 'C1' }, parse([turn('c0')]), WS, T0).sessionId)
      const source = setup(s, { target_session_id: targetsSession ? sid : null })
      s.setHandoffStatus(H1, status, null, T0)
      s.ingestParse({ agent: 'codex', nativeId: 'C1' }, parse([turn('c0')], [marker(H1, markerThread ?? source)]), WS, T0 + 1)
      out = statusOf(s, H1)
    })
    return out
  }
  assert.equal(run('pending', true), 'delivered')
  assert.equal(run('unconfirmed', true), 'delivered')
  assert.equal(run('pending', false), 'pending') // binds, but aims at another session
  assert.equal(run('draft', true), 'draft') // aims at this session, but is not binding
  assert.equal(run('pending', true, 't_99999999-9999-9999-9999-999999999999'), 'pending')
})
