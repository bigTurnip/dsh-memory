/**
 * 测试侧独立门禁（D-13）。
 *
 * 与开发侧 `src/test/verify-all.mjs` 完全分开，互不引用：
 *   - 开发门禁验「实现对不对」（src/test/ 下工程师自有脚本）
 *   - 本门禁验「用户看到的东西对不对」（tests/ 下测试侧资产）
 *
 * 两套都通过，才算服务层可信；两者都验不到真实 GUI（L3/L4/L5）。
 *
 * 用法（**必须用宿主运行时**，live.mjs 要 FTS5）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tests/gate.mjs
 *
 * 注意：live.mjs 读 `lib/` 构建产物。若 src 比 lib 新，本门禁会自动重建，
 * 避免「测的是过期产物」这类假绿（该坑两侧各踩过一次）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 取目录树下最新 mtime。 */
function newest(dir) {
  const out = spawnSync(
    process.platform === 'win32' ? 'powershell' : 'sh',
    process.platform === 'win32'
      ? ['-NoProfile', '-Command', `Get-ChildItem -Recurse -File '${dir}' | Measure-Object -Property LastWriteTime -Maximum | Select-Object -ExpandProperty Maximum`]
      : ['-c', `find "${dir}" -type f -name '*.ts' -o -type f -name '*.tsx' | xargs stat -f %m 2>/dev/null | sort -n | tail -1`],
    { encoding: 'utf8' },
  )
  const raw = String(out.stdout || '').trim()
  const n = Number(raw)
  return Number.isFinite(n) ? n * 1000 : 0
}

// ---- 新鲜度防呆：live.mjs 读 lib/，src 更新则先重建 ----
const libEntry = join(root, 'lib', 'host', 'index.js')
const libTools = join(root, 'lib', 'host', 'tools', 'index.js')
const missing = [libEntry, libTools].filter((f) => !existsSync(f))
const srcDir = join(root, 'src')
let stale = missing.length > 0
if (!stale && existsSync(srcDir)) {
  const srcNewest = newest(srcDir)
  const libNewest = Math.max(statSync(libEntry).mtimeMs, statSync(libTools).mtimeMs)
  stale = srcNewest > libNewest
}

if (stale) {
  const why = missing.length > 0 ? `缺少产物 ${missing.map((f) => f.replace(root + '/', '')).join(', ')}` : 'src 比 lib 新'
  console.log(`[gate] ${why} —— 先重建`)
  const b = spawnSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit', cwd: root })
  if (b.status !== 0) {
    console.error('[gate] 重建失败，live 段会测到过期产物，中止')
    process.exit(1)
  }
}

// ---- 两段：断言库自检 + 真实输出回归 ----
const segments = [
  { name: '断言库自检（105 条，证明工具可信）', script: 'selfcheck.mjs' },
  { name: '活体契约（真实输出回归 12 条）', script: 'live.mjs' },
]

const results = []
for (const segment of segments) {
  const started = Date.now()
  console.log(`\n${'='.repeat(80)}\n${segment.name}\n${'='.repeat(80)}`)
  const run = spawnSync(process.execPath, [join(here, segment.script)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: root,
    env: process.env,
  })
  const elapsed = Date.now() - started
  const out = `${run.stdout || ''}${run.stderr || ''}`
  process.stdout.write(out)
  results.push({ name: segment.name, ok: run.status === 0, elapsed })
}

console.log(`\n${'='.repeat(80)}\n测试侧门禁汇总\n${'='.repeat(80)}`)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(36)} ${String(r.elapsed)}ms`)
}
const failed = results.filter((r) => !r.ok).length
console.log(failed === 0 ? `\n${results.length}/${results.length} 段通过` : `\n${failed} 段失败`)
process.exit(failed === 0 ? 0 : 1)
