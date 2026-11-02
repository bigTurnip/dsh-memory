/**
 * O-9：面板 DOM 断言（SSR 渲染，不需要浏览器）。
 *
 * 用真实渲染输出验证 test-engineer 要断言的元素**真的在 DOM 里**，
 * 而不是"我以为写了"。带数据的态通过 mock fetch 注入。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryPanel, SettingsDrawer, ViewA } from '../client/panel.js'
import { MemoryTail, detectMemoryTurn, tailLabel } from '../client/tail.js'
import { PANEL_ID, PanelEntryIcon, apply } from '../client/index.js'

interface Opts {
  path: string
  enabled?: boolean
  list?: unknown
  recycle?: unknown
  changes?: unknown
}

/** 设置抽屉必须渲染的七项（写死而不用 SETTING_KEYS：擅删一项应让自测失败）。 */
const SETTING_ROWS = [
  'enabled',
  'prompt_writes',
  'write_prompt_budget',
  'retention_days',
  'episodic_retention_days',
  'decay_window_days',
  'recall_inject',
]

function mockFetch(opts: Opts): void {
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (input: string) => {
    const url = String(input)
    const body = (data: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data, message: 'ok' }),
    })
    if (url.includes('/health')) return body({ enabled: opts.enabled ?? true, retentionDays: 30, ftsAvailable: true, now: 0 })
    if (url.includes('/list')) return body(opts.list ?? { counts: { n: 0, a: 0, b: 0, c: 0, filterLabel: null }, recycleCount: 0, emptyText: null, entries: [] })
    if (url.includes('/recycle')) return body(opts.recycle ?? [])
    if (url.includes('/changes')) return body(opts.changes ?? { choices: [], chain: [], current: null })
    return { ok: false, status: 404, json: async () => ({ code: 404, data: null, message: 'no' }) }
  }
}

const entry = (id: string, ordinal: number, content: string, status: 'active' | 'superseded' | 'expired', layer: 'semantic' | 'episodic' = 'semantic') => ({
  id, ordinal, mark: status === 'active' ? '+' : status === 'superseded' ? '~' : '-',
  content, layer, scope: 'project' as const, status, statusText: status === 'active' ? '生效' : status === 'superseded' ? '已修正（2026-10-30 被第 3 条取代）' : '已过期（2026-11-19 到期，不参与检索）',
  sourceAt: Date.UTC(2026, 9, 30), eventPhrase: '你说明时', sourceType: 'explicit', snippet: content,
  sessionId: 's', turnSeq: 1, reuseCount: 0, lastHitAt: null, supersededBy: null, expiresAt: null, sensitivity: 'normal',
})

interface RegisteredSlot {
  readonly name: string
  readonly id?: string
  readonly key?: string
  readonly label?: string | (() => string)
}

interface StubSlotDescriptor extends RegisteredSlot {
  readonly order?: number
}

/** 只收集注册面：`apply` 的两种绑定是否指向同一个地址，是这里唯一要验的东西。 */
function stubContext(): { ctx: unknown; registrations: RegisteredSlot[] } {
  const registrations: RegisteredSlot[] = []
  const ctx = {
    effect: (reversible: () => void | (() => void)): void => {
      reversible()
    },
    inject: (): void => {
      /* 测试里没有 layout / sessions 服务：面板打开与 projectKey 走各自的降级 */
    },
    slots: {
      inject: (_name: string, contribute: () => unknown): void => {
        contribute()
      },
      register: (descriptor: StubSlotDescriptor): (() => void) => {
        registrations.push({
          name: descriptor.name,
          id: descriptor.id,
          key: descriptor.key,
          label: descriptor.label,
        })
        return () => {}
      },
    },
  }
  return { ctx, registrations }
}

export async function run(): Promise<boolean> {
  let pass = 0
  let fail = 0
  const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) pass += 1
    else fail += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} ${detail}`)
  }

  // ---- 无会话：D-0（X-3） ----
  const noSession = renderToStaticMarkup(<MemoryPanel projectKey={null} />)
  check('无会话走 D-0（X-3）', noSession.includes('data-testid="mem-state-no-session"'))
  check('D-0 提示文案逐字', noSession.includes('记忆面板跟随会话显示。先新建或进入一个会话。'))

  // ---- 空态 ----
  mockFetch({ path: '/p' })
  const empty = renderToStaticMarkup(<MemoryPanel projectKey="/p" />)
  check('有会话渲染 3 页签（PC-01）', (empty.match(/role="tab"/g) ?? []).length === 3, `${(empty.match(/role="tab"/g) ?? []).length}`)
  check('页签 testid 齐全', ['mem-tab-a', 'mem-tab-b', 'mem-tab-c'].every((id) => empty.includes(`data-testid="${id}"`)))
  check('空态 testid 存在', empty.includes('data-testid="mem-state-empty"') || empty.includes('data-testid="mem-state-loading"'))
  // 设置入口在页头而不是第四个页签（HC-3）：加了它，页签数必须仍是 3
  check('页头有设置入口（HC-3 不新增页签）', empty.includes('data-testid="mem-settings-open"'))
  // 抽屉关闭时不渲染任何设置控件（否则整块 DOM 白白多出一份表单）
  check('抽屉关闭时不渲染', !empty.includes('data-testid="mem-settings"'))

  // 设置抽屉：7 行 + 召回预览（SSR，不需要交互）
  // 注：SSR 不跑 useEffect，所以「关闭记忆态」的分支渲染不出来；改用源码计数验证两个分支都有入口。
  const panelSource = readFileSync(join(process.env.DSH_MEMORY_SRC_ROOT ?? '.', 'client/panel.tsx'), 'utf8')
  check(
    '正常态与关闭态都有设置入口',
    (panelSource.match(/data-testid="mem-settings-open"/g) ?? []).length === 2,
    `${(panelSource.match(/data-testid="mem-settings-open"/g) ?? []).length} 处`,
  )
  check('设置入口不在页签里（HC-3 仍恰 3 个）', !/data-testid="mem-tab-(settings|config)"/.test(panelSource))
  const settingsValues: Record<string, string> = {
    enabled: '1',
    prompt_writes: '1',
    write_prompt_budget: '3',
    retention_days: 'null',
    episodic_retention_days: '30',
    decay_window_days: '90',
    recall_inject: '0',
  }
  const drawer = renderToStaticMarkup(
    <SettingsDrawer
      open
      values={settingsValues}
      error={null}
      preview={{ query: '测试命令', hits: [], text: '', elapsedMs: 1, degraded: false }}
      onChange={() => {}}
      onSave={() => {}}
      onPreview={() => {}}
      onClose={() => {}}
    />,
  )
  const drawerFlat = drawer.replace(/\s+/g, ' ')
  check('设置抽屉 testid', drawer.includes('data-testid="mem-settings"'))
  check('七项设置行齐全', SETTING_ROWS.every((key) => drawer.includes(`data-testid="mem-set-row-${key}"`)), `${SETTING_ROWS.filter((key) => !drawer.includes(`mem-set-row-${key}`)).join(',') || '齐全'}`)
  check('召回开关是复选框', /type="checkbox"[^>]*data-testid="mem-set-recall_inject"|data-testid="mem-set-recall_inject"[^>]*type="checkbox"/.test(drawer))
  check('nullable 项有「不过期」开关', drawer.includes('data-testid="mem-set-retention_days-unlimited"'))
  check('每项都有说明文案（X-4）', SETTING_ROWS.every((key) => drawer.includes(`data-testid="mem-set-hint-${key}"`)))
  check('说明不是实现细节', !drawerFlat.includes('SQLite') && !drawerFlat.includes('memory_settings'))
  check('召回预览区齐全', drawer.includes('data-testid="mem-recall-input"') && drawer.includes('data-testid="mem-recall-preview"'))
  check('空命中时说明「不会注入」', drawerFlat.includes('没有命中任何生效记忆'))
  check('保存/关闭按钮', drawer.includes('data-testid="mem-settings-save"') && drawer.includes('data-testid="mem-settings-close"'))
  check('设置不改记忆内容（无新建/编辑入口）', !drawerFlat.includes('新建') && !drawerFlat.includes('编辑'))

  // ---- 带数据：直接渲染 ViewA（SSR 不跑 useEffect，所以不走 MemoryPanel） ----
  const sixEntries = [
    entry('e1', 1, '发版前必须先跑 pnpm build', 'active'),
    entry('e2', 2, '注释用中文', 'active', 'semantic'),
    entry('e3', 3, '测试命令是 vitest', 'active'),
    entry('e4', 4, '测试命令是 jest', 'superseded'),
    entry('e5', 5, 'HMR 不生效', 'active', 'episodic'),
    entry('e6', 6, 'pnpm 安装超时', 'expired', 'episodic'),
  ]
  const counts6 = { n: 6, a: 4, b: 1, c: 1, filterLabel: null }
  const viewAProps = {
    list: { counts: counts6, recycleCount: 1, emptyText: null, entries: sixEntries },
    entries: sixEntries,
    counts: counts6,
    filter: {} as Record<string, string>,
    searchInput: '',
    page: 0,
    pageSize: 10,
    expandedExpired: false,
    onSearch: () => {},
    onFilter: () => {},
    onClearFilter: () => {},
    onPage: () => {},
    onExpandExpired: () => {},
    onEdit: () => {},
    onRestore: () => {},
    onDelete: () => {},
    onHardDelete: () => {},
    onChanges: () => {},
  }
  const withData = renderToStaticMarkup(<ViewA {...viewAProps} />)
  const flat = withData.replace(/\s+/g, ' ')
  check('统计条 testid', withData.includes('data-testid="mem-stats"'))
  check('N 渲染为 6', flat.includes('共 6 条'), '')
  check('分状态计数 a/b/c 齐全', ['mem-count-a-value', 'mem-count-b-value', 'mem-count-c-value'].every((id) => withData.includes(id)))
  check('公式 a+b+c=N 渲染', flat.includes('4 + 1 + 1 = 6'))
  check('回收站单独一行且明写不计入', flat.includes('不计入上面的 6 条'))
  check('三重冗余·序号后缀符号', (withData.match(/mem-mark/g) ?? []).length >= 6, `${(withData.match(/mem-mark/g) ?? []).length} 处`)
  check('三重冗余·状态标签（已修正带取代）', withData.includes('被第 3 条取代'))
  check('三重冗余·状态标签（已过期带到期）', withData.includes('到期，不参与检索'))
  check('三重冗余·小节标题', flat.includes('已修正 1 条'))
  check('分组只按分层', flat.includes('语义层') && flat.includes('情景层'))
  check('不出现程序层', !flat.includes('程序'))
  check('筛选控件恰 3 个下拉', (withData.match(/data-testid="mem-filter-(scope|layer|status)"/g) ?? []).length === 3)
  check('筛选下拉无类型选项', !/类型|重要度|置信度/.test(withData))
  check('编辑/删除/变更记录按钮存在', withData.includes('mem-edit-e1') && withData.includes('mem-delete-e1') && withData.includes('mem-history-e1'))
  // T-4：恢复入口只在「已过期」卡片出现（已修正不可回滚、生效无需恢复）
  check('已过期条目有恢复入口（T-4）', withData.includes('data-testid="mem-restore-e6"'))
  check('生效/已修正条目无恢复入口', !withData.includes('mem-restore-e1') && !withData.includes('mem-restore-e4'))
  check('无「在对话中定位」按钮（HC-7）', !withData.includes('在对话中定位'))
  check('未筛选时不显示筛选标签（X-2）', !withData.includes('data-testid="mem-filter-label"'))

  // ---- 筛选态：必须显示筛选条件（X-2） ----
  const filteredCounts = { n: 3, a: 2, b: 1, c: 0, filterLabel: '项目级' }
  const filteredView = renderToStaticMarkup(
    <ViewA {...viewAProps} counts={filteredCounts} list={{ counts: filteredCounts, recycleCount: 0, emptyText: null, entries: sixEntries.slice(0, 3) }} entries={sixEntries.slice(0, 3)} filter={{ scope: 'project' }} />,
  )
  check('筛选态显示筛选条件（X-2）', filteredView.includes('data-testid="mem-filter-label"') && filteredView.includes('项目级'))

  // ---- 折叠（D-8 X-3：全清单 c>5 才折叠，且不减小计数） ----
  const collapseCounts = { n: 12, a: 4, b: 1, c: 7, filterLabel: null }
  const manyExpired = [
    ...sixEntries.slice(0, 5),
    ...Array.from({ length: 7 }, (_, i) => entry(`x${i}`, 6 + i, `过期条目 ${i + 1}`, 'expired', 'episodic')),
  ]
  const folded = renderToStaticMarkup(
    <ViewA {...viewAProps} counts={collapseCounts} list={{ counts: collapseCounts, recycleCount: 0, emptyText: null, entries: manyExpired }} entries={manyExpired} />,
  )
  const foldedFlat = folded.replace(/\s+/g, ' ')
  check('折叠行存在（D-8 X-3）', folded.includes('data-testid="mem-expired-fold"'))
  check('折叠不减小 N 与 c', foldedFlat.includes('共 12 条') && foldedFlat.includes('7'))
  check('折叠提示明写不影响计数', foldedFlat.includes('折叠不影响计数'))

  // ---- 入口：侧栏入口行 + 中心列主面板（dsh-kb 接入方式） ----
  const icon = renderToStaticMarkup(<PanelEntryIcon size={16} />)
  check('入口图标是「记」字方章', icon.includes('记') && icon.includes('data-testid="mem-icon"'))
  check('入口**无角标**（PE-19 / X-5）', !/badge|角标|mem-icon-count/.test(icon), '')

  const { ctx, registrations } = stubContext()
  apply(ctx as never)
  const row = registrations.find((item) => item.name === 'sidebar.panellist')
  const panel = registrations.find((item) => item.name === 'main')
  check(
    '入口行 id 与 main 的 key 绑定一致',
    row?.id !== undefined && row.id === panel?.key,
    `${String(row?.id)} / ${String(panel?.key)}`,
  )
  check('入口行 label 是「记忆」', row?.label === '记忆')
  check('面板地址不与会话界面冲突', PANEL_ID !== 'conversation' && PANEL_ID !== '')
  check('对话侧仍挂 turnTail（PE-09）', registrations.some((item) => item.name === 'conversation.chat.turnTail'))

  // ---- turnTail：无内容返回 null（PE-09） ----
  check('非记忆轮次 detect 返回 null', detectMemoryTurn('这是一段普通回答') === null)
  check('清单轮次能识别', detectMemoryTurn('记忆清单 ｜ 项目 x ｜ 共 6 条（生效 4 / 已修正 1 / 已过期 1）')?.view === 'a')
  check('回收站轮次能识别', detectMemoryTurn('回收站 ｜ 共 2 条（可恢复）')?.view === 'b')
  check('清单文案逐字', tailLabel({ view: 'a', count: 6 }) === '在面板中打开 · 共 6 条')
  check('回收站文案逐字', tailLabel({ view: 'b', count: 1 }) === '在面板中打开 · 回收站 1 条')
  check('变更记录文案逐字', tailLabel({ view: 'c', count: 4 }) === '在面板中打开 · 变更记录 4 个版本')
  const tailNull = renderToStaticMarkup(<>{MemoryTail({ text: '普通回答', onOpen: () => {} })}</>)
  check('无关轮次 turnTail 渲染为空（PE-09）', tailNull === '', JSON.stringify(tailNull))

  console.log(`\n${pass}/${pass + fail} 通过`)
  return fail === 0
}
