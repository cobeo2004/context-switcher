// The plugin's own worker. Orca transpiles this file when it loads; a save restarts it.
import type { OrcaWorkerApi } from 'orca/worker'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from './store'
import { THREAD_READ_MJS } from './cliSource'
import { createIngest } from './ingest'

const SWEEP_EVERY_MS = 60_000

let store: Store | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const dir = join(homedir(), '.context-switcher')
  const dbPath = join(dir, 'context.sqlite')
  const cliPath = join(dir, 'bin', 'thread-read.mjs')
  let s: Store | null = null
  try {
    s = openStore(dbPath)
    store = s
  } catch (error) {
    orca.log(`history database unavailable: ${String(error)}`)
    try {
      await orca.host.call('notifications.show', {
        title: 'Context Switcher',
        body: 'History database unavailable; switches will build from the session file'
      })
    } catch (notificationError) {
      orca.log(`notification failed: ${String(notificationError)}`)
    }
  }

  if (s) {
    const activeStore = s
    const retention = await orca.settings.get('retentionDays')
    const pruned = activeStore.prune(typeof retention === 'number' ? retention : 90)
    if (pruned) orca.log(`pruned ${pruned} idle thread(s)`)

    const sweep = () => {
      for (const change of activeStore.sweep()) orca.panels.post('handoff.changed', change)
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
    post: (change) => {
      orca.panels.post('handoff.changed', change)
    }
  })
  orca.events.on('agent.status.changed', ingest.onStatus)

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
