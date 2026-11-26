// Proves the repo's lint policy bites and stays narrow: every case in gate/lint-cases.mjs is linted on its own and must
// report exactly its expected rules. Also pins the knip `@public` exceptions to gate/public-exports.txt.
import { ESLint } from 'eslint'
import { readFileSync, readdirSync } from 'node:fs'
import tseslint from 'typescript-eslint'
import cases from '../gate/lint-cases.mjs'

const typed = new ESLint({ overrideConfigFile: 'eslint.config.mjs', ignore: false })
// Boundary cases use real owner paths (src/store.ts …) that the type service cannot load, and their rules are not type-aware.
const untyped = new ESLint({ overrideConfigFile: 'eslint.config.mjs', ignore: false, overrideConfig: tseslint.configs.disableTypeChecked })
let failed = 0
for (const c of cases) {
  const eslint = c.path.startsWith('gate/') ? typed : untyped
  const [r] = await eslint.lintText(c.code, { filePath: c.path })
  const got = r.messages.map((m) => m.ruleId ?? (m.message.includes('noInlineConfig') ? 'inline-config' : `other: ${m.message}`)).sort()
  const want = [...c.expect].sort()
  if (got.join() !== want.join()) {
    failed++
    console.error(`FAIL ${c.name} (${c.path}): expected [${want.join(', ')}], got [${got.join(', ')}]`)
  }
}

const allowed = readFileSync('gate/public-exports.txt', 'utf8').split('\n').filter(Boolean).sort()
const tagged = []
// Recursive: src/sources/ and later subdirs carry tags too.
for (const f of readdirSync('src', { recursive: true }).filter((n) => /\.tsx?$/.test(n))) {
  const lines = readFileSync(`src/${f}`, 'utf8').split('\n')
  lines.forEach((l, i) => {
    if (!l.includes('@public')) return
    const name = /export (?:declare )?(?:class|interface|type|const|function) (\w+)/.exec(lines[i + 1] ?? '')?.[1]
    tagged.push(name ?? `${f}:${i + 1} (no export on the next line)`)
  })
}
if (tagged.sort().join() !== allowed.join()) {
  failed++
  console.error(`FAIL @public set: expected [${allowed.join(', ')}], got [${tagged.join(', ')}]`)
}

if (failed) process.exit(1)
console.log(`gate fixtures: ${cases.length} lint cases and the @public set (${allowed.length}) match`)
