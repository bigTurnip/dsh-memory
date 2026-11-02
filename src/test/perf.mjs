import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const out = mkdtempSync(join(tmpdir(), 'dsh-memory-perf-build-'))
await build({ entryPoints: [join(root,'test/perf-entry.ts')], bundle: true, outfile: join(out,'b.mjs'),
  format:'esm', platform:'node', target:'node22', packages:'external', logLevel:'warning' })
const mod = await import(pathToFileURL(join(out,'b.mjs')).href)
const total = Number(process.argv.find(a=>a.startsWith('--total='))?.slice(8) ?? 10000)
const queries = Number(process.argv.find(a=>a.startsWith('--queries='))?.slice(10) ?? 500)
const r = mod.run(total, queries)
rmSync(out, { recursive:true, force:true })
process.exit(r.pass ? 0 : 1)
