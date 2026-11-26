import { assert, test } from 'orca/testing'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATION_1, openStore, type Store } from './store'
import type { CanonicalTurn, ContextPackage, HandoffId, ParseResult, ThreadId, TurnId } from './types'

const T0 = 1_700_000_000_000
const H1 = 'h_11111111-1111-1111-1111-111111111111' as HandoffId
const H2 = 'h_22222222-2222-2222-2222-222222222222' as HandoffId
const WS = { workspaceId: 'ws1', terminalId: 'term1' }

const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'cs-mig-')), 'context.sqlite')
const turn = (nativeId: string, extra: Partial<CanonicalTurn> = {}): CanonicalTurn => ({
  nativeId,
  kind: 'user',
  text: nativeId,
  at: T0,
  ...extra
})
const parse = (turns: CanonicalTurn[], extra: Partial<ParseResult> = {}): ParseResult => ({
  turns,
  cursor: { kind: 'offset', file: { path: '/x', dev: 1, ino: 1, size: 1 }, offset: 1 },
  formatVersion: 'v1',
  markers: [],
  ...extra
})
function pkg(selectedTurnIds: TurnId[], omittedTurnIds: TurnId[], text = 'pkg é'): ContextPackage {
  return {
    text,
    bytes: 0,
    mode: 'delta',
    selectedTurnIds,
    omittedTurnIds,
    selected: selectedTurnIds.length,
    omitted: omittedTurnIds.length,
    coveredFromOrd: null,
    coveredToOrd: null,
    lossy: false,
    threadReadCommand: 'node x'
  }
}
function draft(s: Store, id: HandoffId, threadId: ThreadId, sel: TurnId[], omit: TurnId[], text?: string) {
  s.createDraft(
    {
      id,
      thread_id: threadId,
      source_session_id: null,
      source_agent: 'claude',
      target_agent: 'codex',
      target_session_id: null,
      target_terminal_id: 'term1',
      workspace_id: 'ws1',
      strategy: 'launch'
    },
    pkg(sel, omit, text),
    T0
  )
}
const inInput = (s: Store, id: string) =>
  (s.db.prepare('SELECT in_input FROM handoffs WHERE id = ?').get(id) as { in_input: number }).in_input

test('upgrade: a PR1 database at user_version 1 gets chars 0, in_input 0, carried 1; re-open is idempotent', () => {
  const path = tmpPath()
  const raw = new DatabaseSync(path)
  raw.exec(`${MIGRATION_1}\nPRAGMA user_version = 1;`)
  raw.exec(`INSERT INTO threads (id, created_at, updated_at) VALUES ('t1', 0, 0);
    INSERT INTO sessions (id, agent, native_id, thread_id, created_at, updated_at) VALUES (1, 'claude', 'A', 't1', 0, 0);
    INSERT INTO turns (id, thread_id, session_id, ord, native_id, kind, source, at) VALUES (1, 't1', 1, 1, 'a', 'user', 'conversation', 0), (2, 't1', 1, 2, 'b', 'user', 'conversation', 0);
    INSERT INTO handoffs (id, thread_id, source_agent, target_agent, workspace_id, strategy, mode, selected, omitted, bytes, status, created_at, updated_at)
      VALUES ('${H1}', 't1', 'claude', 'codex', 'ws1', 'launch', 'full', 2, 0, 3, 'delivered', 0, 0);
    INSERT INTO handoff_turns (handoff_id, turn_id) VALUES ('${H1}', 1), ('${H1}', 2);`)
  raw.close()

  const a = openStore(path)
  assert.equal(a.userVersion(), 2)
  assert.deepEqual({ ...(a.db.prepare('SELECT chars, in_input FROM handoffs').get() as object) }, { chars: 0, in_input: 0 })
  assert.deepEqual(
    a.db
      .prepare('SELECT carried FROM handoff_turns ORDER BY turn_id')
      .all()
      .map((r) => (r as { carried: number }).carried),
    [1, 1]
  )
  a.close()
  const b = openStore(path)
  assert.equal(b.userVersion(), 2)
  assert.equal((b.db.prepare('SELECT count(*) n FROM handoff_turns').get() as { n: number }).n, 2)
  b.close()
})

test('CHECKs: chars 4097, in_input 2 and carried 2 are rejected', () => {
  const s = openStore(tmpPath())
  const thread = s.ingestParse({ agent: 'claude', nativeId: 'A' }, parse([turn('a#0')]), WS, T0).threadId!
  const ins = (chars: number, inIn: number) =>
    s.db
      .prepare(
        `INSERT INTO handoffs (id, thread_id, source_agent, target_agent, workspace_id, strategy, mode, selected, omitted, bytes, chars, in_input, status, created_at, updated_at)
     VALUES (?, ?, 'claude', 'codex', 'ws1', 'launch', 'full', 0, 0, 0, ?, ?, 'draft', 0, 0)`
      )
      .run(`h_${chars}_${inIn}`, thread, chars, inIn)
  assert.throws(() => ins(4097, 0), /CHECK/)
  assert.throws(() => ins(0, 2), /CHECK/)
  ins(4096, 1)
  const turnId = s.eligibleTurns(thread)[0]!.id
  assert.throws(
    () => s.db.prepare("INSERT INTO handoff_turns (handoff_id, turn_id, carried) VALUES ('h_4096_1', ?, 2)").run(turnId),
    /CHECK/
  )
})

test("createDraft writes chars and carried 0 rows; omitted turns stay in a delivered target's delta; coveredFor reads them back", () => {
  const s = openStore(tmpPath())
  const a = s.ingestParse({ agent: 'claude', nativeId: 'A' }, parse([turn('A:1'), turn('A:2'), turn('A:3')]), WS, T0)
  const thread = a.threadId!
  const [a1, a2, a3] = s.eligibleTurns(thread).map((t) => t.id)
  draft(s, H1, thread, [a1!, a3!], [a2!], 'é😀x')
  assert.equal((s.db.prepare('SELECT chars FROM handoffs WHERE id = ?').get(H1) as { chars: number }).chars, 4)
  s.claimDraft(H1, T0 + 1)
  const b = s.ingestParse(
    { agent: 'codex', nativeId: 'B' },
    parse([turn('m#0', { handoffId: H1 }), turn('B:1', { kind: 'assistant' })], {
      markers: [{ handoffId: H1, threadId: thread, nativeId: 'm#0', userRecordIndex: 0 }]
    }),
    WS,
    T0 + 2
  )
  assert.equal(b.threadId, thread)
  assert.deepEqual(
    s.eligibleTurns(thread, b.sessionId!).map((t) => t.text),
    ['A:2']
  )

  assert.deepEqual(
    s.coveredFor(H1).map((t) => [t.ord, t.text, t.agent, t.carried]),
    [[2, 'A:2', 'claude', 0]]
  )
  assert.deepEqual(
    s.coveredFor(H1, { full: true }).map((t) => [t.text, t.carried]),
    [
      ['A:1', 1],
      ['A:2', 0],
      ['A:3', 1]
    ]
  )
  assert.deepEqual(s.coveredFor('h_none' as HandoffId), [])
})

test('in_input: set only while pending/unconfirmed, cleared by delivered/failed/expired', () => {
  const s = openStore(tmpPath())
  const thread = s.ingestParse({ agent: 'claude', nativeId: 'A' }, parse([turn('a#0')]), WS, T0).threadId!
  draft(s, H1, thread, [], [])
  assert.equal(s.setInInput(H1), false) // still a draft
  assert.equal(inInput(s, H1), 0)
  s.claimDraft(H1, T0 + 1)
  assert.equal(s.setInInput(H1), true)
  assert.equal(inInput(s, H1), 1)
  s.setHandoffStatus(H1, 'unconfirmed', null, T0 + 2)
  assert.equal(inInput(s, H1), 1)
  s.setHandoffStatus(H1, 'delivered', null, T0 + 3)
  assert.equal(inInput(s, H1), 0)
  assert.equal(s.setInInput(H1), false)
  assert.equal(inInput(s, H1), 0)

  // The ingest bind path (direct deliver statement) clears it too.
  draft(s, H2, thread, [], [])
  s.claimDraft(H2, T0 + 1)
  s.setInInput(H2)
  s.ingestParse(
    { agent: 'codex', nativeId: 'B' },
    parse([turn('m#0', { handoffId: H2 })], { markers: [{ handoffId: H2, threadId: thread, nativeId: 'm#0', userRecordIndex: 0 }] }),
    WS,
    T0 + 4
  )
  assert.equal(inInput(s, H2), 0)
  for (const st of ['failed', 'expired'] as const) {
    s.db.prepare("UPDATE handoffs SET status = 'pending', in_input = 1 WHERE id = ?").run(H2)
    s.setHandoffStatus(H2, st, null, T0 + 5)
    assert.equal(inInput(s, H2), 0, st)
  }
})
