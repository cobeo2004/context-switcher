import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { locate } from './locate'
import { LocalSessionSource } from './sessionSource'
import { SessionNotFound } from '../types'

const src = new LocalSessionSource()
const ID = '0b5e2a4c-1f3d-4e6a-9b7c-8d9e0f1a2b3c'

async function withHome(files: string[], fn: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'cs-loc-'))
  try {
    for (const f of files) {
      mkdirSync(dirname(join(home, f)), { recursive: true })
      writeFileSync(join(home, f), '{}\n')
    }
    await fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('claude: every non-alphanumeric cwd char becomes -', () =>
  withHome([`.claude/projects/-a--t3-x-y-z/${ID}.jsonl`], async (home) => {
    const p = await locate('claude', src, { sessionId: ID, cwd: '/a/.t3/x_y z', home })
    assert.equal(p, join(home, `.claude/projects/-a--t3-x-y-z/${ID}.jsonl`))
  }))

test('claude: falls back to any project dir when the slug dir differs', () =>
  withHome([`.claude/projects/-other/${ID}.jsonl`], async (home) => {
    assert.equal(await locate('claude', src, { sessionId: ID, cwd: '/a/b', home }), join(home, `.claude/projects/-other/${ID}.jsonl`))
  }))

test('cursor: chats/<md5(cwd)>/<id>/store.db', () =>
  withHome([`.cursor/chats/aee31d71a4dce5fe24481547cc863476/${ID}/store.db`], async (home) => {
    const p = await locate('cursor', src, { sessionId: ID, cwd: '/a/b', home })
    assert.equal(p, join(home, `.cursor/chats/aee31d71a4dce5fe24481547cc863476/${ID}/store.db`))
  }))

test('codex: uses the .zst when only the .zst exists, newest day first', () =>
  withHome(
    [`.codex/sessions/2026/11/25/rollout-2026-11-25T10-00-00-${ID}.jsonl.zst`, `.codex/sessions/2026/09/01/rollout-x-other.jsonl`],
    async (home) => {
      const p = await locate('codex', src, { sessionId: ID, cwd: '/a', home })
      assert.equal(p, join(home, `.codex/sessions/2026/11/25/rollout-2026-11-25T10-00-00-${ID}.jsonl.zst`))
    }
  ))

test('codex: prefers the live .jsonl over the .zst and the newer day over the older', () =>
  withHome(
    [
      `.codex/sessions/2026/02/09/rollout-old-${ID}.jsonl`,
      `.codex/sessions/2026/11/25/rollout-new-${ID}.jsonl.zst`,
      `.codex/sessions/2026/11/25/rollout-new-${ID}.jsonl`
    ],
    async (home) => {
      assert.equal(
        await locate('codex', src, { sessionId: ID, cwd: '/a', home }),
        join(home, `.codex/sessions/2026/11/25/rollout-new-${ID}.jsonl`)
      )
    }
  ))

test('codex: re-locates when the cached .jsonl was replaced by .jsonl.zst (ENOENT)', () =>
  withHome([`.codex/sessions/2026/11/25/rollout-t-${ID}.jsonl.zst`], async (home) => {
    const cached = join(home, `.codex/sessions/2026/11/25/rollout-t-${ID}.jsonl`)
    assert.equal(await locate('codex', src, { sessionId: ID, cwd: '/a', home, cached }), `${cached}.zst`)
  }))

test('a cached path that still exists is returned as is', () =>
  withHome([`elsewhere/${ID}.jsonl`], async (home) => {
    const cached = join(home, `elsewhere/${ID}.jsonl`)
    assert.equal(await locate('claude', src, { sessionId: ID, cwd: '/a', home, cached }), cached)
  }))

test('pi: --<slug>--/*_<id>.jsonl, with any other dir as fallback', async () => {
  await withHome([`.pi/agent/sessions/--a-b--/2026-11-25T10-00-00_${ID}.jsonl`], async (home) => {
    assert.equal(
      await locate('pi', src, { sessionId: ID, cwd: '/a/b', home }),
      join(home, `.pi/agent/sessions/--a-b--/2026-11-25T10-00-00_${ID}.jsonl`)
    )
  })
  await withHome([`.pi/agent/sessions/--moved--/t_${ID}.jsonl`], async (home) => {
    assert.equal(await locate('pi', src, { sessionId: ID, cwd: '/a/b', home }), join(home, `.pi/agent/sessions/--moved--/t_${ID}.jsonl`))
  })
})

test('pi: a symlinked dir under sessions/ is not followed', () =>
  withHome([`outside/t_${ID}.jsonl`], async (home) => {
    mkdirSync(join(home, '.pi/agent/sessions'), { recursive: true })
    symlinkSync(join(home, 'outside'), join(home, '.pi/agent/sessions/link'))
    await assert.rejects(locate('pi', src, { sessionId: ID, cwd: '/a/b', home }), (e) => e instanceof SessionNotFound)
  }))

test('SessionNotFound names every path tried', () =>
  withHome([], async (home) => {
    const cached = join(home, 'gone.jsonl')
    const want: Record<string, string[]> = {
      claude: [cached, join(home, `.claude/projects/-a-b/${ID}.jsonl`), join(home, `.claude/projects/*/${ID}.jsonl`)],
      codex: [cached, join(home, `.codex/sessions/YYYY/MM/DD/rollout-*-${ID}.jsonl[.zst]`)],
      pi: [cached, join(home, `.pi/agent/sessions/--a-b--/*_${ID}.jsonl`), join(home, `.pi/agent/sessions/*/*_${ID}.jsonl`)],
      cursor: [cached, join(home, `.cursor/chats/aee31d71a4dce5fe24481547cc863476/${ID}/store.db`)]
    }
    for (const agent of ['claude', 'codex', 'pi', 'cursor'] as const) {
      await assert.rejects(
        locate(agent, src, { sessionId: ID, cwd: '/a/b', home, cached }),
        (e) => e instanceof SessionNotFound && e.message.endsWith(`tried ${(want[agent] ?? []).join(', ')}`)
      )
    }
  }))

test('an id that could leave the agent dir is refused before any read', () =>
  withHome([`.claude/projects/x/${ID}.jsonl`], async (home) => {
    for (const sessionId of ['../x', 'a/b', '', '..']) {
      await assert.rejects(
        locate('claude', src, { sessionId, cwd: '/a', home }),
        (e) => e instanceof SessionNotFound && e.message.includes('invalid')
      )
    }
  }))
