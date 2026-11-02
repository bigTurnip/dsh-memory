/**
 * 记忆面板（A 清单 / B 回收站 / C 变更记录）。
 *
 * 契约落点：
 * - **恰 3 页签**（PC-01 / HC-3），没有第四视图。
 * - **首行统计**由 Host 的 `countVisible` 给出，前端不再算（S-1 / S-5）。
 * - **筛选态首行必须显示筛选条件**（D-8 X-2），未筛选时不显示。
 * - **折叠**按全清单合计 > 5（D-8 X-3），折叠不减小 N 与 c。
 * - **面板不是写入入口**（PB-4）：没有"新建"按钮，空态指向对话。
 * - **不渲染点了没反应的按钮**（HC-7）：没有"在对话中定位"。
 * - **破坏性操作回显正文 + 二次确认**（PC-22 / PC-24）：硬删必须勾选。
 * - **页签计数存在但入口无角标**（D-8 X-5）。
 *
 * 所有关键元素带稳定 `data-testid`（test-engineer O-9）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { api, MemoryApiError, type ChangesResponse, type ListEntry, type ListResponse, type RecallPreview, type RecycleEntry } from './transport.js'
import { SETTING_SPECS, isFlagOn, isUnlimited } from '../shared/settings.js'

export interface PanelProps {
  /** 当前会话的工作目录（projectKey）。取不到时为 null（D-0 降级）。 */
  projectKey?: string | null
  /** 打开参数：落在哪个视图（PE-10）。 */
  initialView?: 'a' | 'b' | 'c'
}

type View = 'a' | 'b' | 'c'

const VIEW_LABEL: Record<View, string> = { a: '记忆清单', b: '回收站', c: '变更记录' }

/** 逐字文案（DC-16 等；改字需走设计评审）。 */
const TEXT = {
  empty: '目前没有记录任何关于你的记忆。',
  emptySub: '你在对话里说过、值得长期记住的事，我会自动记下来。',
  filterEmpty: '筛选后为空（不是没有记忆）。',
  readFailed: '记忆暂时读不到（超时），这次没法给你清单。',
  recycleEmpty: '回收站是空的。',
  closed: '记忆已关闭，我现在没有可查的记忆。',
  closedSub: '说「开启记忆」可以打开。',
  noSession: '记忆面板跟随会话显示。先新建或进入一个会话。',
} as const

function formatDate(ms: number | null): string {
  if (ms === null) return '—'
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function MemoryPanel(props: PanelProps): ReactElement {
  const projectKey = props.projectKey ?? null
  const [view, setView] = useState<View>(props.initialView ?? 'a')
  const [list, setList] = useState<ListResponse | null>(null)
  const [recycle, setRecycle] = useState<RecycleEntry[] | null>(null)
  const [changes, setChanges] = useState<ChangesResponse | null>(null)
  const [changesTarget, setChangesTarget] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState<{ scope?: string; layer?: string; status?: string; q?: string }>({})
  const [searchInput, setSearchInput] = useState('')
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [expandedExpired, setExpandedExpired] = useState(false)
  // 设置抽屉（不是页签：页签恰三个是 PC-01 / HC-3 的硬约束）
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Record<string, string> | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [recallPreview, setRecallPreview] = useState<RecallPreview | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (projectKey === null) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const health = await api.health()
      if (!health.enabled) {
        setClosed(true)
        setLoading(false)
        return
      }
      setClosed(false)
      if (view === 'a') setList(await api.list(projectKey, filter))
      else if (view === 'b') setRecycle(await api.recycle(projectKey))
      else setChanges(await api.changes(projectKey, changesTarget))
    } catch (caught) {
      // DC-16：读取失败**不得**套用空态文案
      setError(caught instanceof MemoryApiError ? caught.message : '记忆暂时读不到（超时），这次没法给你清单。')
    } finally {
      setLoading(false)
    }
  }, [projectKey, view, filter, changesTarget])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 搜索防抖 ≥200ms（panel-memory §3.3）
  const onSearch = (value: string): void => {
    setSearchInput(value)
    if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setFilter((current) => ({ ...current, ...(value.trim() === '' ? {} : { q: value.trim() }) }))
      if (value.trim() === '') setFilter((current) => { const { q: _drop, ...rest } = current; return rest })
      setPage(0)
    }, 220)
  }

  const clearFilter = (): void => {
    setFilter({})
    setSearchInput('')
    setPage(0)
  }

  const runAction = async (action: () => Promise<void>, success: string, undo?: () => Promise<void>): Promise<void> => {
    try {
      await action()
      setToast({ text: success, ...(undo === undefined ? {} : { undo: () => void undo().then(() => void refresh()) }) })
      await refresh()
    } catch (caught) {
      setToast({ text: caught instanceof MemoryApiError ? caught.message : String(caught) })
    }
  }

  const counts = list?.counts

  // ---------------------------------------------------------------- 设置抽屉
  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      setSettings(await api.settings())
      setSettingsError(null)
    } catch (caught) {
      setSettingsError(caught instanceof MemoryApiError ? caught.message : String(caught))
    }
  }, [])

  const openSettings = (): void => {
    setSettingsOpen(true)
    setSettings(null)
    setRecallPreview(null)
    setSettingsError(null)
    void loadSettings()
  }

  const saveSettings = async (): Promise<void> => {
    if (settings === null) return
    try {
      const result = await api.saveSettings(settings)
      setSettings(result.values)
      setSettingsError(null)
      // 保存后必须重取：enabled / retention_days 会直接改变清单与文案
      setToast({ text: `设置已保存（${result.changed.length} 项），立即生效。` })
      await refresh()
    } catch (caught) {
      setSettingsError(caught instanceof MemoryApiError ? caught.message : String(caught))
    }
  }

  const previewRecall = async (query: string): Promise<void> => {
    try {
      setRecallPreview(await api.recallPreview(projectKey, query))
      setSettingsError(null)
    } catch (caught) {
      setSettingsError(caught instanceof MemoryApiError ? caught.message : String(caught))
    }
  }
  const pageSize = 10
  const pagedEntries = useMemo(() => {
    if (list === null) return []
    // 折叠：全清单已过期 > 5 时，未展开只显示前 5 条（D-8 X-3）。折叠**不减小**计数。
    const collapse = (counts?.c ?? 0) > 5 && !expandedExpired
    let expiredShown = 0
    return list.entries
      .slice(page * pageSize, page * pageSize + pageSize)
      .filter((entry) => {
        if (!collapse || entry.status !== 'expired') return true
        expiredShown += 1
        return expiredShown <= 5
      })
  }, [list, page, counts, expandedExpired])

  // ---------------------------------------------------------------- 无会话 / 关闭
  if (projectKey === null) {
    return (
      <div className="mem-root" data-testid="mem-panel">
        <div className="mem-state" data-testid="mem-state-no-session">
          <div className="mem-state-title">{TEXT.noSession}</div>
        </div>
      </div>
    )
  }

  if (closed) {
    return (
      <div className="mem-root" data-testid="mem-panel">
        {/* 关闭态也要能打开设置：否则"开启记忆"在面板上无路可走。 */}
        <div className="mem-head">
          <span className="mem-head-title">记忆</span>
          <button type="button" className="mem-btn mem-head-btn" data-testid="mem-settings-open" onClick={openSettings}>
            设置
          </button>
        </div>
        <div className="mem-state" data-testid="mem-state-closed">
          <div className="mem-state-title">{TEXT.closed}</div>
          <div className="mem-state-sub">{TEXT.closedSub}</div>
        </div>
        <SettingsDrawer
          open={settingsOpen}
          values={settings}
          error={settingsError}
          preview={recallPreview}
          onChange={(key, value) => setSettings((current) => ({ ...(current ?? {}), [key]: value }))}
          onSave={() => void saveSettings()}
          onPreview={(query) => void previewRecall(query)}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    )
  }

  return (
    <div className="mem-root" data-testid="mem-panel">
      {/* 设置是抽屉，不是第四个页签（PC-01 / HC-3：页签恰三个）。 */}
      <div className="mem-head">
        <span className="mem-head-title">记忆</span>
        <button type="button" className="mem-btn mem-head-btn" data-testid="mem-settings-open" onClick={openSettings}>
          设置
        </button>
      </div>

      {/* 三个页签，恰三个（PC-01 / HC-3）。计数在页签上（X-5），入口无角标。 */}
      <div className="mem-tabs" role="tablist" aria-label="记忆视图" data-testid="mem-tabs">
        {(['a', 'b', 'c'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            className="mem-tab"
            aria-selected={view === candidate}
            aria-controls={`mem-panel-${candidate}`}
            data-testid={`mem-tab-${candidate}`}
            onClick={() => {
              setView(candidate)
              setPage(0)
            }}
          >
            <span className="mem-tab-label">{VIEW_LABEL[candidate]}</span>
            {candidate === 'a' && list !== null ? (
              <span className="mem-tab-count" data-testid="mem-tab-count-a">
                {list.counts.n}
              </span>
            ) : null}
            {candidate === 'b' && list !== null ? (
              <span className="mem-tab-count" data-testid="mem-tab-count-b">
                {list.recycleCount}
              </span>
            ) : null}
            {candidate === 'c' && changes !== null ? (
              <span className="mem-tab-count" data-testid="mem-tab-count-c">
                {changes.choices.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="mem-body" role="tabpanel" id={`mem-panel-${view}`}>
        {loading ? (
          <div data-testid="mem-state-loading">
            <div className="mem-skeleton" />
            <div className="mem-skeleton" />
            <div className="mem-skeleton" />
            <span className="mem-sr" aria-live="polite">正在读取记忆…</span>
          </div>
        ) : error !== null ? (
          // 失败态：**不得套用空态文案**（DC-16 / HC"空失败不混"）
          <div className="mem-state" data-testid="mem-state-error">
            <div className="mem-state-title" data-testid="mem-error-text">
              {error}
            </div>
            <button type="button" className="mem-btn" data-testid="mem-retry" onClick={() => void refresh()}>
              重试
            </button>
            <div className="mem-state-sub" style={{ marginTop: 12 }}>
              也可以在对话里问「你记得我什么」。
            </div>
          </div>
        ) : view === 'a' ? (
          <ViewA
            list={list}
            entries={pagedEntries}
            counts={counts}
            filter={filter}
            searchInput={searchInput}
            page={page}
            pageSize={pageSize}
            expandedExpired={expandedExpired}
            onSearch={onSearch}
            onFilter={(next) => {
              setFilter(next)
              setPage(0)
            }}
            onClearFilter={clearFilter}
            onPage={setPage}
            onExpandExpired={() => setExpandedExpired(true)}
            onEdit={(entry) => setDialog({ kind: 'edit', entry })}
            // 已过期条目的恢复入口（T-4）：没有它，`manage.restore()` 的 expired 分支
            // 只能靠直接调 HTTP，页面上无路可走。
            onRestore={(entry) =>
              void runAction(
                () => api.restore(projectKey, entry.id).then(() => undefined),
                `已恢复第 ${entry.ordinal} 条，重新计时 30 天。`,
              )
            }
            onDelete={(entry) => setDialog({ kind: 'delete', entry })}
            onHardDelete={async (entry) => {
              // 两步协议：先 prepare 拿回显 + token
              try {
                const prepared = await api.prepareHardDelete(projectKey, entry.id)
                setDialog({ kind: 'hard-delete', entry, prepared })
              } catch (caught) {
                setToast({ text: caught instanceof MemoryApiError ? caught.message : String(caught) })
              }
            }}
            onChanges={(entry) => {
              setChangesTarget(entry.id)
              setView('c')
            }}
          />
        ) : view === 'b' ? (
          <ViewB
            entries={recycle}
            onRestore={(entry) =>
              void runAction(
                () => api.restore(projectKey, entry.id).then(() => undefined),
                `已恢复第 ${entry.ordinal} 条。`,
              )
            }
            onHardDelete={async (entry) => {
              try {
                const prepared = await api.prepareHardDelete(projectKey, entry.id)
                setDialog({ kind: 'hard-delete', entry: entry as unknown as ListEntry, prepared })
              } catch (caught) {
                setToast({ text: caught instanceof MemoryApiError ? caught.message : String(caught) })
              }
            }}
          />
        ) : (
          <ViewC
            changes={changes}
            target={changesTarget}
            onSelect={(memoryId) => setChangesTarget(memoryId)}
            onBack={() => {
              setChangesTarget(null)
            }}
          />
        )}
      </div>

      {toast !== null ? (
        <div className="mem-toast" data-testid="mem-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo !== undefined ? (
            <button
              type="button"
              className="mem-btn"
              data-testid="mem-toast-undo"
              onClick={() => {
                toast.undo?.()
                setToast(null)
              }}
            >
              撤销
            </button>
          ) : null}
          <button type="button" className="mem-btn" data-testid="mem-toast-close" onClick={() => setToast(null)}>
            关闭
          </button>
        </div>
      ) : null}

      {dialog !== null ? (
        <Dialog
          state={dialog}
          onCancel={() => setDialog(null)}
          onConfirm={async (payload) => {
            setDialog(null)
            await payload()
          }}
          projectKey={projectKey}
          runAction={runAction}
        />
      ) : null}

      <SettingsDrawer
        open={settingsOpen}
        values={settings}
        error={settingsError}
        preview={recallPreview}
        onChange={(key, value) => setSettings((current) => ({ ...(current ?? {}), [key]: value }))}
        onSave={() => void saveSettings()}
        onPreview={(query) => void previewRecall(query)}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

// ================================================================ 设置抽屉

export interface SettingsDrawerProps {
  readonly open: boolean
  /** 存库格式的当前值；`null` = 正在读取。 */
  readonly values: Record<string, string> | null
  readonly error?: string | null
  readonly preview?: RecallPreview | null
  readonly onChange: (key: string, value: string) => void
  readonly onSave: () => void
  readonly onPreview: (query: string) => void
  readonly onClose: () => void
}

/**
 * 设置抽屉。
 *
 * 为什么是抽屉不是页签：面板页签恰三个（PC-01 / HC-3）。设置改的是"插件怎么工作"，
 * 不是"记忆长什么样"；混进视图会让"看记忆"与"配记忆"两个动作在同一视觉层级打架。
 *
 * 控件类型全部来自 `SETTING_SPECS`（shared）——面板不自己决定哪个键是开关、哪个是数字，
 * 否则界面与后端校验就是两套规则。
 */
export function SettingsDrawer(props: SettingsDrawerProps): ReactElement | null {
  const [query, setQuery] = useState('')
  if (!props.open) return null

  const values = props.values
  return (
    <div className="mem-overlay" data-testid="mem-settings">
      <div className="mem-dialog mem-settings" role="dialog" aria-label="记忆设置">
        <h3>记忆设置</h3>
        <p className="mem-consequence">
          这些是插件设置，不是记忆条目（不会进入清单，也不会被检索）。保存后立即生效。
        </p>

        {props.error !== null && props.error !== undefined ? (
          <div className="mem-set-error" data-testid="mem-settings-error" role="alert">
            {props.error}
          </div>
        ) : null}

        {values === null ? (
          <div className="mem-state-sub" data-testid="mem-settings-loading">
            正在读取设置…
          </div>
        ) : (
          <div className="mem-set-list">
            {SETTING_SPECS.map((spec) => {
              const raw = values[spec.key] ?? ''
              const unlimited = spec.kind === 'nullable-integer' && isUnlimited(raw)
              return (
                <div className="mem-set-row" key={spec.key} data-testid={`mem-set-row-${spec.key}`}>
                  {spec.kind === 'flag' ? (
                    <label className="mem-set-check">
                      <input
                        type="checkbox"
                        checked={isFlagOn(raw)}
                        data-testid={`mem-set-${spec.key}`}
                        onChange={(event) => props.onChange(spec.key, event.target.checked ? '1' : '0')}
                      />
                      <span>{spec.label}</span>
                    </label>
                  ) : (
                    <div className="mem-set-num">
                      <span className="mem-set-name">{spec.label}</span>
                      <input
                        type="number"
                        className="mem-set-input"
                        min={spec.min}
                        max={spec.max}
                        value={unlimited ? '' : raw}
                        disabled={unlimited}
                        data-testid={`mem-set-${spec.key}`}
                        onChange={(event) => props.onChange(spec.key, event.target.value)}
                      />
                      <span className="mem-set-unit">{spec.unit}</span>
                      {spec.kind === 'nullable-integer' ? (
                        <label className="mem-set-check mem-set-unlimited">
                          <input
                            type="checkbox"
                            checked={unlimited}
                            data-testid={`mem-set-${spec.key}-unlimited`}
                            onChange={(event) =>
                              props.onChange(spec.key, event.target.checked ? 'null' : String(spec.min ?? 30))
                            }
                          />
                          <span>不过期</span>
                        </label>
                      ) : null}
                    </div>
                  )}
                  <div className="mem-set-hint" data-testid={`mem-set-hint-${spec.key}`}>
                    {spec.hint}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* 召回预览：与真实注入共用同一个格式化函数，所以"预览见到的"就是"会注入的" */}
        <div className="mem-set-preview" data-testid="mem-recall-box">
          <div className="mem-echo-label">召回预览（用一段你自己的话试试会注入什么）</div>
          <div className="mem-set-preview-row">
            <input
              type="text"
              className="mem-set-input mem-set-query"
              value={query}
              placeholder="例如：发版流程 / 测试命令"
              data-testid="mem-recall-input"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className="mem-btn"
              data-testid="mem-recall-preview"
              disabled={query.trim() === ''}
              onClick={() => props.onPreview(query.trim())}
            >
              预览
            </button>
          </div>
          {props.preview !== null && props.preview !== undefined ? (
            <pre className="mem-recall-text" data-testid="mem-recall-text">
              {props.preview.text === ''
                ? '没有命中任何生效记忆：开启后这一轮不会注入任何内容。'
                : props.preview.text}
            </pre>
          ) : null}
        </div>

        <div className="mem-dialog-actions">
          <button
            type="button"
            className="mem-btn mem-btn--primary"
            data-testid="mem-settings-save"
            disabled={values === null}
            onClick={props.onSave}
          >
            保存
          </button>
          <button type="button" className="mem-btn" data-testid="mem-settings-close" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

// ================================================================ A 清单

export interface ViewAProps {
  list: ListResponse | null
  entries: readonly ListEntry[]
  counts: { n: number; a: number; b: number; c: number; filterLabel: string | null } | undefined
  filter: { scope?: string; layer?: string; status?: string; q?: string }
  searchInput: string
  page: number
  pageSize: number
  expandedExpired: boolean
  onSearch: (value: string) => void
  onFilter: (next: { scope?: string; layer?: string; status?: string; q?: string }) => void
  onClearFilter: () => void
  onPage: (page: number) => void
  onExpandExpired: () => void
  onEdit: (entry: ListEntry) => void
  onRestore: (entry: ListEntry) => void
  onDelete: (entry: ListEntry) => void
  onHardDelete: (entry: ListEntry) => void
  onChanges: (entry: ListEntry) => void
}

export function ViewA(props: ViewAProps): ReactElement {
  const { list, counts, entries } = props
  if (list === null || counts === undefined) return <div />

  const filtered = counts.filterLabel !== null
  const hasFilter = Object.keys(props.filter).length > 0

  return (
    <div data-testid="mem-view-a">
      {/* 首行统计：DC-10 的唯一实现点。数字全部来自 Host 的 countVisible。 */}
      <div className="mem-stats" data-testid="mem-stats">
        <div className="mem-stats-line">
          <span className="mem-stats-total" data-testid="mem-count-n">
            共 {counts.n} 条
          </span>
          <span className="mem-pill" data-status="active" data-testid="mem-count-a">
            + 生效 <span data-testid="mem-count-a-value">{counts.a}</span>
          </span>
          <span className="mem-pill" data-status="superseded" data-testid="mem-count-b">
            ~ 已修正 <span data-testid="mem-count-b-value">{counts.b}</span>
          </span>
          <span className="mem-pill" data-status="expired" data-testid="mem-count-c">
            - 已过期 <span data-testid="mem-count-c-value">{counts.c}</span>
          </span>
          <span className="mem-formula" data-testid="mem-count-formula">
            {counts.a} + {counts.b} + {counts.c} = {counts.n}
          </span>
        </div>
        {/* D-8 X-2：有筛选时首行必须显示筛选条件 */}
        {filtered ? (
          <div className="mem-filter-note" data-testid="mem-filter-label">
            已筛选：{counts.filterLabel}
          </div>
        ) : null}
        {list.recycleCount > 0 ? (
          <div className="mem-recycle-note" data-testid="mem-recycle-note">
            回收站另有 {list.recycleCount} 条已删除（可恢复），不计入上面的 {counts.n} 条
          </div>
        ) : null}
      </div>

      <div className="mem-toolbar" data-testid="mem-toolbar">
        <input
          className="mem-input"
          type="search"
          placeholder="搜索内容与来源"
          aria-label="搜索记忆"
          value={props.searchInput}
          data-testid="mem-search"
          onChange={(event) => props.onSearch(event.target.value)}
        />
        <select
          className="mem-select"
          aria-label="按作用域筛选"
          data-testid="mem-filter-scope"
          value={props.filter.scope ?? ''}
          onChange={(event) =>
            props.onFilter({ ...props.filter, ...(event.target.value === '' ? {} : { scope: event.target.value }) })
          }
        >
          <option value="">全部作用域</option>
          <option value="project">项目</option>
          <option value="user">用户</option>
        </select>
        <select
          className="mem-select"
          aria-label="按分层筛选"
          data-testid="mem-filter-layer"
          value={props.filter.layer ?? ''}
          onChange={(event) =>
            props.onFilter({ ...props.filter, ...(event.target.value === '' ? {} : { layer: event.target.value }) })
          }
        >
          <option value="">全部分层</option>
          <option value="semantic">语义</option>
          <option value="episodic">情景</option>
        </select>
        <select
          className="mem-select"
          aria-label="按状态筛选"
          data-testid="mem-filter-status"
          value={props.filter.status ?? ''}
          onChange={(event) =>
            props.onFilter({ ...props.filter, ...(event.target.value === '' ? {} : { status: event.target.value }) })
          }
        >
          <option value="">全部状态</option>
          <option value="active">生效</option>
          <option value="superseded">已修正</option>
          <option value="expired">已过期</option>
        </select>
        {hasFilter ? (
          <button type="button" className="mem-btn" data-testid="mem-clear-filter" onClick={props.onClearFilter}>
            清空筛选
          </button>
        ) : null}
      </div>

      {entries.length === 0 ? (
        // 空态 vs 筛选后为空：两者文案必须不同（PC-36 / DC-16）
        <div className="mem-state" data-testid={hasFilter ? 'mem-state-filter-empty' : 'mem-state-empty'}>
          <div className="mem-state-title">
            {hasFilter ? TEXT.filterEmpty : TEXT.empty}
          </div>
          <div className="mem-state-sub">
            {hasFilter ? '说「看全部」或点「清空筛选」可回到全集。' : TEXT.emptySub}
          </div>
          {hasFilter ? (
            <button type="button" className="mem-btn" data-testid="mem-empty-clear" onClick={props.onClearFilter}>
              清空筛选
            </button>
          ) : (
            // 面板不是写入入口（PB-4）：空态指向对话
            <div className="mem-state-sub">去对话里说点什么，或说「记住：…」。</div>
          )}
        </div>
      ) : (
        <>
          <Groups entries={entries} onEdit={props.onEdit} onRestore={props.onRestore} onDelete={props.onDelete} onHardDelete={props.onHardDelete} onChanges={props.onChanges} projectKey="" />
          {counts.c > 5 && !props.expandedExpired ? (
            <div className="mem-expired-fold" data-testid="mem-expired-fold">
              已过期另有 {counts.c - 5} 条未展开（本页展示 5 / {counts.c} 条）；折叠不影响计数。
              <button type="button" className="mem-btn" data-testid="mem-expand-expired" style={{ marginTop: 8 }} onClick={props.onExpandExpired}>
                展开全部
              </button>
            </div>
          ) : null}
          <div className="mem-pager" data-testid="mem-pager">
            <span data-testid="mem-page-info">
              第 {props.page + 1} 页
            </span>
            <span>
              <button
                type="button"
                className="mem-btn"
                data-testid="mem-prev"
                disabled={props.page === 0}
                onClick={() => props.onPage(props.page - 1)}
              >
                上一页
              </button>
              <button
                type="button"
                className="mem-btn"
                data-testid="mem-next"
                disabled={(props.page + 1) * props.pageSize >= counts.n}
                onClick={() => props.onPage(props.page + 1)}
              >
                下一页
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function Groups(props: {
  entries: readonly ListEntry[]
  onEdit: (entry: ListEntry) => void
  onRestore: (entry: ListEntry) => void
  onDelete: (entry: ListEntry) => void
  onHardDelete: (entry: ListEntry) => void
  onChanges: (entry: ListEntry) => void
  projectKey: string
}): ReactElement {
  const layers: Array<'semantic' | 'episodic'> = ['semantic', 'episodic']
  return (
    <>
      {layers.map((layer) => {
        const rows = props.entries.filter((entry) => entry.layer === layer)
        // 不渲染空分组（DC-11 / PC-05）
        if (rows.length === 0) return null
        return (
          <section key={layer} className="mem-group" data-testid={`mem-layer-${layer}`}>
            <h2 className="mem-group-title">{layer === 'semantic' ? '语义层' : '情景层'}</h2>
            {(['active', 'superseded', 'expired'] as const).map((status) => {
              const group = rows.filter((entry) => entry.status === status)
              if (group.length === 0) return null
              return (
                <div key={status} data-testid={`mem-statusgroup-${layer}-${status}`}>
                  <h3 className="mem-subtitle">
                    {status === 'active' ? '生效' : status === 'superseded' ? '已修正' : '已过期'} {group.length} 条
                  </h3>
                  {group.map((entry) => (
                    <Card key={entry.id} entry={entry} onEdit={props.onEdit} onRestore={props.onRestore} onDelete={props.onDelete} onHardDelete={props.onHardDelete} onChanges={props.onChanges} />
                  ))}
                </div>
              )
            })}
          </section>
        )
      })}
    </>
  )
}

function Card(props: {
  entry: ListEntry
  onEdit: (entry: ListEntry) => void
  onRestore: (entry: ListEntry) => void
  onDelete: (entry: ListEntry) => void
  onHardDelete: (entry: ListEntry) => void
  onChanges: (entry: ListEntry) => void
}): ReactElement {
  const { entry } = props
  return (
    <article
      className="mem-card"
      data-status={entry.status}
      data-testid={`mem-card-${entry.id}`}
      aria-label={`第${entry.ordinal}条，${entry.layer === 'semantic' ? '语义' : '情景'}，${entry.scope === 'project' ? '项目' : '用户'}，${entry.statusText}，${entry.content ?? ''}`}
    >
      <div className="mem-card-head">
        {/* 三重冗余之一：序号后缀字符。aria-hidden——语义由 label 承担 */}
        <span className="mem-mark" aria-hidden="true">
          {entry.ordinal}
          {entry.mark}
        </span>
        <span className="mem-content">{entry.content}</span>
      </div>
      <div className="mem-meta">
        作用域 {entry.scope === 'project' ? '项目' : '用户'} ｜ 分层 {entry.layer === 'semantic' ? '语义' : '情景'} ｜ 来源 {formatDate(entry.sourceAt)} {entry.eventPhrase}
      </div>
      {/* 三重冗余之二：状态标签文字（含取代关系/到期日） */}
      <div className="mem-status-text" data-testid={`mem-status-${entry.id}`} data-status-text={entry.status}>
        {entry.statusText}
      </div>
      <div className="mem-actions">
        {/* T-4：只有「已过期」能恢复（已修正不可回滚，DC-27；生效无需恢复）。 */}
        {entry.status === 'expired' ? (
          <button type="button" className="mem-btn" data-testid={`mem-restore-${entry.id}`} onClick={() => props.onRestore(entry)}>
            恢复
          </button>
        ) : null}
        <button type="button" className="mem-btn" data-testid={`mem-edit-${entry.id}`} onClick={() => props.onEdit(entry)}>
          编辑
        </button>
        <button type="button" className="mem-btn" data-testid={`mem-history-${entry.id}`} onClick={() => props.onChanges(entry)}>
          变更记录
        </button>
        <button type="button" className="mem-btn" data-testid={`mem-delete-${entry.id}`} onClick={() => props.onDelete(entry)}>
          删除
        </button>
        <button type="button" className="mem-btn mem-btn--danger" data-testid={`mem-harddelete-${entry.id}`} onClick={() => props.onHardDelete(entry)}>
          彻底删除
        </button>
      </div>
    </article>
  )
}

// ================================================================ B 回收站

export function ViewB(props: {
  entries: readonly RecycleEntry[] | null
  onRestore: (entry: RecycleEntry) => void
  onHardDelete: (entry: RecycleEntry) => void
}): ReactElement {
  const entries = props.entries ?? []
  if (entries.length === 0) {
    return (
      <div className="mem-state" data-testid="mem-state-recycle-empty">
        <div className="mem-state-title">{TEXT.recycleEmpty}</div>
      </div>
    )
  }
  return (
    <div data-testid="mem-view-b">
      <table className="mem-table">
        <caption>回收站条目（可恢复）</caption>
        <thead>
          <tr>
            <th scope="col">条目</th>
            <th scope="col">作用域 / 分层</th>
            <th scope="col">删除时间</th>
            <th scope="col">保留期</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} data-testid={`mem-recycle-${entry.id}`}>
              <td>
                <span className="mem-mark" aria-hidden="true">
                  {entry.ordinal}
                  {entry.mark}
                </span>{' '}
                {entry.content}
                {/* D-8 X-6：移除原因必须可见 */}
                <div className="mem-meta" data-testid={`mem-recycle-reason-${entry.id}`}>
                  {entry.removeReason}
                </div>
              </td>
              <td>
                {entry.scope === 'project' ? '项目' : '用户'} · {entry.layer === 'semantic' ? '语义' : '情景'}
              </td>
              <td>{formatDate(entry.deletedAt)}</td>
              <td data-testid={`mem-recycle-days-${entry.id}`}>
                {/* D-8 X-4：不过期配置下不得出现天数 */}
                {entry.remainingDays === null ? '长期保留' : `剩余 ${entry.remainingDays} 天`}
              </td>
              <td>
                <button type="button" className="mem-btn" data-testid={`mem-restore-${entry.id}`} onClick={() => props.onRestore(entry)}>
                  恢复
                </button>
                <button type="button" className="mem-btn mem-btn--danger" data-testid={`mem-harddelete-${entry.id}`} onClick={() => props.onHardDelete(entry)}>
                  彻底删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ================================================================ C 变更记录

export function ViewC(props: {
  changes: ChangesResponse | null
  target: string | null
  onSelect: (memoryId: string) => void
  onBack: () => void
}): ReactElement {
  const changes = props.changes
  if (changes === null) return <div />
  // PC-35：直接进 C 时给"选条目"列表，**不是全局时间线**
  if (props.target === null || changes.chain.length === 0) {
    return (
      <div data-testid="mem-view-c-choices">
        <h2 className="mem-group-title">选择要查看的条目</h2>
        {changes.choices.length === 0 ? (
          <div className="mem-state" data-testid="mem-state-changes-empty">
            <div className="mem-state-title">{TEXT.empty}</div>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {changes.choices.map((choice) => (
              <li key={choice.memoryId}>
                <button
                  type="button"
                  className="mem-btn"
                  style={{ width: '100%', justifyContent: 'space-between', marginBottom: 6 }}
                  data-testid={`mem-c-choice-${choice.memoryId}`}
                  onClick={() => props.onSelect(choice.memoryId)}
                >
                  <span>{choice.content}</span>
                  <span className="mem-meta">{choice.versions} 个版本</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  return (
    <div data-testid="mem-view-c-chain">
      <button type="button" className="mem-btn" data-testid="mem-c-back" onClick={props.onBack} style={{ marginBottom: 10 }}>
        ← 换个条目
      </button>
      <div className="mem-meta" data-testid="mem-c-current-note">
        只有当前版本参与检索。历史只追加，不提供回滚（DC-27 / PC-34）。
      </div>
      <ol style={{ paddingLeft: 18 }} data-testid="mem-c-list">
        {changes.chain.map((entry, index) => (
          <li key={entry.id} data-testid={`mem-c-node-${index}`} style={{ marginBottom: 10 }}>
            <div className="mem-content">{entry.content ?? ''}</div>
            <div className="mem-meta">
              {entry.fromStatus} → {entry.toStatus} · {entry.reason} · {formatDate(entry.at)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ================================================================ 弹窗

type DialogState =
  | { kind: 'edit'; entry: ListEntry }
  | { kind: 'delete'; entry: ListEntry }
  | { kind: 'hard-delete'; entry: ListEntry; prepared: { token: string; echo: { content: string | null } } }

function Dialog(props: {
  state: DialogState
  projectKey: string | null
  onCancel: () => void
  onConfirm: (action: () => Promise<void>) => Promise<void>
  runAction: (action: () => Promise<void>, success: string, undo?: () => Promise<void>) => Promise<void>
}): ReactElement {
  const { state } = props
  if (state.kind === 'edit') return <EditDialog state={state} projectKey={props.projectKey} onCancel={props.onCancel} onConfirm={props.onConfirm} />
  if (state.kind === 'delete') return <DeleteDialog state={state} projectKey={props.projectKey} onCancel={props.onCancel} onConfirm={props.onConfirm} runAction={props.runAction} />
  return <HardDeleteDialog state={state} projectKey={props.projectKey} onCancel={props.onCancel} onConfirm={props.onConfirm} runAction={props.runAction} />
}

function EditDialog(props: {
  state: { kind: 'edit'; entry: ListEntry }
  projectKey: string | null
  onCancel: () => void
  onConfirm: (action: () => Promise<void>) => Promise<void>
}): ReactElement {
  const entry = props.state.entry
  const [content, setContent] = useState(entry.content ?? '')
  const [scope, setScope] = useState<'project' | 'user'>(entry.scope)
  const dialogRef = useRef<HTMLDivElement>(null)

  return (
    <div className="mem-overlay" data-testid="mem-dialog-edit" role="dialog" aria-modal="true" aria-labelledby="mem-edit-title">
      <div className="mem-dialog" ref={dialogRef}>
        <h3 id="mem-edit-title">编辑第 {entry.ordinal} 条</h3>
        <label style={{ display: 'block', marginBottom: 10 }}>
          <span className="mem-echo-label">内容</span>
          <textarea
            className="mem-input"
            style={{ width: '100%', minHeight: 88, paddingTop: 8 }}
            value={content}
            maxLength={500}
            data-testid="mem-edit-content"
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        {/* D-5 Q3 / PC-31：分层不可改，且是**只读展示**而不是 disabled select */}
        <div className="mem-echo" data-testid="mem-edit-layer-readonly">
          <div className="mem-echo-label">分层（不可修改）</div>
          <div>
            {entry.layer === 'semantic' ? '语义' : '情景'} — 分层由写入侧判定。如需换层，请删除后用想要的说法重新记一次。
          </div>
        </div>
        <label style={{ display: 'block', marginBottom: 10 }}>
          <span className="mem-echo-label">作用域</span>
          <select className="mem-select" style={{ width: '100%' }} value={scope} data-testid="mem-edit-scope" onChange={(event) => setScope(event.target.value as 'project' | 'user')}>
            <option value="project">项目</option>
            <option value="user">用户</option>
          </select>
        </label>
        {/* PC-32：事前告知后果 */}
        <div className="mem-consequence" data-testid="mem-edit-consequence">
          保存后：旧内容转为「已修正」并进入变更记录，新内容生效，当前会话内立即可检索。
        </div>
        <div className="mem-dialog-actions">
          <button type="button" className="mem-btn" data-testid="mem-edit-cancel" onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="mem-btn mem-btn--primary"
            data-testid="mem-edit-save"
            disabled={content.trim() === ''}
            onClick={() => void props.onConfirm(() => api.edit(props.projectKey, { id: entry.id, content: content.trim(), scope }).then(() => undefined))}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteDialog(props: {
  state: { kind: 'delete'; entry: ListEntry }
  projectKey: string | null
  onCancel: () => void
  onConfirm: (action: () => Promise<void>) => Promise<void>
  runAction: (action: () => Promise<void>, success: string, undo?: () => Promise<void>) => Promise<void>
}): ReactElement {
  const entry = props.state.entry
  return (
    <div className="mem-overlay" data-testid="mem-dialog-delete" role="dialog" aria-modal="true" aria-labelledby="mem-del-title">
      <div className="mem-dialog">
        <h3 id="mem-del-title">删除第 {entry.ordinal} 条？</h3>
        {/* PC-22：回显目标正文，不是只给序号 */}
        <div className="mem-echo" data-testid="mem-delete-echo">
          <div className="mem-echo-label">将删除的目标条目</div>
          <div>{entry.content}</div>
          <div className="mem-meta">
            {entry.statusText} · {entry.scope === 'project' ? '项目' : '用户'} · {formatDate(entry.sourceAt)}
          </div>
        </div>
        <div className="mem-consequence">
          立即从检索与清单中消失，但进入回收站可随时恢复。删除后说「你记得我什么」也不会再看到它。
        </div>
        <div className="mem-dialog-actions">
          <button type="button" className="mem-btn" data-testid="mem-delete-cancel" onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="mem-btn mem-btn--danger"
            data-testid="mem-delete-confirm"
            onClick={() =>
              void props.onConfirm(async () => {
                await props.runAction(
                  () => api.remove(props.projectKey, entry.id).then(() => undefined),
                  `已删除第 ${entry.ordinal} 条。`,
                  () => api.restore(props.projectKey, entry.id).then(() => undefined),
                )
              })
            }
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  )
}

function HardDeleteDialog(props: {
  state: { kind: 'hard-delete'; entry: ListEntry; prepared: { token: string; echo: { content: string | null } } }
  projectKey: string | null
  onCancel: () => void
  onConfirm: (action: () => Promise<void>) => Promise<void>
  runAction: (action: () => Promise<void>, success: string, undo?: () => Promise<void>) => Promise<void>
}): ReactElement {
  const { entry, prepared } = props.state
  const [checked, setChecked] = useState(false)
  const [typed, setTyped] = useState('')
  const CONFIRM_WORD = '彻底删除'

  return (
    <div className="mem-overlay" data-testid="mem-dialog-harddelete" role="dialog" aria-modal="true" aria-labelledby="mem-hard-title">
      <div className="mem-dialog">
        <h3 id="mem-hard-title">彻底删除第 {entry.ordinal} 条？</h3>
        <div className="mem-echo" data-testid="mem-hard-echo">
          <div className="mem-echo-label">将彻底删除的目标条目</div>
          <div>{prepared.echo.content}</div>
        </div>
        <div className="mem-consequence">
          此操作不可撤销。该内容不会再出现在检索、清单、变更记录或任何摘要中，也不进入回收站。
        </div>
        {/* PC-24：显式勾选 + 输入确认词；模糊肯定不视为确认 */}
        <label className="mem-check">
          <input
            type="checkbox"
            checked={checked}
            data-testid="mem-hard-checkbox"
            onChange={(event) => setChecked(event.target.checked)}
          />
          <span>我确认要彻底删除上面这条内容，理解此操作不可撤销。</span>
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <span className="mem-echo-label">请输入「{CONFIRM_WORD}」以确认</span>
          <input
            className="mem-input"
            style={{ width: '100%' }}
            value={typed}
            data-testid="mem-hard-typed"
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <div className="mem-dialog-actions">
          <button type="button" className="mem-btn" data-testid="mem-hard-cancel" onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="mem-btn mem-btn--danger"
            data-testid="mem-hard-confirm"
            disabled={!checked || typed.trim() !== CONFIRM_WORD}
            onClick={() =>
              void props.onConfirm(async () => {
                await props.runAction(
                  () => api.hardDelete(props.projectKey, entry.id, prepared.token).then(() => undefined),
                  '已彻底删除 1 条。此操作不可撤销。',
                )
              })
            }
          >
            确认彻底删除
          </button>
        </div>
      </div>
    </div>
  )
}
