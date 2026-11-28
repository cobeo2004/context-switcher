// Plan rows 8.3 and 8.5 through the worker: preview freezes a draft, run delivers it in the background and always settles.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'
import { openStore } from './store'
import { buildContext } from './context'
import { createSwitch } from './switch'
import { DRAFT_TTL_MS, type HandoffId, type SessionId, type ThreadId } from './types'

const FIXTURES = 'src/sources/fixtures'
const CWD = '/w/proj'
const SRC_SID = '00000000-0000-4000-8000-0000000000c1' // the codex source session
const NEW_SID = '00000000-0000-4000-8000-0000000000c2' // the claude session a launch starts
const RULE = '─'.repeat(30)
const SCREENS: Record<string, { idle: string[]; after: (text: string) => string[] }> = {
  claude: { idle: [RULE, '❯ ', RULE], after: () => ['✻ Thinking… (3s)', RULE, '❯ ', RULE] }, // spinner = submitted (F11)
  pi: { idle: [RULE, RULE], after: (text) => [RULE, text.split('\n')[0] ?? '', RULE] } // stays in the editor
}
const INSTALLED = JSON.stringify({ ok: true, result: { agents: ['claude', 'codex', 'pi', 'cursor', 'antigravity'].map((id) => ({ id })) } })

interface Agent {
  terminalId: string
  title: null
  agent: string
  state: 'done' | 'working'
  stateStartedAt: number
  sessionId: string | null
}

async function setup(o: { hostId?: string; sourceAgent?: string; read?: () => string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const prev = process.env['HOME']
  process.env['HOME'] = home
  const codexDir = join(home, '.codex', 'sessions', '2026', '01', '01')
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(
    join(codexDir, `rollout-2026-01-01T00-00-00-${SRC_SID}.jsonl`),
    readFileSync(join(FIXTURES, 'codex', 'synthetic', 'session.jsonl'))
  )
  const agents: Agent[] = [
    { terminalId: 'term1', title: null, agent: o.sourceAgent ?? 'codex', state: 'done', stateStartedAt: 1, sessionId: SRC_SID }
  ]
  const sent: { terminalId: string; text: string; enter?: boolean }[] = []
  let target = 'claude'
  let t = Date.now()
  const clock = {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    }
  }
  const screen = () => {
    const s = SCREENS[target] ?? { idle: ['$'], after: () => ['$'] }
    const typed = sent.find((x) => x.enter === true)
    return typed ? s.after(typed.text) : s.idle
  }
  const host = mockHost({
    settings: { retentionDays: 90 },
    results: {
      'workspace.readContext': { workspaceId: 'ws1', branch: 'main', displayName: 'proj', terminals: [] },
      'workspace.list': {
        workspaces: [{ id: 'ws1', kind: 'folder', name: 'proj', path: CWD, branch: null, hostId: o.hostId ?? 'local' }],
        truncated: false
      },
      'agents.list': () => ({ agents }),
      'agent.launch': (p: { agent: string }) => {
        const r = { terminalId: 'term2' }
        agents.push({ terminalId: r.terminalId, title: null, agent: p.agent, state: 'done', stateStartedAt: 2, sessionId: null })
        return r
      },
      'agent.resume': { terminalId: 'term3', started: true },
      'terminal.read': () => ({ lines: o.read ? o.read() : screen(), truncated: false }),
      'terminal.sendText': (p: { terminalId: string; text: string; enter?: boolean }) => {
        sent.push(p)
        return { accepted: true }
      },
      'terminal.focus': { focused: true },
      'workspace.open': { opened: true }
    }
  })
  const runCli = () => Promise.resolve(INSTALLED)
  const worker = await mountWorker({ default: (orca) => main.start(orca, runCli, clock), deactivate: main.deactivate }, { host })
  const db = () => openStore(join(home, '.context-switcher', 'context.sqlite'))
  const row = (id: string) => {
    const s = db()
    const r = s.db.prepare('SELECT status, in_input, error, package, target_terminal_id FROM handoffs WHERE id = ?').get(id) as {
      status: string
      in_input: number
      error: string | null
      package: string | null
      target_terminal_id: string | null
    }
    s.close()
    return r
  }
  const preview = async (to: string, sourceTerminalId = 'term1') => {
    target = to
    return worker.request('switch.preview', { sourceTerminalId, target: to, lossy: false })
  }
  /** Lets the background delivery run (it awaits only mock calls and the fake clock) until `done` holds. */
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 5000 && !done(); i++)
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    assert.ok(done(), 'background delivery did not reach the expected state')
  }
  const restore = async () => {
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
    process.env['HOME'] = prev
  }
  return { home, worker, host, agents, sent, clock: { add: (ms: number) => (t += ms) }, db, row, preview, until, restore }
}
type Setup = Awaited<ReturnType<typeof setup>>

async function okPreview(s: Setup, to: string) {
  const p = await s.preview(to)
  if (!p.ok) throw new Error(`preview failed: ${p.code} ${p.message}`)
  return p
}
const changes = (s: Setup) => s.worker.posts.filter((p) => p.event === 'handoff.changed').map((p) => p.payload)

test('preview freezes a draft whose package is exactly `sent`, within 4096 chars', async () => {
  const s = await setup()
  try {
    const p = await okPreview(s, 'claude')
    assert.equal(p.sent, p.pkg.text)
    assert.ok(p.sent.length <= 4096 && p.pkg.selected > 0)
    assert.equal(p.strategy, 'launch')
    const r = s.row(p.handoffId)
    assert.equal(r.status, 'draft')
    assert.equal(r.package, p.sent)
    assert.equal(s.host.callsOf('agent.launch').length, 0)
  } finally {
    await s.restore()
  }
})

test('remote workspace, unknown terminal, screen-only source and cursor target are refused with their codes', async () => {
  const remote = await setup({ hostId: 'ssh:box' })
  try {
    const p = await remote.preview('claude')
    assert.equal(p.ok ? 'ok' : p.code, 'remote')
  } finally {
    await remote.restore()
  }
  const s = await setup({ sourceAgent: 'antigravity' })
  try {
    const unknown = await s.preview('claude', 'nope')
    assert.equal(unknown.ok ? 'ok' : unknown.code, 'no_agent')
    const lossy = await s.preview('claude')
    assert.equal(lossy.ok ? 'ok' : lossy.code, 'unsupported_format')
    const state = await s.worker.request('switch.state')
    const cursor = state.targets.find((t) => t.agent === 'cursor')
    assert.equal(cursor?.deliverable, false)
    assert.match(cursor.reason ?? '', /Cursor/)
    assert.match(state.targets.find((t) => t.agent === 'antigravity')?.reason ?? '', /no readiness profile for antigravity/)
    assert.equal(state.targets.find((t) => t.agent === 'pi')?.resumable, false)
    assert.deepEqual(
      { workspace: state.workspace, defaultSource: state.defaultSource },
      { workspace: { id: 'ws1', name: 'proj', remote: false }, defaultSource: 'term1' }
    )
  } finally {
    await s.restore()
  }
})

test('run answers pending synchronously while agent.launch is still unsettled', () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const store = openStore(join(home, 'db.sqlite'))
  try {
    const thread = 't_00000000-0000-4000-8000-0000000000d1' as ThreadId
    const id = 'h_00000000-0000-4000-8000-0000000000d1' as HandoffId
    store.db.prepare('INSERT INTO threads (id, created_at, updated_at) VALUES (?, ?, ?)').run(thread, 0, 0)
    const pkg = buildContext(store, { threadId: thread, target: { agent: 'claude' }, budget: 4096, purpose: 'switch', handoffId: id })
    store.createDraft(
      {
        id,
        thread_id: thread,
        source_session_id: null,
        source_agent: 'codex',
        target_agent: 'claude',
        target_session_id: null,
        target_terminal_id: null,
        workspace_id: 'ws1',
        strategy: 'launch'
      },
      pkg
    )
    const launches: string[] = []
    const never = () => new Promise<never>(() => undefined)
    const sw = createSwitch({
      store: () => store,
      focused: never,
      workspaces: never,
      agents: never,
      launch: (_ws, agent) => {
        launches.push(agent)
        return never()
      },
      resume: never,
      activate: never,
      focus: never,
      read: never,
      sendText: never,
      ingest: never,
      budget: never,
      notify: never,
      post: () => undefined,
      runCli: never,
      now: Date.now,
      sleep: never
    })
    assert.deepEqual(sw.run({ handoffId: id }), { ok: true, handoffId: id, status: 'pending' })
    assert.deepEqual(launches, ['claude'])
  } finally {
    store.close()
  }
})

test('launch path: one send of the exact draft text, focus, then delivered once ingest binds the marker', async () => {
  const s = await setup()
  try {
    const p = await okPreview(s, 'claude')
    assert.deepEqual(await s.worker.request('switch.run', { handoffId: p.handoffId }), {
      ok: true,
      handoffId: p.handoffId,
      status: 'pending'
    })
    await s.until(() => s.host.callsOf('terminal.focus').length > 0)
    for (const call of s.host.callsOf('agent.launch')) assert.equal(Object.hasOwn(call as object, 'prompt'), false)
    assert.deepEqual(s.sent, [{ terminalId: 'term2', text: p.sent, enter: true }])
    assert.deepEqual(s.host.callsOf('workspace.open'), [{ workspaceId: 'ws1' }])
    assert.deepEqual(s.host.callsOf('terminal.focus'), [{ terminalId: 'term2' }])
    assert.equal(s.row(p.handoffId).status, 'pending')
    assert.equal(s.row(p.handoffId).target_terminal_id, 'term2')

    const dir = join(s.home, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const record = { type: 'user', uuid: 'u1', version: '2.1.0', message: { role: 'user', content: p.sent } }
    writeFileSync(join(dir, `${NEW_SID}.jsonl`), JSON.stringify(record) + '\n')
    await s.worker.emit('agent.status.changed', {
      workspaceId: 'ws1',
      paneKey: 'p2',
      terminalId: 'term2',
      state: 'done',
      receivedAt: 1,
      sessionId: NEW_SID
    })
    assert.equal(s.row(p.handoffId).status, 'delivered')
    assert.equal(s.row(p.handoffId).package, null)
    assert.deepEqual(changes(s).at(-1), { handoffId: p.handoffId, status: 'delivered', inInput: false })
  } finally {
    await s.restore()
  }
})

/** Ingests the codex source, then adds two claude sessions to its thread; returns the newer one's native id. */
async function seedClaudeSessions(s: Setup): Promise<string> {
  await s.worker.emit('agent.status.changed', {
    workspaceId: 'ws1',
    paneKey: 'p1',
    terminalId: 'term1',
    state: 'done',
    receivedAt: 1,
    sessionId: SRC_SID
  })
  const st = s.db()
  const { thread_id: thread } = st.db.prepare('SELECT thread_id FROM sessions').get() as { thread_id: string }
  const add = st.db.prepare(
    'INSERT INTO sessions (agent, native_id, thread_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  add.run('claude', 'older', thread, 'ws1', 1, 1)
  add.run('claude', 'newer', thread, 'ws1', 2, Date.now() + 60_000)
  st.close()
  return 'newer'
}

test('resume targets the newest claude session of the thread with a delta, through agent.resume', async () => {
  const s = await setup()
  try {
    const native = await seedClaudeSessions(s)
    const p = await okPreview(s, 'claude')
    assert.equal(p.strategy, 'resume')
    assert.equal(p.pkg.mode, 'delta')
    await s.worker.request('switch.run', { handoffId: p.handoffId })
    await s.until(() => s.host.callsOf('terminal.focus').length > 0)
    assert.deepEqual(s.host.callsOf('agent.resume'), [{ workspaceId: 'ws1', agent: 'claude', sessionId: native }])
    assert.equal(s.host.callsOf('agent.launch').length, 0)
    assert.deepEqual(s.sent, [{ terminalId: 'term3', text: p.sent, enter: true }])
  } finally {
    await s.restore()
  }
})

test('F12: a target session already open in an Orca terminal gets the text there, without agent.resume', async () => {
  const s = await setup()
  try {
    const native = await seedClaudeSessions(s)
    s.agents.push({ terminalId: 'term9', title: null, agent: 'claude', state: 'done', stateStartedAt: 0, sessionId: native })
    const p = await okPreview(s, 'claude')
    await s.worker.request('switch.run', { handoffId: p.handoffId })
    await s.until(() => s.host.callsOf('terminal.focus').length > 0)
    assert.equal(s.host.callsOf('agent.resume').length, 0)
    assert.deepEqual(s.sent, [{ terminalId: 'term9', text: p.sent, enter: true }])
  } finally {
    await s.restore()
  }
})

test('an unreadable terminal fails with one notification and no send; it never stays pending', async () => {
  const s = await setup({
    read: () => {
      throw hostError('action_failed', 'terminal gone')
    }
  })
  try {
    const p = await okPreview(s, 'claude')
    await s.worker.request('switch.run', { handoffId: p.handoffId })
    await s.until(() => s.row(p.handoffId).status !== 'pending')
    const r = s.row(p.handoffId)
    assert.equal(r.status, 'failed')
    assert.match(r.error ?? '', /terminal gone/)
    assert.equal(r.package, null)
    assert.equal(s.sent.length, 0)
    assert.equal(s.host.callsOf('notifications.show').length, 1)
    assert.equal((changes(s).at(-1) as { status: string }).status, 'failed')
  } finally {
    await s.restore()
  }
})

test('a screen that never shows the idle prompt times out as failed with zero sends', async () => {
  const s = await setup({ read: () => ['loading…'] })
  try {
    const p = await okPreview(s, 'claude')
    await s.worker.request('switch.run', { handoffId: p.handoffId })
    await s.until(() => s.row(p.handoffId).status !== 'pending')
    assert.equal(s.row(p.handoffId).status, 'failed')
    assert.match(s.row(p.handoffId).error ?? '', /did not become ready/)
    assert.equal(s.sent.length, 0)
  } finally {
    await s.restore()
  }
})

test('pi (no adapter): text left in its editor ends unconfirmed with in_input, never delivered or pending', async () => {
  const s = await setup()
  try {
    const p = await okPreview(s, 'pi')
    assert.equal(p.strategy, 'launch')
    await s.worker.request('switch.run', { handoffId: p.handoffId })
    await s.until(() => s.row(p.handoffId).status !== 'pending')
    assert.deepEqual(
      s.sent.map((x) => x.text),
      [p.sent, '\r']
    )
    assert.equal(s.row(p.handoffId).status, 'unconfirmed')
    assert.equal(s.row(p.handoffId).in_input, 1)
    assert.deepEqual(changes(s).at(-1), { handoffId: p.handoffId, status: 'unconfirmed', inInput: true })
  } finally {
    await s.restore()
  }
})

test('run twice → already_run with one launch; run after the draft TTL → expired with no host calls', async () => {
  const s = await setup()
  try {
    const p = await okPreview(s, 'claude')
    await s.worker.request('switch.run', { handoffId: p.handoffId })
    assert.deepEqual(await s.worker.request('switch.run', { handoffId: p.handoffId }), { ok: false, code: 'already_run' })
    await s.until(() => s.host.callsOf('terminal.focus').length > 0)
    assert.equal(s.host.callsOf('agent.launch').length, 1)

    const late = await okPreview(s, 'claude')
    s.clock.add(DRAFT_TTL_MS + 1)
    assert.deepEqual(await s.worker.request('switch.run', { handoffId: late.handoffId }), { ok: false, code: 'expired' })
    assert.equal(s.row(late.handoffId).status, 'expired')
    assert.equal(s.host.callsOf('agent.launch').length, 1)
    assert.deepEqual(await s.worker.request('switch.run', { handoffId: 'h_missing' }), { ok: false, code: 'unknown' })
    const got = await s.worker.request('handoff.get', { handoffId: p.handoffId })
    assert.deepEqual([got?.status, got?.strategy, got?.chars], ['pending', 'launch', p.sent.length])
    assert.equal(await s.worker.request('handoff.get', { handoffId: 'h_missing' }), null)
  } finally {
    await s.restore()
  }
})

test('F10: a stale done event never outranks the listed working state of an open target terminal (review 1)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const store = openStore(join(home, 'db.sqlite'))
  try {
    const thread = 't_00000000-0000-4000-8000-0000000000e1' as ThreadId
    const id = 'h_00000000-0000-4000-8000-0000000000e1' as HandoffId
    store.db.prepare('INSERT INTO threads (id, created_at, updated_at) VALUES (?, ?, ?)').run(thread, 0, 0)
    const sid = store.db
      .prepare('INSERT INTO sessions (agent, native_id, thread_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('claude', 'n1', thread, 'ws1', 0, 0).lastInsertRowid
    const sessionId = Number(sid) as SessionId
    const pkg = buildContext(store, {
      threadId: thread,
      target: { agent: 'claude', sessionId },
      budget: 4096,
      purpose: 'switch',
      handoffId: id
    })
    store.createDraft(
      {
        id,
        thread_id: thread,
        source_session_id: null,
        source_agent: 'codex',
        target_agent: 'claude',
        target_session_id: sessionId,
        target_terminal_id: null,
        workspace_id: 'ws1',
        strategy: 'resume'
      },
      pkg
    )
    let t = Date.now()
    let lookups = 0
    const sends: string[] = []
    const ok = () => Promise.resolve(undefined)
    const never = () => new Promise<never>(() => undefined)
    const sw = createSwitch({
      store: () => store,
      focused: never,
      workspaces: never,
      agents: () => {
        // The first lookup (F12) races an older `done`; every listing says the terminal is busy.
        if (lookups++ === 0) sw.onStatus({ terminalId: 'term9', state: 'done', receivedAt: t })
        return Promise.resolve([{ terminalId: 'term9', agent: 'claude', state: 'working', stateStartedAt: 0, sessionId: 'n1' }])
      },
      launch: never,
      resume: never,
      activate: ok,
      focus: ok,
      read: () => Promise.resolve({ lines: [RULE, '❯ ', RULE], truncated: false }), // the TUI still paints its idle frame
      sendText: (_tid, text) => {
        sends.push(text)
        return Promise.resolve({ accepted: true })
      },
      ingest: never,
      budget: never,
      notify: () => Promise.resolve(),
      post: () => undefined,
      runCli: never,
      now: () => t,
      sleep: (ms) => {
        t += ms
        return Promise.resolve()
      }
    })
    assert.equal(sw.run({ handoffId: id }).ok, true)
    const status = () => (store.db.prepare('SELECT status FROM handoffs WHERE id = ?').get(id) as { status: string }).status
    for (let i = 0; i < 5000 && status() === 'pending'; i++)
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    assert.equal(lookups, 2)
    assert.deepEqual(sends, [])
    assert.equal(status(), 'failed')
  } finally {
    store.close()
  }
})

test('a source file that no longer parses refuses unsupported_format instead of packaging stored turns (review 1)', async () => {
  const s = await setup()
  try {
    await seedClaudeSessions(s) // the codex source is ingested once, so stale turns exist
    writeFileSync(join(s.home, '.codex', 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${SRC_SID}.jsonl`), 'not json\n')
    const p = await s.preview('claude')
    assert.equal(p.ok, false)
    assert.equal(p.code, 'unsupported_format')
    const st = s.db()
    assert.equal((st.db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE status = 'draft'").get() as { n: number }).n, 0)
    st.close()
  } finally {
    await s.restore()
  }
})
