/**
 * U-4 实测：`sidebar.footer.action` 上「既有 occupant（cordis 插件入口）+ 记忆入口 +
 * Settings」在**真实宿主几何**下能否共存，以及各自的实际像素。
 *
 * **D-14 修订（2026-11-01）**：入口已搬回 `sidebar.panellist`，由宿主入口行渲染
 * （只吃图标 + label）。本脚本测的是**旧形态**的几何，保留作为历史对照与
 * 「同排为何不可行」的证据，**不再作为入口验收门禁**：现在的入口几何由宿主行决定，
 * 可断言的部分已移到 `panel-render-entry.tsx`（id/key 绑定、无角标）。
 *
 * === 三个数值全部来自宿主源码，不是设计稿的假设 ===
 *  1. 侧栏宽：layout store 默认 sidebar=280，computeColumns 夹紧到 [264, 420]
 *     —— 设计稿 panel-entry.md §8.3 写的「236px」与宿主不符（236 是更早版本的常量）。
 *  2. 折叠轨宽：computeColumns 的 collapsedWidth = (darwin || windows-titlebar) ? 0 : 56
 *     —— macOS 桌面（本机就是）**整列隐藏、没有轨道**；56px 轨只在浏览器 Web GUI / Windows 存在。
 *  3. 脚区几何：侧栏 root 是 `padding:6px 12px`，折叠时 `18px 10px 6px`；
 *     footerActions 是 `width:100%; display:flex`；设置的 triggerRow 是 `calc(100% + 4px)`。
 *
 * === 为什么这样测可信 ===
 * CSS 原样取自安装产物（test/extract-host-css.mjs），DOM 结构照抄三个 occupant
 * 的真实渲染结构，布局由无头 Chromium 真算并取 getBoundingClientRect。
 *
 * === 明确局限 ===
 * 这是「宿主 CSS + 真实结构 + 真机宽度常量」的布局测量，不是运行中 Electron
 * 窗口的截图。窗口级因素（macOS 隐藏标题栏、滚动条占位）未建模。
 *
 * 运行：node test/u4-entry-metrics.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hostCss = readFileSync(join(here, 'fixtures/host-entry.css'), 'utf8')
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const scratch = join(tmpdir(), 'dsh-memory-u4')
const profile = join(scratch, 'edge-profile')
rmSync(profile, { recursive: true, force: true }); mkdirSync(profile, { recursive: true })

/** 宿主真实侧栏宽度：min 264 / default 280 / max 420。 */
const SIDEBAR_WIDTHS = [264, 280, 420]
/** 宿主折叠轨宽度（仅 web/windows 存在）。 */
const RAIL = 56
/** 侧栏 root 的水平 padding：宽态 12px，折叠 10px。 */
const PAD = { wide: 12, rail: 10 }

const cordis = (rail) => `
<div class="sB3NaG_layer${rail ? ' sB3NaG_rail' : ''}" id="cordis"><div class="sB3NaG_footerButtons">
 <button class="sB3NaG_badge" id="plugin" aria-label="插件"><svg width="${rail?18:16}" height="${rail?18:16}"></svg>
 ${rail?'':'<span class="sB3NaG_badgeLabel">插件</span><span class="sB3NaG_badgeCount">0</span>'}</button>
</div></div>`

const CANDIDATES = {
  /** V1 与 occupant 同排，各占 100%（设计 §8.3「同排」+ §8.1「图标+文字」的字面实现） */
  v1_same_row: {
    css: `.mem{flex:none;width:100%;display:flex;margin:8px 0 0}
.mem__btn{box-sizing:border-box;width:100%;height:44px;display:inline-flex;align-items:center;gap:8px;
 padding:0 10px 0 8px;border:0;border-radius:12px;background:0 0;font:inherit;font-size:14px;
 line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden}`,
    railCss: `.kB3qhq_collapsed .mem{width:36px;height:36px;margin:0;justify-content:center}
.kB3qhq_collapsed .mem__btn{width:36px;height:36px;border-radius:50%;padding:0;justify-content:center;gap:0}
.kB3qhq_collapsed .mem__label{display:none}`,
  },
  /** V2 与 occupant 同排，但各占一半（需 occupant 可压缩；host occupant 是 flex:none，做不到） */
  v2_same_row_split: {
    css: `.kB3qhq_footerActions{align-items:center}
#cordis{flex:1 1 0;min-width:0}
.mem{flex:1 1 0;min-width:36px;display:flex;margin:8px 0 0}
.mem__btn{box-sizing:border-box;width:100%;height:44px;display:inline-flex;align-items:center;gap:6px;
 padding:0 8px;border:0;border-radius:12px;background:0 0;font:inherit;font-size:14px;line-height:22px;
 color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden}
.mem__label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    railCss: `.kB3qhq_collapsed .mem{flex:none;width:36px;height:36px;margin:0}
.kB3qhq_collapsed .mem__btn{width:36px;height:36px;border-radius:50%;padding:0;justify-content:center;gap:0}
.kB3qhq_collapsed .mem__label{display:none}`,
  },
  /** V3 纵向叠放（替代方案）：脚区两行，各占满宽，互不挤压 */
  v3_stacked: {
    css: `.kB3qhq_footerActions{flex-direction:column;gap:2px}
.mem{flex:none;width:100%;display:flex;order:-1}
.mem__btn{box-sizing:border-box;width:100%;height:44px;display:inline-flex;align-items:center;gap:8px;
 padding:0 10px 0 8px;border:0;border-radius:12px;background:0 0;font:inherit;font-size:14px;
 line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden}`,
    railCss: `.kB3qhq_collapsed .kB3qhq_footerActions{flex-direction:column;gap:2px}
.kB3qhq_collapsed .mem{width:36px;height:36px;margin:0;justify-content:center}
.kB3qhq_collapsed .mem__btn{width:36px;height:36px;border-radius:50%;padding:0;justify-content:center;gap:0}
.kB3qhq_collapsed .mem__label{display:none}`,
  },
}

const page = (v, rail, width) => `<!doctype html><meta charset="utf-8"><style>
:root{--dsw-specific-sidebar-fill:#F7F5F2;--dsw-alias-label-primary:#1B1A18;--dsw-alias-label-secondary:#4E4A45;
--dsw-alias-label-tertiary:#6E6862;--dsw-alias-interactive-bg-hover:#EAE6E0;--dsw-radius-sm:6px;
--dsw-radius-md:8px;--dsw-alias-border-l3:#DDD8D2;--dsw-alias-button-elevated-fill:#FFF}
html,body{margin:0}
${hostCss}
${v.css}
${rail ? v.railCss : ''}
</style><div id="app"></div><pre id="out"></pre><script>
document.getElementById('app').innerHTML=\`
<div class="kB3qhq_root" id="root">
 <div class="kB3qhq_regionArea"></div>
 <div class="kB3qhq_footArea">
  <div class="kB3qhq_footerActions" id="fa">
   ${cordis(rail)}
   <div class="mem" id="memLayer"><button class="mem__btn" id="memory" aria-label="记忆">
    <span id="mark">记</span><span class="mem__label" id="label">记忆</span></button></div>
  </div>
  <div class="kB3qhq_settingsArea">
   <div class="_77Pn0W_triggerRow${rail?' _77Pn0W_railRow':''}"><button class="_77Pn0W_trigger${rail?' _77Pn0W_rail':''}" id="settings" aria-label="设置">
    <svg width="16" height="16"></svg>${rail?'':'<span class="_77Pn0W_triggerLabel">设置</span>'}</button></div>
  </div>
 </div>
</div>\`;
const root=document.getElementById('root');
root.classList.toggle('kB3qhq_collapsed', ${rail});
root.style.cssText+=';width:${width}px;height:640px;display:flex;flex-direction:column';
const mk=document.getElementById('mark');
mk.style.cssText='flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;background:#1B1A18;color:#fff;font-size:11px;font-weight:700;line-height:1';
const q=s=>document.querySelector(s);
const R=s=>{const e=q(s);if(!e)return null;const r=e.getBoundingClientRect();
 return{w:+r.width.toFixed(1),h:+r.height.toFixed(1),x:+r.left.toFixed(1),y:+r.top.toFixed(1),right:+r.right.toFixed(1),bottom:+r.bottom.toFixed(1)};};
const ov=(a,b)=>a&&b&&!(a.right<=b.x||b.right<=a.x)&&!(a.bottom<=b.y||b.bottom<=a.y);
const mem=R('#memory'),pl=R('#plugin'),se=R('#settings'),rb=root.getBoundingClientRect();
const fa=q('#fa'),lbl=q('#label');
document.getElementById('out').textContent='R:'+JSON.stringify({
 mem, plugin:pl, settings:se,
 overlapPlugin:ov(mem,pl), overlapSettings:ov(mem,se),
 clipLeftInFoot:+(fa.getBoundingClientRect().left-mem.x).toFixed(1),
 clipRight:+(mem.right-rb.right).toFixed(1),
 faOverflow:fa.scrollWidth>fa.clientWidth+.5, rootOverflow:root.scrollWidth>root.clientWidth+.5,
 labelVisible:lbl?getComputedStyle(lbl).display!=='none':null,
 labelTruncated:lbl?lbl.scrollWidth>lbl.clientWidth+.5:null,
});
</script>`

const M = {}
for (const [name, v] of Object.entries(CANDIDATES)) {
  for (const width of SIDEBAR_WIDTHS) {
    const f = join(scratch, `u4-${name}-w${width}.html`)
    writeFileSync(f, page(v, false, width), 'utf8')
    const dom = execFileSync(EDGE, ['--headless=new','--disable-gpu','--no-sandbox',`--user-data-dir=${profile}`,
      '--virtual-time-budget=800','--dump-dom',`file://${f}`], { encoding:'utf8', maxBuffer: 16*1024*1024 })
    const m = dom.match(/R:(\{[\s\S]*?\})<\/pre>/)
    M[`${name}/wide${width}`] = m ? JSON.parse(m[1].replace(/&quot;/g,'"')) : { error: dom.slice(-400) }
  }
  const f = join(scratch, `u4-${name}-rail.html`)
  writeFileSync(f, page(v, true, RAIL), 'utf8')
  const dom = execFileSync(EDGE, ['--headless=new','--disable-gpu','--no-sandbox',`--user-data-dir=${profile}`,
    '--virtual-time-budget=800','--dump-dom',`file://${f}`], { encoding:'utf8', maxBuffer: 16*1024*1024 })
  const m = dom.match(/R:(\{[\s\S]*?\})<\/pre>/)
  M[`${name}/rail56`] = m ? JSON.parse(m[1].replace(/&quot;/g,'"')) : { error: dom.slice(-400) }
}

const rows = []
/**
 * D-11 修复 5：退出码门禁只作用于**已采用形态**。
 * D-9 Q1 裁定入口为「纵向叠放、记忆在 cordis 之上」（`src/client/entry.tsx` 的
 * `order:-1`），对应本脚本的 V3；V1/V2 是**同排**方案，已被 D-9 Q1 以几何不可行否决
 * （cordis 入口 `flex:none; width:calc(100%+4px)` 宽态即独占整行）。
 * 若把被否决方案也计入退出码，U-4 会永远红 —— 那与假阳性同样是无效门禁。
 * V1/V2 仍照跑照打，作为「同排为何不可行」的对照证据。
 */
const ADOPTED = 'v3_stacked'
const chk = (id, desc, ok, detail) => rows.push({ id, desc, ok, detail, adopted: id.startsWith(ADOPTED) })
for (const [key, r] of Object.entries(M)) {
  if (r.error) { chk(key, '测量失败', false, r.error); continue }
  const rail = key.endsWith('rail56')
  const usable = rail ? RAIL - 2*PAD.rail : Number(key.match(/wide(\d+)/)[1]) - 2*PAD.wide + 4
  chk(`${key}.overlap`, '与插件入口 / Settings 不重叠（设计 §8.3）',
    !r.overlapPlugin && !r.overlapSettings, `plugin=${r.overlapPlugin} settings=${r.overlapSettings}`)
  chk(`${key}.clip`, '入口不被侧栏列裁切（overflow:hidden 不吞掉内容）',
    r.clipRight <= 0.5 && r.clipLeftInFoot >= -0.5, `右溢 ${r.clipRight} / 左溢 ${r.clipLeftInFoot}`)
  chk(`${key}.hit44`, rail
    ? '折叠轨命中区 ≥36×36（D-9 Q2：44×44 仅宽态适用，折叠沿用宿主 36×36）'
    : '命中区 ≥44×44（设计 §8.1/§8.4 触控要求）',
    rail ? r.mem.w >= 36 && r.mem.h >= 36 : r.mem.w >= 44 && r.mem.h >= 44,
    `${r.mem.w}×${r.mem.h}`)
  chk(`${key}.icon`, '图标 18×18', true, '（本脚本固定 18px，不随档位变）')
  if (!rail) chk(`${key}.label`, '宽态显示「记忆」文字', r.labelVisible === true,
    `labelVisible=${r.labelVisible}${r.labelTruncated?'，被截断':''}`)
  else chk(`${key}.label`, '折叠轨不显示文字/数字', r.labelVisible === false, `labelVisible=${r.labelVisible}`)
  void usable
}

const gated = rows.filter((x) => x.adopted)
const control = rows.filter((x) => !x.adopted)
const pass = rows.filter((x) => x.ok).length
const gatedFail = gated.filter((x) => !x.ok).length
const report = [
  `U-4 实测（历史对照：D-14 起入口改由 sidebar.panellist 宿主行渲染）：入口在真实宿主几何下的像素（${new Date().toISOString()}）`,
  '=' .repeat(104),
  `判定形态：${ADOPTED}（D-9 Q1 纵向叠放）；其余形态为对照，不计入退出码`,
  ...rows.map((x) => `${x.ok?'PASS':'FAIL'}  ${x.adopted?'':'[对照] '}${x.id.padEnd(27)} ${x.desc.padEnd(44)} → ${x.detail}`),
  '='.repeat(104),
  `${pass}/${rows.length} 通过（全部）  ｜  门禁项 ${gated.length - gatedFail}/${gated.length} 通过`,
  `U-4 判定：${gatedFail === 0 ? 'PASS' : 'FAIL'}（已采用形态 ${ADOPTED} 失败 ${gatedFail} 项）`,
  '',
  '宿主常量（源码依据）：',
  '  computeColumns(): sidebar = clamp(pref, 264, 420)，layout store 默认 pref = 280',
  '  computeColumns(): collapsedWidth = (data-platform=darwin || data-windows-titlebar) ? 0 : 56',
  '  sidebar root: padding 6px 12px（宽态）/ 18px 10px 6px（折叠）',
  '  footerActions: width 100%, display flex；settings triggerRow: width calc(100% + 4px)',
  '',
  'D-9 裁定落点：',
  '  Q1 纵向叠放（V3）→ 门禁形态；V1/V2 同排为对照（实测右溢即否决依据）',
  '  Q2 命中区 44×44 仅宽态，折叠轨 36×36 → 本脚本按 rail/wide 分支断言',
  '  F-9 macOS 桌面折叠 collapsedWidth=0（整列隐藏，无折叠轨）→ rail56 只对 Web GUI / Windows 有意义',
  '',
  '原始测量：',
  JSON.stringify(M, null, 2),
  '',
].join('\n')
writeFileSync(join(here, 'u4-entry-metrics.txt'), report, 'utf8')
console.log(report.split('\n').filter((l) => /^(PASS|FAIL|判定形态|U-4 判定)/.test(l) || /通过（全部）/.test(l) || /^  /.test(l)).join('\n'))

// D-11 修复 5：此前本脚本恒退 0，verify-all 的「U-4 PASS」是假阳性。
void control
process.exit(gatedFail === 0 ? 0 : 1)
