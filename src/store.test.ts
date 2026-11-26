import { assert, test } from 'orca/testing'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from './store'
import {
  DRAFT_TTL_MS,
  PENDING_SWEEP_MS,
  type CanonicalTurn,
  type ContextPackage,
  type HandoffId,
  type MarkerHit,
  type ParseResult,
  type ThreadId,
  type TurnId
} from './types'

const T0 = 1_700_000_000_000
const DAY = 86_400_000
const H1 = 'h_11111111-1111-1111-1111-111111111111' as HandoffId
const H2 = 'h_22222222-2222-2222-2222-222222222222' as HandoffId

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'cs-store-'))
}
function fresh(): Store {
  return openStore(join(tmp(), 'cs', 'context.sqlite'))
}
function turn(nativeId: string, kind: CanonicalTurn['kind'] = 'user', extra: Partial<CanonicalTurn> = {}): CanonicalTurn {
  return { nativeId, kind, text: nativeId, at: T0, ...extra }
}
function parse(turns: CanonicalTurn[], extra: Partial<ParseResult> = {}): ParseResult {
  return {
    turns,
    cursor: { kind: 'offset', file: { path: '/x.jsonl', dev: 1, ino: 1, size: 10 }, offset: 10 },
    formatVersion: 'test-v1',
    markers: [],
    ...extra
  }
}
const WS = { workspaceId: 'ws1', terminalId: 'term1' }

function ingest(s: Store, agent: string, nativeId: string, turns: CanonicalTurn[], extra: Partial<ParseResult> = {}, ctx = WS, now = T0) {
  return s.ingestParse({ agent, nativeId }, parse(turns, extra), ctx, now)
}
function pkg(selectedTurnIds: TurnId[], over: Partial<ContextPackage> = {}): ContextPackage {
  return {
    text: 'pkg',
    bytes: 3,
    mode: 'full',
    selectedTurnIds,
    omittedTurnIds: [],
    selected: selectedTurnIds.length,
    omitted: 0,
    coveredFromOrd: null,
    coveredToOrd: null,
    lossy: false,
    threadReadCommand: 'node x',
    ...over
  }
}
function draft(
  s: Store,
  id: HandoffId,
  threadId: ThreadId,
  targetAgent: string,
  selectedTurnIds: TurnId[],
  now = T0,
  over: Record<string, unknown> = {}
) {
  s.createDraft(
    {
      id,
      thread_id: threadId,
      source_session_id: null,
      source_agent: 'claude',
      target_agent: targetAgent,
      target_session_id: null,
      target_terminal_id: 'term1',
      workspace_id: 'ws1',
      strategy: 'launch',
      ...over
    },
    pkg(selectedTurnIds),
    now
  )
}
function status(s: Store, id: string): { status: string; package: string | null } {
  return { ...(s.db.prepare('SELECT status, package FROM handoffs WHERE id = ?').get(id) as { status: string; package: string | null }) }
}
function marker(handoffId: HandoffId, threadId: ThreadId, nativeId = 'm#0'): MarkerHit {
  return { handoffId, threadId, nativeId, userRecordIndex: 0 }
}
const texts = (rows: { text: string }[]) => rows.map((r) => r.text).sort()

// ---- Migration ----

test('migrates from 0, re-open is idempotent, newer user_version is refused', () => {
  const path = join(tmp(), 'context.sqlite')
  const a = openStore(path)
  assert.equal(a.userVersion(), 2)
  a.close()
  const b = openStore(path)
  assert.equal(b.userVersion(), 2)
  b.db.exec('PRAGMA user_version = 3')
  b.close()
  assert.throws(() => openStore(path), /newer/)
})

// ---- Ingest and join ----

test('re-ingesting the same parse adds nothing', () => {
  const s = fresh()
  const p = [turn('a#0'), turn('a#1', 'assistant')]
  const first = ingest(s, 'claude', 'A', p)
  ingest(s, 'claude', 'A', p)
  assert.equal(s.threadTurns(first.threadId!, 0, 100).length, 2)
  const t = s.db.prepare('SELECT next_ord FROM threads WHERE id = ?').get(first.threadId) as { next_ord: number }
  assert.equal(t.next_ord, 3)
})

test('a parse with no turns and no markers creates no session row', () => {
  const s = fresh()
  const r = ingest(s, 'claude', 'A', [])
  assert.equal(r.sessionId, null)
  assert.equal((s.db.prepare('SELECT count(*) n FROM sessions').get() as { n: number }).n, 0)
})

test('a marker hit that binds joins the thread and marks the hand-off delivered', () => {
  const s = fresh()
  const a = ingest(s, 'claude', 'A', [turn('a#0')])
  const thread = a.threadId!
  draft(s, H1, thread, 'codex', [])
  assert.equal(s.claimDraft(H1, T0 + 1), 'claimed')
  const b = ingest(s, 'codex', 'B', [turn('m#0', 'user', { handoffId: H1 }), turn('b#0', 'assistant')], { markers: [marker(H1, thread)] })
  assert.equal(b.threadId, thread)
  assert.deepEqual(status(s, H1), { status: 'delivered', package: null })
  const row = s.db.prepare('SELECT target_session_id FROM handoffs WHERE id = ?').get(H1) as { target_session_id: number }
  assert.equal(row.target_session_id, b.sessionId)
  const m = s.db.prepare("SELECT source, handoff_id FROM turns WHERE native_id = 'm#0'").get() as { source: string; handoff_id: string }
  assert.deepEqual({ ...m }, { source: 'handoff', handoff_id: H1 })
})

test('a marker hit for another agent or workspace starts a new thread and leaves the hand-off pending', () => {
  const s = fresh()
  const thread = ingest(s, 'claude', 'A', [turn('a#0')]).threadId!
  draft(s, H1, thread, 'codex', [])
  s.claimDraft(H1, T0 + 1)
  const wrongAgent = ingest(s, 'pi', 'P', [turn('m#0', 'user', { handoffId: H1 })], { markers: [marker(H1, thread)] })
  assert.notEqual(wrongAgent.threadId, thread)
  assert.ok(wrongAgent.warnings.length > 0)
  const wrongWs = ingest(
    s,
    'codex',
    'B',
    [turn('m#0', 'user', { handoffId: H1 })],
    { markers: [marker(H1, thread)] },
    { workspaceId: 'ws2', terminalId: 'term1' }
  )
  assert.notEqual(wrongWs.threadId, thread)
  const wrongTerm = ingest(
    s,
    'codex',
    'C',
    [turn('m#0', 'user', { handoffId: H1 })],
    { markers: [marker(H1, thread)] },
    { workspaceId: 'ws1', terminalId: 'other' }
  )
  assert.notEqual(wrongTerm.threadId, thread)
  assert.equal(status(s, H1).status, 'pending')
  const m = s.db.prepare("SELECT source FROM turns WHERE native_id = 'm#0' AND session_id = ?").get(wrongAgent.sessionId) as {
    source: string
  }
  assert.equal(m.source, 'handoff')
})

test('a marker in an existing session never moves it, but delivers a hand-off that targets it', () => {
  const s = fresh()
  const t1 = ingest(s, 'claude', 'A', [turn('a#0')]).threadId!
  const b = ingest(s, 'codex', 'B', [turn('b#0')])
  draft(s, H1, t1, 'codex', [], T0, { target_session_id: b.sessionId, strategy: 'resume' })
  s.claimDraft(H1, T0 + 1)
  const again = ingest(s, 'codex', 'B', [turn('b#0'), turn('m#0', 'user', { handoffId: H1 })], { markers: [marker(H1, t1)] })
  assert.equal(again.threadId, b.threadId)
  assert.equal(status(s, H1).status, 'delivered')
})

test('activeNativeIds flips turns to active=0 and back', () => {
  const s = fresh()
  const p = [turn('e1#0'), turn('e2#0', 'assistant'), turn('e3#0')]
  const r = ingest(s, 'pi', 'P', p, { activeNativeIds: ['e1#0', 'e2#0', 'e3#0'] })
  const active = () => s.threadTurns(r.threadId!, 0, 10).map((t) => `${t.native_id}:${t.active}`)
  ingest(s, 'pi', 'P', p.slice(0, 1), { activeNativeIds: ['e1#0'] })
  assert.deepEqual(active(), ['e1#0:1', 'e2#0:0', 'e3#0:0'])
  ingest(s, 'pi', 'P', p, { activeNativeIds: ['e1#0', 'e2#0', 'e3#0'] })
  assert.deepEqual(active(), ['e1#0:1', 'e2#0:1', 'e3#0:1'])
})

// ---- Coverage ([WM]) ----

test("coverage: A:2 ingested after B:1 stays in B's delta (fails under a MAX(ord) watermark)", () => {
  const s = fresh()
  const a = ingest(s, 'claude', 'A', [turn('A:1')])
  const thread = a.threadId!
  const a1 = s.eligibleTurns(thread).map((t) => t.id)
  draft(s, H1, thread, 'codex', a1)
  s.claimDraft(H1, T0 + 1)
  const b = ingest(s, 'codex', 'B', [turn('m#0', 'user', { handoffId: H1 }), turn('B:1', 'assistant')], { markers: [marker(H1, thread)] })
  ingest(s, 'claude', 'A', [turn('A:1'), turn('A:2')])
  ingest(s, 'codex', 'B', [turn('m#0', 'user', { handoffId: H1 }), turn('B:1', 'assistant'), turn('B:2', 'assistant')], {
    markers: [marker(H1, thread)]
  })
  assert.deepEqual(texts(s.eligibleTurns(thread, a.sessionId!)), ['B:1', 'B:2'])
  assert.deepEqual(texts(s.eligibleTurns(thread, b.sessionId!)), ['A:2'])
})

test('coverage: turns from unconfirmed or failed hand-offs, and omitted turns, stay eligible', () => {
  const s = fresh()
  const a = ingest(s, 'claude', 'A', [turn('A:1'), turn('A:2'), turn('A:3')])
  const thread = a.threadId!
  const b = ingest(s, 'codex', 'B', [turn('B:1')])
  const [t1, t2] = s.eligibleTurns(thread, b.sessionId!).map((t) => t.id)
  // H1 carried A:1 but never got confirmed; H2 carried A:2 and failed. A:3 was omitted by both.
  draft(s, H1, thread, 'codex', [t1!], T0, { target_session_id: b.sessionId })
  draft(s, H2, thread, 'codex', [t2!], T0, { target_session_id: b.sessionId })
  s.setHandoffStatus(H1, 'unconfirmed', null, T0)
  s.setHandoffStatus(H2, 'failed', 'boom', T0)
  assert.deepEqual(texts(s.eligibleTurns(thread, b.sessionId!)), ['A:1', 'A:2', 'A:3'])
})

// ---- Drafts and sweep ----

test('claimDraft runs once; an expired draft cannot be claimed', () => {
  const s = fresh()
  const thread = ingest(s, 'claude', 'A', [turn('a#0')]).threadId!
  draft(s, H1, thread, 'codex', [])
  assert.equal(s.claimDraft(H1, T0 + 1), 'claimed')
  assert.equal(s.claimDraft(H1, T0 + 2), 'already_run')
  draft(s, H2, thread, 'codex', [])
  assert.equal(s.claimDraft(H2, T0 + DRAFT_TTL_MS + 1), 'expired')
  assert.deepEqual(status(s, H2), { status: 'expired', package: null })
})

test('sweep: old pending → unconfirmed, old draft → expired, package NULL', () => {
  const s = fresh()
  const thread = ingest(s, 'claude', 'A', [turn('a#0')]).threadId!
  draft(s, H1, thread, 'codex', [])
  s.claimDraft(H1, T0)
  draft(s, H2, thread, 'codex', [])
  assert.equal(status(s, H1).package, 'pkg')
  const changed = s.sweep(T0 + PENDING_SWEEP_MS)
  assert.deepEqual(changed.map((c) => `${c.id}:${c.status}`).sort(), [`${H1}:unconfirmed`, `${H2}:expired`])
  assert.deepEqual(status(s, H1), { status: 'unconfirmed', package: null })
  assert.deepEqual(status(s, H2), { status: 'expired', package: null })
})

// ---- Schema and storage ----

test('turns has no output or reasoning column', () => {
  const s = fresh()
  const cols = (s.db.prepare('PRAGMA table_info(turns)').all() as { name: string }[]).map((c) => c.name)
  assert.ok(!cols.some((c) => /output|reasoning|content/.test(c)), cols.join(','))
})

test('a lossy hand-off with a non-NULL package violates the CHECK', () => {
  const s = fresh()
  const thread = ingest(s, 'claude', 'A', [turn('a#0')]).threadId!
  assert.throws(
    () =>
      s.db
        .prepare(
          `INSERT INTO handoffs (id, thread_id, source_agent, target_agent, workspace_id, strategy, mode, selected, omitted, bytes, lossy, package, status, created_at, updated_at)
       VALUES (?, ?, 'antigravity', 'claude', 'ws1', 'launch', 'full', 0, 0, 3, 1, 'secret', 'draft', 0, 0)`
        )
        .run(H1, thread),
    /CHECK/
  )
  // createDraft never writes lossy text either.
  s.createDraft(
    {
      id: H2,
      thread_id: thread,
      source_session_id: null,
      source_agent: 'antigravity',
      target_agent: 'claude',
      target_session_id: null,
      target_terminal_id: null,
      workspace_id: 'ws1',
      strategy: 'launch'
    },
    pkg([], { lossy: true }),
    T0
  )
  assert.equal(status(s, H2).package, null)
})

test('targetSessionFor picks the newest of two sessions of that agent', () => {
  const s = fresh()
  const a = ingest(s, 'claude', 'A', [turn('a#0')], {}, WS, T0)
  draft(s, H1, a.threadId!, 'claude', [])
  s.claimDraft(H1, T0)
  const c2 = ingest(s, 'claude', 'C2', [turn('m#0', 'user', { handoffId: H1 })], { markers: [marker(H1, a.threadId!)] }, WS, T0 + 1000)
  assert.equal(s.targetSessionFor(a.threadId!, 'claude')?.id, c2.sessionId)
  assert.equal(s.targetSessionFor(a.threadId!, 'codex'), null)
})

// ---- Prune ----

test('prune keys on thread updated_at; prune(0) deletes nothing', () => {
  const s = fresh()
  const now = T0 + 400 * DAY
  // Live thread: first session idle 200 days, second joined via hand-off yesterday.
  const old = ingest(s, 'claude', 'A', [turn('a#0')], {}, WS, now - 200 * DAY)
  draft(s, H1, old.threadId!, 'codex', [], now - DAY)
  s.claimDraft(H1, now - DAY)
  ingest(s, 'codex', 'B', [turn('m#0', 'user', { handoffId: H1 })], { markers: [marker(H1, old.threadId!)] }, WS, now - DAY)
  const idle = ingest(s, 'pi', 'P', [turn('p#0')], {}, WS, now - 91 * DAY)
  assert.equal(s.prune(0, now), 0)
  assert.equal(s.prune(90, now), 1)
  assert.equal(s.threadTurns(old.threadId!, 0, 10).length, 2)
  assert.equal(s.threadTurns(idle.threadId!, 0, 10).length, 0)
  assert.equal((s.db.prepare('SELECT count(*) n FROM sessions').get() as { n: number }).n, 2)
})

// ---- File modes ----

test('dir is 0700 and DB 0600, also when the dir already existed as 0755', () => {
  for (const preexisting of [false, true]) {
    const dir = join(tmp(), 'cs')
    if (preexisting) {
      mkdirSync(dir, { mode: 0o755 })
      chmodSync(dir, 0o755)
    }
    const s = openStore(join(dir, 'context.sqlite'))
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, 'context.sqlite')).mode & 0o777, 0o600)
    s.close()
  }
})

test('the DB is WAL with foreign keys on', () => {
  const path = join(tmp(), 'context.sqlite')
  openStore(path).close()
  const raw = new DatabaseSync(path)
  assert.equal((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
  raw.close()
})
