// D1 entry points: the switch command opens the panel through the Orca CLI, the status bar names the active agent.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'
import { OPEN_ARGS, ORCA_CLIS, statusText } from './entry'
import { run } from './proc'

interface Agent {
  terminalId: string
  title: null
  agent: string | null
  state: 'done'
  stateStartedAt: number
}
const agent = (name: string | null, stateStartedAt: number): Agent => ({
  terminalId: `t-${String(name)}-${String(stateStartedAt)}`,
  title: null,
  agent: name,
  state: 'done',
  stateStartedAt
})

async function withWorker(
  fails: readonly string[],
  agents: Agent[],
  body: (w: Awaited<ReturnType<typeof mountWorker>>, calls: string[][]) => Promise<void> | void
) {
  const prev = process.env['HOME']
  process.env['HOME'] = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const calls: string[][] = []
  const runCli = (file: string, args: readonly string[]) => {
    calls.push([file, ...args])
    return fails.includes(file) ? Promise.reject(new Error('ENOENT')) : Promise.resolve('')
  }
  try {
    const host = mockHost({ settings: { retentionDays: 90 }, results: { 'agents.list': { agents } } })
    const worker = await mountWorker({ default: (orca) => main.start(orca, runCli), deactivate: main.deactivate }, { host })
    try {
      await body(worker, calls)
      assert.deepEqual(worker.refusals, [])
    } finally {
      await worker.deactivate()
    }
  } finally {
    process.env['HOME'] = prev
  }
}

const statusTexts = (w: Awaited<ReturnType<typeof mountWorker>>) =>
  w.host.callsOf('statusBar.update').map((p) => (p as { id: string; text: string }).id + ':' + (p as { text: string }).text)

test('the switch command opens the panel with the bundled CLI first', async () => {
  await withWorker([], [], async (w, calls) => {
    await w.command('context-switcher.switch')
    assert.deepEqual(calls, [
      ['/Applications/Orca.app/Contents/Resources/bin/orca', 'plugin', 'open', 'local.context-switcher', '--panel', 'switch']
    ])
    assert.equal(w.host.callsOf('notifications.show').length, 0)
  })
})

test('a missing bundled CLI falls back to orca on PATH without a notification', async () => {
  await withWorker([ORCA_CLIS[0] ?? ''], [], async (w, calls) => {
    await w.command('context-switcher.switch')
    assert.deepEqual(
      calls.map((c) => c[0]),
      ORCA_CLIS
    )
    assert.deepEqual(calls[1]?.slice(1), OPEN_ARGS)
    assert.equal(w.host.callsOf('notifications.show').length, 0)
  })
})

test('when every CLI fails the command shows exactly one notification', async () => {
  await withWorker(ORCA_CLIS, [], async (w, calls) => {
    await w.command('context-switcher.switch')
    assert.equal(calls.length, 2)
    const shown = w.host.callsOf('notifications.show') as { body: string }[]
    assert.equal(shown.length, 1)
    assert.equal(shown[0]?.body, 'Open Context Switcher from the right sidebar')
  })
})

const lastStatus = (w: Awaited<ReturnType<typeof mountWorker>>) => statusTexts(w).at(-1)

test('activation names the only agent in the status bar', async () => {
  await withWorker([], [agent('claude', 5)], (w) => {
    assert.equal(statusTexts(w)[0], 'active-agent:Claude ▾')
  })
})

test('workspace.changed and agent.status.changed refresh the status bar; the latest stateStartedAt wins', async () => {
  const agents = [agent('claude', 5)]
  await withWorker([], agents, async (w) => {
    assert.equal(statusTexts(w)[0], 'active-agent:Claude ▾')
    agents.push(agent('codex', 9))
    await w.emit('workspace.changed', { context: null })
    assert.equal(lastStatus(w), 'active-agent:Codex ▾')
    agents.splice(0, agents.length, agent('pi', 7))
    await w.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', state: 'working', receivedAt: 1 })
    assert.equal(lastStatus(w), 'active-agent:Pi ▾')
  })
})

test('statusText: no agent, unnamed agents and ties', () => {
  assert.equal(statusText([]), 'Agent ▾')
  assert.equal(statusText([agent(null, 9)]), 'Agent ▾')
  assert.equal(statusText([agent(null, 9), agent('codex', 1)]), 'Codex ▾')
  assert.equal(statusText([agent('claude', 3), agent('codex', 3)]), 'Claude ▾')
})

test('proc.run returns stdout and rejects when the program fails', async () => {
  assert.equal(await run(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok')
  await assert.rejects(run(join(tmpdir(), 'cs-no-such-binary'), []))
})

test('workspace.changed tells an open panel to re-read switch.state; agent status events do not (each re-read is a new preview)', async () => {
  await withWorker([], [agent('claude', 5)], async (w) => {
    const panelPosts = () => w.posts.filter((p) => p.event === 'agents.changed').length
    const base = panelPosts() // the subscription replays the current context once on mount
    await w.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', state: 'working', receivedAt: 1 })
    assert.equal(panelPosts(), base)
    await w.emit('workspace.changed', { context: null })
    assert.equal(panelPosts(), base + 1)
  })
})
