// Plan rows 8.3 and 8.5: sources, targets, the frozen preview (a draft row) and background delivery (§0.5).
// Host-free: worker.ts passes the Orca calls in as plain callbacks.
import { randomUUID } from 'node:crypto'
import { buildContext } from './context'
import { confirmOnScreen, deliverText, type DeliverHost, type StatusEvent } from './deliver'
import type { StatusEvent as IngestEvent } from './ingest'
import type { Run } from './proc'
import { profileFor } from './readiness'
import type { Store } from './store'
import { DRAFT_TTL_MS, HANDOFF_MARKER, HARD_CAP, type ContextPackage, type HandoffId, type HandoffRow, type ThreadId } from './types'

interface AgentRow {
  terminalId: string | null
  agent: string | null
  state: string
  stateStartedAt: number
  sessionId?: string | null
}

export interface SwitchDeps {
  store: () => Store | null
  focused: () => Promise<{ workspaceId?: string; displayName: string } | null>
  workspaces: () => Promise<{ id: string; name: string; hostId: string | null }[]>
  agents: (workspaceId?: string) => Promise<AgentRow[]>
  launch: (workspaceId: string, agent: string) => Promise<{ terminalId: string }>
  resume: (workspaceId: string, agent: string, sessionId: string) => Promise<{ terminalId: string; started: boolean }>
  activate: (workspaceId: string) => Promise<unknown>
  focus: (terminalId: string) => Promise<unknown>
  read: DeliverHost['read']
  sendText: DeliverHost['sendText']
  ingest: (evt: IngestEvent) => Promise<'unsupported' | undefined>
  budget: () => Promise<number | null>
  notify: (body: string) => Promise<void>
  post: (change: { handoffId: string; status: HandoffRow['status']; inInput: boolean; error?: string }) => void
  runCli: Run
  now: () => number
  sleep: (ms: number) => Promise<void>
}

// v0.1 adapter agents (ingest.ts ADAPTERS): their hand-off is delivered when ingest binds the marker.
const ADAPTER_AGENTS = new Set(['claude', 'codex'])
const STATIC_TARGETS = ['claude', 'codex', 'pi', 'cursor', 'antigravity', 'opencode']
/** `agent.resume`'s enum ([HA]) minus pi and prime-agent, which cannot resume by id ([RE]). */
const RESUME_AGENTS = [
  'claude',
  'codebuddy',
  'codex',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'gemini',
  'antigravity',
  'opencode',
  'opencode2',
  'mimo-code',
  'droid',
  'grok',
  'devin',
  'omp',
  'copilot',
  'cursor',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro',
  'hermes'
] as const
type ResumeAgent = (typeof RESUME_AGENTS)[number]
const RESUMABLE: ReadonlySet<string> = new Set(RESUME_AGENTS)
export const isResumeAgent = (agent: string): agent is ResumeAgent => RESUMABLE.has(agent)

const label = (agent: string) => agent.charAt(0).toUpperCase() + agent.slice(1)
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** `orca agent installed --json` → agent ids, or null when the CLI is missing or answers something else. */
function installedIds(stdout: string): string[] | null {
  const v: unknown = JSON.parse(stdout)
  const agents = isRec(v) && isRec(v['result']) ? v['result']['agents'] : undefined
  if (!Array.isArray(agents)) return null
  return agents.flatMap((a: unknown) => (isRec(a) && typeof a['id'] === 'string' ? [a['id']] : []))
}

export function createSwitch(deps: SwitchDeps) {
  const listeners = new Set<StatusEvent[]>()

  /** The in-worker `agent.status.changed` fan-out: each delivery keeps its own event log (rule L). */
  function onStatus(e: { terminalId?: string; state: string; receivedAt: number }): void {
    for (const log of listeners) log.push({ terminalId: e.terminalId ?? null, state: e.state, receivedAt: e.receivedAt })
  }

  async function workspace() {
    const ctx = await deps.focused()
    if (!ctx?.workspaceId) return null
    const id = ctx.workspaceId
    const row = (await deps.workspaces()).find((w) => w.id === id)
    return { id, name: row?.name ?? ctx.displayName, remote: !!row?.hostId && row.hostId !== 'local' }
  }

  /** R3: the focused workspace's agents; the only one, else the one whose state started last. */
  async function sources() {
    const rows = (await deps.agents()).flatMap((a) =>
      a.terminalId && a.agent
        ? [
            {
              terminalId: a.terminalId,
              agent: a.agent,
              sessionId: a.sessionId ?? null,
              supported: ADAPTER_AGENTS.has(a.agent),
              stateStartedAt: a.stateStartedAt
            }
          ]
        : []
    )
    const best = rows.reduce<(typeof rows)[number] | null>((b, r) => (!b || r.stateStartedAt > b.stateStartedAt ? r : b), null)
    return { sources: rows, defaultSource: best?.terminalId ?? null }
  }

  /** R4: the installed agents (static list when the CLI fails). Deliverable = a sendText target with a readiness profile. */
  async function targets() {
    let ids: string[] | null = null
    try {
      ids = installedIds(await deps.runCli('orca', ['agent', 'installed', '--json']))
    } catch {
      // no CLI on PATH or not JSON: the static list below
    }
    return (ids ?? STATIC_TARGETS).map((agent) => {
      const resumable = isResumeAgent(agent)
      // PR8d dropped (P2 (c)): Cursor has no session identity through Orca, and sendText never reaches its input.
      const reason =
        agent === 'cursor'
          ? "Orca can't tell this plugin's Cursor launch apart from yours yet"
          : profileFor(agent) === null
            ? `no readiness profile for ${agent} yet`
            : undefined
      return { agent, label: label(agent), resumable, deliverable: reason === undefined, ...(reason === undefined ? {} : { reason }) }
    })
  }

  async function state() {
    return { workspace: await workspace(), ...(await sources()), targets: await targets() }
  }

  const refuse = (code: 'unsupported_format' | 'session_not_found' | 'remote' | 'no_agent', message: string) =>
    ({ ok: false, code, message, lossyAvailable: false }) as const

  async function preview(input: { sourceTerminalId: string; target: string; lossy: boolean }) {
    const store = deps.store()
    // ponytail: R17's in-memory draft (DB unavailable) is not built yet; the panel shows this message instead.
    if (!store) return refuse('session_not_found', 'The history database is unavailable')
    const ws = await workspace()
    if (!ws) return refuse('no_agent', 'No workspace is focused')
    if (ws.remote) return refuse('remote', 'Remote workspaces are not supported yet')
    const src = (await deps.agents(ws.id)).find((a) => a.terminalId === input.sourceTerminalId)
    if (!src?.agent) return refuse('no_agent', 'No agent runs in that terminal')
    // Screen capture (lossy, R6) is out of v0.1 scope.
    if (!ADAPTER_AGENTS.has(src.agent)) return refuse('unsupported_format', `${label(src.agent)} sessions can't be read yet`)
    const target = (await targets()).find((t) => t.agent === input.target)
    if (!target?.deliverable) return refuse('no_agent', target?.reason ?? `${input.target} is not installed`)
    if (!src.sessionId) return refuse('session_not_found', `${label(src.agent)} has not finished a turn yet`)

    const fresh = await deps.ingest({ state: 'done', workspaceId: ws.id, terminalId: input.sourceTerminalId, sessionId: src.sessionId }) // same path as PR7
    // Stored turns from an earlier parse would be stale: never package them as the current context.
    if (fresh === 'unsupported') return refuse('unsupported_format', `This ${label(src.agent)} session's format can't be read`)
    const source = store.db
      .prepare('SELECT id, thread_id FROM sessions WHERE agent = ? AND native_id = ?')
      .get(src.agent, src.sessionId) as { id: HandoffRow['source_session_id']; thread_id: ThreadId } | undefined
    if (!source) return refuse('session_not_found', `No readable ${label(src.agent)} session was found`)

    const inThread = store.targetSessionFor(source.thread_id, target.agent)
    const there = inThread && inThread.id !== source.id ? inThread : null // claude → claude launches a new session
    const strategy = there ? (target.resumable ? 'resume' : 'launch-fallback') : 'launch'
    const handoffId = `h_${randomUUID()}` as HandoffId
    const budget = Math.min(Math.max((await deps.budget()) ?? HARD_CAP, 1024), HARD_CAP) // R19, D4
    const pkg: ContextPackage = buildContext(store, {
      threadId: source.thread_id,
      target: strategy === 'resume' && there ? { agent: target.agent, sessionId: there.id } : { agent: target.agent },
      budget,
      purpose: 'switch',
      handoffId
    })
    const now = deps.now()
    store.createDraft(
      {
        id: handoffId,
        thread_id: source.thread_id,
        source_session_id: source.id,
        source_agent: src.agent,
        target_agent: target.agent,
        target_session_id: strategy === 'resume' && there ? there.id : null,
        target_terminal_id: null,
        workspace_id: ws.id,
        strategy
      },
      pkg,
      now
    )
    return { ok: true, handoffId, pkg, sent: pkg.text, strategy, expiresAt: now + DRAFT_TTL_MS } as const
  }

  const rowOf = (store: Store, id: string) =>
    store.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as (HandoffRow & { in_input: number; chars: number }) | undefined

  function post(store: Store, id: string) {
    const h = rowOf(store, id)
    if (h) deps.post({ handoffId: id, status: h.status, inInput: h.in_input === 1, ...(h.error ? { error: h.error } : {}) })
  }

  function get(input: { handoffId: string }) {
    const store = deps.store()
    const h = store && rowOf(store, input.handoffId)
    if (!h) throw new Error(`unknown hand-off ${input.handoffId}`)
    return {
      status: h.status,
      inInput: h.in_input === 1,
      ...(h.error ? { error: h.error } : {}),
      strategy: h.strategy,
      bytes: h.bytes,
      chars: h.chars
    }
  }

  /** 8.5: claim the draft, start delivery without awaiting it, answer at once (30 s invoke limit). */
  function run(input: { handoffId: string }) {
    const store = deps.store()
    if (!store) return { ok: false, code: 'unknown' } as const
    const id = input.handoffId as HandoffId
    const claim = store.claimDraft(id, deps.now())
    if (claim === 'missing') return { ok: false, code: 'unknown' } as const
    if (claim !== 'claimed') {
      post(store, id)
      return { ok: false, code: claim } as const
    }
    post(store, id)
    void deliverHandoff(store, id)
    return { ok: true, handoffId: id, status: 'pending' } as const
  }

  /** §0.5, always settled: delivered/unconfirmed/failed here, or pending until ingest binds (the sweep ends it otherwise). */
  async function deliverHandoff(store: Store, id: HandoffId): Promise<void> {
    const events: StatusEvent[] = []
    listeners.add(events) // subscribe before the terminal opens (rule L's fresh-event check)
    let terminalId: string | null = null
    // Focus is a courtesy: its failure never changes the outcome.
    const focus = (tid: string) => deps.focus(tid).then(undefined, () => undefined)
    // Only a pending row moves: a late ingest bind (delivered) is never overwritten. Writes are synchronous, so no race.
    const settle = (status: 'delivered' | 'unconfirmed' | 'failed', error: string | null = null) => {
      if (rowOf(store, id)?.status !== 'pending') return
      store.setHandoffStatus(id, status, error, deps.now())
      post(store, id)
    }
    const fail = async (error: string, show = false) => {
      settle('failed', error)
      await deps.notify(error)
      if (show && terminalId) await focus(terminalId)
    }
    try {
      const h = rowOf(store, id)
      if (!h?.package) throw new Error('the hand-off text is gone')
      const agent = h.target_agent
      let started = true
      if (h.strategy === 'resume') {
        const native = store.db.prepare('SELECT native_id FROM sessions WHERE id = ?').get(h.target_session_id) as
          { native_id: string } | undefined
        if (!native) throw new Error(`the ${label(agent)} session is no longer known`)
        // F12: agent.resume reuses only terminals it opened, so a session already open in an Orca terminal gets the text there.
        const open = (await deps.agents(h.workspace_id)).find((a) => a.agent === agent && a.sessionId === native.native_id && a.terminalId)
        if (open?.terminalId) {
          terminalId = open.terminalId
          started = false
        } else {
          const r = await deps.resume(h.workspace_id, agent, native.native_id)
          terminalId = r.terminalId
          started = r.started
        }
      } else {
        terminalId = (await deps.launch(h.workspace_id, agent)).terminalId // no prompt: launch prompts are dropped [PR] (a)
      }
      const t0 = deps.now()
      const target = terminalId
      store.db.prepare('UPDATE handoffs SET target_terminal_id = ? WHERE id = ?').run(target, id)
      if (!started) {
        // F10: a terminal already running may be busy. The listed state is the newest known one, so it goes last
        // (newestStatus reads from the end); taken before any send, it can never count as a fresh post-send event.
        const listed = (await deps.agents(h.workspace_id)).find((a) => a.terminalId === target)
        if (listed?.state === 'working') events.push({ terminalId: target, state: 'working', receivedAt: deps.now() })
      }
      await deps.activate(h.workspace_id) // F1: sendText and terminal.read only work in the active worktree
      let tSend = t0
      const host: DeliverHost = {
        read: deps.read,
        sendText: (tid, text, enter) => {
          if (enter) tSend = deps.now()
          return deps.sendText(tid, text, enter)
        },
        now: deps.now,
        sleep: deps.sleep
      }
      const marker = `${HANDOFF_MARKER}${id}`
      const { outcome } = await deliverText(host, {
        terminalId: target,
        text: h.package,
        marker,
        agent,
        t0,
        resume: h.strategy === 'resume',
        events
      })
      const failure = {
        blocked: `${label(agent)} needs attention in its terminal (e.g. a trust or login prompt)`,
        timeout: `${label(agent)} did not become ready in time`,
        not_landed: `The text did not reach ${label(agent)}`,
        refused: `${label(agent)}'s terminal refused the text`,
        submitted: null,
        in_input: null
      }[outcome]
      if (failure !== null) {
        await fail(failure, outcome === 'blocked')
        return
      }
      if (outcome === 'in_input' && store.setInInput(id, deps.now())) post(store, id)
      await focus(target)
      if (ADAPTER_AGENTS.has(agent)) return // pending until ingest binds the marker (L.5)
      const seen = await confirmOnScreen(host, { terminalId: target, events, marker, tSend, agent })
      if (seen === 'in_input') store.setInInput(id, deps.now())
      if (seen === 'delivered') settle('delivered')
      else settle('unconfirmed', seen === 'not_seen' ? `delivery not verifiable for ${label(agent)}` : null)
    } catch (e) {
      await fail(messageOf(e))
    } finally {
      listeners.delete(events)
    }
  }

  return { onStatus, state, preview, run, get }
}
