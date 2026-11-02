/**
 * 一条命令跑完全部自测（lead 与 test-engineer 的复跑入口）。
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/verify-all.mjs
 *
 * 依次跑：单元+集成（run-all）/ smoke / 面板 DOM / H-1 召回 / H-4 性能 / U-4 像素 / 活体契约。
 * 任何一段失败即整体失败（退出码 1），并打印是哪一段。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

/**
 * 构建产物新鲜度检查（防"拿旧 lib 假装通过"）。
 *
 * 背景：第 7 段 live.mjs 走的是 **lib/ 构建产物**，而其余各段是把 src 的 TS
 * 现编到临时目录再 import。于是存在一条真实的门禁漏洞 ——
 * 改了 src 忘了 `npm run build` 时，run-all 会用新代码变红，
 * 而 live 段仍拿旧 lib 全绿；更糟的是若只跑 verify-all，
 * 一句"7/7 通过"里混着一次没验过的东西。
 * （我自己就在这上面栽过一次：把源码措辞改坏后 live 仍 12/12，实为未重建。）
 *
 * 处置：src 比 lib 新就先重建，让每一段验的都是当前源码。
 */
function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue
      newest = Math.max(newest, newestMtime(full))
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  return newest
}

const artifacts = [join(root, 'lib', 'host', 'index.js'), join(root, 'lib', 'host', 'tools', 'index.js')]
const missing = artifacts.filter((file) => !existsSync(file))
const srcNew = newestMtime(join(root, 'src'))
const libOldest = missing.length > 0 ? 0 : Math.min(...artifacts.map((file) => statSync(file).mtimeMs))

if (missing.length > 0 || srcNew > libOldest) {
  const why = missing.length > 0 ? `缺少产物 ${missing.map((f) => f.replace(root + '/', '')).join(', ')}` : 'src 比 lib 新'
  process.stdout.write(`[verify] ${why} —— 先重建 lib/，否则第 7 段会验到旧代码\n`)
  const built = spawnSync(process.execPath, [join(root, 'build.mjs')], { encoding: 'utf8', cwd: root })
  if (built.status !== 0) {
    process.stdout.write(built.stdout ?? '')
    process.stderr.write(built.stderr ?? '')
    console.error('构建失败，无法继续（第 7 段依赖 lib/ 产物）')
    process.exit(1)
  }
}

const segments = [
  { name: '单元+集成+硬约束（run-all）', script: 'run-all.mjs' },
  { name: 'smoke（O-1 就绪）', script: 'smoke.mjs' },
  { name: '面板 DOM 断言（O-9）', script: 'panel-render.mjs' },
  { name: 'H-1 召回率', script: 'recall.mjs' },
  { name: 'H-4 性能（10k）', script: 'perf.mjs' },
  // D-14：入口已改由宿主 `sidebar.panellist` 行渲染，U-4 保留为历史几何对照。
  { name: 'U-4 入口像素（历史对照）', script: 'u4-entry-metrics.mjs' },
  // D-13：本门禁只跑开发侧自测（src/test/ 下自有脚本）。
  // 测试侧资产（tests/）由测试工程师维护、由 tests/gate.mjs 独立跑，
  // 不在本门禁内引用 —— 否则改测试工具会让开发门禁变红，责任边界就糊了。
]

const results = []
for (const segment of segments) {
  const started = Date.now()
  // 注意：不要用 new URL().pathname —— 它会把中文路径百分号编码，node 找不到文件
  const run = spawnSync(process.execPath, [join(here, segment.script)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const ms = Date.now() - started
  results.push({ ...segment, code: run.status ?? 1, ms })
  process.stdout.write(run.stdout ?? '')
  if (run.status !== 0 && run.stderr) process.stderr.write(run.stderr)
}

console.log(`\n${'='.repeat(80)}\n汇总`)
for (const result of results) {
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'}  ${result.name.padEnd(34)} ${result.ms}ms`)
}
const failed = results.filter((result) => result.code !== 0)
console.log(`${results.length - failed.length}/${results.length} 段通过`)
process.exit(failed.length === 0 ? 0 : 1)
