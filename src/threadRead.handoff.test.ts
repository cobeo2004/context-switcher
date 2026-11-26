import { assert, test } from 'orca/testing'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openStore } from './store'
import { THREAD_READ_MJS } from './cliSource'
import type { CanonicalTurn, HandoffId } from './types'

const PAGE_CHARS = 8000
const dir = mkdtempSync(join(tmpdir(), 'cs-trh-'))
const dbPath = join(dir, 'context.sqlite')
const cli = join(dir, 'thread-read.mjs')
writeFileSync(cli, THREAD_READ_MJS)
const store = openStore(dbPath)
function must<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined)
  return value
}

/** One thread of `turns` and a hand-off that carried the ords in `carried` and omitted the ords in `omitted`. */
function handoffTurns(turns: CanonicalTurn[], carried: number[], omitted: number[]): { h: string; thread: string } {
  const { threadId } = store.ingestParse(
    { agent: 'claude', nativeId: randomUUID() },
    { turns, cursor: { kind: 'offset', file: { path: '/x', dev: 1, ino: 1, size: 1 }, offset: 1 }, formatVersion: 'v1', markers: [] },
    { workspaceId: 'ws1' }
  )
  const thread = must(threadId)
  const idOf = new Map(store.eligibleTurns(thread).map((t) => [t.ord, t.id]))
  const h = `h_${randomUUID()}` as HandoffId
  store.createDraft(
    {
      id: h,
      thread_id: thread,
      source_session_id: null,
      source_agent: 'claude',
      target_agent: 'codex',
      target_session_id: null,
      target_terminal_id: null,
      workspace_id: 'ws1',
      strategy: 'launch'
    },
    {
      text: 'pkg',
      bytes: 3,
      mode: 'full',
      selectedTurnIds: carried.map((o) => must(idOf.get(o))),
      omittedTurnIds: omitted.map((o) => must(idOf.get(o))),
      selected: carried.length,
      omitted: omitted.length,
      coveredFromOrd: null,
      coveredToOrd: null,
      lossy: false,
      threadReadCommand: ''
    }
  )
  return { h, thread }
}
/** One thread of `texts` (ord 1..n), alternating user/assistant, and a hand-off covering `carried` + `omitted`. */
function handoff(texts: string[], carried: number[], omitted: number[]): { h: string; thread: string } {
  return handoffTurns(
    texts.map((text, i) => ({ nativeId: `n${i}`, kind: i % 2 ? 'assistant' : 'user', text, at: 0 })),
    carried,
    omitted
  )
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, CONTEXT_SWITCHER_DB: dbPath } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
/** Runs argv, then every printed `next:` line verbatim, until `# end`. */
function pages(args: string[]): string[] {
  const out: string[] = []
  for (let argv = args; ;) {
    const r = run(argv)
    assert.equal(r.code, 0, r.err)
    assert.ok(r.out.length <= PAGE_CHARS, `page ${out.length + 1} is ${r.out.length} chars`)
    assert.ok(!out.includes(r.out), 'repeated page')
    out.push(r.out)
    const last = must(r.out.trimEnd().split('\n').pop())
    if (last === '# end') return out
    assert.match(last, /^next: node ~\/\.context-switcher\/bin\/thread-read\.mjs --handoff /)
    const words = last.slice('next: '.length).split(' ')
    argv = words.slice(2) // drop `node` and the installed path: run() supplies process.execPath and the temp CLI
    assert.ok(out.length < 50, 'runaway paging')
  }
}
const wholeOrds = (page: string) => [...page.matchAll(/^#(\d+) \w+ \[claude\]: /gm)].map((m) => Number(m[1]))
const chunks = (page: string) =>
  [...page.matchAll(/^#(\d+) \w+ \(chars (\d+)–(\d+) of (\d+)\): (.*)$/gm)].map((m) => ({
    ord: Number(m[1]),
    a: Number(m[2]),
    b: Number(m[3]),
    n: Number(m[4]),
    text: must(m[5])
  }))
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('large metadata pages forward without losing text or metadata', () => {
  for (const full of [false, true])
    for (const n of [7600, 7774, 7800, 20000])
      for (const text of ['😀'.repeat(4500), ''])
        for (const astral of [false, true]) {
          if (!text && n !== 20000) continue
          const path = astral ? '😀'.repeat(Math.floor(n / 2)) + 'p'.repeat(n % 2) : 'p'.repeat(n)
          const meta = `  paths: ${path}\n  tool: read\n`
          const { h } = handoffTurns([{ nativeId: 'n0', kind: 'tool_call', text, paths: [path], tool: 'read', at: 0 }], [], [1])
          const ps = pages(['--handoff', h, ...(full ? ['--full'] : [])])
          const cs = ps.flatMap(chunks)
          assert.equal(cs.map((c) => c.text).join(''), text)
          for (const c of cs) {
            assert.equal(c.n, text.length)
            assert.equal(c.b - c.a + 1, c.text.length)
            assert.ok(!LONE.test(c.text))
          }
          const ms = ps.flatMap((p) => [
            ...p.matchAll(/^#1 tool_call \(metadata chars (\d+)–(\d+) of (\d+)\): ([\s\S]*?)\n(?=next:|# end)/gm)
          ])
          assert.equal(ms.map((m) => m[4]).join(''), meta)
          for (const m of ms) {
            assert.equal(Number(m[3]), meta.length)
            assert.equal(Number(m[2]) - Number(m[1]) + 1, must(m[4]).length)
            assert.ok(!LONE.test(must(m[4])))
          }
          const offsets = ps.slice(0, -1).map((p) => Number(must(/--offset (\d+)$/.exec(p.trimEnd())?.[1])))
          assert.ok(offsets.every((o, i) => o > 0 && (i === 0 || o > must(offsets[i - 1]))))
        }
})

test('exact set: carried {1, 9, 10}, omitted 2–8 → prints #2–#8 once, header first, # end last', () => {
  const { h, thread } = handoff(
    range(1, 10).map((i) => `turn ${i}`),
    [1, 9, 10],
    range(2, 8)
  )
  const ps = pages(['--handoff', h])
  assert.equal(ps.length, 1)
  assert.equal(must(must(ps[0]).split('\n')[0]), `# hand-off ${h} thread ${thread}: 7 turns (omitted)`)
  assert.deepEqual(wholeOrds(must(ps[0])), range(2, 8))
  assert.ok(must(ps[0]).includes('#2 assistant [claude]: turn 2\n'))
})

test('--full multi-page: every next line keeps --full, union is exactly 1…10 with no repeats', () => {
  const { h } = handoff(
    range(1, 10).map((i) => `${i}:`.padEnd(1500, 'f')),
    [1, 9, 10],
    range(2, 8)
  )
  const ps = pages(['--handoff', h, '--full'])
  assert.ok(ps.length >= 2, String(ps.length))
  assert.ok(must(ps[0]).startsWith(`# hand-off ${h} thread `) && must(must(ps[0]).split('\n')[0]).endsWith(': 10 turns (full)'))
  for (const p of ps.slice(0, -1)) assert.ok(must(p.trimEnd().split('\n').pop()).includes(' --full '), p.slice(-200))
  assert.deepEqual(ps.flatMap(wholeOrds), range(1, 10))
})

test('default multi-page: 12 omitted turns of 1500 chars → 5 on the first page, --after <ord5>, union is the 12', () => {
  const { h } = handoff(
    range(1, 13).map((i) => `${i}:`.padEnd(1500, 'd')),
    [1],
    range(2, 13)
  )
  const ps = pages(['--handoff', h])
  assert.deepEqual(wholeOrds(must(ps[0])), range(2, 6))
  assert.ok(
    must(ps[0]).trimEnd().endsWith(`next: node ~/.context-switcher/bin/thread-read.mjs --handoff ${h} --after 6`),
    must(ps[0]).slice(-200)
  )
  assert.deepEqual(ps.flatMap(wholeOrds), range(2, 13))
})

test('one huge turn: 20 000 chars → 3 pages, chunks rejoin to the exact text, offsets increase', () => {
  const sentinel = `SENTINEL-${randomUUID().replace(/-/g, '')}`
  let text = ''
  while (text.length < 20_000) text += Math.random().toString(36).slice(2)
  text = (text.slice(0, 10_000) + sentinel + text.slice(10_000)).slice(0, 20_000)
  const { h } = handoff(['small', text], [1], [2])
  const ps = pages(['--handoff', h])
  assert.equal(ps.length, 3)
  const cs = ps.flatMap(chunks)
  assert.equal(cs.length, 3)
  assert.equal(cs.map((c) => c.text).join(''), text)
  assert.ok(
    cs
      .map((c) => c.text)
      .join('')
      .includes(sentinel)
  )
  assert.deepEqual(
    cs.map((c) => c.n),
    [20_000, 20_000, 20_000]
  )
  assert.equal(must(cs[0]).a, 1)
  assert.equal(must(cs[2]).b, 20_000)
  const offsets = ps.slice(0, -1).map((p) => Number(must(/--after 1 --offset (\d+)$/.exec(p.trimEnd())?.[1])))
  assert.ok(must(offsets[0]) > 0 && must(offsets[1]) > must(offsets[0]), offsets.join(','))
  assert.deepEqual(offsets, [must(cs[0]).b, must(cs[1]).b])
})

test('tool_call metadata is printed once and excluded from text chunk offsets', () => {
  const sentinel = `SENTINEL-${randomUUID().replace(/-/g, '')}`
  const text = 'x'.repeat(4500) + sentinel + 'x'.repeat(4500)
  const { h } = handoffTurns(
    [
      { nativeId: 'n0', kind: 'user', text: 'small', at: 0 },
      { nativeId: 'n1', kind: 'tool_call', text, paths: ['/a'], tool: 'read', at: 0 }
    ],
    [1],
    [2]
  )
  const ps = pages(['--handoff', h])
  for (const p of ps) assert.ok(p.length <= PAGE_CHARS, `page is ${p.length} chars`)
  const cs = ps.flatMap(chunks)
  assert.ok(cs.length > 1, 'expected the tool_call to be chunked')
  for (const c of cs) assert.equal(c.n, text.length)
  assert.equal(cs.map((c) => c.text).join(''), text)
  assert.ok(
    cs
      .map((c) => c.text)
      .join('')
      .includes(sentinel)
  )
  assert.equal(ps.join('\n').match(/^ {2}paths: \/a$/gm)?.length, 1)
  assert.equal(ps.join('\n').match(/^ {2}tool: read$/gm)?.length, 1)
})

test('an excerpted (carried 0) turn is printed whole, chunked when it does not fit one page', () => {
  const last = 'HEAD-MARK ' + 'e'.repeat(9000) + ' TAIL-MARK'
  const { h } = handoff(['first', 'answer', last], [1, 2], [3])
  const ps = pages(['--handoff', h])
  assert.equal(ps.length, 2)
  assert.equal(
    ps
      .flatMap(chunks)
      .map((c) => c.text)
      .join(''),
    last
  )
})

test('astral boundary: a huge turn of 😀 never splits a surrogate pair', () => {
  const text = '😀'.repeat(7000)
  const { h } = handoff(['x', text], [1], [2])
  const cs = pages(['--handoff', h]).flatMap(chunks)
  assert.ok(cs.length >= 2)
  for (const c of cs) assert.ok(!LONE.test(c.text), `chunk ${c.a}–${c.b} has a lone surrogate`)
  assert.equal(cs.map((c) => c.text).join(''), text)
})

test('errors: unknown hand-off exits 2; bad args exit 64', () => {
  const { h, thread } = handoff(['a', 'b'], [1], [2])
  assert.equal(run(['--handoff', 'h_00000000-0000-0000-0000-000000000000']).code, 2)
  assert.equal(run(['--handoff']).code, 64)
  assert.equal(run(['--handoff', h, thread]).code, 64)
  assert.equal(run(['--handoff', h, '--offset', '5']).code, 64)
  assert.equal(run(['--handoff', h, '--after', '-1']).code, 64)
  assert.equal(run(['--handoff', h, '--after', '1', '--offset', 'x']).code, 64)
  assert.equal(run(['--handoff', h, '--limit', '5']).code, 64)
  assert.equal(run([thread, '--full']).code, 64)
  assert.equal(run(['--handoff', h, '--after', '1']).code, 0)
})
