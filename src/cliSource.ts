/**
 * The `thread-read` CLI (R16), shipped as one plain-ESM string the worker writes to
 * ~/.context-switcher/bin/thread-read.mjs. No transpile, no import.meta.url, Node built-ins only.
 * Usage: thread-read <threadId> [--after <n>] [--limit <n>]. Exit 2: unknown thread. Exit 64: bad args.
 * Keep it free of backticks and dollar-brace: it lives inside String.raw.
 */
export const THREAD_READ_MJS = String.raw`#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

function usage() {
  process.stderr.write('usage: thread-read <threadId> [--after <n>] [--limit <n>]\n')
  process.exit(64)
}

const args = process.argv.slice(2)
let threadId = null
let after = 0
let limit = 50
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--after' || a === '--limit') {
    const v = args[++i]
    if (!/^\d+$/.test(v || '')) usage()
    if (!Number.isSafeInteger(Number(v)) || (a === '--limit' && !Number.isSafeInteger(Number(v) + 1))) usage()
    if (a === '--after') after = Number(v)
    else limit = Number(v)
  } else if (threadId === null && !a.startsWith('-')) threadId = a
  else usage()
}
if (threadId === null || limit < 1) usage()

const path = process.env.CONTEXT_SWITCHER_DB || join(homedir(), '.context-switcher', 'context.sqlite')
let db
try {
  db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 2000')
} catch (e) {
  process.stderr.write('thread-read: cannot open ' + path + ': ' + e.message + '\n')
  process.exit(1)
}

if (!db.prepare('SELECT 1 FROM threads WHERE id = ?').get(threadId)) {
  process.stderr.write('thread-read: unknown thread ' + threadId + '\n')
  process.exit(2)
}

const rows = db.prepare(
  'SELECT t.ord, t.kind, s.agent, t.text, t.paths, t.tool, t.active FROM turns t JOIN sessions s ON s.id = t.session_id ' +
  'WHERE t.thread_id = ? AND t.ord > ? ORDER BY t.ord LIMIT ?'
).all(threadId, after, limit + 1)

const out = []
for (const r of rows.slice(0, limit)) {
  out.push('#' + r.ord + ' ' + r.kind + ' [' + r.agent + ']: ' + r.text + (r.active ? '' : ' (inactive)'))
  if (r.paths) out.push('  paths: ' + JSON.parse(r.paths).join(', '))
  if (r.tool) out.push('  tool: ' + r.tool)
}
if (rows.length > limit) out.push('next: --after ' + rows[limit - 1].ord)
process.stdout.write(out.join('\n') + (out.length ? '\n' : ''))
`
