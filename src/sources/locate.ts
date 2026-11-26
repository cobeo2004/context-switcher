import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SessionNotFound, assertNever, type AdapterAgent, type SessionSource } from '../types'

export interface LocateQuery {
  sessionId: string
  cwd: string
  home: string
  cached?: string // sessions.source_path; re-located when it is gone (codex .jsonl → .jsonl.zst)
}

// The id becomes a path segment, so nothing that could climb out of the agent's directory.
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Finds an agent's native session file (plan §PR4 locator table). Throws SessionNotFound naming every path tried. */
export async function locate(agent: AdapterAgent, src: SessionSource, q: LocateQuery): Promise<string> {
  if (!SAFE_ID.test(q.sessionId)) throw new SessionNotFound(`${agent}: invalid session id ${JSON.stringify(q.sessionId)}`)
  const tried: string[] = []
  const probe = async (p: string) => {
    tried.push(p)
    return (await src.stat(p)) !== null
  }
  const found = q.cached !== undefined && (await probe(q.cached)) ? q.cached : await search(agent, src, q, tried, probe)
  if (found !== undefined) return found
  throw new SessionNotFound(`${agent}: session ${q.sessionId} not found; tried ${tried.join(', ')}`)
}

async function search(
  agent: AdapterAgent,
  src: SessionSource,
  { sessionId: id, cwd, home }: LocateQuery,
  tried: string[],
  probe: (p: string) => Promise<boolean>
): Promise<string | undefined> {
  switch (agent) {
    case 'claude': {
      const root = join(home, '.claude', 'projects')
      const direct = join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`)
      if (await probe(direct)) return direct
      tried.push(join(root, '*', `${id}.jsonl`))
      for (const dir of await src.list(root)) {
        const p = join(root, dir, `${id}.jsonl`)
        if (await src.stat(p)) return p
      }
      return undefined
    }
    case 'codex': {
      const root = join(home, '.codex', 'sessions')
      tried.push(join(root, 'YYYY', 'MM', 'DD', `rollout-*-${id}.jsonl[.zst]`))
      // ponytail: walks every day dir, newest first; index by id if histories get long enough to matter.
      const desc = async (dir: string) =>
        (await src.list(dir))
          .filter((n) => /^\d+$/.test(n))
          .sort()
          .reverse()
      for (const y of await desc(root))
        for (const m of await desc(join(root, y)))
          for (const d of await desc(join(root, y, m))) {
            const names = await src.list(join(root, y, m, d))
            const hit = [`-${id}.jsonl`, `-${id}.jsonl.zst`].map((end) => names.find((n) => n.startsWith('rollout-') && n.endsWith(end)))
            const name = hit[0] ?? hit[1]
            if (name !== undefined) return join(root, y, m, d, name)
          }
      return undefined
    }
    case 'pi': {
      // Pi's dir slug; the id is unique, so every other dir is a fallback when the slug rule differs.
      const root = join(home, '.pi', 'agent', 'sessions')
      const slug = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
      tried.push(join(root, slug, `*_${id}.jsonl`), join(root, '*', `*_${id}.jsonl`))
      const inDir = async (dir: string) => {
        const name = (await src.list(join(root, dir))).find((n) => n.endsWith(`_${id}.jsonl`))
        return name === undefined ? undefined : join(root, dir, name)
      }
      const preferred = await inDir(slug)
      if (preferred !== undefined) return preferred
      // ponytail: lists every real dir under the user's own sessions root (symlinks skipped); add a budget if that grows huge.
      for (const dir of (await src.dirs(root)).filter((d) => d !== slug)) {
        const hit = await inDir(dir)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    case 'cursor': {
      const p = join(home, '.cursor', 'chats', createHash('md5').update(cwd).digest('hex'), id, 'store.db')
      return (await probe(p)) ? p : undefined
    }
    default:
      return assertNever(agent)
  }
}
