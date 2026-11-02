/**
 * O-1 / O-7：一条 smoke 命令，自证"记忆已就绪"。
 *
 * test-engineer 的通过标准要求"能一条命令确认记忆可用"，否则 125+ 条 E2E 无从开始。
 *
 * 检查六件事：
 * 1. 宿主运行时（版本 + 是否 FTS5）
 * 2. 库能打开、表能建
 * 3. 默认设置正确（enabled=1 / retention=30）
 * 4. 四个工具都已导出且可调用一次
 * 5. HTTP 路由表已注册且**没有 create**（PB-4）
 * 6. 一次端到端：写入 → 检索 → 列表 → 删除 → 回收站
 *
 * 运行：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/smoke.mjs
 */

import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const out = mkdtempSync(join(tmpdir(), 'dsh-memory-smoke-'))
process.env.DSH_MEMORY_SRC_ROOT = root

await build({
  entryPoints: [join(root, 'test/smoke-entry.ts')],
  bundle: true,
  outfile: join(out, 'bundle.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
})
const mod = await import(pathToFileURL(join(out, 'bundle.mjs')).href)
const ok = await mod.smoke()
rmSync(out, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
