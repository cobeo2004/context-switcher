/** One protobuf wire-format field. Varint and fixed64 are bigint (they can exceed 2^53); nested messages stay bytes. */
export type WireField =
  | { no: number; wire: 0; value: bigint }
  | { no: number; wire: 1; value: bigint }
  | { no: number; wire: 2; value: Uint8Array }
  | { no: number; wire: 5; value: number }

const MAX_FIELD = 2n ** 29n - 1n

/** Minimal wire reader (no dependency). Throws on truncation, groups and unknown wire types; callers map that to UnsupportedFormat. */
export function fields(buf: Uint8Array): WireField[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out: WireField[] = []
  let at = 0
  const take = (n: number) => {
    if (at + n > buf.length) throw new Error(`protobuf: truncated at byte ${at}`)
    at += n
    return at - n
  }
  const varint = () => {
    let v = 0n
    for (let shift = 0n; ; shift += 7n) {
      const b = buf[take(1)] ?? 0
      // The 10th byte holds bit 63 only; anything more (or an 11th byte) is past uint64.
      if (shift === 63n && b > 1) throw new Error(`protobuf: varint exceeds 64 bits at byte ${at - 1}`)
      v |= BigInt(b & 0x7f) << shift
      if (b < 0x80) return v
    }
  }
  while (at < buf.length) {
    const tag = varint()
    if (tag >> 3n < 1n || tag >> 3n > MAX_FIELD) throw new Error(`protobuf: field number ${tag >> 3n} out of range`)
    const no = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) out.push({ no, wire, value: varint() })
    else if (wire === 1) out.push({ no, wire, value: view.getBigUint64(take(8), true) })
    else if (wire === 2) {
      const len = Number(varint())
      const start = take(len)
      out.push({ no, wire, value: buf.subarray(start, start + len) })
    } else if (wire === 5) out.push({ no, wire, value: view.getUint32(take(4), true) })
    else throw new Error(`protobuf: unsupported wire type ${wire} for field ${no}`)
  }
  return out
}
