// Runs src/worker.ts's activate(orca) over a mock host with a temp HOME.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'

test('diag reports schema version, file modes and the installed CLI', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'))
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    const worker = await mountWorker(main, { host: mockHost({ settings: { retentionDays: 90, budgetBytes: 32768 } }) })
    const diag = await worker.request('diag')
    assert.equal(diag.userVersion, 1)
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
    process.env.HOME = prev
  }
})
