import { assert, test } from 'orca/testing'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './store'
import { THREAD_READ_MJS } from './cliSource'
import type { CanonicalTurn } from './types'

const dir = mkdtempSync(join(tmpdir(), 'cs-tr-'))
const dbPath = join(dir, 'context.sqlite')
const cli = join(dir, 'thread-read.mjs')
writeFileSync(cli, THREAD_READ_MJS)

const store = openStore(dbPath)
const turns: CanonicalTurn[] = Array.from({ length: 20 }, (_, i) => ({ nativeId: `n${i}`, kind: 'user', text: `turn ${i + 1}`, at: 0 }))
turns[2] = { nativeId: 'n2', kind: 'file_change', text: '', paths: ['a.ts', 'b.ts'], at: 0 }
turns[3] = { nativeId: 'n3', kind: 'tool_call', text: '', tool: 'Grep', at: 0 }
const { threadId } = store.ingestParse(
  { agent: 'claude', nativeId: 'A' },
  { turns, cursor: { kind: 'offset', file: { path: '/x', dev: 1, ino: 1, size: 1 }, offset: 1 }, formatVersion: 'v1', markers: [],
    activeNativeIds: turns.filter((t) => t.nativeId !== 'n4').map((t) => t.nativeId) },
  { workspaceId: 'ws1' }
)
store.close()

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, CONTEXT_SWITCHER_DB: dbPath } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('pages with --after and --limit and says where to continue', () => {
  const r = run(threadId!, '--after', '10', '--limit', '5')
  assert.equal(r.code, 0, r.err)
  const ords = [...r.out.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]))
  assert.deepEqual(ords, [11, 12, 13, 14, 15])
  assert.ok(r.out.includes('#11 user [claude]: turn 11'))
  assert.ok(r.out.trimEnd().endsWith('next: --after 15'))
})

test('prints paths, tool and inactive markers; no next line at the end', () => {
  const r = run(threadId!)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.includes('#3 file_change [claude]: \n  paths: a.ts, b.ts\n'))
  assert.ok(r.out.includes('#4 tool_call [claude]: \n  tool: Grep\n'))
  assert.ok(r.out.includes('#5 user [claude]: turn 5 (inactive)'))
  assert.ok(!r.out.includes('next:'))
})

test('unknown thread exits 2, bad args exit 64', () => {
  assert.equal(run('t_none').code, 2)
  assert.equal(run().code, 64)
  assert.equal(run(threadId!, '--limit', 'x').code, 64)
  assert.equal(run(threadId!, '--bogus').code, 64)
})
