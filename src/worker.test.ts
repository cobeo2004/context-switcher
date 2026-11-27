// Runs src/worker.ts's activate(orca) over a mock host with a temp HOME.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'
import { openStore } from './store'

test('a corrupt database produces one notification and leaves the worker running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const prev = process.env['HOME']
  process.env['HOME'] = home
  try {
    const dir = join(home, '.context-switcher')
    mkdirSync(dir)
    writeFileSync(join(dir, 'context.sqlite'), 'garbage')
    const host = mockHost({ settings: { retentionDays: 90 } })
    const worker = await mountWorker(main, { host })
    assert.equal(host.callsOf('notifications.show').length, 1)
    await worker.emit('agent.status.changed', {
      workspaceId: 'ws1',
      paneKey: 'p1',
      terminalId: 't1',
      state: 'done',
      receivedAt: 1,
      sessionId: 's1'
    })
    // store = null: ingest (which lists a named workspace) is skipped; the status bar lists the focused one
    assert.equal(host.callsOf('agents.list').filter((p) => p !== undefined && 'workspaceId' in (p as object)).length, 0)
    await worker.deactivate()
  } finally {
    process.env['HOME'] = prev
  }
})

test('activation prunes idle threads and sweeps stale pending handoffs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const prev = process.env['HOME']
  process.env['HOME'] = home
  try {
    const seeded = openStore(join(home, '.context-switcher', 'context.sqlite'))
    const now = Date.now()
    const thread = seeded.db.prepare('INSERT INTO threads (id, created_at, updated_at) VALUES (?, ?, ?)')
    thread.run('old', 0, 0)
    thread.run('active', now, now)
    seeded.db
      .prepare(
        `INSERT INTO handoffs (id, thread_id, source_agent, target_agent, workspace_id, strategy, mode,
         selected, omitted, bytes, status, created_at, updated_at)
         VALUES ('h_old', 'active', 'claude', 'codex', 'ws', 'launch', 'full', '[]', '[]', 0, 'pending', 0, 0)`
      )
      .run()
    seeded.close()
    const worker = await mountWorker(main, { host: mockHost({ settings: { retentionDays: 90 } }) })
    const check = openStore(join(home, '.context-switcher', 'context.sqlite'))
    assert.equal((check.db.prepare('SELECT count(*) AS n FROM threads WHERE id = ?').get('old') as { n: number }).n, 0)
    assert.equal((check.db.prepare('SELECT count(*) AS n FROM threads WHERE id = ?').get('active') as { n: number }).n, 1)
    assert.equal((check.db.prepare('SELECT status FROM handoffs WHERE id = ?').get('h_old') as { status: string }).status, 'unconfirmed')
    assert.equal(worker.posts.filter((post) => post.event === 'handoff.changed').length, 1)
    check.close()
    await worker.deactivate()
  } finally {
    process.env['HOME'] = prev
  }
})

test('diag reports schema version, file modes and the installed CLI', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const prev = process.env['HOME']
  process.env['HOME'] = home
  try {
    const worker = await mountWorker(main, { host: mockHost({ settings: { retentionDays: 90, budgetBytes: 32768 } }) })
    const diag = await worker.request('diag')
    assert.equal(diag.userVersion, 2)
    assert.equal(diag.dirMode, '700')
    assert.equal(diag.dbMode, '600')
    assert.equal(diag.cliInstalled, true)
    assert.equal(diag.dbPath, join(home, '.context-switcher', 'context.sqlite'))
    assert.equal(diag.node, process.version)
    assert.match(diag.sqlite, /^3\./)
    assert.equal(statSync(join(home, '.context-switcher', 'bin', 'thread-read.mjs')).mode & 0o777, 0o700)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    process.env['HOME'] = prev
  }
})
