/**
 * Host 与 Browser 共用的**纯类型与纯常量**。
 *
 * 纪律：本文件不得 import 任何 Node 或 React 的东西 —— 它会被两端同时打包。
 * 一旦引入 node:sqlite 或 react，浏览器 bundle 会在加载期直接抛错。
 *
 * 对应契约：docs/tech-design.md §2.1（字段表）、§6.1（状态与不变量）。
 */

/** 五状态。**顺序即状态机的枚举顺序**，不要在中间插入新值。 */
export const STATUS = ['active', 'superseded', 'expired', 'deleted_soft', 'deleted_hard'] as const
export type Status = (typeof STATUS)[number]

/**
 * 分层：**只有两个**。
 *
 * D-3 取消四类型后，分层是唯一的结构性归类；程序记忆不进 MVP（OQ-8=A），
 * 所以 `procedural` 在这里**根本不存在**——不是"先留着以后用"，而是刻意不写。
 */
export const LAYER = ['semantic', 'episodic'] as const
export type Layer = (typeof LAYER)[number]

/**
 * 持久作用域：**只有两个**。
 *
 * `session` 不持久化（PRD §3.4 / B-3），因此不进任何视图；
 * 它也不在这个联合类型里，写 `scope: 'session'` 是编译错误。
 */
export const SCOPE = ['project', 'user'] as const
export type Scope = (typeof SCOPE)[number]

/**
 * 来源类型 = **来源可信度**（PRD §3.7）。
 *
 * 注意它**不是**条目分类：D-3 取消的是 `conclusion/correction/preference/lesson`，
 * 这里是"你明说的 / 你纠正过的 / 系统推断的"，描述可信度而非主题。
 */
export const SOURCE_TYPE = ['explicit', 'correction', 'inferred'] as const
export type SourceType = (typeof SOURCE_TYPE)[number]

export const SENSITIVITY = ['normal', 'restricted'] as const
export type Sensitivity = (typeof SENSITIVITY)[number]

/** 产生该条目的对话片段引用（DC-07 / AC-11）。 */
export interface SourceRef {
  /** 会话 id。取不到时写空串（见 host/tools 的 fail-closed 说明）。 */
  readonly sessionId: string
  /** 该轮次序号。 */
  readonly turnSeq: number
  /** 原文片段（可截断）。空串表示无引用，此时不得落库（DC-07）。 */
  readonly snippet: string
  /** 产生时间（ms）。 */
  readonly at: number
  /** 来源事件短语，用于五要素标注（D-8 X-7）。例：「你纠正测试命令时」。 */
  readonly eventPhrase: string
}

/** 一条记忆（与 DDL 一一对应）。 */
export interface MemoryRow {
  readonly id: string
  readonly layer: Layer
  readonly content: string | null
  readonly scope: Scope
  readonly projectKey: string | null
  readonly sourceType: SourceType
  readonly sourceRef: SourceRef
  readonly createdAt: number
  readonly confirmedAt: number
  readonly status: Status
  readonly supersededBy: string | null
  readonly expiresAt: number | null
  readonly reuseCount: number
  readonly lastHitAt: number | null
  readonly sensitivity: Sensitivity
  readonly deletedAt: number | null
}

/** V-C 变更记录的一条（只追加，A→B→A 是三个节点）。 */
export interface ChangeRow {
  readonly id: string
  readonly memoryId: string
  readonly fromStatus: Status
  readonly toStatus: Status
  readonly reason: ChangeReason
  readonly actor: 'user' | 'system'
  readonly at: number
  readonly detail: Record<string, unknown> | null
}

/**
 * 变更原因。`user_asked_not_to_keep` 是 **D-8 X-6** 的落地：
 * 「别记」移除走软删，但回收站必须标注「因用户要求不保留」。
 */
export const CHANGE_REASON = [
  'correction',
  'edit',
  'scope_change',
  'conflict',
  'expire',
  'restore',
  'delete',
  'hard_delete',
  'user_asked_not_to_keep',
] as const
export type ChangeReason = (typeof CHANGE_REASON)[number]

/** 三视图（DC-09）。**不存在第四种**，所以这里是三个字面量而不是开放字符串。 */
export const VIEW = ['a', 'b', 'c'] as const
export type View = (typeof VIEW)[number]

/** 筛选条件。`null` 表示未筛选（D-8 X-2 要求区分）。 */
export interface Filter {
  readonly scope?: Scope
  readonly layer?: Layer
  readonly status?: Status
  /** 搜索词（匹配正文与来源事件描述）。 */
  readonly query?: string
}

/** 线上错误码。前端只显示 message，不显示 code。 */
export const ERROR_CODE = {
  notFound: 'MEMORY_NOT_FOUND',
  ambiguous: 'MEMORY_AMBIGUOUS',
  needsConfirm: 'MEMORY_NEEDS_CONFIRM',
  invalid: 'MEMORY_INVALID',
  closed: 'MEMORY_CLOSED',
  timeout: 'MEMORY_TIMEOUT',
  internal: 'MEMORY_INTERNAL',
} as const

/** 空态文案（DC-16 逐字，**改字需走设计评审**）。 */
export const TEXT = {
  empty: '目前没有记录任何关于你的记忆。',
  emptySub: '你在对话里说过、值得长期记住的事，我会自动记下来。',
  readFailed: '记忆暂时读不到（超时），这次没法给你清单。',
  readFailedSub: '可以稍后再问一次。',
  closed: '记忆已关闭，我现在没有可查的记忆。',
  closedSub: '说「开启记忆」可以打开。',
  recycleEmpty: '回收站是空的。',
  noSession: '记忆面板跟随会话显示。先新建或进入一个会话。',
  rejectedNotKept: '因用户要求不保留',
  deletedByUser: '你删除了这条',
} as const
