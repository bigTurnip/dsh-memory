/**
 * U-4 基线对照：**只放宿主自己的 occupant**（cordis + Settings，没有记忆入口），
 * 量同一个脚区。用途：区分「宿主本来就有的溢出」与「加了我的入口才有的溢出」。
 * 不做这一步就会把宿主的既有全出血写法误判成我的缺陷。
 *
 * 运行：node test/u4-baseline.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const hostCss = readFileSync(join(here,'fixtures/host-entry.css'),'utf8')
const EDGE='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const scratch=join(tmpdir(),'dsh-memory-u4'); const profile=join(scratch,'edge-profile'); rmSync(profile,{recursive:true,force:true}); mkdirSync(profile,{recursive:true})

const page=(rail)=>`<!doctype html><meta charset="utf-8"><style>
:root{--dsw-specific-sidebar-fill:#F7F5F2;--dsw-alias-label-primary:#1B1A18;--dsw-alias-label-secondary:#4E4A45;
--dsw-alias-label-tertiary:#6E6862;--dsw-alias-interactive-bg-hover:#EAE6E0;--dsw-radius-sm:6px;--dsw-radius-md:8px;
--dsw-alias-border-l3:#DDD8D2;--dsw-alias-button-elevated-fill:#FFF}
html,body{margin:0}
${hostCss}
</style><div id="app"></div><pre id="out"></pre><script>
document.getElementById('app').innerHTML=\`
<div class="kB3qhq_root" id="root">
 <div class="kB3qhq_regionArea"></div>
 <div class="kB3qhq_footArea">
  <div class="kB3qhq_footerActions" id="fa">
   <div class="sB3NaG_layer${rail?' sB3NaG_rail':''}" id="cordis"><div class="sB3NaG_footerButtons">
    <button class="sB3NaG_badge" id="plugin" aria-label="插件"><svg width="${rail?18:16}" height="${rail?18:16}"></svg>
    ${rail?'':'<span class="sB3NaG_badgeLabel">插件</span><span class="sB3NaG_badgeCount">0</span>'}</button>
   </div></div>
  </div>
  <div class="kB3qhq_settingsArea"><div class="_77Pn0W_triggerRow${rail?' _77Pn0W_railRow':''}">
   <button class="_77Pn0W_trigger${rail?' _77Pn0W_rail':''}" id="settings" aria-label="设置">
    <svg width="16" height="16"></svg>${rail?'':'<span class="_77Pn0W_triggerLabel">设置</span>'}</button>
  </div></div>
 </div>
</div>\`;
const root=document.getElementById('root');
root.classList.toggle('kB3qhq_collapsed',${rail});
root.style.cssText+=';width:${rail?56:280}px;height:640px;display:flex;flex-direction:column';
const q=s=>document.querySelector(s);
const R=s=>{const r=q(s).getBoundingClientRect();return{w:+r.width.toFixed(1),h:+r.height.toFixed(1),right:+r.right.toFixed(1)};};
const fa=q('#fa'), rb=root.getBoundingClientRect();
document.getElementById('out').textContent='R:'+JSON.stringify({
 plugin:R('#plugin'), settings:R('#settings'),
 faScrollW:fa.scrollWidth, faClientW:fa.clientWidth,
 footOverflow: fa.scrollWidth>fa.clientWidth+.5,
 rootScrollW:root.scrollWidth, rootClientW:root.clientWidth,
 rootOverflow: root.scrollWidth>root.clientWidth+.5,
 pluginRightOverflow:+(R('#plugin').right-rb.right).toFixed(1),
});
</script>`
const res={}
for(const rail of [false,true]){
  const f=join(scratch,`u4b-${rail}.html`); writeFileSync(f,page(rail),'utf8')
  const dom=execFileSync(EDGE,['--headless=new','--disable-gpu','--no-sandbox',`--user-data-dir=${profile}`,
    '--virtual-time-budget=800','--dump-dom',`file://${f}`],{encoding:'utf8',maxBuffer:16*1024*1024})
  const m=dom.match(/R:(\{[\s\S]*?\})<\/pre>/)
  res[rail?'rail56':'wide280']= m?JSON.parse(m[1].replace(/&quot;/g,'"')):{error:dom.slice(-300)}
}
const lines=Object.entries(res).map(([k,v])=>`${k}: plugin=${v.plugin.w}×${v.plugin.h} settings=${v.settings.w}×${v.settings.h} `+
  `fa=${v.faScrollW}/${v.faClientW} footOverflow=${v.footOverflow} root=${v.rootScrollW}/${v.rootClientW} rootOverflow=${v.rootOverflow} pluginRightOverflow=${v.pluginRightOverflow}px`)
writeFileSync(join(here,'u4-baseline.txt'),'U-4 基线（仅宿主 occupant，无记忆入口）\n'+lines.join('\n')+'\n\n'+JSON.stringify(res,null,2)+'\n','utf8')
console.log('U-4 基线（仅宿主 occupant，无记忆入口）'); console.log(lines.join('\n'))
