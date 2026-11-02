/** H-1 召回率实测入口（宿主运行时）。 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const out = mkdtempSync(join(tmpdir(), 'dsh-memory-recall-build-'))
process.env.DSH_MEMORY_SRC_ROOT = root

await build({
  entryPoints: [join(root, 'test/recall-entry.ts')],
  bundle: true,
  outfile: join(out, 'bundle.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
})
const mod = await import(pathToFileURL(join(out, 'bundle.mjs')).href)
const topK = Number(process.argv.find((a) => a.startsWith('--top='))?.slice(6) ?? 3)
const result = mod.run(topK)
rmSync(out, { recursive: true, force: true })

// D-11 修复 5：此前本脚本恒退 0，verify-all 的「H-1 PASS」是假阳性。
// 现在按阈值判定（top-K 召回率 ≥ 95%）输出真实退出码。
process.exit(result.passed ? 0 : 1)
