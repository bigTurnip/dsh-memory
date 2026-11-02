/**
 * 构建整个包：先编译 host 侧 TypeScript → lib/，再打包 client bundle → lib/client.js。
 *
 * 两步都不能少：
 *   1. host 侧是 Node 侧代码（插件入口 lib/index.js），由 tsc 按 tsconfig.build.json 产出；
 *   2. client 侧是浏览器 bundle，宿主只认一种形态——classic script，执行时调用
 *      `window.__ModuleLoader__.load({ id, factory })` 注册 factory（模块体惰性）。
 *      所以不是普通 esbuild 打包，而是「esbuild 出 CJS + 外面套 factory 壳」。
 *
 * `external` 必须与宿主的共享模块表一致（多要一个就会在浏览器里抛
 * "cannot resolve"）。本插件只依赖 react 与 react/jsx-runtime。
 */
import { build } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = resolve(here, 'lib')

/** 宿主 web boot 冻结的共享模块表里，本插件实际用到的。 */
const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom']

// 客户端模块 id 必须等于包名：宿主按 entry 的 name（= package.json name）查找
// 对应的浏览器 bundle，写短名会让面板模块在浏览器里对不上号。
const PACKAGE_ID = '@clinexin/dsh-memory'

// ── 0. 清空旧产物，避免残留导致「产物落后于源码」 ───────────────────────────
await rm(libDir, { recursive: true, force: true })
await mkdir(libDir, { recursive: true })

// ── 1. 编译 host 侧 TypeScript → lib/（含 lib/index.js，即包入口）─────────────
console.log('编译 host 侧 TypeScript → lib/ …')
const tsc = spawnSync(
  process.execPath,
  [resolve(here, 'node_modules/typescript/bin/tsc'), '-p', resolve(here, 'tsconfig.build.json')],
  { stdio: 'inherit', cwd: here },
)
if (tsc.status !== 0) {
  throw new Error(`tsc 编译失败（退出码 ${String(tsc.status)}），host 侧产物未生成`)
}
console.log('host 侧编译完成')

// ── 2. 打包 client bundle → lib/client.js ──────────────────────────────────
const result = await build({
  entryPoints: [resolve(here, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120', 'safari17', 'firefox120'],
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
  charset: 'utf8',
  absWorkingDir: here,
})

const [out] = result.outputFiles
if (!out) throw new Error('esbuild 没有产出文件')

const bundled = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(PACKAGE_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${out.text}
		return module.exports;
	}
});
`

const target = resolve(libDir, 'client.js')
await writeFile(target, bundled, 'utf8')
const kb = (Buffer.byteLength(bundled) / 1024).toFixed(1)
console.log(`已打包 ${PACKAGE_ID} → lib/client.js（${kb} KB）`)

// ── 3. 校验包入口确实存在（防止 main 指向不存在的文件）──────────────────────
const { access } = await import('node:fs/promises')
// 入口路径以 package.json 的 main 为准，避免两处各写一个路径再次漂移
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(here, 'package.json'), 'utf8'))
const mainRel = typeof pkg.main === 'string' ? pkg.main : './lib/host/index.js'
const entry = resolve(here, mainRel)
try {
  await access(entry)
} catch {
  throw new Error(`构建结束但包入口 ${mainRel} 不存在——请检查 tsconfig.build.json 的 include/rootDir`)
}
console.log(`校验通过：包入口 ${mainRel} 存在`)
