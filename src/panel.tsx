// The switch panel (R1-R4, R6, R18): pick source and target, see the frozen digest, press Switch.
import {
  Button,
  Callout,
  Checkbox,
  CodeView,
  EmptyState,
  KeyValue,
  Select,
  Stack,
  Text,
  atom,
  plugin,
  read,
  set,
  type Atom,
  type PanelContext,
  type PluginPanelEvents,
  type PluginRequestOutput
} from 'orca'

type State = PluginRequestOutput<'switch.state'>
type Preview = PluginRequestOutput<'switch.preview'>
type Changed = PluginPanelEvents['handoff.changed']
interface Status {
  handoffId: string
  status: Changed['status']
  inInput: boolean
  error?: string
  agent?: string // the target it went to, so a reopened panel names the right agent
}

const CAP = 4096

const stateA = atom<State | null>(null)
const sourceA = atom('')
const targetA = atom('')
const lossyA = atom(false)
const previewA = atom<Preview | null>(null)
const problemA = atom<string | null>(null)
// Survives a panel close, so reopening shows what happened to the last switch.
const statusA = atom<Status | null>('switch.status', null, { persist: 'plugin' })
// The hand-off being sent, from the Switch press until switch.run answers: a second press cannot race the first.
const sendingA = atom<string | null>(null)
/** A hand-off still on its way: no other switch may start, and its status must not be cleared. */
const inFlight = (s: Status | null) => s !== null && (s.status === 'pending' || s.status === 'draft')

let seq = 0

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function toStatus(c: Changed, agent: string | undefined): Status {
  return {
    handoffId: c.handoffId,
    status: c.status,
    inInput: c.inInput,
    ...(c.error === undefined ? {} : { error: c.error }),
    ...(agent === undefined ? {} : { agent })
  }
}

async function preview(): Promise<void> {
  const mine = ++seq
  set(previewA, null) // the old draft is for the old selection: never runnable while the new one loads
  const sourceTerminalId = read(sourceA)
  const target = read(targetA)
  if (!sourceTerminalId || !target || read(stateA)?.workspace?.remote) {
    set(previewA, null)
    return
  }
  try {
    const p = await plugin.request('switch.preview', { sourceTerminalId, target, lossy: read(lossyA) })
    if (mine !== seq) return
    set(problemA, null)
    set(previewA, p)
  } catch (e) {
    if (mine !== seq) return
    set(previewA, null)
    set(problemA, message(e))
  }
}

/** The status restored at mount, until the worker has answered for it. */
let restored: Status | null = null

/** Re-reads the restored status. An unreachable worker (still loading, awaiting approval) leaves it for the next load. */
async function verify(): Promise<void> {
  const last = restored
  if (!last) return
  let g: PluginRequestOutput<'handoff.get'>
  try {
    g = await plugin.request('handoff.get', { handoffId: last.handoffId })
  } catch {
    return
  }
  if (restored === last) restored = null
  if (read(statusA) !== last) return // a newer event or a press replaced it: that one is current
  // Unknown to the store (DB reset): a restored pending would otherwise block Switch forever.
  set(
    statusA,
    g === null
      ? null
      : toStatus(
          { handoffId: last.handoffId, status: g.status, inInput: g.inInput, ...(g.error === undefined ? {} : { error: g.error }) },
          last.agent
        )
  )
}

async function load(): Promise<void> {
  void verify()
  try {
    const s = await plugin.request('switch.state')
    set(stateA, s)
    const source =
      s.sources.find((x) => x.terminalId === read(sourceA)) ?? s.sources.find((x) => x.terminalId === s.defaultSource) ?? s.sources[0]
    // Keep the picked target, unless the source moved to that same agent (a switch to itself is never the default).
    const sameSource = (source?.terminalId ?? '') === read(sourceA)
    const keep = s.targets.find((t) => t.agent === read(targetA) && t.deliverable && (sameSource || t.agent !== source?.agent))
    const pick = keep ?? s.targets.find((t) => t.deliverable && t.agent !== source?.agent) ?? s.targets.find((t) => t.deliverable)
    const changed = (source?.terminalId ?? '') !== read(sourceA) || (pick?.agent ?? '') !== read(targetA)
    set(sourceA, source?.terminalId ?? '')
    set(targetA, pick?.agent ?? '')
    set(problemA, null)
    // A workspace event (a launch opening a terminal, a rename) must not mint a new draft for the same selection.
    if (!changed && read(previewA) !== null) return
  } catch (e) {
    set(problemA, message(e))
    return
  }
  await preview()
}

function choose(a: Atom<string>, value: string): void {
  set(a, value)
  set(lossyA, false)
  if (!inFlight(read(statusA))) set(statusA, null) // keep following a hand-off that is still on its way
  void preview()
}

function toggleLossy(checked: boolean): void {
  set(lossyA, checked)
  void preview()
}

async function run(handoffId: string): Promise<void> {
  if (read(sendingA) !== null || inFlight(read(statusA))) return
  const agent = read(targetA) // the target this draft was previewed for, read before any await
  set(sendingA, handoffId)
  // Pending from the press, never from the reply: a late reply can then never undo a settle that came first.
  set(statusA, { handoffId, status: 'pending', inInput: false, agent })
  const mine = () => read(statusA)?.handoffId === handoffId
  try {
    const r = await plugin.request('switch.run', { handoffId })
    if (r.ok) return
    if (r.code === 'expired') {
      if (mine()) set(statusA, { handoffId, status: 'expired', inInput: false, agent })
      void preview()
    } else {
      // already_run / unknown: this draft is spent; fetch a fresh one, then say why (a successful preview clears problems).
      if (mine()) set(statusA, null)
      await preview()
      set(problemA, `That preview can't be used (${r.code}); a fresh one is below.`)
    }
  } catch (e) {
    if (mine() && read(statusA)?.status === 'pending') set(statusA, null) // never started: nothing to follow
    set(problemA, message(e))
  } finally {
    set(sendingA, null)
  }
}

function onChanged(c: Changed): void {
  const p = read(previewA)
  const was = read(statusA)
  // Pending is set on the press (run), so the hand-off being sent is always `was` here.
  const agent = was?.handoffId === c.handoffId ? was.agent : p?.ok && p.handoffId === c.handoffId ? read(targetA) : null
  if (agent === null) return // another hand-off
  // The previewed draft expiring must not replace the status of a hand-off still on its way (it would re-enable Switch).
  if (inFlight(was) && was?.handoffId !== c.handoffId) {
    if (p?.ok === true && p.handoffId === c.handoffId && c.status === 'expired') void preview()
    return
  }
  set(statusA, toStatus(c, agent))
  // Settled (delivered, unconfirmed, failed, expired): that draft is spent, so offer a fresh one.
  if (!inFlight(read(statusA)) && p?.ok === true && p.handoffId === c.handoffId) void preview()
}

export function setup(ctx: PanelContext): void {
  restored = read(statusA)
  ctx.subscriptions.push(
    plugin.on('handoff.changed', onChanged),
    plugin.on('agents.changed', () => {
      void load()
    })
  )
  void load()
}

function StatusLine({ status, agent }: { status: Status; agent: string }) {
  if (status.inInput && (status.status === 'pending' || status.status === 'unconfirmed')) {
    return (
      <Callout tone="warning" title="Not sent yet">
        The hand-off is in {agent}'s input but was not sent. Press Enter in that terminal.
      </Callout>
    )
  }
  switch (status.status) {
    case 'delivered':
      return <Callout tone="success">Delivered to {agent}.</Callout>
    case 'unconfirmed':
      return <Callout tone="warning">Sent to {agent}, but its arrival is not confirmed. Check that terminal.</Callout>
    case 'failed':
      return (
        <Callout tone="danger" title="Switch failed">
          {status.error ?? 'The hand-off could not be delivered.'}
        </Callout>
      )
    case 'expired':
      return <Callout tone="warning">The preview expired. A fresh one is below; press Switch again.</Callout>
    case 'draft':
    case 'pending':
      return <Text muted>Pending: delivering to {agent}…</Text>
  }
}

export default function Panel() {
  const state = read(stateA)
  const problem = read(problemA)
  if (!state) {
    return problem ? <Callout tone="danger">{problem}</Callout> : <Text muted>Loading…</Text>
  }
  if (!state.workspace || state.sources.length === 0) {
    return <EmptyState icon="agent" title="No agent to switch" description="Start an agent in this workspace, then reopen this panel." />
  }
  const source = read(sourceA)
  const target = read(targetA)
  const lossy = read(lossyA)
  const p = read(previewA)
  const status = read(statusA)
  const remote = state.workspace.remote
  const targetLabel = state.targets.find((t) => t.agent === target)?.label ?? target
  const showLossy = lossy || (p !== null && !p.ok && p.lossyAvailable)
  const pointer = p?.ok === true && p.sent !== p.pkg.text
  // A draft runs once: after Switch it stays disabled until a fresh preview replaces it.
  const spent = status !== null && p?.ok === true && status.handoffId === p.handoffId
  const busy = read(sendingA) !== null || inFlight(status)
  return (
    <Stack gap="md">
      {remote ? <Callout tone="warning">Remote workspaces not supported yet</Callout> : null}
      <Select
        label="From"
        value={source}
        options={state.sources.map((s) => ({ value: s.terminalId, label: `${s.agent} · ${s.terminalId}` }))}
        onChange={(v) => {
          choose(sourceA, v)
        }}
      />
      <Select
        label="To"
        value={target}
        options={state.targets.map((t) => ({
          value: t.agent,
          label: t.deliverable || !t.reason ? t.label : `${t.label} (${t.reason})`,
          disabled: !t.deliverable
        }))}
        onChange={(v) => {
          choose(targetA, v)
        }}
      />
      {problem ? <Callout tone="danger">{problem}</Callout> : null}
      {p && !p.ok ? <Callout tone={p.code === 'unsupported_format' ? 'warning' : 'danger'}>{p.message}</Callout> : null}
      {showLossy ? (
        <Stack gap="xs">
          <Callout tone="warning" title="Screen capture, lossy">
            This session cannot be read from disk. The hand-off would be built from what the terminal shows, and is not kept.
          </Callout>
          <Checkbox label="Use screen capture (lossy)" checked={lossy} onChange={toggleLossy} />
        </Stack>
      ) : null}
      {p?.ok ? (
        <Stack gap="sm">
          <CodeView label="Hand-off" code={p.pkg.text} wrap maxHeight="md" />
          <KeyValue
            items={[
              { label: 'Characters', value: `${p.pkg.text.length} / ${CAP}` },
              { label: 'Omitted turns', value: p.pkg.omitted },
              { label: 'Strategy', value: p.strategy }
            ]}
          />
          {pointer ? (
            <Stack gap="xs">
              <Callout tone="neutral">
                Cursor receives the short line below. It then runs thread-read --full, which prints the turns in this preview plus the{' '}
                {p.pkg.omitted} omitted ones in full.
              </Callout>
              <CodeView label="Sent to Cursor" code={p.sent} wrap maxHeight="sm" />
            </Stack>
          ) : null}
        </Stack>
      ) : null}
      {status ? (
        <StatusLine status={status} agent={state.targets.find((t) => t.agent === status.agent)?.label ?? status.agent ?? targetLabel} />
      ) : null}
      <Button
        variant="solid"
        disabled={remote || !p?.ok || spent || busy}
        onPress={() => {
          if (p?.ok) void run(p.handoffId)
        }}
      >
        Switch
      </Button>
    </Stack>
  )
}
