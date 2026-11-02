/**
 * 对话通道清单文本解析器（test-engineer 独立断言工具）。
 *
 * ## 为什么需要它
 * 验收结论必须建立在**结构化断言**上，而不是"肉眼读输出觉得对"。
 * 没有解析器，`a+b+c=N` 这种恒等式只能靠眼睛看 —— 那正是 v1 计划里
 * "独立复跑"流于形式的根因。
 *
 * ## 设计原则
 * 1. **只认契约写死的格式**（DC-10 首行、DC-13 三行条目、DC-11 分组）。
 *    格式漂移一律进 `unrecognized`，让漂移自己冒出来，而不是被我悄悄忽略。
 * 2. **不做宽容解析**。解析不出来就是 `unrecognized`，不猜、不兜底。
 *    宽容解析会让"实现改坏了"伪装成"解析器兼容了"。
 * 3. **纯函数、零 I/O、零依赖**。系统 node 与宿主运行时都能跑。
 *
 * ## 格式事实（2026-11-01 从真实输出抓取，非假设）
 * ```
 * 记忆清单 ｜ 项目 dsh-momery ｜ 共 6 条（生效 4 / 已修正 1 / 已过期 1）      ← 有项目
 * 记忆清单（项目级） ｜ 项目 dsh-momery ｜ 共 5 条（…）                      ← 有项目 + 筛选
 * 记忆清单 ｜ 无项目上下文 ｜ 共 6 条（…）                                   ← 无项目上下文
 * 记忆清单 ｜ 共 6 条（生效 4 / 已修正 1 / 已过期 1）                        ← 缺锚点（回归形态）
 *
 * 语义层
 * 生效 3 条
 * 1+ 发版前必须先跑 pnpm build
 *    作用域：项目 ｜ 来源：2026-10-30 你说明发版流程时（你明确说的）
 *    状态：生效
 * 4~ 测试命令是 jest
 *    状态：已修正（2026-10-25 被第 2 条取代）
 * 6- 10-20 排查过 pnpm 安装超时
 *    状态：已过期（2026-10-31 到期，不参与检索）
 *
 * 已过期另有 3 条未展开（本页展示 5 / 8 条）；折叠不影响计数
 * 说「继续」看第 11-20 条          ← 或「已到最后一页」
 * 回收站另有 1 条已删除（可恢复），不计入上面的 6 条；说「看回收站」查看
 * ```
 * 回收站（V-B）格式不同：`作用域：项目 ｜ 层级：语义`，状态行为 `已删除（可恢复 · 原因）`。
 *
 * ## 两个已确认的易错点（写解析器时差点搞错）
 * - **分页序号跨页连续**：第 2 页从 `11+` 开始，不是从 `1+`。所以 `ordinal`
 *   是"全清单序号"，可用于跨页并集比对。
 * - **分组头计数是全量而非当页**：`生效 13 条` 在第 2 页仍写 13，
 *   不是当页 3 条。因此不能用"小节头计数之和"当分页并集大小。
 */

/** 状态标记字符 → 语义（DC-13 三重冗余之一）。 */
export const MARK_TO_STATUS = {
  '+': 'active',
  '~': 'superseded',
  '-': 'expired',
  x: 'deleted_soft',
} as const

export type ParsedStatus = (typeof MARK_TO_STATUS)[keyof typeof MARK_TO_STATUS]
export type ParsedMark = keyof typeof MARK_TO_STATUS
export type ParsedLayer = 'semantic' | 'episodic'

export interface ParsedEntry {
  /** 全清单序号（跨页连续，1 起）。 */
  readonly ordinal: number
  /** 状态标记字符。 */
  readonly mark: ParsedMark
  /** 由 mark 推出的状态。 */
  readonly status: ParsedStatus
  /** 条目正文（首行，不含缩进属性行）。 */
  readonly content: string
  /** 所在分层（由最近的层标题决定；V-B 由「层级：」行给出）。 */
  readonly layer: ParsedLayer | null
  /** 作用域。 */
  readonly scope: 'project' | 'user' | null
  /** 来源日期 `YYYY-MM-DD`（V-A 才有）。 */
  readonly sourceDate: string | null
  /** 来源事件短语（V-A 才有）。 */
  readonly eventPhrase: string | null
  /** 来源可信度标注（`你明确说的` / `你纠正过的` / `系统推断的`）。 */
  readonly sourceLabel: string | null
  /** 状态行原文（`状态：` 之后的部分）。空串表示缺状态行。 */
  readonly statusText: string
  /** 已修正：被第几条取代。 */
  readonly supersededByOrdinal: number | null
  /** 已过期：到期日。 */
  readonly expiredAt: string | null
  /** 已删除：移除原因。 */
  readonly removeReason: string | null
}

export interface ParsedCounts {
  readonly n: number
  readonly a: number
  readonly b: number
  readonly c: number
}

export interface ParsedSection {
  readonly status: ParsedStatus
  /** 小节标题声明的条数（`生效 3 条` → 3）。**全量计数，不是当页条数**。 */
  readonly declaredCount: number
  readonly entries: readonly ParsedEntry[]
}

export interface ParsedGroup {
  readonly layer: ParsedLayer
  readonly sections: readonly ParsedSection[]
}

export interface ParsedFold {
  /** 折叠行声明的隐藏条数。 */
  readonly hiddenCount: number
  /** 本页展示数。 */
  readonly shown: number
  /** 总过期数。 */
  readonly total: number
  /** 是否有「看已过期的」展开入口。 */
  readonly hasEntry: boolean
}

export interface ParsedPager {
  readonly hasNext: boolean
  readonly nextRange: { readonly from: number; readonly to: number } | null
  readonly atLastPage: boolean
}

/**
 * 首行项目锚点的三态 + 一个"缺失"态（D-11 追加节）。
 *
 * - `named`：`项目 <目录名>` —— 合法
 * - `no-context`：`无项目上下文` —— 合法（无会话 / 拿不到 workingDirectory）
 * - `missing`：**完全没有锚点段** —— 这是 N-4 修复前的历史格式，
 *   在 N-4 之后属于**回归**。解析器接受它（以便给出精确诊断），
 *   但 `assertProjectAnchorPresent` 必须把它判红。
 */
export type ProjectAnchorKind = 'named' | 'no-context' | 'missing'

export interface ParsedList {
  readonly view: 'a' | 'b'
  /** 首行筛选限定词（`项目级` / null）。 */
  readonly filterLabel: string | null
  /**
   * **N-4**：首行项目名（仅 `anchorKind === 'named'` 时非 null）。
   *
   * 注意 `no-context` 与 `missing` 都为 null —— 二者**必须靠 `anchorKind` 区分**，
   * 只看 `projectName` 会把"显式声明无项目"和"锚点缺失"混为一谈。
   */
  readonly projectName: string | null
  /**
   * 首行锚点形态。**这是区分回归与合法格式的唯一依据**：
   * `missing` 在 N-4 之后一律是缺陷。
   */
  readonly anchorKind: ProjectAnchorKind
  /** 首行计数（V-B 为 null）。 */
  readonly counts: ParsedCounts | null
  /** 回收站条数（V-B 首行 `共 k 条`）。 */
  readonly recycleCount: number | null
  /** 回收站声明的保留天数；无天数承诺 → null（X-4）。 */
  readonly retentionDaysClaim: number | null
  /** 空态文案（逐字，DC-16）。 */
  readonly emptyText: string | null
  /** 筛选后为空的文案。 */
  readonly filteredEmptyText: string | null
  /** 分组（V-A）。 */
  readonly groups: readonly ParsedGroup[]
  /** 所有条目（按出现顺序）。 */
  readonly entries: readonly ParsedEntry[]
  /** 折叠信息。 */
  readonly fold: ParsedFold | null
  readonly pager: ParsedPager
  /** `回收站另有 k 条…不计入上面的 N 条`。 */
  readonly recycleNote: { readonly count: number; readonly n: number } | null
  /**
   * 无法识别的非空行。**本解析器的核心质量信号**：
   * 契约格式漂移会全部落在这里，而不是被静默跳过。
   */
  readonly unrecognized: readonly string[]
}

// ---------------------------------------------------------------- 正则

/**
 * 首行 V-A。
 *
 * ## 锚点三态（D-11 追加节裁定）
 * N-4 修复后，实现**始终**印一个项目锚点，只有三种合法形态：
 * 1. `记忆清单 ｜ 项目 <目录名> ｜ 共 N 条（…）`            —— 有项目
 * 2. `记忆清单（<限定词>） ｜ 项目 <目录名> ｜ 共 N 条（…）` —— 有项目 + 筛选
 * 3. `记忆清单 ｜ 无项目上下文 ｜ 共 N 条（…）`             —— 无项目上下文
 *
 * ## 为什么「省略锚点」仍要能被解析出来
 * 省略锚点是 **N-4 修复前的历史格式**，也是**回归形态**。
 * 如果正则直接不认它，它会掉进 `unrecognized` —— 那确实能"抓到"，
 * 但抓到的形式是"格式无法识别"，与"锚点缺失"这个具体缺陷语义不同，
 * 断言无法给出准确诊断。
 *
 * 所以这里**接受**省略形态，但用 `anchorKind: 'missing'` **显式打标记**，
 * 让 `assertProjectAnchorPresent` 能精确报「锚点缺失（回归）」，
 * 而不是笼统的"格式漂移"。**解析器接受 ≠ 断言放过** ——
 * 这正是"工具不得替实现吞掉回归"的落地点。
 */
const RE_LIST_HEAD =
  /^记忆清单(?:（(?<filter>[^）]+)）)?(?: ｜ (?:(?<anchorKw>项目|无项目上下文)(?: (?<project>.+?))?))? ｜ 共 (?<n>\d+) 条（生效 (?<a>\d+) \/ 已修正 (?<b>\d+) \/ 已过期 (?<c>\d+)）$/

/** 首行 V-B。保留天数段可选（X-4：不过期时不得出现天数）。 */
const RE_RECYCLE_HEAD =
  /^回收站 ｜ 共 (?<k>\d+) 条（可恢复(?<retention>，保留 (?<days>\d+) 天后彻底删除)?）$/

const RE_GROUP = /^(?<layer>语义层|情景层)$/
const RE_SECTION = /^(?<status>生效|已修正|已过期) (?<count>\d+) 条$/
const RE_ENTRY = /^(?<ordinal>\d+)(?<mark>[+~x-]) (?<content>.*)$/
const RE_SCOPE_SOURCE =
  /^ {3}作用域：(?<scope>项目|用户) ｜ 来源：(?<date>\d{4}-\d{2}-\d{2}) (?<phrase>.+)（(?<label>[^）]+)）$/
const RE_SCOPE_LAYER = /^ {3}作用域：(?<scope>项目|用户) ｜ 层级：(?<layer>语义|情景)$/
const RE_STATUS = /^ {3}状态：(?<text>.+)$/
const RE_SUPERSEDED_BY = /被第 (?<ordinal>\d+) 条取代/
const RE_EXPIRED_AT = /（(?<date>\d{4}-\d{2}-\d{2}) 到期，不参与检索）/
const RE_REMOVE_REASON = /^已删除（可恢复 · (?<reason>.+)）$/
const RE_FOLD =
  /^已过期另有 (?<hidden>\d+) 条未展开（本页展示 (?<shown>\d+) \/ (?<total>\d+) 条）；折叠不影响计数$/
const RE_FOLD_ENTRY = /^说「看已过期的」可单独查看$/
const RE_NEXT = /^说「继续」看第 (?<from>\d+)-(?<to>\d+) 条$/
const RE_LAST = /^已到最后一页$/
const RE_RECYCLE_NOTE =
  /^回收站另有 (?<count>\d+) 条已删除（可恢复），不计入上面的 (?<n>\d+) 条；说「看回收站」查看$/

/** DC-16 空态文案（逐字）。 */
const EMPTY_TEXT = '目前没有记录任何关于你的记忆。'
/** 筛选后为空的文案（前缀匹配，后半句是实现自由）。 */
const FILTERED_EMPTY_PREFIX = '筛选后为空（不是没有记忆）'
/** 回收站空态文案。 */
const RECYCLE_EMPTY_TEXT = '回收站是空的。'

const STATUS_NAME_TO_PARSED: Record<string, ParsedStatus> = {
  生效: 'active',
  已修正: 'superseded',
  已过期: 'expired',
}

const LAYER_NAME_TO_PARSED: Record<string, ParsedLayer> = {
  语义: 'semantic',
  情景: 'episodic',
}

function toLayer(text: string | null | undefined): ParsedLayer | null {
  if (text === null || text === undefined) return null
  return LAYER_NAME_TO_PARSED[text] ?? null
}

/** 可变版本的条目（解析期间逐步补齐属性）。 */
interface MutableEntry {
  ordinal: number
  mark: ParsedMark
  /** 由 mark 推出，写入时即确定，不再变。 */
  status: ParsedStatus
  content: string
  layer: ParsedLayer | null
  scope: 'project' | 'user' | null
  sourceDate: string | null
  eventPhrase: string | null
  sourceLabel: string | null
  statusText: string
  supersededByOrdinal: number | null
  expiredAt: string | null
  removeReason: string | null
}

function newEntry(ordinal: number, mark: ParsedMark, content: string, layer: ParsedLayer | null): MutableEntry {
  return {
    ordinal,
    mark,
    status: MARK_TO_STATUS[mark],
    content,
    layer,
    scope: null,
    sourceDate: null,
    eventPhrase: null,
    sourceLabel: null,
    statusText: '',
    supersededByOrdinal: null,
    expiredAt: null,
    removeReason: null,
  }
}

/**
 * 解析一段清单文本。
 *
 * 不抛异常：格式不符只记 `unrecognized`。是否"合格"由断言决定，
 * 而不是解析器替我做判断。
 */
export function parseList(text: string): ParsedList {
  const lines = text.split('\n')
  const unrecognized: string[] = []

  let view: 'a' | 'b' = 'a'
  let filterLabel: string | null = null
  let projectName: string | null = null
  let anchorKind: ProjectAnchorKind = 'missing'
  let counts: ParsedCounts | null = null
  let recycleCount: number | null = null
  let retentionDaysClaim: number | null = null
  let emptyText: string | null = null
  let filteredEmptyText: string | null = null
  let fold: ParsedFold | null = null
  let recycleNote: { count: number; n: number } | null = null
  let pager: ParsedPager = { hasNext: false, nextRange: null, atLastPage: false }

  const entries: MutableEntry[] = []
  const groups: Array<{ layer: ParsedLayer; sections: Array<{ status: ParsedStatus; declaredCount: number }> }> = []

  let currentLayer: ParsedLayer | null = null
  /** 最近一个已产出、仍可被后续属性行补写的条目。 */
  let lastEntry: MutableEntry | null = null

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line === '') continue

    // ---- 首行：V-A ----
    const listHead = RE_LIST_HEAD.exec(line)
    if (listHead?.groups !== undefined) {
      view = 'a'
      filterLabel = listHead.groups.filter ?? null
      // 三态判定：关键词决定 anchorKind，不能只看 project 是否为空
      const anchorKeyword = listHead.groups.anchorKw
      if (anchorKeyword === '项目') {
        anchorKind = 'named'
        projectName = listHead.groups.project ?? null
      } else if (anchorKeyword === '无项目上下文') {
        anchorKind = 'no-context'
        projectName = null
      } else {
        anchorKind = 'missing'
        projectName = null
      }
      counts = {
        n: Number(listHead.groups.n),
        a: Number(listHead.groups.a),
        b: Number(listHead.groups.b),
        c: Number(listHead.groups.c),
      }
      continue
    }

    // ---- 首行：V-B ----
    const recycleHead = RE_RECYCLE_HEAD.exec(line)
    if (recycleHead?.groups !== undefined) {
      view = 'b'
      recycleCount = Number(recycleHead.groups.k)
      retentionDaysClaim = recycleHead.groups.days === undefined ? null : Number(recycleHead.groups.days)
      continue
    }

    // ---- 空态 / 筛选后为空 ----
    if (line === EMPTY_TEXT) {
      emptyText = line
      continue
    }
    if (line === RECYCLE_EMPTY_TEXT) {
      emptyText = line
      continue
    }
    if (line.startsWith(FILTERED_EMPTY_PREFIX)) {
      filteredEmptyText = line
      continue
    }

    // ---- 分组标题 ----
    const group = RE_GROUP.exec(line)
    if (group?.groups !== undefined) {
      currentLayer = toLayer(group.groups.layer === '语义层' ? '语义' : '情景')
      lastEntry = null
      if (currentLayer !== null && !groups.some((candidate) => candidate.layer === currentLayer)) {
        groups.push({ layer: currentLayer, sections: [] })
      }
      continue
    }

    // ---- 状态小节标题 ----
    const section = RE_SECTION.exec(line)
    if (section?.groups !== undefined) {
      const status = STATUS_NAME_TO_PARSED[section.groups.status ?? '']
      if (status !== undefined) {
        lastEntry = null
        const currentGroup = groups.find((candidate) => candidate.layer === currentLayer)
        currentGroup?.sections.push({ status, declaredCount: Number(section.groups.count) })
      }
      continue
    }

    // ---- 条目首行 ----
    const entryMatch = RE_ENTRY.exec(line)
    if (entryMatch?.groups !== undefined) {
      const mark = entryMatch.groups.mark as ParsedMark
      const parsed = newEntry(
        Number(entryMatch.groups.ordinal),
        mark,
        entryMatch.groups.content ?? '',
        currentLayer,
      )
      entries.push(parsed)
      lastEntry = parsed
      continue
    }

    // ---- 属性行：作用域 + 来源（V-A） ----
    const scopeSource = RE_SCOPE_SOURCE.exec(line)
    if (scopeSource?.groups !== undefined) {
      if (lastEntry !== null) {
        lastEntry.scope = scopeSource.groups.scope === '项目' ? 'project' : 'user'
        lastEntry.sourceDate = scopeSource.groups.date ?? null
        lastEntry.eventPhrase = scopeSource.groups.phrase ?? null
        lastEntry.sourceLabel = scopeSource.groups.label ?? null
      } else {
        unrecognized.push(line)
      }
      continue
    }

    // ---- 属性行：作用域 + 层级（V-B） ----
    const scopeLayer = RE_SCOPE_LAYER.exec(line)
    if (scopeLayer?.groups !== undefined) {
      if (lastEntry !== null) {
        lastEntry.scope = scopeLayer.groups.scope === '项目' ? 'project' : 'user'
        lastEntry.layer = toLayer(scopeLayer.groups.layer)
      } else {
        unrecognized.push(line)
      }
      continue
    }

    // ---- 属性行：状态 ----
    const statusLine = RE_STATUS.exec(line)
    if (statusLine?.groups !== undefined) {
      if (lastEntry !== null) {
        const statusText = statusLine.groups.text ?? ''
        lastEntry.statusText = statusText
        const superseded = RE_SUPERSEDED_BY.exec(statusText)
        if (superseded?.groups !== undefined) {
          lastEntry.supersededByOrdinal = Number(superseded.groups.ordinal)
        }
        const expired = RE_EXPIRED_AT.exec(statusText)
        if (expired?.groups !== undefined) {
          lastEntry.expiredAt = expired.groups.date ?? null
        }
        const removeReason = RE_REMOVE_REASON.exec(statusText)
        if (removeReason?.groups !== undefined) {
          lastEntry.removeReason = removeReason.groups.reason ?? null
        }
      } else {
        unrecognized.push(line)
      }
      continue
    }

    // ---- 折叠行 ----
    const foldLine = RE_FOLD.exec(line)
    if (foldLine?.groups !== undefined) {
      fold = {
        hiddenCount: Number(foldLine.groups.hidden),
        shown: Number(foldLine.groups.shown),
        total: Number(foldLine.groups.total),
        hasEntry: false,
      }
      lastEntry = null
      continue
    }
    if (RE_FOLD_ENTRY.test(line)) {
      fold = fold === null ? { hiddenCount: 0, shown: 0, total: 0, hasEntry: true } : { ...fold, hasEntry: true }
      continue
    }

    // ---- 分页 ----
    const next = RE_NEXT.exec(line)
    if (next?.groups !== undefined) {
      pager = {
        ...pager,
        hasNext: true,
        nextRange: { from: Number(next.groups.from), to: Number(next.groups.to) },
      }
      continue
    }
    if (RE_LAST.test(line)) {
      pager = { ...pager, atLastPage: true }
      continue
    }

    // ---- 回收站计数行 ----
    const note = RE_RECYCLE_NOTE.exec(line)
    if (note?.groups !== undefined) {
      recycleNote = { count: Number(note.groups.count), n: Number(note.groups.n) }
      continue
    }

    // ---- 已知的说明性行（不参与断言，但也不算未识别） ----
    if (/^说「恢复第 N 条」可恢复 ｜ 说「彻底删除第 N 条」不可恢复$/.test(line)) continue
    if (/^说「第 N 条详情」看完整内容与来源/.test(line)) continue
    if (/^说「看全部」/.test(line)) continue

    // ---- 未识别 ----
    unrecognized.push(line)
  }

  // 组装分组结构（把条目按 层 + 状态 归位）
  const parsedGroups: ParsedGroup[] = groups.map((group) => ({
    layer: group.layer,
    sections: group.sections.map((section) => ({
      status: section.status,
      declaredCount: section.declaredCount,
      entries: entries.filter(
        (candidate) => candidate.layer === group.layer && MARK_TO_STATUS[candidate.mark] === section.status,
      ),
    })),
  }))

  return {
    view,
    filterLabel,
    projectName,
    anchorKind,
    counts,
    recycleCount,
    retentionDaysClaim,
    emptyText,
    filteredEmptyText,
    groups: parsedGroups,
    entries,
    fold,
    pager,
    recycleNote,
    unrecognized,
  }
}
