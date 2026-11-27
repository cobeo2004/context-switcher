// Plan row 7.2: ingest a session on `done`. A replayed `done` is a no-op parse (cursor + UNIQUE native ids), never readiness.
import { claude } from './sources/claude'
import { codex } from './sources/codex'
import { LocalSessionSource } from './sources/sessionSource'
import type { Store } from './store'
import { UnsupportedFormat, type Adapter, type Cursor } from './types'

// v0.1: claude and codex only; pi and cursor join this map when their adapters land.
const ADAPTERS: Partial<Record<string, Adapter>> = { claude, codex }

/** The `agent.status.changed` fields ingest reads ([EV]). */
export interface StatusEvent {
  state: string
  workspaceId: string | null
  workspaceListId?: string
  terminalId?: string
  sessionId?: string
}

export interface IngestDeps {
  store: () => Store | null
  home: () => string
  agents: (workspaceId: string) => Promise<{ terminalId: string | null; agent: string | null; sessionId?: string | null }[]>
  workspaces: () => Promise<{ id: string; hostId: string | null; path: string }[]>
  log: (message: string) => void
  post: (change: { id: string; status: 'delivered' }) => void
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** A stored offset cursor, rebuilt field by field; anything else re-parses from the start, which is safe (§0.4). */
function toCursor(text: unknown): Cursor | null {
  if (typeof text !== 'string') return null
  const v: unknown = JSON.parse(text)
  if (!isRec(v) || v['kind'] !== 'offset' || typeof v['offset'] !== 'number') return null
  const f = v['file']
  if (!isRec(f)) return null
  const file = { path: String(f['path']), dev: Number(f['dev']), ino: Number(f['ino']), size: Number(f['size']) }
  const anchor = str(v['anchor'])
  return { kind: 'offset', file, offset: v['offset'], ...(anchor === undefined ? {} : { anchor }) }
}

export function createIngest(deps: IngestDeps) {
  const src = new LocalSessionSource()
  const warned = new Set<string>()
  let queue = Promise.resolve()

  async function run(evt: StatusEvent): Promise<void> {
    const store = deps.store()
    if (!store || evt.state !== 'done' || !evt.terminalId || !evt.workspaceId) return
    const row = (await deps.agents(evt.workspaceId)).find((a) => a.terminalId === evt.terminalId)
    const adapter = ADAPTERS[row?.agent ?? '']
    if (!adapter) return
    const wsId = evt.workspaceListId ?? evt.workspaceId
    const ws = (await deps.workspaces()).find((w) => w.id === wsId)
    if (ws?.hostId !== 'local') return
    const sessionId = evt.sessionId ?? row?.sessionId
    if (!sessionId) {
      deps.log(`ingest: no session id yet for terminal ${evt.terminalId}`)
      return
    }

    const prev: unknown = store.db
      .prepare('SELECT cursor, source_path FROM sessions WHERE agent = ? AND native_id = ?')
      .get(adapter.agent, sessionId)
    const cached = isRec(prev) ? str(prev['source_path']) : undefined
    const path = await adapter.locate(src, { sessionId, cwd: ws.path, home: deps.home(), ...(cached === undefined ? {} : { cached }) })
    let parse: Awaited<ReturnType<typeof adapter.parse>>
    try {
      parse = await adapter.parse(src, path, isRec(prev) ? toCursor(prev['cursor']) : null)
    } catch (e) {
      if (!(e instanceof UnsupportedFormat)) throw e
      // Once per resolved session, whichever terminal or event field named it (row 7.2).
      const key = `${adapter.agent}:${sessionId}`
      if (!warned.has(key)) deps.log(`ingest: ${e.message}`)
      warned.add(key)
      return
    }

    const statusOf = (id: string) => {
      const h: unknown = store.db.prepare('SELECT status FROM handoffs WHERE id = ?').get(id)
      return isRec(h) ? str(h['status']) : undefined
    }
    // One entry per hand-off: several records may carry the same marker.
    const before = new Map(parse.markers.map((m) => [m.handoffId, statusOf(m.handoffId)] as const))
    const result = store.ingestParse({ agent: adapter.agent, nativeId: sessionId }, parse, {
      workspaceId: evt.workspaceId,
      terminalId: evt.terminalId,
      sourcePath: path
    })
    for (const w of result.warnings) deps.log(w)
    // Binding is ingest's only status transition (§0.2 rule 3/4).
    for (const [id, was] of before) if (was !== 'delivered' && statusOf(id) === 'delivered') deps.post({ id, status: 'delivered' })
  }

  /** Serialised: one ingest at a time, in event order. Errors are logged, never thrown into Orca. */
  function onStatus(evt: StatusEvent): Promise<void> {
    queue = queue
      .then(() => run(evt))
      .catch((e: unknown) => {
        deps.log(`ingest failed: ${String(e)}`)
      })
    return queue
  }

  return { onStatus }
}
