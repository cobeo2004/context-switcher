import { assert, test } from 'orca/testing'
import { compare } from './crosscheck.ts'
const user = { role: 'user' as const, text: 'synthetic one' }
const assistant = { role: 'assistant' as const, text: 'synthetic two' }
test('crosscheck: an unlimited Orca reply must match every native message', () => {
  assert.equal(compare([user, assistant], [], false), 'MISMATCH counts native 2, orca 0')
  assert.equal(compare([user, assistant], [assistant], false), 'MISMATCH counts native 2, orca 1')
  assert.equal(compare([user, assistant], [user, assistant], false), 'equal')
})
test('crosscheck: only a nonempty limited Orca reply compares a native tail', () => {
  assert.equal(compare([user, assistant], [assistant], true), 'equal')
  assert.equal(compare([user, assistant], [user], true), 'MISMATCH at 1 (native 2, orca 1)')
  assert.equal(compare([user, assistant], [], true), 'MISMATCH counts native 2, orca 0')
  assert.equal(compare([user], [user, assistant], true), 'MISMATCH counts native 1, orca 2')
  assert.equal(compare([], []), 'MISMATCH counts native 0, orca 0') // empty is never a pass
})
