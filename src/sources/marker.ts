import { MARKER_RE, type HandoffId, type MarkerHit, type ThreadId } from '../types'

/**
 * §0.2 rule 2: scan EVERY user record this parse read, raw and before any injection filter. No cap on the count
 * (revision 3's first-five cap missed resumed hand-offs). One hit per record: the first MARKER_RE match.
 */
export function scanMarkers(records: readonly { nativeId: string; rawText: string }[]): MarkerHit[] {
  return records.flatMap(({ nativeId, rawText }, userRecordIndex) => {
    const [, handoffId, threadId] = MARKER_RE.exec(rawText) ?? []
    if (handoffId === undefined || threadId === undefined) return []
    return [{ handoffId: handoffId as HandoffId, threadId: threadId as ThreadId, nativeId, userRecordIndex }]
  })
}
