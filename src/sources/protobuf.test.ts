import { assert, test } from 'orca/testing'
import { fields } from './protobuf'

const bytes = (...b: number[]) => new Uint8Array(b)

test('multi-byte varint (300 = ac 02) and a 10-byte max varint', () => {
  assert.deepEqual(fields(bytes(0x08, 0xac, 0x02)), [{ no: 1, wire: 0, value: 300n }])
  const max = fields(bytes(0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01))
  assert.deepEqual(max, [{ no: 2, wire: 0, value: 2n ** 64n - 1n }])
})

test('fixed32, fixed64 (little-endian) and a multi-byte field number', () => {
  const got = fields(bytes(0x0d, 0x01, 0x02, 0x03, 0x04, 0x11, 1, 0, 0, 0, 0, 0, 0, 0x80, 0xa0, 0x06, 0x00))
  assert.deepEqual(got, [
    { no: 1, wire: 5, value: 0x04030201 },
    { no: 2, wire: 1, value: 0x8000000000000001n },
    { no: 100, wire: 0, value: 0n }
  ])
})

test('nested message: length-delimited bytes decode again', () => {
  // field 1 = "hi"; field 2 = { field 1 = 150, field 2 = "a" }
  const buf = bytes(0x0a, 0x02, 0x68, 0x69, 0x12, 0x06, 0x08, 0x96, 0x01, 0x12, 0x01, 0x61)
  const [name, child] = fields(buf)
  assert.ok(name?.wire === 2 && child?.wire === 2)
  assert.equal(new TextDecoder().decode(name.value), 'hi')
  const inner = fields(child.value)
  assert.equal(inner[0]?.value, 150n)
  assert.ok(inner[1]?.wire === 2)
  assert.equal(new TextDecoder().decode(inner[1].value), 'a')
})

test('decodes from a subarray with a non-zero byteOffset', () => {
  const outer = bytes(0xff, 0xff, 0x0d, 0x01, 0x00, 0x00, 0x00)
  assert.deepEqual(fields(outer.subarray(2)), [{ no: 1, wire: 5, value: 1 }])
})

test('empty input is no fields; malformed input throws', () => {
  assert.deepEqual(fields(bytes()), [])
  assert.throws(() => fields(bytes(0x0a, 0x05, 0x61)), /truncated/) // length 5, 1 byte present
  assert.throws(() => fields(bytes(0x08, 0x80)), /truncated/) // varint never ends
  assert.throws(() => fields(bytes(0x0d, 0x01, 0x02)), /truncated/) // fixed32 short
  assert.throws(() => fields(bytes(0x09, 1, 2, 3)), /truncated/) // fixed64 short
  assert.throws(() => fields(bytes(0x0b)), /wire type 3/) // start group
  assert.throws(() => fields(bytes(0x08, ...Array.from({ length: 10 }, () => 0x80), 0x01)), /exceeds 64 bits/) // 11 bytes
  assert.throws(() => fields(bytes(0x00, 0x00)), /field number 0 out of range/)
})

test('uint64 and field-number boundaries', () => {
  const tenth = (last: number) => bytes(0x08, ...Array.from({ length: 9 }, () => 0xff), last)
  assert.deepEqual(fields(tenth(0x01)), [{ no: 1, wire: 0, value: 2n ** 64n - 1n }])
  assert.throws(() => fields(tenth(0x02)), /exceeds 64 bits/) // 2^64: one past the max
  assert.throws(() => fields(tenth(0x7f)), /exceeds 64 bits/)
  // tag (2^29 - 1) << 3 = 0xfffffff8: the largest field number is fine, one more is refused.
  assert.deepEqual(fields(bytes(0xf8, 0xff, 0xff, 0xff, 0x0f, 0x00)), [{ no: 2 ** 29 - 1, wire: 0, value: 0n }])
  assert.throws(() => fields(bytes(0x80, 0x80, 0x80, 0x80, 0x10, 0x00)), /field number 536870912 out of range/)
  assert.throws(
    () => fields(bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01)),
    /field number 1152921504606846976 out of range/
  )
})
