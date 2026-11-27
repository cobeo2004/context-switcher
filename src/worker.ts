// The plugin's own worker. Orca transpiles this file when it loads; a save restarts it.
import type { OrcaWorkerApi } from 'orca/worker'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from './store'
import { THREAD_READ_MJS } from './cliSource'
import { createIngest } from './ingest'
import { run, type Run } from './proc'
import { openPanel, STATUS_ITEM, statusText, SWITCH_COMMAND } from './entry'
import { createSwitch, isResumeAgent } from './switch'

const SWEEP_EVERY_MS = 60_000

let store: Store | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

interface Clock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}
const realClock: Clock = {
  now: Date.now,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
}

export default function activate(orca: OrcaWorkerApi): Promise<void> {
  return start(orca, run)
}

/** `activate` with the process runner and clock passed in, so tests never spawn a real Orca or wait real time. */
export async function start(orca: OrcaWorkerApi, runCli: Run, clock: Clock = realClock): Promise<void> {
  const notify = async (body: string) => {
    try {
      await orca.host.call('notifications.show', { title: 'Context Switcher', body })
    } catch (notificationError) {
      orca.log(`notification failed: ${String(notificationError)}`)
    }
  }
  const dir = join(homedir(), '.context-switcher')
  const dbPath = join(dir, 'context.sqlite')
  const cliPath = join(dir, 'bin', 'thread-read.mjs')
  let s: Store | null = null
  try {
    s = openStore(dbPath)
    store = s
  } catch (error) {
    orca.log(`history database unavailable: ${String(error)}`)
    await notify('History database unavailable; switches will build from the session file')
  }

  if (s) {
    const activeStore = s
    const retention = await orca.settings.get('retentionDays')
    const pruned = activeStore.prune(typeof retention === 'number' ? retention : 90)
    if (pruned) orca.log(`pruned ${pruned} idle thread(s)`)

    const inInput = activeStore.db.prepare('SELECT in_input FROM handoffs WHERE id = ?')
    const sweep = () => {
      for (const { id, status } of activeStore.sweep()) {
        const row = inInput.get(id) as { in_input: number } | undefined
        orca.panels.post('handoff.changed', { handoffId: id, status, inInput: row?.in_input === 1 })
      }
    }
    sweep()
    sweepTimer = setInterval(sweep, SWEEP_EVERY_MS)
  }

  const ingest = createIngest({
    store: () => store,
    home: homedir,
    agents: async (workspaceId) => (await orca.host.call('agents.list', { workspaceId })).agents,
    workspaces: async () => (await orca.host.call('workspace.list', undefined)).workspaces,
    log: (message) => {
      orca.log(message)
    },
    post: ({ id, status }) => {
      orca.panels.post('handoff.changed', { handoffId: id, status, inInput: false })
    }
  })
  orca.events.on('agent.status.changed', async (e) => {
    await ingest.onStatus(e)
  })

  const switcher = createSwitch({
    store: () => store,
    focused: () => orca.host.call('workspace.readContext', undefined),
    workspaces: async () => (await orca.host.call('workspace.list', undefined)).workspaces,
    agents: async (workspaceId) => (await orca.host.call('agents.list', workspaceId === undefined ? undefined : { workspaceId })).agents,
    launch: (workspaceId, agent) => orca.host.call('agent.launch', { workspaceId, agent }),
    resume: (workspaceId, agent, sessionId) => {
      if (!isResumeAgent(agent)) throw new Error(`${agent} cannot resume a session`)
      return orca.host.call('agent.resume', { workspaceId, agent, sessionId })
    },
    activate: (workspaceId) => orca.host.call('workspace.open', { workspaceId }),
    focus: (terminalId) => orca.host.call('terminal.focus', { terminalId }),
    read: (terminalId) => orca.host.call('terminal.read', { terminalId }),
    sendText: (terminalId, text, enter) => orca.host.call('terminal.sendText', { terminalId, text, enter }),
    ingest: ingest.onStatus,
    budget: async () => {
      const value = await orca.settings.get('budgetChars')
      return typeof value === 'number' ? value : null
    },
    notify,
    post: (change) => {
      orca.panels.post('handoff.changed', change)
    },
    runCli,
    ...clock
  })
  orca.events.on('agent.status.changed', switcher.onStatus)
  orca.panels.handle('switch.state', switcher.state)
  orca.panels.handle('switch.preview', switcher.preview)
  orca.panels.handle('switch.run', switcher.run)
  orca.panels.handle('handoff.get', switcher.get)

  orca.commands.register(SWITCH_COMMAND, async () => {
    if (!(await openPanel(runCli))) await notify('Open Context Switcher from the right sidebar')
  })
  const refreshStatus = async () => {
    try {
      const { agents } = await orca.host.call('agents.list', undefined)
      await orca.host.call('statusBar.update', { id: STATUS_ITEM, text: statusText(agents) })
    } catch (error) {
      orca.log(`status bar update failed: ${String(error)}`)
    }
  }
  orca.events.on('workspace.changed', async () => {
    // Only here, not on agent.status.changed: the panel re-previews (a new draft) on every agents.changed.
    orca.panels.post('agents.changed', {})
    await refreshStatus()
  })
  orca.events.on('agent.status.changed', refreshStatus)
  // Orca also replays the current context to a new `workspace.changed` subscriber; a second identical update is harmless.
  await refreshStatus()

  mkdirSync(join(dir, 'bin'), { recursive: true, mode: 0o700 })
  writeFileSync(cliPath, THREAD_READ_MJS, { mode: 0o700 })
  chmodSync(cliPath, 0o700)

  orca.panels.handle('diag', () => {
    if (!s) throw new Error('history database unavailable')
    return {
      node: process.version,
      sqlite: (s.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
      dbPath,
      userVersion: s.userVersion(),
      cliInstalled: existsSync(cliPath),
      dirMode: mode(dir),
      dbMode: mode(dbPath)
    }
  })
}

export function deactivate(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  store?.close()
  store = null
}
