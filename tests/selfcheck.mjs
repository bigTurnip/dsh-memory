/**
 * 解析器自检（`src/test/assert/selfcheck.mjs`）。
 *
 * ## 为什么自检要正反成对
 * 只跑"正向样例必须过"是不够的 —— 那样只能证明解析器**不会误报**，
 * 证明不了它**能抓到违约**。一个永远返回空结果的解析器也能让所有正向样例通过。
 * 所以每条口径都配一条**反向违约注入**：故意喂一段违反契约的文本，
 * 断言必须失败。只有两边都成立，断言库才具备证据力。
 *
 * ## 退出码纪律（F-13 的教训）
 * 本脚本**显式 `process.exit`**：任一失败即 exit 1。
 * 这正是 recall.mjs / u4-entry-metrics.mjs 犯过的错 —— 它们恒 exit 0，
 * 导致 verify-all 把 FAIL 记成 PASS。这里不允许重演。
 *
 * ## 运行
 * 系统 node 即可（纯文本解析，不碰 sqlite）：
 *   node src/test/assert/selfcheck.mjs
 * 用宿主运行时跑也行（结果相同）。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')  // D-13：测试侧资产已迁至包根 tests/

// 把 TS 编译成 ESM 再 import —— 与工程师自测同样的做法，不引入额外构建步骤
const out = mkdtempSync(join(tmpdir(), 'dsh-memory-assert-'))
await build({
  entryPoints: [join(here, 'selfcheck-body.ts')],
  bundle: true,
  outfile: join(out, 'bundle.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
})

const mod = await import(pathToFileURL(join(out, 'bundle.mjs')).href)
const ok = await mod.runSelfcheck()
rmSync(out, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
