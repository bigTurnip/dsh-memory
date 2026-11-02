/**
 * 面板样式（设计 token 取自 `panel-memory.md` §8）。
 *
 * **容器断点**（PE-07）：面板现在占据中心列，但仍要能被拖窄到 300px 左右。
 * 所以这里全部用 `@container` 而不是 `@media` —— 用视口断点会让面板在 380px 里
 * 画出 236px 的竖排页签 + 表格（设计文档 §3.3 明确点出的坑）。
 */

export const PANEL_CSS = `
.mem-root {
  --bg: #F7F5F2; --surface: #FFFFFF; --surface-2: #F1EEEA; --surface-3: #EAE6E0;
  --border: #DDD8D2; --border-strong: #C4BEB7;
  --ink: #1B1A18; --ink-2: #4E4A45; --ink-3: #6E6862; --muted: #6B6560;
  --brand: #14584A; --ok: #1B6B45; --sup: #3F5D75; --warn: #8A5A00; --danger: #A11E1E;
  --focus: #0B5FA5;
  --ok-soft: #E4F2EA; --sup-soft: #E8EEF4; --warn-soft: #FBF0DA; --danger-soft: #FBE9E9;
  --brand-soft: #E6F0EC;
  container-type: inline-size;
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--bg); color: var(--ink);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
}
@media (prefers-color-scheme: dark) {
  .mem-root {
    --bg: #17161A; --surface: #1F1E23; --surface-2: #26252B; --surface-3: #2E2D34;
    --border: #35333A; --border-strong: #4A474F;
    --ink: #F2EFEA; --ink-2: #C8C3BC; --ink-3: #A09991; --muted: #B4ADA5;
    --brand: #7FD9BE; --ok: #7FD1A8; --sup: #9DB4C9; --warn: #E8B45C; --danger: #F18F8F;
    --focus: #7FB4E8;
    --ok-soft: #17332A; --sup-soft: #1B2530; --warn-soft: #33291A; --danger-soft: #331A1A;
    --brand-soft: #1E3B34;
  }
}

/* ---------- 页签导航（W1 左竖排；W2/W3 顶排分段条） ---------- */
.mem-tabs { display: flex; flex: none; gap: 2px; border-bottom: 1px solid var(--border); background: var(--surface); }
/* 中心列很宽时页签与正文同宽居中，避免"页签贴左边、正文在中间"的错位 */
@container (min-width: 760px) {
  .mem-tabs { padding: 0 max(24px, calc((100cqw - 960px) / 2)); }
}
.mem-tab {
  appearance: none; border: 0; background: 0 0; cursor: pointer;
  min-height: 44px; padding: 0 12px; color: var(--ink-2);
  font: inherit; font-size: 13px; display: inline-flex; align-items: center; gap: 6px;
  border-bottom: 2px solid transparent;
}
.mem-tab[aria-selected="true"] { color: var(--brand); border-bottom-color: var(--brand); font-weight: 650; }
.mem-tab:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }
/* X-5：页签计数（允许且应当存在）——注意这不是入口角标 */
.mem-tab-count { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 11.5px; }

@container (max-width: 519px) {
  .mem-tabs { display: grid; grid-template-columns: repeat(3, 1fr); }
  .mem-tab { justify-content: center; padding: 0 6px; }
}
@container (max-width: 379px) {
  .mem-tab-label { display: none; }
}

/* ---------- 主清单 ---------- */
.mem-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
@container (min-width: 760px) {
  .mem-body { padding: 16px 24px; }
  /* 中心列全宽时正文限宽居中：一行 1400px 的记忆卡片读起来是散的 */
  .mem-body > * { max-width: 960px; margin-left: auto; margin-right: auto; }
}
.mem-stats { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.mem-stats-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 13px; }
.mem-stats-total { font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
.mem-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 4px; font-size: 11.5px; font-weight: 650; }
.mem-pill[data-status="active"] { background: var(--ok-soft); color: var(--ok); }
.mem-pill[data-status="superseded"] { background: var(--sup-soft); color: var(--sup); }
.mem-pill[data-status="expired"] { background: var(--warn-soft); color: var(--warn); }
.mem-formula { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.mem-filter-note { color: var(--brand); font-size: 11.5px; margin-top: 4px; }
.mem-recycle-note { color: var(--muted); font-size: 11.5px; margin-top: 4px; }

.mem-toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; align-items: center; }
.mem-input, .mem-select {
  min-height: 44px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--surface); color: var(--ink); font: inherit; font-size: 13px;
}
.mem-input { flex: 1 1 120px; min-width: 0; }
.mem-btn {
  min-height: 44px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--surface); color: var(--ink); font: inherit; font-size: 13px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
}
.mem-btn:hover { background: var(--surface-2); }
.mem-btn:focus-visible { outline: 3px solid var(--focus); outline-offset: 1px; }
.mem-btn[disabled] { opacity: .5; cursor: not-allowed; }
.mem-btn--danger { color: var(--danger); border-color: var(--danger); }
.mem-btn--primary { background: var(--brand); border-color: var(--brand); color: #fff; }
.mem-btn--primary[disabled] { background: var(--border-strong); border-color: var(--border-strong); color: var(--surface); }

.mem-group { margin-bottom: 14px; }
.mem-group-title { font-size: 13.5px; font-weight: 700; margin: 0 0 6px; }
.mem-subtitle { font-size: 12px; font-weight: 650; color: var(--ink-2); margin: 10px 0 6px; }
.mem-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; margin-bottom: 8px;
  border-left: 3px solid var(--border);
}
.mem-card[data-status="active"] { border-left-color: var(--ok); }
.mem-card[data-status="superseded"] { border-left-color: var(--sup); background: linear-gradient(90deg, var(--sup-soft), var(--surface) 40%); }
.mem-card[data-status="expired"] { border-left-color: var(--warn); background: linear-gradient(90deg, var(--warn-soft), var(--surface) 40%); }
.mem-card-head { display: flex; gap: 8px; align-items: baseline; }
.mem-mark { font-family: ui-monospace, monospace; font-weight: 700; color: var(--ink-3); flex: none; }
.mem-content { font-size: 14.5px; line-height: 1.55; flex: 1; min-width: 0; word-break: break-word; }
.mem-meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
.mem-status-text { font-size: 11.5px; font-weight: 650; margin-top: 4px; }
.mem-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }

.mem-expired-fold { background: var(--surface-2); border: 1px dashed var(--border-strong); border-radius: 8px; padding: 10px 12px; font-size: 12px; color: var(--ink-2); }

.mem-pager { display: flex; gap: 6px; align-items: center; justify-content: space-between; padding: 8px 0; font-size: 12px; color: var(--muted); }

/* ---------- 面板表格（X-8：面板可用表格，DC-12 只约束对话通道） ---------- */
.mem-table { width: 100%; border-collapse: collapse; font-size: 12.5px; background: var(--surface); }
.mem-table caption { text-align: left; color: var(--muted); font-size: 11.5px; padding-bottom: 4px; }
.mem-table th, .mem-table td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.mem-table th { font-weight: 650; color: var(--ink-2); font-size: 11.5px; }
.mem-table td { word-break: break-word; }

/* ---------- 页头（标题 + 设置入口） ---------- */
/* 设置入口放页头而不是页签：页签恰三个（PC-01 / HC-3），第四个页签会被判违反契约。 */
.mem-head {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  min-height: 44px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--surface);
}
.mem-head-title { font-size: 13px; font-weight: 700; color: var(--ink-2); }
.mem-head-btn { min-height: 32px; padding: 0 10px; font-size: 12.5px; }
@container (min-width: 760px) {
  .mem-head { padding: 0 max(24px, calc((100cqw - 960px) / 2)); }
}

/* ---------- 设置抽屉 ---------- */
/* 抽屉比普通弹窗宽：7 行设置 + 召回预览，520px 会把数字框挤到换行。 */
.mem-settings { max-width: 640px; }
.mem-set-list { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
.mem-set-row { padding: 10px 0; border-bottom: 1px solid var(--border); }
.mem-set-row:last-child { border-bottom: 0; }
.mem-set-check {
  display: flex; gap: 8px; align-items: center; min-height: 32px;
  font-size: 13px; font-weight: 650; cursor: pointer;
}
.mem-set-check input { width: 18px; height: 18px; accent-color: var(--brand); cursor: pointer; }
.mem-set-check input:focus-visible { outline: 3px solid var(--focus); outline-offset: 1px; }
.mem-set-num { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 32px; }
.mem-set-name { font-size: 13px; font-weight: 650; }
.mem-set-input {
  min-height: 32px; width: 96px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface); color: var(--ink); font: inherit; font-size: 13px; font-variant-numeric: tabular-nums;
}
.mem-set-input:focus-visible { outline: 3px solid var(--focus); outline-offset: 1px; }
.mem-set-input[disabled] { opacity: .5; }
.mem-set-unit { font-size: 12px; color: var(--muted); }
.mem-set-unlimited { min-height: 32px; font-weight: 400; font-size: 12.5px; color: var(--ink-2); }
.mem-set-hint { font-size: 11.5px; line-height: 1.55; color: var(--muted); margin-top: 4px; }
.mem-set-error {
  background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger); border-radius: 8px;
  padding: 8px 12px; margin-bottom: 12px; font-size: 12.5px; line-height: 1.5;
}
.mem-set-preview { border-top: 1px solid var(--border); padding-top: 12px; margin-bottom: 12px; }
.mem-set-preview-row { display: flex; gap: 6px; align-items: center; }
.mem-set-query { flex: 1 1 auto; width: auto; min-width: 0; }
/* 预览用等宽 + 保留换行：所见即注入（同一个 formatRecallText） */
.mem-recall-text {
  margin: 8px 0 0; padding: 10px 12px; background: var(--surface-2); border-radius: 8px;
  font-family: inherit; font-size: 12px; line-height: 1.6; color: var(--ink-2);
  white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto;
}

/* ---------- 空 / 失败 / 关闭 态 ---------- */
.mem-state { padding: 32px 16px; text-align: center; color: var(--ink-2); }
.mem-state-title { font-size: 14.5px; font-weight: 650; color: var(--ink); margin-bottom: 8px; }
.mem-state-sub { font-size: 12.5px; color: var(--muted); margin-bottom: 12px; }
.mem-skeleton { background: var(--surface-3); border-radius: 8px; height: 64px; margin-bottom: 8px; animation: mem-breathe 1.4s ease-in-out infinite; }
@keyframes mem-breathe { 0%,100% { opacity: .7 } 50% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .mem-skeleton { animation: none; } }

/* ---------- 弹窗 ---------- */
.mem-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
.mem-dialog { background: var(--surface); border-radius: 12px; max-width: 520px; width: 100%; max-height: 90vh; overflow: auto; padding: 16px; box-shadow: 0 8px 32px rgba(0,0,0,.24); }
.mem-dialog h3 { margin: 0 0 12px; font-size: 15px; }
.mem-echo { background: var(--surface-2); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; font-size: 13px; }
.mem-echo-label { font-size: 11.5px; color: var(--muted); font-weight: 650; margin-bottom: 4px; }
.mem-consequence { font-size: 12.5px; color: var(--ink-2); margin-bottom: 12px; line-height: 1.6; }
.mem-check { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; margin-bottom: 12px; min-height: 44px; }
.mem-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.mem-toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--surface); padding: 10px 16px; border-radius: 8px; font-size: 12.5px; display: flex; gap: 12px; align-items: center; z-index: 1001; }
/* ---------- 侧栏入口图标（sidebar.panellist） ---------- */
.mem-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.15em; height: 1.15em; border-radius: 4px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
  color: inherit; font-weight: 700; line-height: 1; letter-spacing: 0;
}

.mem-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`

/** 把样式注入文档（幂等）。 */
export function installPanelStyles(): () => void {
  const id = 'dsh-memory/panel.css'
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-memory'
  style.dataset.pluginCss = id
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
  return () => style.remove()
}
