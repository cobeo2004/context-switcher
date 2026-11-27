// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { ContextPackage, HandoffRow, HandoffStatus } from './types'

type Strategy = HandoffRow['strategy']

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
    /** R3/R4: the focused workspace, its agents (sources) and where a switch can go (targets). */
    'switch.state': {
      output: {
        workspace: { id: string; name: string; remote: boolean } | null
        sources: { terminalId: string; agent: string; sessionId: string | null; supported: boolean; stateStartedAt: number }[]
        defaultSource: string | null
        targets: { agent: string; label: string; resumable: boolean; deliverable: boolean; reason?: string }[]
      }
    }
    /** Builds and freezes the digest as a draft; `sent` is exactly what the target will receive. */
    'switch.preview': {
      input: { sourceTerminalId: string; target: string; lossy: boolean }
      output:
        | { ok: true; handoffId: string; pkg: ContextPackage; sent: string; strategy: Strategy; expiresAt: number }
        | {
            ok: false
            code: 'unsupported_format' | 'session_not_found' | 'remote' | 'no_agent'
            message: string
            lossyAvailable: boolean
          }
    }
    /** Claims the previewed draft and delivers it in the background (§0.5). */
    'switch.run': {
      input: { handoffId: string }
      output: { ok: true; handoffId: string; status: 'pending' } | { ok: false; code: 'expired' | 'already_run' | 'unknown' }
    }
    /** A hand-off's current state (e2e polling, the panel on reopen). */
    'handoff.get': {
      input: { handoffId: string }
      output: { status: HandoffStatus; inInput: boolean; error?: string; strategy: Strategy; bytes: number; chars: number }
    }
  }
  interface PluginPanelEvents {
    /** Posted on every hand-off status change (sweep, ingest bind, delivery). */
    'handoff.changed': { handoffId: string; status: HandoffStatus; inInput: boolean; error?: string }
    /** The agents in the focused workspace may have changed; re-read `switch.state`. */
    'agents.changed': Record<string, never>
  }
}
