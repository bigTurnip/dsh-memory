/**
 * 自测入口。
 *
 * **必须用宿主运行时跑**（系统 node v23 的 node:sqlite 没有 FTS5，见 tech-design F-13）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/run-all.mjs
 *
 * 本文件用 esbuild 现场把 TS 编译成 ESM 再 import —— 这样自测不需要额外的构建步骤，
 * 也保证测的是与发布同一份源码。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const out = mkdtempSync(join(tmpdir(), 'dsh-memory-build-'))
process.env.DSH_MEMORY_SRC_ROOT = root

const entry = join(root, 'test/entry.ts')
await build({
  entryPoints: [entry],
  bundle: true,
  outfile: join(out, 'bundle.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
})
const mod = await import(pathToFileURL(join(out, 'bundle.mjs')).href)
const ok = await mod.main()
rmSync(out, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
