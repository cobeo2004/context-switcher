/**
 * The `thread-read` CLI (R16), shipped as one plain-ESM string the worker writes to
 * ~/.context-switcher/bin/thread-read.mjs. No transpile, no import.meta.url, Node built-ins only.
 * Usage: thread-read <threadId> [--after <n>] [--limit <n>]
 *        thread-read --handoff <h_id> [--full] [--after <ord> [--offset <n>]]
 * Exit 2: unknown thread or hand-off. Exit 64: bad args.
 * Keep it free of backticks and dollar-brace: it lives inside String.raw.
 */
export const THREAD_READ_MJS = String.raw`#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PAGE_CHARS = 8000

function usage() {
  process.stderr.write('usage: thread-read <threadId> [--after <n>] [--limit <n>]\n' +
    '       thread-read --handoff <h_id> [--full] [--after <ord> [--offset <n>]]\n')
  process.exit(64)
}

const args = process.argv.slice(2)
let threadId = null
let handoffId = null
let full = false
let after = null
let limit = null
let offset = null
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--after' || a === '--limit' || a === '--offset') {
    const v = args[++i]
    if (!/^\d+$/.test(v || '')) usage()
    if (!Number.isSafeInteger(Number(v)) || (a === '--limit' && !Number.isSafeInteger(Number(v) + 1))) usage()
    if (a === '--after') after = Number(v)
    else if (a === '--limit') limit = Number(v)
    else offset = Number(v)
  } else if (a === '--handoff') {
    const v = args[++i]
    if (!v || v.startsWith('-') || handoffId !== null) usage()
    handoffId = v
  } else if (a === '--full') full = true
  else if (threadId === null && !a.startsWith('-')) threadId = a
  else usage()
}
if (handoffId !== null) {
  if (threadId !== null || limit !== null || (offset !== null && after === null)) usage()
} else {
  if (threadId === null || full || offset !== null) usage()
  if (limit === null) limit = 50
  if (limit < 1) usage()
}

const path = process.env.CONTEXT_SWITCHER_DB || join(homedir(), '.context-switcher', 'context.sqlite')
let db
try {
  db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 2000')
} catch (e) {
  process.stderr.write('thread-read: cannot open ' + path + ': ' + e.message + '\n')
  process.exit(1)
}

if (handoffId !== null) readHandoff()
else readThread()

function readThread() {
  if (!db.prepare('SELECT 1 FROM threads WHERE id = ?').get(threadId)) {
    process.stderr.write('thread-read: unknown thread ' + threadId + '\n')
    process.exit(2)
  }
  const rows = db.prepare(
    'SELECT t.ord, t.kind, s.agent, t.text, t.paths, t.tool, t.active FROM turns t JOIN sessions s ON s.id = t.session_id ' +
    'WHERE t.thread_id = ? AND t.ord > ? ORDER BY t.ord LIMIT ?'
  ).all(threadId, after || 0, limit + 1)

  const out = []
  for (const r of rows.slice(0, limit)) {
    out.push('#' + r.ord + ' ' + r.kind + ' [' + r.agent + ']: ' + r.text + (r.active ? '' : ' (inactive)'))
    if (r.paths) out.push('  paths: ' + JSON.parse(r.paths).join(', '))
    if (r.tool) out.push('  tool: ' + r.tool)
  }
  if (rows.length > limit) out.push('next: --after ' + rows[limit - 1].ord)
  process.stdout.write(out.join('\n') + (out.length ? '\n' : ''))
}

// Every page (header, turns, next line) is at most PAGE_CHARS UTF-16 code units. A turn that does not fit an
// empty page is printed in chunks cut on code-point boundaries; the next line resumes inside it with --offset.
function readHandoff() {
  const h = db.prepare('SELECT thread_id FROM handoffs WHERE id = ?').get(handoffId)
  if (!h) {
    process.stderr.write('thread-read: unknown hand-off ' + handoffId + '\n')
    process.exit(2)
  }
  const rows = db.prepare(
    'SELECT t.ord, t.kind, s.agent, t.text, t.paths, t.tool FROM handoff_turns ht JOIN turns t ON t.id = ht.turn_id ' +
    'JOIN sessions s ON s.id = t.session_id WHERE ht.handoff_id = ? AND (? OR ht.carried = 0) ORDER BY t.ord'
  ).all(handoffId, full ? 1 : 0)

  const next = (ord, off) => 'next: node ~/.context-switcher/bin/thread-read.mjs --handoff ' + handoffId +
    (full ? ' --full' : '') + ' --after ' + ord + (off === undefined ? '' : ' --offset ' + off)
  const metadata = (r) => (r.paths ? '  paths: ' + JSON.parse(r.paths).join(', ') + '\n' : '') +
    (r.tool ? '  tool: ' + r.tool + '\n' : '')

  let page = '# hand-off ' + handoffId + ' thread ' + h.thread_id + ': ' + rows.length + ' turns (' + (full ? 'full' : 'omitted') + ')\n'
  const room = PAGE_CHARS - next(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).length - 1
  let printed = 0
  let lastOrd = 0
  let from = offset || 0
  for (const r of rows) {
    if (after !== null && r.ord <= after) continue
    const text = r.text
    const meta = metadata(r)
    const separateMeta = meta.length > (room - page.length) / 2
    if (from >= text.length + (separateMeta ? meta.length : 0) && from > 0) { from = 0; continue }
    const whole = '#' + r.ord + ' ' + r.kind + ' [' + r.agent + ']: ' + text + (meta ? '\n' + meta : '\n')
    if (from === 0 && page.length + whole.length <= room) {
      page += whole
      printed++
      lastOrd = r.ord
      continue
    }
    if (printed > 0) {
      process.stdout.write(page + next(lastOrd) + '\n')
      return
    }
    const inMeta = separateMeta && from >= text.length
    const segment = inMeta ? meta : text
    const start = inMeta ? from - text.length : from
    const label = (x, y) => '#' + r.ord + ' ' + r.kind + ' (' + (inMeta ? 'metadata chars ' : 'chars ') + x + '–' + y + ' of ' + segment.length + '): '
    const firstMeta = !separateMeta && from === 0 ? meta : ''
    let end = Math.min(segment.length, start + room - page.length - label(segment.length, segment.length).length - 1 - firstMeta.length)
    const c = segment.charCodeAt(end - 1)
    if (end < segment.length && c >= 0xd800 && c <= 0xdbff) end--
    page += label(start + 1, end) + segment.slice(start, end) + '\n' + firstMeta
    if (end < segment.length || (separateMeta && !inMeta && meta)) {
      process.stdout.write(page + next(r.ord - 1, end + (inMeta ? text.length : 0)) + '\n')
      return
    }
    from = 0
    printed++
    lastOrd = r.ord
  }
  process.stdout.write(page + '# end\n')
}
`
