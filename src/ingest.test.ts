import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'
import { openStore } from './store'
import { createIngest } from './ingest'
import { buildContext } from './context'
import { claude } from './sources/claude'
import { codex } from './sources/codex'
import { LocalSessionSource } from './sources/sessionSource'
import type { HandoffId, ThreadId } from './types'

const FIXTURES = 'src/sources/fixtures' // orca plugin test runs from the repo root
const SID = '00000000-0000-4000-8000-0000000000f1'
const CWD = '/w/proj'
const H = 'h_11111111-2222-4333-8444-555555555555'
const T = 't_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const copy = (from: string, to: string) => {
  writeFileSync(to, readFileSync(from))
}

/** A temp HOME, a worker mounted on it, and one local or SSH workspace holding one agent. */
async function setup(opts: { agent?: string; hostId?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const prev = process.env['HOME']
  process.env['HOME'] = home
  const host = mockHost({
    settings: { retentionDays: 90 },
    results: {
      'agents.list': { agents: [{ terminalId: 'term1', title: null, agent: opts.agent ?? 'claude', state: 'done', stateStartedAt: 0 }] },
      'workspace.list': {
        workspaces: [{ id: 'ws1', kind: 'folder', name: 'proj', path: CWD, branch: null, hostId: opts.hostId ?? 'local' }],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const db = () => openStore(join(home, '.context-switcher', 'context.sqlite'))
  const done = (state: 'done' | 'working' = 'done') =>
    worker.emit('agent.status.changed', {
      workspaceId: 'ws1',
      paneKey: 'p1',
      terminalId: 'term1',
      state,
      receivedAt: Date.now(),
      sessionId: SID
    })
  const count = (table: 'turns' | 'sessions') => {
    const s = db()
    const n = s.db.prepare('SELECT (SELECT count(*) FROM turns) AS turns, (SELECT count(*) FROM sessions) AS sessions').get()
    s.close()
    return (n as Record<typeof table, number>)[table]
  }
  const restore = async () => {
    await worker.deactivate()
    process.env['HOME'] = prev
  }
  return { home, worker, db, done, count, restore }
}

function claudeFile(home: string): string {
  const dir = join(home, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${SID}.jsonl`)
}

test('a claude done ingests the fixture in ord order; a replayed done adds nothing', async () => {
  const t = await setup()
  try {
    const file = claudeFile(t.home)
    copy(join(FIXTURES, 'claude', 'synthetic', 'session.jsonl'), file)
    const n = (await claude.parse(new LocalSessionSource(), file, null)).turns.length
    assert.ok(n > 3)
    await t.done()
    const s = t.db()
    const ords = (s.db.prepare('SELECT ord FROM turns ORDER BY id').all() as { ord: number }[]).map((r) => r.ord)
    s.close()
    assert.deepEqual(
      ords,
      Array.from({ length: n }, (_, i) => i + 1)
    )
    await t.done()
    assert.equal(t.count('turns'), n)
    assert.equal(t.count('sessions'), 1)
  } finally {
    await t.restore()
  }
})

test('a codex done ingests the codex fixture', async () => {
  const t = await setup({ agent: 'codex' })
  try {
    const dir = join(t.home, '.codex', 'sessions', '2026', '01', '01')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-01-01T00-00-00-${SID}.jsonl`)
    copy(join(FIXTURES, 'codex', 'synthetic', 'session.jsonl'), file)
    const n = (await codex.parse(new LocalSessionSource(), file, null)).turns.length
    assert.ok(n > 5)
    await t.done()
    assert.equal(t.count('turns'), n)
  } finally {
    await t.restore()
  }
})

test('a working event, an SSH workspace and an agent without an adapter ingest nothing', async () => {
  for (const [opts, state] of [
    [{}, 'working'],
    [{ hostId: 'ssh:x' }, 'done'],
    [{ agent: 'pi' }, 'done']
  ] as const) {
    const t = await setup(opts)
    try {
      copy(join(FIXTURES, 'claude', 'synthetic', 'session.jsonl'), claudeFile(t.home))
      await t.done(state)
      assert.equal(t.count('sessions'), 0)
    } finally {
      await t.restore()
    }
  }
})

test('lazy create: no session before a user turn; the marker turn then joins the pending hand-off', async () => {
  const t = await setup()
  try {
    const seed = t.db()
    const now = Date.now()
    seed.db.prepare('INSERT INTO threads (id, created_at, updated_at) VALUES (?, ?, ?)').run(T, now, now)
    seed.db
      .prepare(
        `INSERT INTO handoffs (id, thread_id, source_agent, target_agent, workspace_id, strategy, mode,
         selected, omitted, bytes, status, created_at, updated_at)
         VALUES (?, ?, 'codex', 'claude', 'ws1', 'launch', 'full', 0, 0, 0, 'pending', ?, ?)`
      )
      .run(H, T, now, now)
    seed.close()

    const file = claudeFile(t.home)
    writeFileSync(file, '')
    await t.done()
    assert.equal(t.count('sessions'), 0)

    const content = `[context-switcher handoff ${H} thread ${T}]\nhello`
    writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', version: '2.1.0', message: { role: 'user', content } }) + '\n')
    await t.done()
    const s = t.db()
    assert.equal((s.db.prepare('SELECT thread_id FROM sessions').get() as { thread_id: string }).thread_id, T)
    assert.equal((s.db.prepare('SELECT status FROM handoffs WHERE id = ?').get(H) as { status: string }).status, 'delivered')
    assert.equal(s.threadTurns(T as ThreadId, 0, 10)[0]?.source, 'handoff')
    s.close()
    assert.deepEqual(
      t.worker.posts.filter((p) => p.event === 'handoff.changed').map((p) => p.payload),
      [{ handoffId: H, status: 'delivered', inInput: false }]
    )
  } finally {
    await t.restore()
  }
})

function seedHandoff(
  s: ReturnType<typeof openStore>,
  opts: { agent?: string; workspace?: string; status?: string; session?: number } = {}
) {
  const now = Date.now()
  s.db.prepare('INSERT OR IGNORE INTO threads (id, created_at, updated_at) VALUES (?, ?, ?)').run(T, now, now)
  s.db
    .prepare(
      `INSERT INTO handoffs (id, thread_id, source_agent, target_agent, target_session_id, workspace_id, strategy, mode,
       selected, omitted, bytes, status, created_at, updated_at) VALUES (?, ?, 'codex', ?, ?, ?, 'launch', 'full', 0, 0, 0, ?, ?, ?)`
    )
    .run(H, T, opts.agent ?? 'claude', opts.session ?? null, opts.workspace ?? 'ws1', opts.status ?? 'pending', now, now)
}

function markerFixture(home: string, agent: 'claude' | 'codex'): void {
  const fixture = readFileSync(join(FIXTURES, agent, 'synthetic', 'session.jsonl'), 'utf8')
  if (agent === 'claude') {
    const lines = fixture.trimEnd().split('\n')
    const meta = lines[1] ?? ''
    const rest = [lines[0] ?? '', ...lines.slice(2)]
    writeFileSync(
      claudeFile(home),
      [meta, ...rest]
        .join('\n')
        .replaceAll('h_00000000-0000-4000-8000-0000000000a2', H)
        .replaceAll('t_00000000-0000-4000-8000-0000000000a2', T) + '\n'
    )
  } else {
    const dir = join(home, '.codex', 'sessions', '2026', '01', '01')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `rollout-2026-01-01T00-00-00-${SID}.jsonl`),
      fixture.replaceAll('h_00000000-0000-4000-8000-0000000000b1', H).replaceAll('t_00000000-0000-4000-8000-0000000000b1', T)
    )
  }
}

test('filtered fixture markers join the target thread for both adapters', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const t = await setup({ agent })
    try {
      const seed = t.db()
      seedHandoff(seed, { agent })
      seed.close()
      markerFixture(t.home, agent)
      await t.done()
      const s = t.db()
      assert.equal((s.db.prepare('SELECT thread_id FROM sessions').get() as { thread_id: string }).thread_id, T)
      assert.equal((s.db.prepare('SELECT status FROM handoffs WHERE id = ?').get(H) as { status: string }).status, 'delivered')
      assert.equal((s.db.prepare('SELECT source FROM turns WHERE handoff_id = ?').get(H) as { source: string }).source, 'handoff')
      s.close()
      assert.deepEqual(
        t.worker.posts.filter((p) => p.event === 'handoff.changed').map((p) => p.payload),
        [{ handoffId: H, status: 'delivered', inInput: false }]
      )
    } finally {
      await t.restore()
    }
  }
})

test('filtered markers do not join a different agent or workspace', async () => {
  for (const opts of [{ agent: 'codex' }, { workspace: 'other' }]) {
    const t = await setup()
    try {
      const seed = t.db()
      seedHandoff(seed, opts)
      seed.close()
      markerFixture(t.home, 'claude')
      await t.done()
      const s = t.db()
      assert.equal((s.db.prepare('SELECT status FROM handoffs WHERE id = ?').get(H) as { status: string }).status, 'pending')
      assert.notEqual((s.db.prepare('SELECT thread_id FROM sessions').get() as { thread_id: string }).thread_id, T)
      s.close()
    } finally {
      await t.restore()
    }
  }
})

test('resumed markers bind without moving the session, including after an unread batch and late binding', async () => {
  for (const [status, batch] of [
    ['pending', 0],
    ['pending', 6],
    ['unconfirmed', 0]
  ] as const) {
    const t = await setup()
    try {
      const file = claudeFile(t.home)
      const record = (id: string, content: string) =>
        JSON.stringify({ type: 'user', uuid: id, version: '2.1.0', message: { role: 'user', content } }) + '\n'
      writeFileSync(file, record('initial', 'initial request'))
      await t.done()
      const s = t.db()
      const session = s.db.prepare('SELECT id, thread_id FROM sessions').get() as { id: number; thread_id: ThreadId }
      const now = Date.now()
      // The hand-off lives in another thread (T), so moving the session there would fail the thread assert below.
      s.db.prepare('INSERT INTO threads (id, created_at, updated_at) VALUES (?, ?, ?)').run(T, now, now)
      s.db
        .prepare(
          'INSERT INTO handoffs (id, thread_id, source_agent, target_agent, target_session_id, workspace_id, strategy, mode, selected, omitted, bytes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)'
        )
        .run(H, T, 'codex', 'claude', session.id, 'ws1', 'resume', 'full', status, now, now)
      s.close()
      assert.notEqual(session.thread_id, T)
      const marker = `[context-switcher handoff ${H} thread ${T}] synthetic secret`
      const extra = Array.from({ length: batch }, (_, i) => record(`ordinary-${i}`, `ordinary ${i}`)).join('')
      writeFileSync(file, readFileSync(file, 'utf8') + extra + record('marker', marker))
      await t.done()
      const result = t.db()
      assert.equal((result.db.prepare('SELECT status FROM handoffs WHERE id = ?').get(H) as { status: string }).status, 'delivered')
      assert.equal(
        (result.db.prepare('SELECT thread_id FROM sessions WHERE id = ?').get(session.id) as { thread_id: string }).thread_id,
        session.thread_id
      )
      assert.equal(
        (result.db.prepare('SELECT source FROM turns WHERE native_id = ?').get('marker#0') as { source: string }).source,
        'handoff'
      )
      const pkg = buildContext(result, {
        threadId: session.thread_id,
        target: { agent: 'codex' },
        budget: 2048,
        purpose: 'switch',
        handoffId: H as HandoffId
      })
      assert.equal(pkg.text.includes('synthetic secret'), false)
      result.close()
    } finally {
      await t.restore()
    }
  }
})

test('an unknown format is logged once per resolved session, whichever terminal names it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const dir = join(home, '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  const bad = `${JSON.stringify({ type: 'user', uuid: 'u1', version: '2.0.0', message: { role: 'user', content: 7 } })}\n`
  for (const sid of ['sa', 'sb']) writeFileSync(join(dir, `${sid}.jsonl`), bad)
  const store = openStore(join(home, 'db.sqlite'))
  const logs: string[] = []
  let row = { terminalId: 'term1', agent: 'claude', sessionId: 'sa' }
  const ingest = createIngest({
    store: () => store,
    home: () => home,
    agents: () => Promise.resolve([row]),
    workspaces: () => Promise.resolve([{ id: 'ws', hostId: 'local', path: '/w/proj' }]),
    log: (m) => logs.push(m),
    post: () => undefined
  })
  // The event has no sessionId, so ingest resolves it from the agent-list row.
  const done = (terminalId: string) => ingest.onStatus({ state: 'done', workspaceId: 'ws', terminalId })
  await done('term1') // sa: logged
  row = { terminalId: 'term1', agent: 'claude', sessionId: 'sb' }
  await done('term1') // sb on the same terminal: logged (a different session)
  row = { terminalId: 'term2', agent: 'claude', sessionId: 'sb' }
  await done('term2') // sb on another terminal: not logged again
  store.close()
  assert.equal(logs.filter((m) => m.startsWith('ingest: ')).length, 2, logs.join(' | '))
})
