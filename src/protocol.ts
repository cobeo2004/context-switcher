// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { HandoffStatus } from './types'

declare module 'orca' {
  interface PluginRequests {
    /** Where the store lives and whether it is healthy (PR1 probe 1.8). */
    diag: {
      output: {
        node: string
        sqlite: string
        dbPath: string
        userVersion: number
        cliInstalled: boolean
        dirMode: string
        dbMode: string
      }
    }
  }
  interface PluginPanelEvents {
    /** Posted when the sweep (or a delivery) moves a hand-off to a new status. */
    'handoff.changed': { id: string; status: HandoffStatus }
  }
}
