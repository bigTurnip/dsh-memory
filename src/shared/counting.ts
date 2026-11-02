/**
 * DC-10 计数口径的**唯一实现**，两条通道（对话清单 / 面板首行）都调这里。
 *
 * 为什么单独成模块：`panel-memory.md` §3.2 说这是「DC-10 在面板上的唯一实现点」，
 * 而 `design-agent-memory.md` DC-10 是同一条规则在对话通道上的表述。两处各写一遍
 * 必然漂移（一个把软删算进 N、另一个不算）。把它做成一个共用函数，且函数内部有
 * 断言，漂移在结构上就不可能发生。
 *
 * 对应裁定：
 * - **D-4 C-2**：「不多不少」= 计数准确性，不是单次输出完整性。
 * - **D-4 C-3**：AC-5 的「清单」专指 V-A。所以 soft 永不计入 N。
 * - **D-8 X-2**：未筛选时 N = 全量 V-A；**有筛选时 N = 筛选后集合**，且首行必须显示筛选条件。
 * - **D-8 X-3**：折叠阈值是「V-A 全清单合计 > 5」，不是单层内。
 *
 * 本文件是纯函数，无 I/O、无 Node 依赖，可被两端打包与单测直接调用。
 */

import type { Filter, Layer, MemoryRow, Scope, Status } from './contract.js'

export interface Counts {
  /** DC-10 的 N：当前视图可见集的三态之和。 */
  readonly n: number
  readonly a: number
  readonly b: number
  readonly c: number
  /**
   * 当前筛选条件的人类可读标签；**未筛选时为 null**。
   * D-8 X-2 要求首行显示它，所以它是返回值的一部分而不是可选装饰。
   */
  readonly filterLabel: string | null
}

/** 某状态是否出现在 V-A 主清单（`design-agent-memory.md` §3 可见性矩阵）。 */
export function inViewA(status: Status): boolean {
  return status === 'active' || status === 'superseded' || status === 'expired'
}

/** 某状态是否出现在 V-B 回收站。 */
export function inViewB(status: Status): boolean {
  return status === 'deleted_soft'
}

/**
 * 检索候选集的唯一判据（**I-2**）。
 *
 * `retrieve.ts` 与自测都调它；任何"检索应该返回什么"的问题都以此为准。
 * 这里刻意接受一个 `Status` 而不是 `MemoryRow`，好让断言能直接对状态枚举做全量检查。
 */
export function retrievable(status: Status): boolean {
  return status === 'active'
}

const SCOPE_LABEL: Record<Scope, string> = { project: '项目级', user: '用户级' }
const LAYER_LABEL: Record<Layer, string> = { semantic: '语义层', episodic: '情景层' }
const STATUS_LABEL: Record<Status, string> = {
  active: '生效',
  superseded: '已修正',
  expired: '已过期',
  deleted_soft: '已删除',
  deleted_hard: '已删除',
}

/**
 * 把筛选条件渲染成首行限定词。**未筛选返回 null**（D-8 X-2：不筛选就不打限定词）。
 *
 * 组合表达按出现顺序拼接，例如「项目级 · 语义层」。
 */
export function describeFilter(filter: Filter | null | undefined): string | null {
  if (filter === null || filter === undefined) return null
  const parts: string[] = []
  if (filter.scope !== undefined) parts.push(SCOPE_LABEL[filter.scope])
  if (filter.layer !== undefined) parts.push(LAYER_LABEL[filter.layer])
  if (filter.status !== undefined) parts.push(STATUS_LABEL[filter.status])
  if (filter.query !== undefined && filter.query.trim() !== '') parts.push(`搜索「${filter.query.trim()}」`)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** 筛选是否等于"什么都没筛"。用于防止调用方传一个空对象却期望 none。 */
export function isFilterEmpty(filter: Filter | null | undefined): boolean {
  return describeFilter(filter) === null
}

/**
 * DC-10 计数。
 *
 * @param rows 当前视图 + 当前筛选后的可见集（**只应包含 V-A 三态**）。
 * @param filter 当前筛选。未筛选传 `null`。
 *
 * 断言 `a+b+c === n === rows.length`：不满足直接抛。宁可在开发期炸掉，
 * 也不要把一个错的 N 渲染给用户（那正是 AC-6 要抓的缺陷）。
 */
export function countVisible(rows: readonly MemoryRow[], filter: Filter | null = null): Counts {
  let a = 0
  let b = 0
  let c = 0
  for (const row of rows) {
    if (row.status === 'active') a += 1
    else if (row.status === 'superseded') b += 1
    else if (row.status === 'expired') c += 1
    else {
      // 软删/硬删不该出现在 V-A 输入里。传进来就是调用方的 bug（违反 D-4 C-3）。
      throw new Error(
        `countVisible: 输入含非 V-A 状态「${row.status}」（id=${row.id}）。` +
          '软删不计入 N，必须由调用方在查询时排除。',
      )
    }
  }
  const n = a + b + c
  if (n !== rows.length) {
    throw new Error(`countVisible: DC-10 不变量被破坏（a+b+c=${n} 但 rows=${rows.length}）`)
  }
  const filterLabel = describeFilter(filter)
  // D-8 X-2：传了"看起来像筛选但其实是空"的对象时，调用方很可能忘了归一化，
  // 那样首行会少打限定词，反而是误导。这里直接拒绝。
  if (filter !== null && filterLabel === null && !isFilterEmpty(filter)) {
    throw new Error('countVisible: 筛选对象非空但无法渲染标签，检查 Filter 字段')
  }
  return { n, a, b, c, filterLabel }
}

/** 已过期折叠阈值（D-8 X-3：全清单口径）。 */
export const EXPIRED_COLLAPSE_THRESHOLD = 5

/**
 * 是否折叠「已过期」小节。
 *
 * **D-8 X-3**：数的是 V-A 全清单的已过期合计，不是某一层内的数量。
 * 反例（本函数要消除的缺陷）：语义 4 条 + 情景 4 条过期 → 全清单 8 > 5 → 必须折叠；
 * 若按"单层内"，两层都不折叠，而对话通道按合计折叠，两通道结论相反 → 违反 S-5。
 */
export function shouldCollapseExpired(counts: Counts): boolean {
  return counts.c > EXPIRED_COLLAPSE_THRESHOLD
}

/**
 * 回收站条数：**单独取**，与 N 无关（DC-10：软删另行列示、不计入 N）。
 *
 * 这个函数存在的意义是让"回收站计数"也只有一个实现——
 * 面板页签 B 的计数与对话「回收站另有 k 条」必须相等。
 */
export function countRecycle(rows: readonly MemoryRow[]): number {
  let k = 0
  for (const row of rows) {
    if (row.status === 'deleted_soft') k += 1
    else if (row.status === 'deleted_hard') {
      // 硬删不得出现在任何视图（AC-5 / PB-6）。出现在输入里就是上游漏了过滤。
      throw new Error(`countRecycle: 输入含已硬删条目（id=${row.id}），硬删不得出现在任何视图`)
    }
  }
  return k
}

/**
 * DC-10 首行的逐字格式（对话通道用；面板用同一组数字自行排版）。
 *
 * **N-4 修复**：首行必须印**项目名**作为 AC-8 的判定锚点（§5.8b / DC-04）。
 * 缺了它，用户与测试都无法确认"当前看到的是哪个项目的记忆"，
 * AC-8「跨项目不串味」在纯文本通道下就不可判定。
 *
 * 三种形态（恒等式 `a+b+c=N` 在任何形态下都不变）：
 *   有项目 `记忆清单 ｜ 项目 <name> ｜ 共 N 条（…）`
 *   无项目 `记忆清单 ｜ 无项目上下文 ｜ 共 N 条（…）`
 *   筛选态 `记忆清单（<filterLabel>） ｜ 项目 <name> ｜ 共 N 条（…）`
 *
 * 无项目时**必须显式声明**，不得静默退回旧格式（省略项目段）——
 * 省略段会让"没有项目"看起来像"旧版本输出"，把 AC-8 的锚点变成不可判定。
 *
 * @param projectName 项目名（工作目录的最后一段）。`null` / `undefined` / 空串 = 无项目上下文。
 */
export function formatCountLine(counts: Counts, projectName?: string | null): string {
  const head = counts.filterLabel === null ? '记忆清单' : `记忆清单（${counts.filterLabel}）`
  const trimmed = typeof projectName === 'string' ? projectName.trim() : ''
  const anchor = trimmed === '' ? '无项目上下文' : `项目 ${trimmed}`
  return `${head} ｜ ${anchor} ｜ 共 ${counts.n} 条（生效 ${counts.a} / 已修正 ${counts.b} / 已过期 ${counts.c}）`
}

/**
 * 从 projectKey（工作目录绝对路径）取项目名 —— §5.8b 要的是**目录名**，不是全路径。
 *
 * 首行是给用户看的，全路径既啰嗦又泄露目录结构；AC-8 的锚点只需要目录名。
 * 无 key → `null`（调用方据此走"无项目上下文"分支）。
 */
export function projectNameFromKey(projectKey: string | null | undefined): string | null {
  if (typeof projectKey !== 'string') return null
  const trimmed = projectKey.trim().replace(/[/\\]+$/, '')
  if (trimmed === '') return null
  const segments = trimmed.split(/[/\\]/).filter((segment) => segment !== '')
  const last = segments[segments.length - 1]
  return last === undefined || last === '' ? null : last
}
