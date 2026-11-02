/**
 * 从已安装的 DSH 构建产物中抽取入口相关的**真实 CSS**，写成 fixture。
 *
 * 为什么要这样做：U-4 要回答「入口在真机 GUI 的实际像素」。运行中的 GUI 需要
 * dsh web 的临时令牌，自动化拿不到；但**像素的唯一来源是宿主自己的 CSS 与布局算法**，
 * 而这两样都在安装产物里。所以本脚本把它们原样抠出来，交给无头浏览器按真实
 * 层叠关系渲染测量 —— 测量的是宿主的规则，不是我的猜测。
 *
 * 产物：test/fixtures/host-entry.css（原样拷贝，不做任何改写）
 * 运行：node test/extract-host-css.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PKGS = '/tmp/asar/pkgs/@deepseek-ai'
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/** 从打包后的 client.js 里取出 `const cssN = "..."` 的全部 CSS 文本。 */
function cssStrings(clientJs) {
  const text = readFileSync(clientJs, 'utf8')
  const out = []
  const re = /const css[\w$]* = "((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(text)) !== null) out.push(JSON.parse(`"${m[1]}"`))
  return out
}

function pick(clientJs, predicate, label) {
  for (const css of cssStrings(clientJs)) if (predicate(css)) return css
  throw new Error(`没有找到 ${label} 的 CSS；安装产物可能已升级，请复核测量脚本`)
}

const sidebar = join(PKGS, 'dsh-client-ui-sidebar/lib/client.js')
const settings = join(PKGS, 'dsh-client-ui-settings-general/lib/client.js')
const cordis = join(PKGS, 'dsh-client-ui-cordis/lib/client.js')

const parts = {
  // 侧栏根、脚区、折叠轨几何
  sidebar: pick(sidebar, (c) => c.includes('footArea'), 'sidebar root/foot'),
  // Settings 行（与入口同处脚区）
  settings: pick(settings, (c) => c.includes('triggerRow'), 'settings trigger row'),
  // 现有 occupant（插件面板）的入口按钮
  cordis: pick(cordis, (c) => c.includes('footerButtons'), 'cordis footer button'),
}

const header = `/* 由 test/extract-host-css.mjs 自动生成，请勿手改。
 * 来源：${ASAR} 内的
 *   @deepseek-ai/dsh-client-ui-sidebar          (侧栏根/脚区/折叠轨)
 *   @deepseek-ai/dsh-client-ui-settings-general (Settings 行)
 *   @deepseek-ai/dsh-client-ui-cordis           (既有 footer occupant)
 * 原样拷贝，未做任何改写。 */
`
mkdirSync(join(here, 'fixtures'), { recursive: true })
writeFileSync(
  join(here, 'fixtures/host-entry.css'),
  header + Object.entries(parts).map(([k, v]) => `/* ===== ${k} ===== */\n${v}`).join('\n\n') + '\n',
  'utf8',
)
console.log('已写出 test/fixtures/host-entry.css：', Object.entries(parts).map(([k, v]) => `${k} ${v.length}B`).join(' / '))
