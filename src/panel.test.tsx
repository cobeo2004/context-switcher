// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
// The mounts reuse the `orca plugin check` scenarios (panel.check.ts), so both render the same panels.
import { assert, mockHost, mount, test, type CheckScenario, type TestPanel } from 'orca/testing'
import * as panel from './panel'

type Scenario = Pick<CheckScenario, 'requests' | 'persisted'>

async function open(scenario: Scenario, requests: object = {}): Promise<TestPanel> {
  const merged = { ...scenario.requests, ...requests }
  const view = await mount(panel, {
    host: mockHost({ requests: merged }),
    ...(scenario.persisted ? { persisted: scenario.persisted } : {})
  })
  await view.settled()
  return view
}

const PKG = {
  text: 'digest',
  bytes: 6,
  mode: 'full' as const,
  selectedTurnIds: [],
  omittedTurnIds: [],
  selected: 1,
  omitted: 0,
  coveredFromOrd: 1,
  coveredToOrd: 1,
  lossy: false,
  threadReadCommand: 'thread-read'
}
const STATE = {
  workspace: { id: 'ws', name: 'demo', remote: false },
  sources: [{ terminalId: 'term_claude', agent: 'claude', sessionId: 's_1', supported: true, stateStartedAt: 1 }],
  defaultSource: 'term_claude',
  targets: [
    { agent: 'claude', label: 'Claude', resumable: true, deliverable: true },
    { agent: 'cursor', label: 'Cursor', resumable: false, deliverable: true }
  ]
}

const PREVIEW = { ok: true as const, handoffId: 'h_1', pkg: PKG, sent: 'digest', strategy: 'launch' as const, expiresAt: 2 }
const BASE: Scenario = { requests: { 'switch.state': STATE, 'switch.preview': PREVIEW } }
const settled = (status: 'failed' | 'unconfirmed' | 'expired', inInput: boolean, error?: string): Scenario => ({
  requests: {
    ...BASE.requests,
    'handoff.get': { status, inInput, strategy: 'launch', bytes: 6, chars: 6, ...(error ? { error } : {}) }
  },
  persisted: { plugin: { 'switch.status': { handoffId: 'h_0', status, inInput, ...(error ? { error } : {}) } } }
})
const check = {
  noAgent: { requests: { 'switch.state': { ...STATE, sources: [] } } },
  remote: { requests: { 'switch.state': { ...STATE, workspace: { id: 'ws', name: 'demo', remote: true } } } },
  lossySource: {
    requests: {
      'switch.state': STATE,
      'switch.preview': (input: { lossy: boolean }) =>
        input.lossy
          ? { ...PREVIEW, handoffId: 'h_2', pkg: { ...PKG, lossy: true } }
          : { ok: false as const, code: 'unsupported_format' as const, message: 'Unsupported format.', lossyAvailable: true }
    }
  },
  overCap: {
    requests: {
      'switch.state': STATE,
      'switch.preview': { ...PREVIEW, pkg: { ...PKG, text: 'x'.repeat(3900), omitted: 12 }, sent: 'x'.repeat(3900) }
    }
  },
  oneClaude: BASE,
  failed: settled('failed', false, 'Codex did not become ready in time'),
  unconfirmed: settled('unconfirmed', false),
  inInput: settled('unconfirmed', true),
  cursorPointer: {
    requests: {
      'switch.state': STATE,
      'switch.preview': {
        ...PREVIEW,
        pkg: { ...PKG, omitted: 5 },
        sent: '[context-switcher handoff h_x thread t_x] run: thread-read.mjs --handoff h_x --full'
      }
    }
  }
} satisfies Record<string, Scenario>

const switchButton = (view: TestPanel) => view.find({ type: 'Button', text: 'Switch' })
const text = (view: TestPanel) => view.summary().join('\n')

async function close(view: TestPanel): Promise<void> {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
}

test('no agent shows an empty state and no Switch button', async () => {
  const view = await open(check.noAgent)
  assert.ok(text(view).includes('No agent to switch'), text(view))
  assert.equal(switchButton(view), null)
  await close(view)
})

test('remote disables Switch and says why', async () => {
  const view = await open(check.remote)
  assert.ok(view.find({ text: /Remote workspaces not supported yet/ }))
  assert.equal(switchButton(view)?.disabled, true)
  await close(view)
})

test('an unsupported source keeps Switch disabled until the lossy checkbox is pressed', async () => {
  const view = await open(check.lossySource)
  assert.ok(view.find({ text: /Screen capture, lossy/ }))
  assert.equal(switchButton(view)?.disabled, true)
  await view.toggle({ type: 'Checkbox', label: 'Use screen capture (lossy)' })
  assert.equal(switchButton(view)?.disabled, false)
  await close(view)
})

test('preview shows chars against the cap, the omitted count and the strategy', async () => {
  const view = await open(check.overCap)
  const kv = view.find({ type: 'KeyValue' })?.text ?? ''
  assert.match(kv, /\/ 4096/)
  assert.match(kv, /12/)
  assert.match(kv, /launch/)
  assert.ok(view.find({ type: 'CodeView' }))
  assert.equal(
    view.findAll({ type: 'CodeView' }).length,
    1,
    JSON.stringify(view.findAll({ type: 'CodeView' }).map((e) => [e.path, e.label]))
  )
  await close(view)
})

test('Switch sends switch.run with the previewed handoffId, then follows handoff.changed', async () => {
  const runs: unknown[] = []
  const view = await open(check.oneClaude, {
    'switch.run': (input: unknown) => {
      runs.push(input)
      return { ok: true, handoffId: 'h_1', status: 'pending' }
    }
  })
  assert.equal(switchButton(view)?.disabled, false)
  await view.press({ type: 'Button', text: 'Switch' })
  assert.deepEqual(runs, [{ handoffId: 'h_1' }])
  assert.ok(view.find({ text: /Pending/ }), JSON.stringify(view.tree()))
  await view.post('handoff.changed', { handoffId: 'h_1', status: 'delivered', inInput: false })
  assert.ok(view.find({ text: /Delivered/ }))
  await close(view)
})

test('a failed hand-off shows its error', async () => {
  const view = await open(check.failed)
  assert.ok(view.find({ text: /did not become ready in time/ }))
  await close(view)
})

test('an unconfirmed hand-off is a warning, not a delivery', async () => {
  const view = await open(check.unconfirmed)
  assert.ok(view.find({ text: /not confirmed/ }))
  assert.equal(view.find({ text: /^Delivered/ }), null)
  await close(view)
})

test('inInput asks for Enter and is not shown as delivered', async () => {
  const view = await open(check.inInput)
  assert.ok(view.find({ text: /Press Enter in that terminal\./ }), text(view))
  assert.equal(view.find({ text: /Delivered/ }), null)
  await close(view)
})

test('an expired result re-runs the preview', async () => {
  let previews = 0
  const view = await open(check.oneClaude, {
    'switch.preview': () => {
      previews += 1
      return {
        ok: true,
        handoffId: `h_${previews}`,
        pkg: PKG,
        sent: 'x',
        strategy: 'launch',
        expiresAt: 2
      }
    },
    'switch.run': () => ({ ok: false, code: 'expired' })
  })
  assert.equal(previews, 1)
  await view.press({ type: 'Button', text: 'Switch' })
  assert.equal(previews, 2)
  assert.ok(view.find({ text: /preview expired/ }))
  await close(view)
})

test('a Cursor pointer shows sent in a second CodeView with the explanation', async () => {
  const view = await open(check.cursorPointer)
  assert.ok(
    view.find({ text: /runs thread-read --full, which prints the turns in this preview plus the 5 omitted ones in full/ }) ??
      text(view).includes('thread-read --full'),
    text(view)
  )
  const views = view.findAll({ type: 'CodeView' })
  assert.equal(views.length, 2)
  assert.match(views[1]?.text ?? '', /thread-read\.mjs --handoff h_x --full/)
  await close(view)
})

test('an undeliverable target is listed disabled with its reason', async () => {
  const view = await open(check.oneClaude, {
    'switch.state': {
      workspace: { id: 'ws', name: 'demo', remote: false },
      sources: [{ terminalId: 'term_claude', agent: 'claude', sessionId: 's_1', supported: true, stateStartedAt: 1 }],
      defaultSource: 'term_claude',
      targets: [
        { agent: 'codex', label: 'Codex', resumable: true, deliverable: true },
        {
          agent: 'antigravity',
          label: 'Antigravity',
          resumable: false,
          deliverable: false,
          reason: 'no readiness profile for antigravity yet'
        }
      ]
    }
  })
  const options = view.find({ type: 'Select', label: 'To' })?.props['options']
  assert.deepEqual(options, [
    { value: 'codex', label: 'Codex', disabled: false },
    { value: 'antigravity', label: 'Antigravity (no readiness profile for antigravity yet)', disabled: true }
  ])
  await close(view)
})

test('agents.changed re-reads switch.state, and a new target previews again', async () => {
  let reads = 0
  const previews: unknown[] = []
  const view = await open(check.oneClaude, {
    'switch.state': () => {
      reads += 1
      return STATE
    },
    'switch.preview': (input: unknown) => {
      previews.push(input)
      return { ok: true, handoffId: 'h_1', pkg: PKG, sent: 'x', strategy: 'launch', expiresAt: 2 }
    }
  })
  assert.equal(reads, 1)
  await view.post('agents.changed', {})
  assert.equal(reads, 2)
  await view.select({ type: 'Select', label: 'To' }, 'cursor')
  assert.deepEqual(previews[previews.length - 1], { sourceTerminalId: 'term_claude', target: 'cursor', lossy: false })
  await close(view)
})

test('agents.changed with the same selection keeps the draft: no new preview, Switch stays disabled after a run (review 1)', async () => {
  let previews = 0
  let runs = 0
  const view = await open(check.oneClaude, {
    'switch.preview': () => {
      previews += 1
      return { ...PREVIEW, handoffId: `h_${previews}` }
    },
    'switch.run': () => {
      runs += 1
      return { ok: true, handoffId: 'h_1', status: 'pending' }
    }
  })
  await view.press({ type: 'Button', text: 'Switch' })
  assert.equal(switchButton(view)?.disabled, true)
  await view.post('agents.changed', {}) // the launch opened a terminal
  assert.equal(previews, 1)
  assert.equal(switchButton(view)?.disabled, true)
  await view.post('handoff.changed', { handoffId: 'h_1', status: 'delivered', inInput: false })
  await view.settled()
  assert.equal(previews, 2) // h_1 is spent once settled; a fresh draft replaces it
  assert.equal(switchButton(view)?.disabled, false)
  assert.equal(runs, 1)
  await close(view)
})

test('already_run fetches a fresh draft instead of leaving Switch on a spent one (review 1)', async () => {
  let previews = 0
  const runs: unknown[] = []
  const view = await open(check.oneClaude, {
    'switch.preview': () => {
      previews += 1
      return { ...PREVIEW, handoffId: `h_${previews}` }
    },
    'switch.run': (input: unknown) => {
      runs.push(input)
      return runs.length === 1 ? { ok: false, code: 'already_run' } : { ok: true, handoffId: 'h_2', status: 'pending' }
    }
  })
  await view.press({ type: 'Button', text: 'Switch' })
  assert.equal(previews, 2)
  assert.ok(view.find({ text: /already_run/ }))
  await view.press({ type: 'Button', text: 'Switch' })
  assert.deepEqual(runs, [{ handoffId: 'h_1' }, { handoffId: 'h_2' }])
  await close(view)
})

test('while a new selection previews, the old draft is not shown or runnable (review 1)', async () => {
  const view = await open(check.oneClaude, {
    'switch.preview': (input: { target: string }) =>
      input.target === 'cursor'
        ? new Promise((resolve) => {
            setTimeout(() => {
              resolve({ ...PREVIEW, handoffId: 'h_cursor' })
            }, 30)
          })
        : PREVIEW
  })
  assert.equal(switchButton(view)?.disabled, false)
  const picked = view.select({ type: 'Select', label: 'To' }, 'cursor')
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
  assert.equal(switchButton(view)?.disabled, true) // h_1 is for claude: not runnable while cursor's preview loads
  await picked
  await view.settled()
  assert.equal(switchButton(view)?.disabled, false)
  await close(view)
})

test('a switch.run reply that arrives after handoff.changed never steps the status back to pending (review 1)', async () => {
  const view = await open(check.oneClaude, {
    'switch.run': () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: true, handoffId: 'h_1', status: 'pending' })
        }, 30)
      })
  })
  const pressed = view.press({ type: 'Button', text: 'Switch' })
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
  await view.post('handoff.changed', { handoffId: 'h_1', status: 'failed', inInput: false, error: 'synthetic failure' })
  await pressed
  await view.settled()
  assert.ok(view.find({ text: /synthetic failure/ }), JSON.stringify(view.tree()))
  assert.equal(view.find({ text: /Pending/ }), null)
  await close(view)
})

test('a failed switch offers a fresh draft, so Switch works again (review 2)', async () => {
  let previews = 0
  const view = await open(check.oneClaude, {
    'switch.preview': () => {
      previews += 1
      return { ...PREVIEW, handoffId: `h_${previews}` }
    },
    'switch.run': () => ({ ok: true, handoffId: 'h_1', status: 'pending' })
  })
  await view.press({ type: 'Button', text: 'Switch' })
  await view.post('handoff.changed', { handoffId: 'h_1', status: 'failed', inInput: false, error: 'synthetic' })
  await view.settled()
  assert.equal(previews, 2)
  assert.equal(switchButton(view)?.disabled, false)
  assert.ok(view.find({ text: /synthetic/ }))
  await close(view)
})

test('a second press before the first reply sends nothing (review 2)', async () => {
  let runs = 0
  const view = await open(check.oneClaude, {
    'switch.run': () => {
      runs += 1
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: true, handoffId: 'h_1', status: 'pending' })
        }, 30)
      })
    }
  })
  const first = view.press({ type: 'Button', text: 'Switch' })
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
  assert.equal(switchButton(view)?.disabled, true)
  await first
  await view.settled()
  assert.equal(runs, 1)
  assert.equal(switchButton(view)?.disabled, true) // pending
  await close(view)
})

test('changing the target while a hand-off is pending keeps following it (review 2)', async () => {
  let previews = 0
  const view = await open(check.oneClaude, {
    'switch.preview': () => {
      previews += 1
      return { ...PREVIEW, handoffId: `h_${previews}` }
    },
    'switch.run': () => ({ ok: true, handoffId: 'h_1', status: 'pending' })
  })
  await view.press({ type: 'Button', text: 'Switch' }) // to the default target, Cursor
  await view.select({ type: 'Select', label: 'To' }, 'claude')
  await view.settled()
  assert.ok(view.find({ text: /Pending/ }))
  assert.equal(switchButton(view)?.disabled, true)
  await view.post('handoff.changed', { handoffId: 'h_1', status: 'delivered', inInput: false })
  assert.ok(view.find({ type: 'Callout', text: /Delivered to Cursor/ }), JSON.stringify(view.tree()))
  await close(view)
})

test('a reopened panel names the agent the hand-off went to, not the current target (review 2)', async () => {
  const view = await open({
    requests: {
      ...BASE.requests,
      'handoff.get': { status: 'unconfirmed', inInput: false, strategy: 'launch', bytes: 6, chars: 6 }
    },
    persisted: { plugin: { 'switch.status': { handoffId: 'h_0', status: 'unconfirmed', inInput: false, agent: 'claude' } } }
  })
  assert.ok(view.find({ text: /Sent to Claude/ }), JSON.stringify(view.tree())) // the default target is Cursor
  await close(view)
})

test('a selection change before the run reply still follows that hand-off and names its agent (review 3)', async () => {
  let finish = () => undefined as unknown
  const reply = new Promise((resolve) => {
    finish = () => {
      resolve({ ok: true, handoffId: 'h_1', status: 'pending' })
    }
  })
  const view = await open(check.oneClaude, {
    'switch.run': () => reply,
    'switch.preview': (input: { target: string }) => ({ ...PREVIEW, handoffId: input.target === 'cursor' ? 'h_1' : 'h_2' })
  })
  const pressed = view.press({ type: 'Button', text: 'Switch' }) // h_1 to the default target, Cursor
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
  const selected = view.select({ type: 'Select', label: 'To' }, 'claude')
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
  const posted = view.post('handoff.changed', { handoffId: 'h_1', status: 'failed', inInput: false, error: 'original cursor run failed' })
  finish()
  await Promise.all([selected, posted, pressed])
  await view.settled()
  assert.ok(view.find({ text: /original cursor run failed/ }), JSON.stringify(view.tree()))
  assert.equal(view.find({ text: /Pending/ }), null)
  await close(view)
})

test('a persisted pending the worker no longer knows is dropped, so Switch is not blocked forever (review 3)', async () => {
  const view = await open({
    requests: {
      ...BASE.requests,
      'handoff.get': null
    },
    persisted: { plugin: { 'switch.status': { handoffId: 'h_0', status: 'pending', inInput: false, agent: 'claude' } } }
  })
  await view.settled()
  assert.equal(view.find({ text: /Pending/ }), null)
  assert.equal(switchButton(view)?.disabled, false)
  await close(view)
})

test('the previewed draft expiring does not replace an in-flight status or re-enable Switch (review 3)', async () => {
  let previews = 0
  const view = await open(check.oneClaude, {
    'switch.preview': () => {
      previews += 1
      return { ...PREVIEW, handoffId: `h_${previews}` }
    },
    'switch.run': () => ({ ok: true, handoffId: 'h_1', status: 'pending' })
  })
  await view.press({ type: 'Button', text: 'Switch' }) // h_1 pending
  await view.post('agents.changed', {})
  await view.select({ type: 'Select', label: 'To' }, 'claude') // previews h_2 while h_1 is pending
  await view.settled()
  await view.post('handoff.changed', { handoffId: 'h_2', status: 'expired', inInput: false })
  await view.settled()
  assert.ok(view.find({ text: /Pending/ }), JSON.stringify(view.tree()))
  assert.equal(switchButton(view)?.disabled, true)
  await close(view)
})

test('a settle, then a selection change, then the run reply: the status stays settled and Switch works (review 4)', async () => {
  let finish = () => undefined as unknown
  const reply = new Promise((resolve) => {
    finish = () => {
      resolve({ ok: true, handoffId: 'h_1', status: 'pending' })
    }
  })
  const view = await open(check.oneClaude, {
    'switch.run': () => reply,
    'switch.preview': (input: { target: string }) => ({ ...PREVIEW, handoffId: input.target === 'cursor' ? 'h_1' : 'h_2' })
  })
  const pressed = view.press({ type: 'Button', text: 'Switch' })
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
  const posted = view.post('handoff.changed', { handoffId: 'h_1', status: 'delivered', inInput: false })
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
  const selected = view.select({ type: 'Select', label: 'To' }, 'claude')
  finish()
  await Promise.all([pressed, posted, selected])
  await view.settled()
  assert.equal(view.find({ text: /Pending/ }), null)
  assert.equal(switchButton(view)?.disabled, false)
  await close(view)
})

test('a worker not reachable at mount keeps the restored status, and the next load confirms it (live check 8.7)', async () => {
  let up = false
  const view = await open({
    requests: {
      ...BASE.requests,
      'handoff.get': () => {
        if (!up) throw new Error('worker not running')
        return { status: 'delivered', inInput: false, strategy: 'launch', bytes: 6, chars: 6 }
      }
    },
    persisted: { plugin: { 'switch.status': { handoffId: 'h_0', status: 'pending', inInput: false, agent: 'claude' } } }
  })
  assert.ok(view.find({ text: /Pending: delivering to Claude/ }), JSON.stringify(view.tree()))
  up = true
  await view.post('agents.changed', {})
  await view.settled()
  assert.ok(view.find({ text: /Delivered to/ }), JSON.stringify(view.tree()))
  await close(view)
})

test('a late answer for the restored status never replaces a newer event (live check 8.7)', async () => {
  const stale = { status: 'pending' as const, inInput: false, strategy: 'launch' as const, bytes: 6, chars: 6 }
  let calls = 0
  let view: TestPanel | null = null
  view = await open({
    requests: {
      ...BASE.requests,
      'handoff.get': async () => {
        calls += 1
        if (calls === 1) throw new Error('worker not running') // mount: the status stays restored
        // The settle event lands while this answer is still on its way.
        void view?.post('handoff.changed', { handoffId: 'h_0', status: 'failed', inInput: false, error: 'boom' })
        await new Promise((resolve) => setTimeout(resolve, 10))
        return stale
      }
    },
    persisted: { plugin: { 'switch.status': { handoffId: 'h_0', status: 'pending', inInput: false, agent: 'claude' } } }
  })
  await view.post('agents.changed', {})
  await view.settled()
  assert.equal(calls, 2)
  assert.ok(view.find({ text: /boom/ }), JSON.stringify(view.tree()))
  await close(view)
})

test('when the source first appears, the target is another agent, not the one picked while there was none (live check 8.7)', async () => {
  let calls = 0
  const view = await open({
    requests: {
      ...BASE.requests,
      'switch.state': () => (++calls === 1 ? { ...STATE, sources: [], defaultSource: null } : STATE)
    }
  })
  await view.post('agents.changed', {})
  await view.settled()
  assert.equal(view.find({ type: 'Select', label: 'To' })?.props['value'], 'cursor', JSON.stringify(view.tree()))
  await close(view)
})

test('a target the user picked survives a reload while the source stays (live check 8.7)', async () => {
  const view = await open(BASE)
  await view.select({ type: 'Select', label: 'To' }, 'claude')
  await view.post('agents.changed', {})
  await view.settled()
  assert.equal(view.find({ type: 'Select', label: 'To' })?.props['value'], 'claude')
  await close(view)
})
