import { assert, test } from 'orca/testing'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { THREAD_READ_MJS } from './cliSource'

test('thread-read rejects unsafe pagination integers as usage errors', () => {
  const cli = join(mkdtempSync(join(tmpdir(), 'cs-args-')), 'thread-read.mjs')
  writeFileSync(cli, THREAD_READ_MJS)
  for (const [flag, value] of [
    ['--limit', '99999999999999999999'],
    ['--after', '99999999999999999999'],
    ['--limit', String(Number.MAX_SAFE_INTEGER)]
  ]) {
    const result = spawnSync(process.execPath, [cli, 't_test', flag, value], { encoding: 'utf8' })
    assert.equal(result.status, 64, result.stderr)
    assert.ok(result.stderr.includes('usage:'))
  }
})
