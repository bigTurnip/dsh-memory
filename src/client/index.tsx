/**
 * 浏览器侧插件入口：侧栏入口行 + 中心列主面板（与 dsh-kb 同一套接入方式）。
 *
 * | slot | 用途 | 契约 |
 * | --- | --- | --- |
 * | `sidebar.panellist` | 侧栏入口行（list，`id` 是面板地址） | PE-01 / PE-19 |
 * | `main` | 面板正文（keyed，`key` 必须等于入口行的 `id`） | PE-03 / PE-06 |
 * | `conversation.chat.turnTail` | 对话侧「在面板中打开」 | PE-09 / PE-10 |
 *
 * 切屏是宿主的点击行为，插件不持有"当前是否打开"的状态：点入口行 →
 * 宿主 `ctx.layout.selectPanel(id)` → 在 `main` 里找 key 相同的组件；
 * 找不到会**抛错并保留当前选中态**。所以 `PANEL_ID` 一处写岔的表现是
 * 「点了没反应 + 控制台报错」。
 *
 * 宿主只提供这些共享模块（`window.__ModuleLoader__` 的白名单）：
 * react / react-dom / @deepseek-ai/cordis / dsh-client-ui-slots 等。
 * 本文件只依赖 react 与自有代码，不引入宿主内部的 primitives —— 少一个依赖就少一处升级风险。
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { ICON_MARK } from './icon.js'
import { MemoryPanel } from './panel.js'
import { MemoryTail, TAIL_CSS } from './tail.js'
import { installPanelStyles } from './styles.js'
import type { TabKind } from './tail.js'

/**
 * 面板地址：入口行的 `id` 与 `main` 的 `key` 必须同为这个值。
 *
 * 用短名而不是包名：它是宿主 `main` 注册表里的面板地址，与 npm 包名无关；
 * `conversation` 已被会话界面占用，这里用一个不会撞的 `memory`。
 */
export const PANEL_ID = 'memory'

/** 只需要 `slots`：面板不做主动切屏，也没有自己的一套布局服务。 */
export const inject = ['slots']

interface SlotDescriptor {
  readonly name: string
  readonly id?: string
  readonly key?: string
  readonly order?: number
  readonly label?: string | (() => string)
  readonly children?: Record<string, { kind: string; scope: string }>
  readonly inject?: () => unknown
}

/** `ctx.layout` 里我们真正用到的一处：选中某个已注册的主面板。 */
interface LayoutLike {
  selectPanel(panelId: string | null): void
}

/** 会话列表里我们真正用到的几个字段（`sessions` 服务的 `list` 快照）。 */
interface SessionSummary {
  readonly cwd?: string
  readonly retainedBy?: { readonly mainView?: number }
  readonly updatedAt?: number
}

interface SessionsSnapshot {
  readonly byId?: Record<string, SessionSummary>
}

interface SessionsListLike {
  getSnapshot(): SessionsSnapshot
  subscribe(listener: () => void): () => void
}

interface ClientContext {
  effect(reversible: () => void | (() => void), label?: string): void
  /**
   * cordis 动态注入：服务就绪时才执行回调。
   *
   * 静态 `inject` 里的服务缺一个，整条 entry 就停在 pending / boot 报
   * "did not activate"；所以可选能力一律走这个。
   */
  inject(names: string[], callback: (ctx: ClientContext) => void): void
  readonly slots: {
    inject(name: string, contribute: () => unknown): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register(descriptor: SlotDescriptor, component: any): () => void
  }
  readonly layout?: LayoutLike
  readonly sessions?: { readonly list?: SessionsListLike }
}

function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const remove = installPanelStyles()
  const id = 'dsh-memory/tail.css'
  if (document.querySelector(`style[data-plugin-css="${id}"]`) === null) {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-memory'
    style.dataset.pluginCss = id
    style.textContent = TAIL_CSS
    document.head.appendChild(style)
    return () => {
      remove()
      style.remove()
    }
  }
  return remove
}

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'agent-memory: styles')

  // ---------- 侧栏入口行 + 中心列主面板 ----------
  // 两条注册共用 PANEL_ID：宿主据此把"点入口"翻译成"切 main"。
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelBody),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      // 数字越小越靠上；与宿主自带入口、dsh-kb 同一列。
      { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: '记忆' },
      PanelEntryIcon,
    ),
  )

  // ---------- 对话侧动作 ----------
  ctx.slots.inject('conversation.chat.turnTail', () =>
    ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'agent-memory', order: 50 }, TailOccupant),
  )

  // ---------- 会话快照 ----------
  // `main` 面板拿不到会话，靠 `sessions.list` 自己挑"当前项目"（AC-8 的作用域锚点）。
  ctx.inject(['sessions'], (sessionCtx) => {
    const list = sessionCtx.sessions?.list
    if (list !== undefined) setSessionsList(list)
  })

  // ---------- 从对话里打开面板 ----------
  // 先切到本面板（宿主动作），再把"落到哪一页"告诉正文。
  ctx.inject(['layout'], (layoutCtx) => {
    setOpenHandler((view) => {
      requestView(view)
      layoutCtx.layout?.selectPanel(PANEL_ID)
    })
  })
}

/**
 * 侧栏入口图标。
 *
 * 文字与无障碍名由宿主的入口行提供（`label: '记忆'`），这里只画方章：
 * `size` 由侧边栏按展开/折叠两态给出。**不画角标**（PE-19 / X-5）。
 */
export function PanelEntryIcon({ size }: { size?: number }): ReactElement {
  return (
    <span
      className="mem-icon"
      data-testid="mem-icon"
      aria-hidden="true"
      style={{ fontSize: `${String(size ?? 16)}px` }}
    >
      {ICON_MARK}
    </span>
  )
}

/**
 * 面板正文（`main`）。
 *
 * 与右侧面板时代的差别：
 * - 没有 `useTabInfo` / `params`：页签入口改成"外部请求"（对话侧按钮），
 *   通过模块级 {@link requestView} 递进来；
 * - projectKey 自己从 `sessions` 快照里挑（`main` 的组件只拿到 `renderSlot`）。
 */
function PanelBody(): ReactElement {
  const [list, setList] = useState<SessionsListLike | undefined>(holder.sessions)
  const [request, setRequest] = useState(() => ({ view: pendingView ?? 'a', rev: 0 }))
  const projectKey = useProjectKey(list)

  // 服务晚到也是正确的：挂上后重新订阅，projectKey 跟着更新。
  useEffect(() => {
    if (list !== undefined) return
    const notify = (): void => {
      setList(holder.sessions)
    }
    sessionsListeners.add(notify)
    return () => {
      sessionsListeners.delete(notify)
    }
  }, [list])

  useEffect(() => {
    pendingView = null
    const listener = (view: TabKind): void => {
      // 每次请求都自增 rev：目标页签与当前相同时也让面板重新落到该页
      setRequest((prev) => ({ view, rev: prev.rev + 1 }))
    }
    viewListeners.add(listener)
    return () => {
      viewListeners.delete(listener)
    }
  }, [])

  // 只有"外部请求换页"才重挂面板；面板内点页签不动 rev，状态不丢。
  return <MemoryPanel key={request.rev} projectKey={projectKey} initialView={request.view} />
}

const EMPTY_SESSIONS: SessionsSnapshot = {}

/** 当前项目 = 前台会话的工作目录；没有前台会话就退到最近更新的那个会话。 */
function projectKeyOf(snapshot: SessionsSnapshot): string | null {
  const sessions = Object.values(snapshot.byId ?? {})
  const foreground = sessions.find((session) => (session.retainedBy?.mainView ?? 0) > 0)

  let newest: SessionSummary | undefined
  for (const session of sessions) {
    if (session.cwd === undefined || session.cwd === '') continue
    if (newest === undefined || (session.updatedAt ?? 0) > (newest.updatedAt ?? 0)) newest = session
  }

  const cwd = foreground?.cwd !== undefined && foreground.cwd !== '' ? foreground.cwd : newest?.cwd
  return cwd === undefined || cwd === '' ? null : cwd
}

function useProjectKey(list: SessionsListLike | undefined): string | null {
  const subscribe = useCallback(
    (onChange: () => void) => (list === undefined ? () => {} : list.subscribe(onChange)),
    [list],
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    () => list?.getSnapshot() ?? EMPTY_SESSIONS,
    () => EMPTY_SESSIONS,
  )
  return useMemo(() => projectKeyOf(snapshot), [snapshot])
}

/** 对话侧 occupant：把 `turn.tail` 的文本接进来。 */
function TailOccupant(props: {
  turn?: { text?: string }
  useChat?: (selector: (snapshot: unknown) => string) => string
}): ReactElement | null {
  // 该轮助手文本：优先用 ownerProps 给的 turn，其次用 chat 快照
  const text = props.turn?.text ?? ''
  return <MemoryTail text={text} onOpen={(view) => holder.open?.(view)} />
}

/**
 * ctx 的模块级持有者。
 *
 * slot occupant 是纯组件、拿不到 ctx，所以"打开面板"与"会话快照"都得
 * 从这里取。这是唯一一处模块级可变状态。
 */
const holder: {
  sessions?: SessionsListLike
  open?: (view: TabKind) => void
} = {}

/** 面板已挂载时的换页通道。 */
const viewListeners = new Set<(view: TabKind) => void>()

/** 面板未挂载时的换页目标（挂载瞬间消费）。 */
let pendingView: TabKind | null = null

const sessionsListeners = new Set<() => void>()

function requestView(view: TabKind): void {
  pendingView = view
  for (const listener of viewListeners) listener(view)
}

function setSessionsList(list: SessionsListLike): void {
  holder.sessions = list
  for (const listener of sessionsListeners) listener()
}

export function setOpenHandler(handler: (view: TabKind) => void): void {
  holder.open = handler
}
