import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DRAFT_TTL_MS,
  PENDING_SWEEP_MS,
  assertNever,
  type ContextPackage,
  type HandoffId,
  type HandoffRow,
  type HandoffStatus,
  type ParseResult,
  type SessionId,
  type SessionRow,
  type ThreadId,
  type TurnRow
} from './types'

export const SCHEMA_VERSION = 2

export const MIGRATION_1 = `
CREATE TABLE threads (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_ord   INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE sessions (
  id             INTEGER PRIMARY KEY,
  agent          TEXT NOT NULL,
  native_id      TEXT NOT NULL,
  thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  workspace_id   TEXT,
  cwd            TEXT,
  source_path    TEXT,
  format_version TEXT,
  cursor         TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (agent, native_id)
);
CREATE TABLE handoffs (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  source_session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  source_agent       TEXT NOT NULL,
  target_agent       TEXT NOT NULL,
  target_session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  target_terminal_id TEXT,
  workspace_id       TEXT NOT NULL,
  strategy           TEXT NOT NULL CHECK (strategy IN ('launch','resume','launch-fallback')),
  mode               TEXT NOT NULL CHECK (mode IN ('full','delta')),
  covered_from_ord   INTEGER,
  covered_to_ord     INTEGER,
  selected           INTEGER NOT NULL,
  omitted            INTEGER NOT NULL,
  bytes              INTEGER NOT NULL CHECK (bytes <= 32768),
  lossy              INTEGER NOT NULL DEFAULT 0,
  package            TEXT CHECK (package IS NULL OR lossy = 0),
  status             TEXT NOT NULL CHECK (status IN ('draft','pending','delivered','unconfirmed','failed','expired')),
  error              TEXT,
  expires_at         INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE TABLE turns (
  id         INTEGER PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  native_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('user','assistant','command','file_change','tool_call')),
  text       TEXT NOT NULL DEFAULT '',
  paths      TEXT,
  tool       TEXT,
  source     TEXT NOT NULL CHECK (source IN ('conversation','handoff')),
  handoff_id TEXT REFERENCES handoffs(id) ON DELETE SET NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  at         INTEGER NOT NULL,
  UNIQUE (session_id, native_id),
  UNIQUE (thread_id, ord)
);
CREATE TABLE handoff_turns (
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  turn_id    INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  PRIMARY KEY (handoff_id, turn_id)
) WITHOUT ROWID;
CREATE INDEX handoffs_status    ON handoffs(status, updated_at);
CREATE INDEX handoffs_target    ON handoffs(target_session_id, status);
CREATE INDEX handoff_turns_turn ON handoff_turns(turn_id);
`

// §0.2: ADD COLUMN instead of a table rebuild (SQLite cannot alter a CHECK). Existing rows: chars 0, in_input 0, carried 1.
const MIGRATION_2 = `
ALTER TABLE handoffs      ADD COLUMN chars    INTEGER NOT NULL DEFAULT 0 CHECK (chars <= 4096);
ALTER TABLE handoffs      ADD COLUMN in_input INTEGER NOT NULL DEFAULT 0 CHECK (in_input IN (0, 1));
ALTER TABLE handoff_turns ADD COLUMN carried  INTEGER NOT NULL DEFAULT 1 CHECK (carried IN (0, 1));
`

/** A turn row plus the agent of the session that produced it. */
export type StoredTurn = TurnRow & { agent: string }
/** A covered turn of one hand-off: 1 carried whole, 0 omitted or excerpted. */
export type CoveredTurn = StoredTurn & { carried: 0 | 1 }

export interface IngestContext {
  workspaceId: string | null
  terminalId?: string | null
  sourcePath?: string | null
}
export interface IngestResult {
  sessionId: SessionId | null
  threadId: ThreadId | null
  inserted: number
  warnings: string[]
}

/** The hand-off fields a caller decides; createDraft fills the rest from the package. */
export type DraftInput = Pick<
  HandoffRow,
  | 'id'
  | 'thread_id'
  | 'source_session_id'
  | 'source_agent'
  | 'target_agent'
  | 'target_session_id'
  | 'target_terminal_id'
  | 'workspace_id'
  | 'strategy'
>

export type ClaimResult = 'claimed' | 'already_run' | 'expired' | 'missing'

export function openStore(path: string) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700) // mkdir mode is masked by umask and ignored for an existing dir
  if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
  chmodSync(path, 0o600)

  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;')

  // ponytail: no transaction helper in node:sqlite; nested calls are not supported.
  function tx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  const userVersion = () => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const version = userVersion()
  if (version > SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `context-switcher: database ${path} has user_version ${version}, newer than this plugin understands (${SCHEMA_VERSION})`
    )
  }
  if (version < 1)
    tx(() => {
      db.exec(`${MIGRATION_1}\nPRAGMA user_version = 1;`)
    })
  if (version < 2)
    tx(() => {
      db.exec(`${MIGRATION_2}\nPRAGMA user_version = 2;`)
    })

  const q = {
    session: db.prepare('SELECT * FROM sessions WHERE agent = ? AND native_id = ?'),
    handoff: db.prepare('SELECT * FROM handoffs WHERE id = ?'),
    newThread: db.prepare('INSERT INTO threads (id, created_at, updated_at) VALUES (?, ?, ?)'),
    touchThread: db.prepare('UPDATE threads SET updated_at = MAX(updated_at, ?) WHERE id = ?'),
    newSession: db.prepare(
      'INSERT INTO sessions (agent, native_id, thread_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
    ),
    saveSession: db.prepare(
      `UPDATE sessions SET cursor = ?, format_version = ?, cwd = COALESCE(?, cwd), source_path = COALESCE(?, source_path),
       workspace_id = COALESCE(workspace_id, ?), updated_at = ? WHERE id = ?`
    ),
    deliver: db.prepare(
      "UPDATE handoffs SET status = 'delivered', target_session_id = ?, package = NULL, error = NULL, in_input = 0, updated_at = ? WHERE id = ?"
    ),
    upsertTurn: db.prepare(
      `INSERT INTO turns (thread_id, session_id, ord, native_id, kind, text, paths, tool, source, handoff_id, active, at)
       VALUES (?, ?, (SELECT next_ord FROM threads WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (session_id, native_id) DO UPDATE SET active = 1
       RETURNING ord`
    ),
    nextOrd: db.prepare('SELECT next_ord FROM threads WHERE id = ?'),
    bumpOrd: db.prepare('UPDATE threads SET next_ord = next_ord + 1 WHERE id = ?'),
    reconcile: db.prepare(
      'UPDATE turns SET active = CASE WHEN native_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END WHERE session_id = ?'
    ),
    // The exact text is kept only while it may still be sent (§0.5); in_input only qualifies pending/unconfirmed.
    status: db.prepare(
      `UPDATE handoffs SET status = ?1, error = ?2, updated_at = ?3,
         package = CASE WHEN ?1 IN ('draft','pending') THEN package ELSE NULL END,
         in_input = CASE WHEN ?1 IN ('pending','unconfirmed') THEN in_input ELSE 0 END
       WHERE id = ?4`
    )
  }

  /** §0.2 binding rule 3; rule 4 adds the target-session check for an existing session. */
  function binds(h: HandoffRow | undefined, threadId: ThreadId, agent: string, ctx: IngestContext): h is HandoffRow {
    return (
      !!h &&
      (h.status === 'pending' || h.status === 'unconfirmed') &&
      h.thread_id === threadId &&
      h.target_agent === agent &&
      h.workspace_id === ctx.workspaceId &&
      (!h.target_terminal_id || !ctx.terminalId || h.target_terminal_id === ctx.terminalId)
    )
  }

  function ingestParse(key: { agent: string; nativeId: string }, parse: ParseResult, ctx: IngestContext, now = Date.now()): IngestResult {
    return tx(() => {
      const warnings: string[] = []
      let session = q.session.get(key.agent, key.nativeId) as SessionRow | undefined

      if (session) {
        for (const m of parse.markers) {
          const h = q.handoff.get(m.handoffId) as HandoffRow | undefined
          if (binds(h, m.threadId, key.agent, ctx) && h.target_session_id === session.id) {
            q.deliver.run(session.id, now, h.id)
          }
        }
      } else {
        // Rule 1: lazy create. Nothing to remember until the prompt is in the file.
        if (parse.turns.length === 0 && parse.markers.length === 0) return { sessionId: null, threadId: null, inserted: 0, warnings }
        let bound: HandoffRow | undefined
        for (const m of parse.markers) {
          const h = q.handoff.get(m.handoffId) as HandoffRow | undefined
          if (binds(h, m.threadId, key.agent, ctx)) {
            bound = h
            break
          }
          warnings.push(`marker ${m.handoffId} in ${key.agent} session ${key.nativeId} does not bind; starting a new thread`)
        }
        let threadId = bound?.thread_id
        if (!threadId) {
          threadId = `t_${randomUUID()}` as ThreadId
          q.newThread.run(threadId, now, now)
        }
        const { id } = q.newSession.get(key.agent, key.nativeId, threadId, ctx.workspaceId, now, now) as { id: SessionId }
        if (bound) q.deliver.run(id, now, bound.id)
        session = q.session.get(key.agent, key.nativeId) as SessionRow
      }

      const threadId = session.thread_id
      let inserted = 0
      for (const t of parse.turns) {
        // handoff_id is a foreign key: keep it only when we know the hand-off.
        const handoffId = t.handoffId && q.handoff.get(t.handoffId) ? t.handoffId : null
        const next = (q.nextOrd.get(threadId) as { next_ord: number }).next_ord
        const { ord } = q.upsertTurn.get(
          threadId,
          session.id,
          threadId,
          t.nativeId,
          t.kind,
          t.text,
          t.paths?.length ? JSON.stringify(t.paths) : null,
          t.tool ?? null,
          t.handoffId ? 'handoff' : 'conversation',
          handoffId,
          t.at
        ) as { ord: number }
        if (ord === next) {
          q.bumpOrd.run(threadId)
          inserted++
        }
      }
      if (parse.activeNativeIds) q.reconcile.run(JSON.stringify(parse.activeNativeIds), session.id)
      q.saveSession.run(
        JSON.stringify(parse.cursor),
        parse.formatVersion,
        parse.cwd ?? null,
        ctx.sourcePath ?? null,
        ctx.workspaceId,
        now,
        session.id
      )
      q.touchThread.run(now, threadId)
      return { sessionId: session.id, threadId, inserted, warnings }
    })
  }

  function createDraft(row: DraftInput, pkg: ContextPackage, now = Date.now()): void {
    tx(() => {
      db.prepare(
        `INSERT INTO handoffs (id, thread_id, source_session_id, source_agent, target_agent, target_session_id, target_terminal_id,
           workspace_id, strategy, mode, covered_from_ord, covered_to_ord, selected, omitted, bytes, chars, lossy, package, status,
           expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
      ).run(
        row.id,
        row.thread_id,
        row.source_session_id,
        row.source_agent,
        row.target_agent,
        row.target_session_id,
        row.target_terminal_id,
        row.workspace_id,
        row.strategy,
        pkg.mode,
        pkg.coveredFromOrd,
        pkg.coveredToOrd,
        pkg.selected,
        pkg.omitted,
        pkg.bytes,
        pkg.text.length,
        pkg.lossy ? 1 : 0,
        pkg.lossy ? null : pkg.text,
        now + DRAFT_TTL_MS,
        now,
        now
      )
      const link = db.prepare('INSERT INTO handoff_turns (handoff_id, turn_id, carried) VALUES (?, ?, ?)')
      for (const turnId of pkg.selectedTurnIds) link.run(row.id, turnId, 1)
      for (const turnId of pkg.omittedTurnIds) link.run(row.id, turnId, 0)
      q.touchThread.run(now, row.thread_id)
    })
  }

  /** draft → pending exactly once (§0.5), so a double click can't send twice. */
  function claimDraft(id: HandoffId, now = Date.now()): ClaimResult {
    return tx(() => {
      const r = db
        .prepare("UPDATE handoffs SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'draft' AND expires_at > ?")
        .run(now, id, now)
      if (Number(r.changes) === 1) return 'claimed'
      const h = q.handoff.get(id) as HandoffRow | undefined
      if (!h) return 'missing'
      switch (h.status) {
        case 'draft':
          q.status.run('expired', null, now, id)
          return 'expired'
        case 'expired':
          return 'expired'
        case 'pending':
        case 'delivered':
        case 'unconfirmed':
        case 'failed':
          return 'already_run'
        default:
          return assertNever(h)
      }
    })
  }

  function setHandoffStatus(id: HandoffId, status: HandoffStatus, error: string | null = null, now = Date.now()): void {
    q.status.run(status, error, now, id)
  }

  /** §0.6 L.4: the text reached the target's input but was not submitted. Only a pending/unconfirmed row qualifies. */
  function setInInput(id: HandoffId, now = Date.now()): boolean {
    return (
      Number(
        db.prepare("UPDATE handoffs SET in_input = 1, updated_at = ? WHERE id = ? AND status IN ('pending','unconfirmed')").run(now, id)
          .changes
      ) === 1
    )
  }

  /** §0.5 sweep: stale pending → unconfirmed, expired drafts → expired. Returns what changed. */
  function sweep(now = Date.now()): { id: HandoffId; status: HandoffStatus }[] {
    return tx(() => [
      ...(db
        .prepare(
          "UPDATE handoffs SET status = 'unconfirmed', package = NULL, updated_at = ? WHERE status = 'pending' AND updated_at <= ? RETURNING id, status"
        )
        .all(now, now - PENDING_SWEEP_MS) as { id: HandoffId; status: HandoffStatus }[]),
      ...(db
        .prepare(
          "UPDATE handoffs SET status = 'expired', package = NULL, updated_at = ? WHERE status = 'draft' AND expires_at <= ? RETURNING id, status"
        )
        .all(now, now) as { id: HandoffId; status: HandoffStatus }[])
    ])
  }

  /** §0.2 delta by coverage. No watermark: anything not delivered to the target stays eligible. */
  function eligibleTurns(threadId: ThreadId, targetSessionId?: SessionId): StoredTurn[] {
    if (targetSessionId === undefined) {
      return db
        .prepare(
          `SELECT t.*, s.agent FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE t.thread_id = ? AND t.source = 'conversation' AND t.active = 1 ORDER BY t.ord`
        )
        .all(threadId) as StoredTurn[]
    }
    return db
      .prepare(
        `SELECT t.*, s.agent FROM turns t JOIN sessions s ON s.id = t.session_id
       WHERE t.thread_id = ? AND t.source = 'conversation' AND t.active = 1 AND t.session_id <> ?
         AND t.id NOT IN (SELECT ht.turn_id FROM handoff_turns ht JOIN handoffs h ON h.id = ht.handoff_id
                          WHERE h.target_session_id = ? AND h.status = 'delivered' AND ht.carried = 1)
       ORDER BY t.ord`
      )
      .all(threadId, targetSessionId, targetSessionId) as StoredTurn[]
  }

  function threadTurns(threadId: ThreadId, after: number, limit: number): StoredTurn[] {
    return db
      .prepare(
        `SELECT t.*, s.agent FROM turns t JOIN sessions s ON s.id = t.session_id
       WHERE t.thread_id = ? AND t.ord > ? ORDER BY t.ord LIMIT ?`
      )
      .all(threadId, after, limit) as StoredTurn[]
  }

  /** `thread-read --handoff`: the omitted/excerpted turns (default) or every covered turn (`full`), in ord order. */
  function coveredFor(handoffId: HandoffId, opts: { full?: boolean } = {}): CoveredTurn[] {
    return db
      .prepare(
        `SELECT t.*, s.agent, ht.carried FROM handoff_turns ht JOIN turns t ON t.id = ht.turn_id JOIN sessions s ON s.id = t.session_id
       WHERE ht.handoff_id = ? AND (? OR ht.carried = 0) ORDER BY t.ord`
      )
      .all(handoffId, opts.full ? 1 : 0) as CoveredTurn[]
  }

  function targetSessionFor(threadId: ThreadId, agent: string): SessionRow | null {
    return (
      (db
        .prepare('SELECT * FROM sessions WHERE thread_id = ? AND agent = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
        .get(threadId, agent) as SessionRow | undefined) ?? null
    )
  }

  /** R19: drop threads idle for `days` (cascades) and dead drafts. `days <= 0` keeps everything. Returns threads deleted. */
  function prune(days: number, now = Date.now()): number {
    if (!(days > 0)) return 0
    return tx(() => {
      db.prepare("DELETE FROM handoffs WHERE status = 'expired' OR (status = 'draft' AND expires_at <= ?)").run(now)
      return Number(db.prepare('DELETE FROM threads WHERE updated_at < ?').run(now - days * 86_400_000).changes)
    })
  }

  return {
    db,
    path,
    userVersion,
    ingestParse,
    createDraft,
    claimDraft,
    setHandoffStatus,
    setInInput,
    sweep,
    eligibleTurns,
    threadTurns,
    coveredFor,
    targetSessionFor,
    prune,
    close: () => {
      db.close()
    }
  }
}

export type Store = ReturnType<typeof openStore>
