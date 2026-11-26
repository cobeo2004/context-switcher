/** Agents with a native-session adapter (R5). */
export type AdapterAgent = 'claude' | 'codex' | 'pi' | 'cursor'

/** Canonical turn kinds (R5). Whole turns are the selection unit (R12). */
export type TurnKind = 'user' | 'assistant' | 'command' | 'file_change' | 'tool_call'

/** What an adapter emits. Never tool output, file contents or reasoning (R10). */
export interface CanonicalTurn {
  nativeId: string // stable and unique inside one session, see §0.4
  kind: TurnKind
  text: string // user/assistant text; command line for 'command'; '' otherwise
  paths?: string[] // touched file paths (file_change, path-bearing tool_call)
  tool?: string // tool name (tool_call, and command when the tool is known)
  at: number // ms epoch; 0 when the format has none
  handoffId?: string // set when this turn carries a hand-off marker → stored as source='handoff'
}

/** File identity, used by every cursor (recovery after truncation, replacement, .jsonl → .jsonl.zst). */
export interface FileId {
  path: string
  dev: number
  ino: number
  size: number
}

/** Per-agent ingest cursor (D3 / recon diff 3). */
export type Cursor =
  | { kind: 'offset'; file: FileId; offset: number } // claude, codex (offset in the decompressed stream for .zst)
  | { kind: 'snapshot'; file: FileId; root?: string } // pi (whole-file re-read), cursor (root = latestRootBlobId; equal root + equal file ⇒ skip)
// Recovery rule (all kinds): stat differs in dev/ino, or size < file.size ⇒ discard the cursor and re-parse from the start.
// Idempotent native ids (§0.4) make the re-parse safe.

/** A hand-off marker found in a raw user record before any injection filter (§0.2 join rule). */
export interface MarkerHit {
  handoffId: string
  threadId: string
  nativeId: string
  userRecordIndex: number
}

export interface ParseResult {
  turns: CanonicalTurn[]
  cursor: Cursor
  formatVersion: string // what the adapter matched, stored on the session row
  cwd?: string
  markers: MarkerHit[] // from the first MARKER_SCAN_USER_RECORDS raw user records, pre-filter
  activeNativeIds?: string[] // pi, cursor: the full active branch; turns not listed become active = 0
}

/** R7. v1 ships LocalSessionSource only. Every adapter read goes through it, including SQLite. */
export interface SessionSource {
  list(dir: string): Promise<string[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number; dev: number; ino: number } | null>
  read(path: string, from?: number): Promise<Uint8Array> // bytes from offset to EOF
  /** Opens the live DB read-only and runs fn inside one read transaction (one WAL snapshot). No file copy. */
  withSqliteSnapshot<T>(path: string, fn: (q: SqliteReader) => T): Promise<T>
}
export interface SqliteReader {
  all(sql: string, ...params: (string | number)[]): Record<string, unknown>[]
}

/** @public PR3 adapter contract */
export interface Adapter {
  agent: AdapterAgent
  formatVersion: string // declared, e.g. 'pi-session-v3' (R5)
  locate(src: SessionSource, q: { sessionId: string; cwd: string; home: string; cached?: string }): Promise<string> // throws SessionNotFound
  parse(src: SessionSource, path: string, cursor: Cursor | null): Promise<ParseResult> // throws UnsupportedFormat
}

/** @public PR3 adapter contract */
export class UnsupportedFormat extends Error {
  readonly agent: string
  readonly detail: string
  constructor(agent: string, detail: string) {
    super(`${agent}: unsupported session format (${detail})`)
    this.agent = agent
    this.detail = detail
  }
}
/** @public PR3 adapter contract */
export class SessionNotFound extends Error {}

export type HandoffStatus = 'draft' | 'pending' | 'delivered' | 'unconfirmed' | 'failed' | 'expired' // R15 widened, §3 decision 6

/** Rows (mirror the DDL). */
/** @public PR3 adapter contract */
export interface ThreadRow {
  id: string
  created_at: number
  updated_at: number
  next_ord: number
}
export interface SessionRow {
  id: number
  agent: string
  native_id: string
  thread_id: string
  workspace_id: string | null
  cwd: string | null
  source_path: string | null
  format_version: string | null
  cursor: string | null /* JSON Cursor */
  created_at: number
  updated_at: number
}
export interface TurnRow {
  id: number
  thread_id: string
  session_id: number
  ord: number
  native_id: string
  kind: TurnKind
  text: string
  paths: string | null /* JSON string[] */
  tool: string | null
  source: 'conversation' | 'handoff'
  handoff_id: string | null
  active: 0 | 1
  at: number
}
export interface HandoffRow {
  id: string
  thread_id: string
  source_session_id: number | null
  source_agent: string
  target_agent: string
  target_session_id: number | null
  target_terminal_id: string | null
  workspace_id: string
  strategy: 'launch' | 'resume' | 'launch-fallback'
  mode: 'full' | 'delta'
  covered_from_ord: number | null
  covered_to_ord: number | null
  selected: number
  omitted: number
  bytes: number
  lossy: 0 | 1
  package: string | null // exact text while draft/pending, non-lossy only; NULL once settled
  status: HandoffStatus
  error: string | null
  expires_at: number | null
  created_at: number
  updated_at: number
}

/** R12 input/output. */
export interface ContextTarget {
  agent: string
  sessionId?: number
} // sessionId set ⇒ that session is in the thread ⇒ delta
export interface BuildContextInput {
  threadId: string
  target: ContextTarget
  budget: number
  purpose: 'switch' | 'delegate'
  handoffId: string
}
export interface ContextPackage {
  text: string // exactly what is delivered
  bytes: number // Buffer.byteLength(text, 'utf8')
  mode: 'full' | 'delta'
  selectedTurnIds: number[] // DB turn ids carried (→ handoff_turns); [] for lossy
  omittedTurnIds: number[] // eligible ids not carried whole (skipped, or excerpted by rule E) → handoff_turns carried = 0; [] for lossy
  selected: number
  omitted: number
  coveredFromOrd: number | null
  coveredToOrd: number | null
  lossy: boolean
  threadReadCommand: string
}
export const HARD_CAP = 4096
export const DRAFT_TTL_MS = 10 * 60_000
export const PENDING_SWEEP_MS = 10 * 60_000 // pending older than this ⇒ unconfirmed
/** First line: `[context-switcher handoff h_<uuid> thread t_<uuid>]`. Must not start with '<': the Claude and Codex adapters drop user text starting with '<' as injected. */
export const HANDOFF_MARKER = '[context-switcher handoff '
/** @public PR3 adapter contract */
export const MARKER_RE = /\[context-switcher handoff (h_[0-9a-f-]{36}) thread (t_[0-9a-f-]{36})\]/
