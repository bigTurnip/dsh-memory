/**
 * 三视图的组装（DC-09：**恰好三种，不得新增第四种**）。
 *
 * V-A 主清单 / V-B 回收站 / V-C 变更记录。
 * 这里导出的函数**只有这三个** —— 想加第四视图必须先加一个导出，
 * 而自测 HC-3 会断言导出集合等于 {listA, listB, listC}。
 */

import type { Db } from '../db/index.js'
import * as dao from '../db/dao.js'
import type { ChangeRow, Filter, Layer, MemoryRow, Scope, Status } from '../../shared/contract.js'
import { countRecycle, countVisible, describeFilter, isFilterEmpty, type Counts } from '../../shared/counting.js'
import { TEXT } from '../../shared/contract.js'

export interface ListContext {
  readonly projectKey: string | null
}

/** 逐条渲染所需的派生信息（对话清单与面板表格共用同一份）。 */
export interface ListEntry {
  readonly row: MemoryRow
  /** 会话内序号（1 起）。面板里用于「第 N 条」指代。 */
  readonly ordinal: number
  /** 状态后缀符号 `+ ~ - x`（三重冗余之一）。 */
  readonly mark: '+' | '~' | '-' | 'x' | ''
  /** 状态标签文字（三重冗余之二，含取代关系/到期日）。 */
  readonly statusText: string
}

const MARK: Record<Status, ListEntry['mark']> = {
  active: '+',
  superseded: '~',
  expired: '-',
  deleted_soft: 'x',
  deleted_hard: '',
}

function formatDate(ms: number): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 状态标签文字（DC-14）。
 *
 * `已修正` 必带「被第 N 条取代 + 日期」；`已过期` 必带「到期日 + 不参与检索」。
 * `ordinalOf` 把 id 映射成当前清单里的序号（取代关系要指"第几条"）。
 */
export function statusTextFor(row: MemoryRow, ordinalOf: (id: string) => number | null): string {
  switch (row.status) {
    case 'active':
      return '生效'
    case 'superseded': {
      const target = row.supersededBy === null ? null : ordinalOf(row.supersededBy)
      const which = target === null ? '更新的条目' : `第 ${target} 条`
      return `已修正（${formatDate(row.confirmedAt)} 被${which}取代）`
    }
    case 'expired': {
      const due = row.expiresAt === null ? formatDate(row.confirmedAt) : formatDate(row.expiresAt)
      return `已过期（${due} 到期，不参与检索）`
    }
    case 'deleted_soft': {
      const reason = row.content === null ? TEXT.deletedByUser : TEXT.deletedByUser
      return `已删除（可恢复 · ${reason}）`
    }
    case 'deleted_hard':
      return ''
  }
}

/** 应用筛选（V-A 内部）。**筛选语义必须与对话限定词等价**（S-2 / PC-12）。 */
export function applyFilter(rows: readonly MemoryRow[], filter: Filter | null): MemoryRow[] {
  if (filter === null || isFilterEmpty(filter)) return [...rows]
  return rows.filter((row) => {
    if (filter.scope !== undefined && row.scope !== filter.scope) return false
    if (filter.layer !== undefined && row.layer !== filter.layer) return false
    if (filter.status !== undefined && row.status !== filter.status) return false
    if (filter.query !== undefined && filter.query.trim() !== '') {
      const needle = filter.query.trim().toLowerCase()
      const haystack = `${row.content ?? ''} ${row.sourceRef.eventPhrase} ${row.sourceRef.snippet}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

/** 排序：分层语义→情景；层内 生效→已修正→已过期；同状态按最近确认时间倒序（PC-20）。 */
const LAYER_ORDER: Record<Layer, number> = { semantic: 0, episodic: 1 }
const STATUS_ORDER: Record<string, number> = {
  active: 0,
  superseded: 1,
  expired: 2,
  deleted_soft: 3,
}

export function sortRows(rows: readonly MemoryRow[]): MemoryRow[] {
  return [...rows].sort((left, right) => {
    const layerDiff = LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
    if (layerDiff !== 0) return layerDiff
    const statusDiff = (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9)
    if (statusDiff !== 0) return statusDiff
    if (right.confirmedAt !== left.confirmedAt) return right.confirmedAt - left.confirmedAt
    return left.id.localeCompare(right.id)
  })
}

export interface ViewAResult {
  readonly counts: Counts
  readonly entries: readonly ListEntry[]
  /** 回收站条数（**单独取，不计入 N**）。 */
  readonly recycleCount: number
  /** 空状态文案（V-A 为空时非 null）。 */
  readonly emptyText: string | null
}

/**
 * V-A 主清单。
 *
 * @param filter 当前筛选。`null` = 未筛选（D-8 X-2 要求区分这两种情形）。
 */
export function listA(db: Db, ctx: ListContext, filter: Filter | null = null): ViewAResult {
  const all = dao.listByStatuses(db, {
    statuses: ['active', 'superseded', 'expired'],
    projectKey: ctx.projectKey,
  })
  const sorted = sortRows(all)
  const filtered = applyFilter(sorted, filter)
  const counts = countVisible(filtered, filter)

  const byId = new Map(filtered.map((row) => [row.id, row]))
  const ordinalOf = (id: string): number | null => {
    const index = filtered.findIndex((row) => row.id === id)
    return index < 0 ? null : index + 1
  }
  // 被取代的目标可能不在当前筛选集里，此时用全集序号兜底
  const ordinalOfAny = (id: string): number | null => {
    const inFiltered = ordinalOf(id)
    if (inFiltered !== null) return inFiltered
    const fullIndex = sorted.findIndex((row) => row.id === id)
    return fullIndex < 0 ? null : fullIndex + 1
  }
  void byId

  const entries: ListEntry[] = filtered.map((row) => ({
    row,
    ordinal: ordinalOf(row.id) ?? 0,
    mark: MARK[row.status],
    statusText: statusTextFor(row, ordinalOfAny),
  }))

  const recycleCount = countRecycle(
    dao.listByStatuses(db, { statuses: ['deleted_soft'], projectKey: ctx.projectKey }),
  )

  // 空态区分：完全没记忆 vs 筛选后为空（PC-36 / §5.7）
  let emptyText: string | null = null
  if (entries.length === 0) {
    const hasAny = all.length > 0
    emptyText = hasAny ? null : TEXT.empty
  }

  return { counts, entries, recycleCount, emptyText }
}

export interface ViewBEntry extends ListEntry {
  /** 移除原因（D-8 X-6：「别记」要标注「因用户要求不保留」）。 */
  readonly removeReason: string
  /** 剩余保留天数；配置为不过期时为 null（D-8 X-4：此时 UI 不得出现天数）。 */
  readonly remainingDays: number | null
}

/** V-B 回收站。 */
export function listB(db: Db, ctx: ListContext, retentionDays: number | null, now: number): ViewBEntry[] {
  const rows = dao.listByStatuses(db, {
    statuses: ['deleted_soft'],
    projectKey: ctx.projectKey,
  })
  const sorted = sortRows(rows)
  return sorted.map((row, index) => {
    const reason = dao.findRemoveReason(db, row.id)
    const removeReason =
      reason === 'user_asked_not_to_keep' ? TEXT.rejectedNotKept : TEXT.deletedByUser
    let remainingDays: number | null = null
    if (retentionDays !== null && row.deletedAt !== null) {
      const elapsed = Math.floor((now - row.deletedAt) / 86_400_000)
      remainingDays = Math.max(0, retentionDays - elapsed)
    }
    return {
      row,
      ordinal: index + 1,
      mark: MARK[row.status],
      statusText: `已删除（可恢复 · ${removeReason}）`,
      removeReason,
      remainingDays,
    }
  })
}

export interface ViewCResult {
  /** 直接进 V-C 时的"选条目"列表（PC-35：不得提供全局时间线）。 */
  readonly choices: readonly { memoryId: string; content: string; status: Status; versions: number }[]
  /** 选定某条目后的版本链（按时间正序）。 */
  readonly chain: readonly ChangeRow[]
  readonly current: MemoryRow | null
}

/**
 * V-C 变更记录。
 *
 * @param memoryId 选定的条目。为 null 时只返回"选条目"列表 ——
 *   这是 PC-35「必须先选定条目、不得提供全局时间线」的实现。
 */
export function listC(db: Db, ctx: ListContext, memoryId: string | null): ViewCResult {
  const choices = sortRows(
    dao.listByStatuses(db, { statuses: ['active', 'superseded', 'expired'], projectKey: ctx.projectKey }),
  ).map((row) => ({
    memoryId: row.id,
    content: row.content ?? '',
    status: row.status,
    versions: dao.listChanges(db, row.id).length,
  }))

  if (memoryId === null) return { choices, chain: [], current: null }

  const row = dao.getById(db, memoryId)
  if (row === null || row.status === 'deleted_hard') {
    // 硬删条目的版本链也不可见（AC-5 / PB-6）
    return { choices, chain: [], current: null }
  }
  return { choices, chain: dao.listChanges(db, memoryId), current: row }
}

/** 筛选标签（首行回显，D-8 X-2）。 */
export function filterLabelOf(filter: Filter | null): string | null {
  return describeFilter(filter)
}

/** 供自测断言：三视图导出集合。 */
export const VIEW_EXPORTS = ['listA', 'listB', 'listC'] as const

/** 作用域/分层的中文名（面板与对话共用）。 */
export const SCOPE_NAME: Record<Scope, string> = { project: '项目', user: '用户' }
export const LAYER_NAME: Record<Layer, string> = { semantic: '语义', episodic: '情景' }
