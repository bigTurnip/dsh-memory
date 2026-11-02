/**
 * 状态机：5 状态 / 9 转换（`tech-design.md` §6.2）。
 *
 * **所有状态变更只能经 `transition()`** —— 它同时写 `memory_changes`（V-C）。
 * 这条纪律让"改了状态但忘了留变更记录"在结构上不可能发生。
 *
 * 九转换与 AC 的对应：
 *   T-1 ∅→active        AC-1
 *   T-2 active→superseded AC-2 / AC-3（旧覆盖，不回滚）
 *   T-3 active→expired  AC-4（仅情景层）
 *   T-4 expired→active  AC-4（用户恢复，重新计时）
 *   T-5 →deleted_soft   AC-5（默认档）
 *   T-6 deleted_soft→原状态 AC-5（撤销 / 回收站恢复）
 *   T-7 deleted_soft→deleted_hard（彻底删除 / 保留期届满）
 *   T-8 任意非硬删→deleted_hard（隐私删除，二次确认）
 *   T-9 deleted_hard→∅ （终态，代码里没有分支）
 */

import type { Db } from '../db/index.js'
import * as dao from '../db/dao.js'
import type { ChangeReason, MemoryRow, Status } from '../../shared/contract.js'

/** 状态元数据（可见性矩阵的程序化表达）。 */
export const STATUS_META: Record<Status, { retrievable: boolean; inListA: boolean; terminal: boolean }> = {
  active: { retrievable: true, inListA: true, terminal: false },
  superseded: { retrievable: false, inListA: true, terminal: false },
  expired: { retrievable: false, inListA: true, terminal: false },
  deleted_soft: { retrievable: false, inListA: false, terminal: false },
  deleted_hard: { retrievable: false, inListA: false, terminal: true },
}

/** 允许的转换表。**不在表里的一律拒绝**（防止手滑写出 T-9 之外的回退）。 */
const ALLOWED: Record<Status, readonly Status[]> = {
  // 新建用 create()，不走 transition；但恢复正常也会进 active，所以这里放开。
  active: ['superseded', 'expired', 'deleted_soft', 'deleted_hard'],
  superseded: ['deleted_soft', 'deleted_hard'],
  expired: ['active', 'deleted_soft', 'deleted_hard'],
  deleted_soft: ['active', 'superseded', 'expired', 'deleted_hard'],
  deleted_hard: [], // T-9：终态
}

export interface TransitionContext {
  readonly actor: 'user' | 'system'
  readonly reason: ChangeReason
  readonly at: number
  readonly detail?: Record<string, unknown>
  /** 新 id 生成器（测试可注入确定性序列）。 */
  readonly nextId: () => string
  /** T-7/T-8 时是否抹除内容。 */
  readonly scrub?: boolean
  readonly supersededBy?: string | null
  readonly expiresAt?: number | null
}

/**
 * 执行一次状态转换。
 *
 * @throws 当转换不在允许表里（含"从终态出发"与"状态没变"）。
 */
export function transition(db: Db, id: string, to: Status, ctx: TransitionContext): MemoryRow {
  const row = dao.getById(db, id)
  if (row === null) throw new Error(`transition: 条目不存在（id=${id}）`)
  const from = row.status

  if (from === to) {
    throw new Error(`transition: 状态未变化（id=${id}，status=${from}）—— 幂等由调用方保证，不要空转`)
  }
  if (STATUS_META[from].terminal) {
    throw new Error(`transition: 条目已是终态（id=${id}，status=${from}），不可再转换`)
  }
  if (!ALLOWED[from].includes(to)) {
    throw new Error(`transition: 不允许的转换 ${from} → ${to}（id=${id}）`)
  }

  if (to === 'deleted_hard' && ctx.scrub === true) {
    // T-8 隐私硬删：抹掉一切可识别信息，并清 FTS
    dao.scrubToHardDeleted(db, id, ctx.at)
  } else {
    dao.updateStatus(db, id, to, {
      supersededBy: ctx.supersededBy ?? null,
      deletedAt: to === 'deleted_soft' ? ctx.at : null,
      expiresAt: to === 'expired' ? (row.expiresAt ?? null) : ctx.expiresAt ?? null,
    })
  }

  dao.insertChange(db, {
    id: ctx.nextId(),
    memoryId: id,
    fromStatus: from,
    toStatus: to,
    reason: ctx.reason,
    actor: ctx.actor,
    at: ctx.at,
    detail: ctx.detail ?? null,
  })

  const updated = dao.getById(db, id)
  if (updated === null) throw new Error(`transition: 转换后读不到条目（id=${id}）`)
  return updated
}

/**
 * 恢复前状态（T-6）。
 *
 * 从 `memory_changes` 里找**最近一次进入 deleted_soft 的那条**记录的 `from_status`，
 * 精确还原。不用"猜"（例如"猜它原来是 active"）—— 软删的可能是已过期条目。
 */
export function previousStatusOf(db: Db, id: string): Status {
  const changes = dao.listChanges(db, id)
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i]!
    if (change.toStatus === 'deleted_soft') return change.fromStatus
  }
  throw new Error(`previousStatusOf: 找不到进入 deleted_soft 的记录（id=${id}）`)
}

/**
 * 过期扫描（T-3）。**只碰 active + episodic**（I-4 / I-5）。
 *
 * 幂等：重复跑不会产生重复 change 记录，因为 transition 会因状态未变而抛错，
 * 而调用方（下面的 sweepExpired）用 active 集合作为输入，转换后的条目自然不在集合里。
 */
export function sweepExpired(db: Db, now: number, nextId: () => string): number {
  const ids = dao.findExpirable(db, now)
  let count = 0
  for (const id of ids) {
    try {
      transition(db, id, 'expired', { actor: 'system', reason: 'expire', at: now, nextId })
      count += 1
    } catch {
      // 并发的另一次扫描可能已经处理过；跳过即可
    }
  }
  return count
}

/**
 * 回收站清理（T-7）。`retentionDays` 为 null 时**不清理**（D-5 Q2 允许的形态）。
 *
 * 注意：若 retentionDays 为 null，UI 文案必须同步去掉天数（D-8 X-4），
 * 这条由自测 HC-10 检查。
 */
export function sweepRecycle(
  db: Db,
  now: number,
  retentionDays: number | null,
  nextId: () => string,
): number {
  if (retentionDays === null) return 0
  const cutoff = now - retentionDays * 86_400_000
  const ids = dao.findRecyclable(db, cutoff)
  let count = 0
  for (const id of ids) {
    try {
      transition(db, id, 'deleted_hard', {
        actor: 'system',
        reason: 'hard_delete',
        at: now,
        nextId,
        scrub: true,
      })
      count += 1
    } catch {
      // 同上
    }
  }
  return count
}
