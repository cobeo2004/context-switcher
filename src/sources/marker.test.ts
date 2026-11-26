import { assert, test } from 'orca/testing'
import { scanMarkers } from './marker'

const H = 'h_11111111-2222-4333-8444-555555555555'
const T = 't_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const marker = `[context-switcher handoff ${H} thread ${T}]`
const plain = (n: number) => Array.from({ length: n }, (_, i) => ({ nativeId: `u${i}`, rawText: `ordinary message ${i}` }))

test('finds a marker inside <system-reminder> wrapping', () => {
  const hits = scanMarkers([{ nativeId: 'r1', rawText: `<system-reminder>\n${marker}\nHere is the context…\n</system-reminder>` }])
  assert.deepEqual(hits, [{ handoffId: H, threadId: T, nativeId: 'r1', userRecordIndex: 0 }])
})

test('scans every record: markers in record 6 and record 40 are both found', () => {
  const records = plain(45)
  records[5] = { nativeId: 'u5', rawText: `${marker} resumed` }
  records[39] = { nativeId: 'u39', rawText: `prefix ${marker}` }
  assert.deepEqual(
    scanMarkers(records).map((h) => [h.nativeId, h.userRecordIndex]),
    [
      ['u5', 5],
      ['u39', 39]
    ]
  )
})

test('finds the Cursor variant C pointer line', () => {
  const pointer = `[context-switcher handoff ${H} thread ${T}] Context hand-off: run  node ~/.context-switcher/bin/thread-read.mjs --handoff ${H} --full  and treat its whole output (follow every next: line) as the hand-off. Then summarise where we are in 3 lines and wait for the user.`
  const [hit, ...rest] = scanMarkers([{ nativeId: '3.0:ab12', rawText: pointer }])
  assert.deepEqual(rest, [])
  assert.equal(hit?.handoffId, H)
  assert.equal(hit.threadId, T)
})

test('one hit per record: the first match', () => {
  const H2 = 'h_99999999-2222-4333-8444-555555555555'
  const hits = scanMarkers([{ nativeId: 'x', rawText: `${marker}\n[context-switcher handoff ${H2} thread ${T}]` }])
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.handoffId, H)
})

test('the marker prefix with a malformed id is no hit', () => {
  for (const rawText of [
    '[context-switcher handoff h_xyz thread t_abc]',
    `[context-switcher handoff ${H.slice(0, -1)} thread ${T}]`,
    `[context-switcher handoff ${H} thread ${T.toUpperCase()}]`,
    `[context-switcher handoff ${H} thread ${T}`
  ]) {
    assert.deepEqual(scanMarkers([{ nativeId: 'x', rawText }]), [], rawText)
  }
  assert.deepEqual(scanMarkers(plain(3)), [])
})
