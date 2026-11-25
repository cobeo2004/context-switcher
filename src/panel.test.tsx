// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mount, test } from 'orca/testing'
import * as panel from './panel'

test('shows the placeholder empty state', async () => {
  const view = await mount(panel)
  assert.ok(view.summary().some((line) => line.includes('Context Switcher')), view.summary().join('\n'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
