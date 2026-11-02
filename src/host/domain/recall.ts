/**
 * 自动召回注入（设置里的「自动召回注入」开关）。
 *
 * 机制（宿主 `@deepseek-ai/dsh-system-prompt` 的 runtime-context）：
 * `ctx.systemPrompt.context()` 注册的文本会在**每次组装请求时**求值，
 * 变成一条 user-role 的运行时上下文快照；快照未变化时不会重复追加。
 *
 * 与既有裁定（PRD R-3.5.1「按需检索，不常驻上下文」）的关系：
 * - 这是**用户显式打开**的例外（`recall_inject` 默认 0），不是默认行为；
 * - 只注入"本轮输入召回得到的 top 3"，不是全量记忆，也不改变 system prompt 本体；
 * - 关闭记忆（`enabled=0`）时**永不注入** —— 否则"关闭后没有可查的记忆"这句话不成立。
 *
 * 宿主 API 的边界（已核实 asar 里的公开 declaration）：
 * - `AssembleContext` 只有 `{ scope, signal }`，**拿不到"用户这一轮说了什么"**；
 * - 所以本轮输入要另找：`agents.currentInitiator()?.session.deriveMessages()` 里取
 *   最后一条 `role === 'user' && source.kind === 'user'` 的消息。
 * - 拿不到会话（headless / 子 agent / 服务缺失）→ 返回空串，**宁可少注入，不注入错内容**。
 */

import type { MemoryService } from './service.js'
import type { RetrieveHit } from './retrieve.js'

/** 一次注入/预览最多带几条记忆（top-K 经验值：top-3 才有 97.9% 召回率，见 tech-design §10.2）。 */
export const RECALL_LIMIT = 3

/** 单条正文的截断长度：注入的是"提示"，不是全文。 */
export const RECALL_CONTENT_MAX = 120

/** 整段注入的字符上限（防止长记忆把上下文吃掉）。 */
export const RECALL_TEXT_MAX = 900

/**
 * runtime-context 的顺序位。
 *
 * 宿主既有顺序：WORKING_DIRECTORY 100 → SANDBOX_POLICY 110 → APPROVAL_POLICY 115
 * → SUBAGENT_DELEGATION 120 → TEAM_IDENTITY 125 → HARNESS_SOURCE 200。
 * 放在 130：在"身份/策略"之后、"工具与界面"之前。
 */
export const RECALL_CONTEXT_ORDER = 130

/** 注入段名（宿主用它做快照 diff 的键，改名 = 让旧快照失效一次）。 */
export const RECALL_CONTEXT_NAME = 'dsh-memory:recall'

// ---------------------------------------------------------------- 宿主最小契约

export interface PromptContextLike {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: { scope?: unknown; signal?: AbortSignal }) => string)
  readonly required?: boolean
}

export interface SystemPromptLike {
  context(entry: PromptContextLike): () => void
}

export interface MessageBlockLike {
  readonly type: string
  readonly text?: string
}

export interface MessageLike {
  readonly role: string
  readonly source?: { readonly kind?: string }
  readonly content?: readonly MessageBlockLike[]
}

export interface SessionLike {
  readonly id?: string
  deriveMessages(): readonly MessageLike[]
}

export interface AgentsLike {
  currentInitiator?(): { readonly session?: SessionLike } | undefined
}

export interface WorkingDirectoryLike {
  get(session: { id: string }): string
}

export interface RecallScope {
  readonly systemPrompt: SystemPromptLike
  readonly agents?: AgentsLike
  readonly workingDirectory?: WorkingDirectoryLike
}

export interface RecallHostContext {
  inject(names: string[], callback: (scope: RecallScope) => void): void
  effect(reversible: () => void | (() => void), label?: string): void
}

// ---------------------------------------------------------------- 文本组装

export interface RecallPreviewHit {
  readonly ordinal: number
  readonly id: string
  readonly content: string
  readonly layer: string
  readonly scope: string
  readonly basis: string
}

export interface RecallPreview {
  readonly query: string
  readonly hits: readonly RecallPreviewHit[]
  readonly text: string
  readonly elapsedMs: number
  readonly degraded: false | 'timeout' | 'error'
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function day(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 组装注入文本。**纯函数**（自测直接断言它，不需要宿主）。
 *
 * @returns 没有命中时返回空串 —— 空串让宿主拿不到可追加的内容，
 *   也就是"这一轮不出现任何记忆"，而不是出现一段"没有相关记忆"的噪音。
 */
export function formatRecallText(hits: readonly RetrieveHit[], now: number): string {
  if (hits.length === 0) return ''
  const lines = [
    '【自动召回的记忆】以下条目可能与你当前这轮输入相关（来自本地记忆库，可能无关）：',
    ...hits.slice(0, RECALL_LIMIT).map((hit, index) => {
      const row = hit.row
      const layer = row.layer === 'semantic' ? '语义' : '情景'
      const scope = row.scope === 'project' ? '项目级' : '用户级'
      const basis = `${layer}·${scope}，${day(row.sourceRef.at)} ${row.sourceRef.eventPhrase}`
      return `${index + 1}. ${clip(row.content ?? '', RECALL_CONTENT_MAX)}（${basis}）`
    }),
    '如与当前问题无关就忽略；不要向用户复述这行说明，也不要说"根据记忆"。',
  ]
  const text = lines.join('\n')
  return text.length > RECALL_TEXT_MAX ? `${text.slice(0, RECALL_TEXT_MAX)}…` : text
}

/** 预览（面板设置抽屉里的「预览」按钮走这里，和真实注入共用同一个格式化函数）。 */
export function buildRecallPreview(
  service: MemoryService,
  query: string,
  projectKey: string | null,
  limit = RECALL_LIMIT,
): RecallPreview {
  const result = service.retrieve(query, projectKey, limit)
  return {
    query,
    hits: result.hits.map((hit, index) => ({
      ordinal: index + 1,
      id: hit.row.id,
      content: hit.row.content ?? '',
      layer: hit.row.layer,
      scope: hit.row.scope,
      basis: `${hit.row.layer === 'semantic' ? '语义' : '情景'}·${hit.row.scope === 'project' ? '项目级' : '用户级'}，${day(hit.row.sourceRef.at)} ${hit.row.sourceRef.eventPhrase}`,
    })),
    text: formatRecallText(result.hits, service.now()),
    elapsedMs: result.elapsedMs,
    degraded: result.degraded,
  }
}

// ---------------------------------------------------------------- 本轮输入

/**
 * 取"这一轮用户说了什么"。
 *
 * 宿主 `AssembleContext` 没有消息，只能从会话投影里倒着找第一条 user 消息。
 * 空消息（纯图片/纯附件）返回 null，避免用空串去检索（那会得到任意 top-3）。
 */
export function currentUserPrompt(scope: RecallScope): string | null {
  let session: SessionLike | undefined
  try {
    session = scope.agents?.currentInitiator?.()?.session
  } catch {
    session = undefined
  }
  if (session === undefined) return null
  let messages: readonly MessageLike[]
  try {
    messages = session.deriveMessages()
  } catch {
    return null
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    const text = (message.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return null
}

function projectKeyOf(scope: RecallScope): string | null {
  let session: SessionLike | undefined
  try {
    session = scope.agents?.currentInitiator?.()?.session
  } catch {
    session = undefined
  }
  if (session?.id === undefined) return null
  try {
    return scope.workingDirectory?.get(session as { id: string }) ?? null
  } catch {
    return null
  }
}

/** 一次注入求值：开关 / 会话 / 降级 任一不满足都返回空串。 */
export function recallTextForScope(scope: RecallScope, service: MemoryService): string {
  if (!service.autoRecallEnabled()) return ''
  const query = currentUserPrompt(scope)
  if (query === null) return ''
  const result = service.retrieve(query, projectKeyOf(scope), RECALL_LIMIT)
  // 降级时不注入：超时/出错的检索结果可能缺条目，注入"半份记忆"比不注入更容易误导。
  if (result.degraded !== false) return ''
  return formatRecallText(result.hits, service.now())
}

/**
 * 注册自动召回注入。
 *
 * 三个服务缺一个就不注册（`agents` 在 headless profile 里可能不存在）——
 * 这条路径是**增强**，不能因为它让插件整体激活失败（与 webServer 同一纪律）。
 */
export function registerRecallInjection(ctx: RecallHostContext, service: MemoryService): void {
  ctx.inject(['systemPrompt', 'agents', 'workingDirectory'], (scope) => {
    // effect 挂在 ctx 上而不是注入出的 scope 上：scope 是服务快照，没有生命周期钩子。
    ctx.effect(
      () =>
        scope.systemPrompt.context({
          name: RECALL_CONTEXT_NAME,
          order: RECALL_CONTEXT_ORDER,
          required: false,
          text: () => recallTextForScope(scope, service),
        }),
      'agent-memory: recall context',
    )
  })
}
