/**
 * **真实输出回归**（`src/test/assert/live.mjs`）。
 *
 * ## 为什么需要这个文件
 * `selfcheck.mjs` 的 105 条用的是**手写样例文本**。它证明解析器与断言库
 * 自身逻辑正确，但**证明不了它们能处理实现真正吐出来的文本**——
 * 一旦实现改了措辞或格式，手写样例仍然全绿，而真实输出已经解析不了了。
 *
 * 本文件补上这一段：**直接调 `memory_list` 拿真实输出 → 喂解析器 → 跑断言**。
 * 这是"解析器 ↔ 实现"之间的活体契约检查，也是我在 task-7 汇报里承认的
 * 「缺真实数据回归」缺口的封闭。
 *
 * ## 与 selfcheck 的分工
 * | 文件 | 验什么 | 依赖 |
 * | --- | --- | --- |
 * | `selfcheck.mjs` | 解析器/断言库**自身**逻辑（正反成对） | 系统 node 即可 |
 * | `live.mjs`（本文件） | 解析器对**真实实现输出**的适配 | **必须宿主运行时**（要 sqlite + FTS5） |
 *
 * ## 退出码
 * 显式 `process.exit`，任一失败即 1。不允许重演 recall/u4 的假阳性。
 *
 * ## 运行
 * ```bash
 * ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *   src/test/assert/live.mjs
 * ```
 */

import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')  // D-13：测试侧资产已迁至包根 tests/

// 先在系统 node 上把 TS 编好，再由宿主运行时 import —— 与工程师自测同做法
const out = mkdtempSync(join(tmpdir(), 'dsh-memory-live-'))
await build({
  entryPoints: [join(here, 'live-body.ts')],
  bundle: true,
  outfile: join(out, 'bundle.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
})

const mod = await import(pathToFileURL(join(out, 'bundle.mjs')).href)
const ok = await mod.runLive(root)
rmSync(out, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
