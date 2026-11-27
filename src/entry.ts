// D1 entry points: the palette command, Mod+Alt+K and the status bar item all open the switch panel.
import type { Run } from './proc'

export const SWITCH_COMMAND = 'context-switcher.switch'
export const STATUS_ITEM = 'active-agent'
// ponytail: the key of a manifest without `publisher` (dev-loaded); change it when the plugin gets a publisher.
const PLUGIN_KEY = 'local.context-switcher'
// The worker runs as `Orca Helper.app`, so an execPath-relative CLI does not exist (probe 1.9(e)).
export const ORCA_CLIS = ['/Applications/Orca.app/Contents/Resources/bin/orca', 'orca']
export const OPEN_ARGS = ['plugin', 'open', PLUGIN_KEY, '--panel', 'switch']

/** Tries each CLI in turn; false when none opened the panel. */
export async function openPanel(run: Run): Promise<boolean> {
  for (const cli of ORCA_CLIS) {
    try {
      await run(cli, OPEN_ARGS)
      return true
    } catch {
      // not there or refused: try the next one
    }
  }
  return false
}

/** R3: the only agent, else the one whose state started last; `Agent ▾` when there is none. */
export function statusText(agents: readonly { agent: string | null; stateStartedAt: number }[]): string {
  let best: { agent: string; stateStartedAt: number } | null = null
  for (const { agent, stateStartedAt } of agents) {
    if (agent && (!best || stateStartedAt > best.stateStartedAt)) best = { agent, stateStartedAt }
  }
  const name = best ? best.agent.charAt(0).toUpperCase() + best.agent.slice(1) : 'Agent'
  return `${name} ▾`
}
