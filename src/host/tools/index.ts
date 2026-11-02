/**
 * 模型可见工具 —— 对话通道的全部能力（PE-15 / S-4：面板不可用时一切仍可用）。
 *
 * 四个工具：`memory_write` / `memory_search` / `memory_list` / `memory_manage`。
 *
 * 设计纪律：
 * - 工具**只调** `MemoryService`，不自己写 SQL —— 两条通道因此不可能不一致。
 * - 取 sessionId 与工作目录走宿主一等能力（tech-design §11-Q3，已核实）：
 *     sessionId  = `exec.agent.session.id`
 *     projectKey = `ctx.workingDirectory.get(exec.agent.session)`
 *   `exec.agent` 是 optional；缺失时 **fail-closed**：不写项目级、不做项目级检索，
 *   因为拿不到 projectKey 就无从判定 AC-8 的隔离边界 —— 宁可少记，不串味。
 */

import type { MemoryService } from '../domain/service.js'
import type { Filter, Layer, MemoryRow, Scope, Status } from '../../shared/contract.js'
import { TEXT } from '../../shared/contract.js'
import { decideDeleteTier, isUserAskedNotToKeep } from '../../shared/delete-tier.js'
import { formatCountLine, projectNameFromKey, EXPIRED_COLLAPSE_THRESHOLD } from '../../shared/counting.js'
import { sourceExcerpt } from '../domain/retrieve.js'

/** 宿主 `workingDirectory` 服务的最小契约（已核实：`get(session)` 无 I/O）。 */
export interface WorkingDirectoryLike {
  get(session: { id: string }): string
}

/** 工具执行上下文的最小契约（只声明我们用到的字段）。 */
export interface ToolExec {
  readonly callId: string
  readonly signal: AbortSignal
  readonly agent?: { readonly session: { readonly id: string } }
}

export interface ToolDeps {
  readonly service: MemoryService
  readonly workingDirectory?: WorkingDirectoryLike
  /** 取不到 agent 时的兜底 projectKey（CLI / 自测用）。 */
  readonly fallbackProjectKey?: string | null
}

export interface ResolvedScope {
  readonly sessionId: string | null
  readonly projectKey: string | null
  /** 是否具备项目级能力（agent 缺失时为 false）。 */
  readonly projectCapable: boolean
}

/**
 * 解析执行上下文的作用域。
 *
 * 这是 Q3 结论的落地点，也是 AC-8 / AC-11 的根基。
 */
export function resolveScope(deps: ToolDeps, exec: ToolExec): ResolvedScope {
  const session = exec.agent?.session
  if (session === undefined) {
    return {
      sessionId: null,
      projectKey: deps.fallbackProjectKey ?? null,
      projectCapable: false,
    }
  }
  const sessionId = session.id
  let projectKey: string | null = null
  try {
    projectKey = deps.workingDirectory?.get(session) ?? deps.fallbackProjectKey ?? null
  } catch {
    projectKey = deps.fallbackProjectKey ?? null
  }
  return { sessionId, projectKey, projectCapable: projectKey !== null }
}

// ---------------------------------------------------------------- 清单渲染

/**
 * 对话清单的纯文本渲染（DC-12：**禁表格**、禁 emoji、禁颜色依赖）。
 *
 * 每条固定三行（A-6），字段顺序固定（§5.2）：
 *   `<序号><状态标记> <内容>`
 *   `   作用域：<项目|用户> ｜ 来源：<日期> <事件短语>（<来源标注>）`
 *   `   状态：<状态文字>`
 *
 * @param options.projectName **N-4**：当前工作目录名，首行的 AC-8 判定锚点。
 *   传 `null` 表示无项目上下文（无会话 / 拿不到 workingDirectory），首行会显式印
 *   「无项目上下文」，而不是静默退回缺锚点的旧格式。
 */
export function renderList(
  view: ReturnType<MemoryService['listA']>,
  options: { pageSize?: number; page?: number; now: number; projectName?: string | null },
): string {
  const pageSize = options.pageSize ?? 10
  const page = options.page ?? 0
  const lines: string[] = []

  lines.push(formatCountLine(view.counts, options.projectName))

  if (view.entries.length === 0) {
    lines.push('')
    lines.push(view.emptyText ?? '筛选后为空（不是没有记忆）。说「看全部」可看所有分层。')
    if (view.recycleCount > 0) {
      lines.push(`回收站另有 ${view.recycleCount} 条已删除（可恢复），说「看回收站」查看`)
    }
    return lines.join('\n')
  }

  const start = page * pageSize
  // D-8 X-3：折叠阈值按**V-A 全清单**已过期合计判定（不是单层内）。
  // 折叠只影响渲染，**不减小 N 与 c**（DC-13 / PC-13）。
  const collapseExpired = view.counts.c > EXPIRED_COLLAPSE_THRESHOLD
  const EXPIRED_PREVIEW = 5
  let expiredShown = 0
  const pageEntries = view.entries
    .slice(start, start + pageSize)
    .filter((entry) => {
      if (!collapseExpired || entry.row.status !== 'expired') return true
      expiredShown += 1
      return expiredShown <= EXPIRED_PREVIEW
    })

  // 分组：语义 → 情景；组内 生效 → 已修正 → 已过期（不打印空分组，DC-11）
  let lastLayer: Layer | null = null
  let lastStatus: Status | null = null
  for (const entry of pageEntries) {
    const row = entry.row
    if (row.layer !== lastLayer) {
      lines.push('')
      lines.push(`${row.layer === 'semantic' ? '语义层' : '情景层'}`)
      lastLayer = row.layer
      lastStatus = null
    }
    if (row.status !== lastStatus) {
      const label =
        row.status === 'active' ? '生效' : row.status === 'superseded' ? '已修正' : '已过期'
      const inGroup = view.entries.filter(
        (candidate) => candidate.row.layer === row.layer && candidate.row.status === row.status,
      ).length
      lines.push(`${label} ${inGroup} 条`)
      lastStatus = row.status
    }
    lines.push(`${entry.ordinal}${entry.mark} ${row.content ?? ''}`)
    lines.push(
      `   作用域：${row.scope === 'project' ? '项目' : '用户'} ｜ 来源：${formatDay(row.sourceRef.at)} ${row.sourceRef.eventPhrase}（${sourceLabel(row.sourceType)}）`,
    )
    lines.push(`   状态：${entry.statusText}`)
  }

  if (collapseExpired && view.counts.c > EXPIRED_PREVIEW) {
    const hidden = view.counts.c - EXPIRED_PREVIEW
    lines.push('')
    lines.push(`已过期另有 ${hidden} 条未展开（本页展示 ${EXPIRED_PREVIEW} / ${view.counts.c} 条）；折叠不影响计数`)
    lines.push('说「看已过期的」可单独查看')
  }

  const total = view.entries.length
  const shown = Math.min(start + pageSize, total)
  lines.push('')
  if (shown < total) {
    lines.push(`说「继续」看第 ${shown + 1}-${Math.min(shown + pageSize, total)} 条`)
  } else {
    lines.push('已到最后一页')
  }
  if (view.recycleCount > 0) {
    lines.push(`回收站另有 ${view.recycleCount} 条已删除（可恢复），不计入上面的 ${view.counts.n} 条；说「看回收站」查看`)
  }
  return lines.join('\n')
}

function sourceLabel(sourceType: string): string {
  return sourceType === 'explicit' ? '你明确说的' : sourceType === 'correction' ? '你纠正过的' : '系统推断的'
}

function formatDay(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 五要素标注（D-8 X-7 / DC-32）。缺任一要素直接抛，不允许打出残缺标注。 */
export function formatBasis(row: MemoryRow, ordinal: number): string {
  const parts = [
    String(ordinal),
    row.layer === 'semantic' ? '语义' : '情景',
    row.scope === 'project' ? '项目' : '用户',
    formatDay(row.sourceRef.at),
    row.sourceRef.eventPhrase,
  ]
  if (parts.some((part) => part === '')) {
    throw new Error(`formatBasis: 标注缺要素（id=${row.id}）`)
  }
  return `依据记忆（第 ${parts[0]} 条 · ${parts[1]} · ${parts[2]}，${parts[3]} ${parts[4]}）：${row.content ?? ''}`
}

/** 回收站渲染（V-B）。 */
export function renderRecycle(
  entries: ReturnType<MemoryService['listB']>,
  retentionDays: number | null,
): string {
  if (entries.length === 0) return '回收站是空的。'
  const head =
    retentionDays === null
      ? `回收站 ｜ 共 ${entries.length} 条（可恢复）`
      : `回收站 ｜ 共 ${entries.length} 条（可恢复，保留 ${retentionDays} 天后彻底删除）`
  const lines = [head, '']
  for (const entry of entries) {
    lines.push(`${entry.ordinal}x ${entry.row.content ?? ''}`)
    lines.push(
      `   作用域：${entry.row.scope === 'project' ? '项目' : '用户'} ｜ 层级：${entry.row.layer === 'semantic' ? '语义' : '情景'}`,
    )
    // D-8 X-6：移除原因必须可见
    lines.push(`   状态：已删除（可恢复 · ${entry.removeReason}）`)
  }
  lines.push('')
  lines.push('说「恢复第 N 条」可恢复 ｜ 说「彻底删除第 N 条」不可恢复')
  return lines.join('\n')
}

// ---------------------------------------------------------------- 工具定义

/**
 * 关闭态应答（**N-1**，F3-c / §5.7 / D-3 逐字，不得改写）。
 *
 * `记忆已关闭，我现在没有可查的记忆。说「开启记忆」可以打开。`
 * 复用 `TEXT.closed + TEXT.closedSub`（同一份字面量，面板与对话不可能漂移）。
 *
 * 为什么必须在查询**之前**拦：关闭态还能列出条目，用户就无法判断功能到底开没开，
 * 且"关了仍能看见内容"违背 OQ-1 关闭的隐私语义（D-11 N-1 的裁定理由）。
 */
const CLOSED_TEXT = `${TEXT.closed}${TEXT.closedSub}`

/**
 * 关闭态**仍然放行**的 memory_manage action。
 *
 * 只有 `enable`：关闭态必须能被打，否则 N-1 的拦截会把 F3-c 文案里
 * 「说『开启记忆』可以打开」这句话亲手变成不可兑现的承诺 —— 用户照着提示说，
 * 结果工具回一句"记忆已关闭"，死循环。`disable` 不需要放行（已是关闭态，幂等）。
 *
 * 这个集合是 N-1 拦截与 N-3 开关通道（修复 4）之间唯一的接缝，
 * 两边改动必须同时成立，所以显式列在这里而不是散进 if。
 *
 * **team-lead 已裁定**：关闭态只放行 enable。
 * 关闭态下「以后别提示写入」也一并被拦 —— 该状态下 write 本就返回 not-salient、
 * 提示行根本不会出现，拦住它不损失任何能力，且保持"关闭态只有一个出路"的语义。
 */
const CLOSED_ALLOWED_ACTIONS: ReadonlySet<string> = new Set(['enable'])

/**
 * 开关回执（N-3 修复 4）。
 *
 * ⚠ **这不是逐字契约**：设计 §5.7 / F3-c 只定义了**查询态**的关闭应答
 * （`记忆已关闭，我现在没有可查的记忆。说「开启记忆」可以打开。`），
 * "关闭成功的回执"没有文档级文案。此处按 team-lead 给的语义要素暂定：
 *   关闭回执必须同时告知 ①不再记录 ②清单不再可查 —— 少了 ②，
 *   用户会以为只是"停止写入"，之后问「你记得我什么」拿到关闭文案会更困惑。
 * 语义要素不变，措辞若要改，走设计评审替换这两个常量即可。
 */
const TOGGLE_ON_TEXT = '记忆已开启。从现在开始我会继续记录和检索，之前的记忆也重新可查。'
const TOGGLE_OFF_TEXT = '记忆已关闭。现在起不再记录新内容，清单与检索均不可查；说「开启记忆」可以打开。'
const MUTE_PROMPT_TEXT = '好，以后不再提示写入。这是设置项，不会成为记忆条目；写入照常进行，只是不再附带提示行。'

/** 模型可见的内容块（宿主只认 text）。 */
export interface ToolContentBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * 工具输出契约。
 *
 * `@deepseek-ai/dsh-tools` 的 `register()` 会**强制**要求这个字段，缺了直接抛
 * `TypeError: tool "x" must declare output { schema, render, presentationMeta? }`，
 * 整个插件跟着 failed。所以它是硬约束，不是可选装饰。
 *
 * - `schema`：对 `execute` 的返回值做 JSON Schema 校验。宿主只支持子集
 *   （type/oneOf/properties/required/additionalProperties/items/enum/const），
 *   不支持 `format`、`minLength` 这类关键字，写了会抛 JsonSchemaError。
 * - `render`：把值渲染成模型可见的内容块。
 */
export interface ToolOutput {
  readonly schema: Record<string, unknown>
  render(args: Record<string, unknown>, value: unknown): ToolContentBlock[]
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutput
  execute(args: Record<string, unknown>, exec: ToolExec): Promise<unknown>
}

/** 允许 null 的标量（`oneOf` 是宿主要求的写法：type 数组不受支持）。 */
function nullable(type: 'string' | 'number' | 'boolean'): Record<string, unknown> {
  return { oneOf: [{ type }, { type: 'null' }] }
}

/**
 * 默认渲染：有可读的 `text` 字段就用它，否则回退到 JSON。
 *
 * `memory_list` / `memory_manage` 的 `text` 已经是给人看的正文，
 * 再套一层 JSON 转义只会让模型读到一堆 `\n`。
 */
function renderValue(_args: Record<string, unknown>, value: unknown): ToolContentBlock[] {
  const text = (value as { text?: unknown } | null)?.text
  if (typeof text === 'string') return [{ type: 'text', text }]
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * 多形态结果的宽松声明。
 *
 * `memory_list` 有清单 / 回收站 / 变更记录三种形态（另有关闭态），
 * `memory_manage` 有九种 action 各自不同的回执。给它们写精确 schema 只会
 * 变成一处跟实现赛跑的重复代码，而宿主目前只消费 `render` 的文本。
 */
const MULTI_SHAPE_OUTPUT: ToolOutput = { schema: { type: 'object' }, render: renderValue }

export function createTools(deps: ToolDeps): ToolDefinition[] {
  const { service } = deps

  return [
    {
      name: 'memory_write',
      description:
        '把一条值得长期记住的事写入记忆。仅在用户明确要求记住、或表达了稳定的偏好/约束时调用。' +
        '不要记录凭据、他人隐私、临时内容。返回受理结果。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '一句话可读陈述，脱离上下文也能读懂' },
          layer: { type: 'string', enum: ['semantic', 'episodic'], description: '稳定事实用 semantic；发生过的事用 episodic' },
          scope: { type: 'string', enum: ['project', 'user'], description: '默认 project；仅跨项目通用的习惯才用 user' },
          sourceType: { type: 'string', enum: ['explicit', 'correction', 'inferred'], description: '用户明说 / 用户纠正 / 系统推断' },
          eventPhrase: { type: 'string', description: '来源事件短语，例如「你说明发版流程时」' },
        },
        required: ['content', 'layer', 'scope', 'sourceType', 'eventPhrase'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            id: nullable('string'),
            layer: nullable('string'),
            scope: nullable('string'),
            category: nullable('string'),
            prompt: { type: 'boolean' },
          },
          required: ['kind', 'prompt'],
        },
        render: renderValue,
      },
      async execute(args, exec) {
        const scope = resolveScope(deps, exec)
        const layer = args.layer as Layer
        const wantScope = args.scope as Scope
        // fail-closed：拿不到 projectKey 时不写项目级（AC-8）
        const effectiveScope: Scope = wantScope === 'project' && !scope.projectCapable ? 'user' : wantScope
        const result = service.write(
          {
            content: String(args.content ?? ''),
            layer,
            scope: effectiveScope,
            sourceType: (args.sourceType as 'explicit' | 'correction' | 'inferred') ?? 'explicit',
            sourceRef: {
              sessionId: scope.sessionId ?? '',
              turnSeq: Number(args.turnSeq ?? 0),
              snippet: String(args.snippet ?? args.content ?? ''),
              at: service.now(),
              eventPhrase: String(args.eventPhrase ?? ''),
            },
          },
          scope.projectKey,
        )
        return {
          kind: result.kind,
          id: result.memory?.id ?? null,
          layer: result.memory?.layer ?? null,
          scope: result.memory?.scope ?? null,
          category: result.category ?? null,
          // D-5 Q1：仅前 N 次给提示
          prompt: scope.sessionId === null ? false : service.shouldPromptWrite(scope.sessionId),
        }
      },
    },

    {
      name: 'memory_search',
      description:
        '按需检索记忆（不常驻上下文）。只在当前任务确实需要历史信息时调用；返回结果带来源。' +
        '检索只返回「生效」的条目。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言描述要找的内容' },
          limit: { type: 'integer', description: '返回条数，默认 5' },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            // false | 'timeout' | 'error'
            degraded: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
            elapsedMs: { type: 'number' },
            hits: { type: 'array', items: { type: 'object' } },
          },
          required: ['degraded', 'elapsedMs', 'hits'],
        },
        render: renderValue,
      },
      async execute(args, exec) {
        const scope = resolveScope(deps, exec)
        const result = service.retrieve(String(args.query ?? ''), scope.projectKey, Number(args.limit ?? 5))
        return {
          degraded: result.degraded,
          elapsedMs: result.elapsedMs,
          hits: result.hits.map((hit, index) => ({
            ordinal: index + 1,
            id: hit.row.id,
            content: hit.row.content,
            layer: hit.row.layer,
            scope: hit.row.scope,
            basis: formatBasis(hit.row, index + 1),
            excerpt: sourceExcerpt(hit.row.sourceRef),
          })),
        }
      },
    },

    {
      name: 'memory_list',
      description:
        '查看记忆清单（V-A）/ 回收站（V-B）/ 变更记录（V-C）。用户问「你记得我什么」时调用。' +
        '支持作用域、分层、状态筛选与搜索。返回的 entries 带 id 与序号（ordinal）：' +
        '按用户说法「第 N 条」操作时，用该 id 作为 memory_manage 的 id 参数。',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['a', 'b', 'c'], description: 'a=清单 b=回收站 c=变更记录' },
          scope: { type: 'string', enum: ['project', 'user'] },
          layer: { type: 'string', enum: ['semantic', 'episodic'] },
          status: { type: 'string', enum: ['active', 'superseded', 'expired'] },
          query: { type: 'string', description: '搜索词' },
          page: { type: 'integer', description: '页码（0 起）' },
          memoryId: { type: 'string', description: 'V-C 时选定条目' },
        },
        required: [],
      },
      output: MULTI_SHAPE_OUTPUT,
      async execute(args, exec) {
        const scope = resolveScope(deps, exec)
        const view = (args.view as 'a' | 'b' | 'c') ?? 'a'

        // N-1：关闭态必须在**读条目之前**拦截。
        // 三个视图（V-A 清单 / V-B 回收站 / V-C 变更记录）都会输出条目正文，
        // 关闭后仍能列出内容 = 用户无法判断功能状态，且违背 OQ-1 的隐私语义。
        // 关闭分支只读开关位，不读条目表，也不返回计数字段（无数据可数）。
        if (!service.enabled()) {
          return { view, closed: true, text: CLOSED_TEXT, counts: null }
        }

        if (view === 'b') {
          const entries = service.listB(scope.projectKey)
          return {
            view: 'b',
            // 序号 → id 映射：「恢复第 N 条」/「彻底删除第 N 条」必须能定位到 id。
            // 只给渲染好的 text，模型拿不到 id，manage 的 id 参数就永远填不上。
            entries: entries.map((entry) => ({
              id: entry.row.id,
              ordinal: entry.ordinal,
              content: entry.row.content,
              layer: entry.row.layer,
              scope: entry.row.scope,
              status: entry.row.status,
              removeReason: entry.removeReason,
              remainingDays: entry.remainingDays,
            })),
            text: renderRecycle(entries, service.retentionDays()),
            count: entries.length,
          }
        }
        if (view === 'c') {
          const result = service.listC(scope.projectKey, (args.memoryId as string) ?? null)
          return {
            view: 'c',
            // PC-35：必须先选定条目，不得提供全局时间线
            choices: result.choices,
            chain: result.chain,
            current: result.current,
          }
        }

        const filter: Filter = {}
        if (args.scope !== undefined) (filter as { scope?: Scope }).scope = args.scope as Scope
        if (args.layer !== undefined) (filter as { layer?: Layer }).layer = args.layer as Layer
        if (args.status !== undefined) (filter as { status?: Status }).status = args.status as Status
        if (args.query !== undefined) (filter as { query?: string }).query = String(args.query)
        const hasFilter = Object.keys(filter).length > 0
        const listing = service.listA(scope.projectKey, hasFilter ? filter : null)
        return {
          view: 'a',
          counts: listing.counts,
          // 序号 → id 映射（同上）：清单文本只给用户在嘴上说的序号，工具层必须另有 id，
          // 否则「删掉第 3 条」「恢复第 6 条」在对话通道里无法落地。
          // 序号与本页 text 里的序号同源（listA 的 ordinal），不受分页/折叠影响。
          entries: listing.entries.map((entry) => ({
            id: entry.row.id,
            ordinal: entry.ordinal,
            content: entry.row.content,
            layer: entry.row.layer,
            scope: entry.row.scope,
            status: entry.row.status,
            statusText: entry.statusText,
          })),
          // N-4：首行带项目名锚点（AC-8 判定锚点）。无 projectKey 时显式走「无项目上下文」。
          projectName: projectNameFromKey(scope.projectKey),
          text: renderList(listing, {
            page: Number(args.page ?? 0),
            now: service.now(),
            projectName: projectNameFromKey(scope.projectKey),
          }),
          recycleCount: listing.recycleCount,
        }
      },
    },

    {
      name: 'memory_manage',
      description:
        '管理记忆：编辑内容/作用域、删除、彻底删除、恢复、批量遗忘，以及功能开关与写入提示静音。' +
        '「删掉」「忘掉」是软删（可恢复）；只有「彻底删除/永久删除/不要留副本」才不可恢复，且需二次确认。' +
        '「开启记忆」→ enable（关闭态下唯一可执行的操作）；「关闭记忆」→ disable；「以后别提示写入」→ mute_prompt_writes。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'edit',
              'delete',
              'hard_delete',
              'confirm_hard_delete',
              'restore',
              'batch_forget',
              'enable',
              'disable',
              'mute_prompt_writes',
            ],
          },
          id: { type: 'string', description: '目标条目 id' },
          ids: { type: 'array', items: { type: 'string' }, description: '批量遗忘的目标' },
          content: { type: 'string', description: '编辑后的新内容' },
          scope: { type: 'string', enum: ['project', 'user'], description: '编辑后的作用域' },
          token: { type: 'string', description: 'hard_delete 第二步的确认令牌' },
          utterance: { type: 'string', description: '用户的原始说法，用于判定档位（D-8 X-1）' },
        },
        required: ['action', 'utterance'],
      },
      output: MULTI_SHAPE_OUTPUT,
      async execute(args, exec) {
        const scope = resolveScope(deps, exec)
        const action = String(args.action)
        const utterance = String(args.utterance ?? '')

        // N-1：关闭态下不执行任何条目操作 —— 不查库、不回显条目正文。
        // manage 的每个 action 都会输出条目内容（edit/restore 返回 row，
        // hard_delete 回显 echo.content），所以"关闭了还能改/还能看到正文"
        // 与 memory_list 是同一个隐私矛盾，一律拦截。
        //
        // 唯一例外是 enable：**关闭态必须还能被开启**，否则 F3-c 的
        // 「说『开启记忆』可以打开」变成一句永远兑现不了的承诺（N-3 修复 4）。
        if (!service.enabled() && !CLOSED_ALLOWED_ACTIONS.has(action)) {
          return { kind: 'closed', closed: true, text: CLOSED_TEXT }
        }

        // ---------- N-3 修复 4：开关通道 ----------
        // 回执都回带 enabled / promptWrites 的真实读值（不是"我刚写了什么"），
        // 这样即使被并发调用，用户看到的也是落库后的实际状态。
        if (action === 'enable' || action === 'disable') {
          const want = action === 'enable'
          service.setEnabled(want)
          const enabled = service.enabled()
          return {
            kind: 'toggled',
            enabled,
            promptWrites: service.promptWritesEnabled(),
            text: enabled ? TOGGLE_ON_TEXT : TOGGLE_OFF_TEXT,
          }
        }

        if (action === 'mute_prompt_writes') {
          service.setPromptWrites(false)
          return {
            kind: 'prompt_muted',
            // 持久设置（memory_settings），不是会话内状态：重启会话仍生效（D-6 Q5）
            promptWrites: service.promptWritesEnabled(),
            enabled: service.enabled(),
            text: MUTE_PROMPT_TEXT,
          }
        }

        if (action === 'edit') {
          const result = service.edit(
            {
              id: String(args.id ?? ''),
              ...(args.content !== undefined ? { content: String(args.content) } : {}),
              ...(args.scope !== undefined ? { scope: args.scope as Scope } : {}),
            },
            scope.projectKey,
          )
          return { kind: 'edited', updated: result.updated, superseded: result.superseded }
        }

        if (action === 'delete') {
          // D-8 X-1 的唯一实现：档位由 decideDeleteTier 判定
          const tier = decideDeleteTier(utterance, args.ids === undefined ? 'single' : 'batch')
          if (tier === 'hard') {
            // 用户说了"彻底删除"但调用了 delete → 走两步协议的第一步
            const prepared = service.prepareHardDelete(String(args.id ?? ''), scope.projectKey)
            return {
              kind: 'needs_confirm',
              token: prepared.token,
              echo: {
                id: prepared.echo.id,
                content: prepared.echo.content,
                layer: prepared.echo.layer,
                scope: prepared.echo.scope,
                sourceAt: prepared.echo.sourceRef.at,
              },
              prompt: '确认请回复「确认彻底删除」；回复「取消」放弃。',
            }
          }
          if (args.ids !== undefined && Array.isArray(args.ids)) {
            const removed = service.batchForget(args.ids.map(String), scope.projectKey)
            return { kind: 'batch_forgotten', count: removed.length, tier: 'soft' }
          }
          // D-8 X-6：。「别记」走软删但要标注原因
          const reason = isUserAskedNotToKeep(utterance) ? 'user_asked_not_to_keep' : 'delete'
          const row = service.softDelete(String(args.id ?? ''), scope.projectKey, reason)
          return { kind: 'deleted', tier: 'soft', row }
        }

        if (action === 'confirm_hard_delete') {
          const row = service.hardDelete(String(args.id ?? ''), String(args.token ?? ''), scope.projectKey)
          return { kind: 'hard_deleted', row }
        }

        if (action === 'restore') {
          const row = service.restore(String(args.id ?? ''), scope.projectKey)
          return { kind: 'restored', row }
        }

        if (action === 'batch_forget') {
          const removed = service.batchForget((args.ids as string[] | undefined)?.map(String) ?? [], scope.projectKey)
          return { kind: 'batch_forgotten', count: removed.length, tier: 'soft' }
        }

        throw new Error(`memory_manage: 未知 action「${action}」`)
      },
    },
  ]
}
