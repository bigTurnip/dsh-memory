/**
 * 管理操作：编辑 / 软删 / 硬删 / 恢复 / 批量遗忘（`tech-design.md` §7.2 / §7.3）。
 *
 * ## 为什么 `layer` 不在编辑入参里（D-5 Q3 / HC-6）
 * `EditInput` **没有** `layer` 字段。改分层在类型层就不可表达 ——
 * 想加回它必须先改这个 interface，而改它会立刻让 `manage.edit()` 的实现编译失败。
 * 这比写一个 `if (input.layer) throw` 强：后者会被"顺手加个参数"绕过。
 *
 * ## 为什么档位不在这里判断
 * 档位由 `shared/delete-tier.ts: decideDeleteTier()` 决定（D-8 X-1），
 * 且面板的「删除」按钮**直接调 softDelete()** —— 它没有 hard 的分支可走。
 * 硬删只能经 `hardDelete()`，而它强制要求一个 confirm token（两步协议在 API 层就存在）。
 */

import type { Db } from '../db/index.js'
import { getNumber } from '../db/index.js'
import * as dao from '../db/dao.js'
import { previousStatusOf, transition } from './state.js'
import type { MemoryRow, Scope } from '../../shared/contract.js'
import type { ChangeReason } from '../../shared/contract.js'

export interface ManageDeps {
  readonly db: Db
  readonly now: number
  readonly nextId: () => string
  readonly projectKey: string | null
}

/**
 * 编辑入参。**注意：没有 layer 字段**（D-5 Q3）。
 *
 * 这是刻意的类型设计，不是遗漏。见文件头注。
 */
export interface EditInput {
  readonly id: string
  readonly content?: string
  readonly scope?: Scope
}

/**
 * 编辑一条记忆。
 *
 * 行为（与对话通道一致，S-2）：
 * - 内容变化 → 旧条目标 `已修正`、新建 `生效`（AC-2 / AC-3）；
 * - 作用域变化 → 记一条变更记录（DC-27：只追加）；
 * - **当次会话内立即可检索**（DC-26）：因为写在同一事务里，无异步延迟。
 */
export function edit(deps: ManageDeps, input: EditInput): { updated: MemoryRow; superseded: MemoryRow | null } {
  const { db, now, nextId, projectKey } = deps
  const row = dao.getById(db, input.id)
  if (row === null) throw new Error(`edit: 条目不存在（id=${input.id}）`)
  if (row.status === 'deleted_soft') {
    throw new Error('edit: 该条目已在回收站，先恢复再改')
  }
  if (row.status === 'deleted_hard') throw new Error('edit: 该条目已彻底删除')
  if (row.content === null) throw new Error('edit: 该条目内容已抹除')

  const contentChanged = input.content !== undefined && input.content.trim() !== row.content
  const scopeChanged = input.scope !== undefined && input.scope !== row.scope

  if (!contentChanged && !scopeChanged) {
    return { updated: row, superseded: null }
  }

  // 作用域变更：直接改（不需要新建版本），留一条 change
  if (scopeChanged) {
    if (input.scope === 'project' && projectKey === null) {
      throw new Error('edit: 升为项目级需要工作目录，但当前取不到')
    }
    dao.updateScope(
      db,
      input.id,
      input.scope!,
      input.scope === 'project' ? projectKey : null,
      now,
    )
    dao.insertChange(db, {
      id: nextId(),
      memoryId: input.id,
      fromStatus: row.status,
      toStatus: row.status,
      reason: 'scope_change',
      actor: 'user',
      at: now,
      detail: { from: row.scope, to: input.scope },
    })
  }

  // 内容变更：旧 → 已修正，新 → 生效（AC-3 的"只返回一个确定性答案"）
  if (contentChanged) {
    const latest = dao.getById(db, input.id)!
    const newId = nextId()
    dao.insert(db, {
      id: newId,
      layer: latest.layer,
      content: input.content!.trim(),
      scope: latest.scope,
      projectKey: latest.projectKey,
      sourceType: 'explicit',
      sourceRef: { ...latest.sourceRef, at: now, eventPhrase: '你在面板或对话里修改了这条' },
      createdAt: now,
      confirmedAt: now,
      status: 'active',
      expiresAt: latest.layer === 'episodic' ? latest.expiresAt : null,
      sensitivity: latest.sensitivity,
    })
    const superseded = transition(db, input.id, 'superseded', {
      actor: 'user',
      reason: 'edit',
      at: now,
      nextId,
      supersededBy: newId,
      detail: { replacedBy: newId, editedVia: 'user' },
    })
    dao.audit(db, {
      id: nextId(),
      at: now,
      op: 'update',
      outcome: 'ok',
      memoryId: newId,
      meta: { kind: 'content', replaced: input.id },
    })
    const created = dao.getById(db, newId)!
    return { updated: created, superseded }
  }

  return { updated: dao.getById(db, input.id)!, superseded: null }
}

/**
 * 普通删除（T-5，默认档）。
 *
 * 面板「删除」按钮与对话「删掉第 N 条」「忘掉第 N 条」都走这里（S-2 / D-8 X-1）。
 */
export function softDelete(deps: ManageDeps, id: string, reason: ChangeReason = 'delete'): MemoryRow {
  const { db, now, nextId } = deps
  const row = dao.getById(db, id)
  if (row === null) throw new Error(`softDelete: 条目不存在（id=${id}）`)
  if (row.status === 'deleted_soft') throw new Error('softDelete: 该条目已在回收站')
  if (row.status === 'deleted_hard') throw new Error('softDelete: 该条目已彻底删除')

  const updated = transition(db, id, 'deleted_soft', {
    actor: 'user',
    reason,
    at: now,
    nextId,
  })
  dao.audit(db, {
    id: nextId(),
    at: now,
    op: 'delete',
    outcome: 'ok',
    memoryId: id,
    meta: { tier: 'soft', reason },
  })
  return updated
}

/** 硬删的两步协议：先 prepare（回显目标），再 execute（带 token）。 */
const confirmTokens = new WeakMap<Db, Map<string, number>>()

function tokenStore(db: Db): Map<string, number> {
  let store = confirmTokens.get(db)
  if (store === undefined) {
    store = new Map()
    confirmTokens.set(db, store)
  }
  return store
}

/**
 * 第一步：准备硬删，返回回显信息与 confirm token。
 *
 * 这是 DC-20「模糊肯定不视为确认」与 DC-17「回显正文」在 API 层的落地：
 * 没有 token 就调不了 `hardDelete()`。
 */
export function prepareHardDelete(
  deps: ManageDeps,
  id: string,
): { token: string; echo: MemoryRow } {
  const { db, nextId } = deps
  const row = dao.getById(db, id)
  if (row === null) throw new Error(`prepareHardDelete: 条目不存在（id=${id}）`)
  if (row.status === 'deleted_hard') throw new Error('prepareHardDelete: 该条目已彻底删除')
  const token = nextId()
  tokenStore(db).set(token, Date.now())
  return { token, echo: row }
}

/**
 * 第二步：执行硬删（T-7 或 T-8）。
 *
 * @param token 必须来自 `prepareHardDelete()`，否则拒绝。
 */
export function hardDelete(deps: ManageDeps, id: string, token: string): MemoryRow {
  const { db, now, nextId } = deps
  const store = tokenStore(db)
  if (!store.has(token)) {
    throw new Error('hardDelete: 缺少有效的确认令牌（必须先 prepareHardDelete 回显目标并二次确认）')
  }
  store.delete(token)

  const row = dao.getById(db, id)
  if (row === null) throw new Error(`hardDelete: 条目不存在（id=${id}）`)
  if (row.status === 'deleted_hard') throw new Error('hardDelete: 已是终态')

  const updated = transition(db, id, 'deleted_hard', {
    actor: 'user',
    reason: 'hard_delete',
    at: now,
    nextId,
    scrub: true,
  })
  // AC-5 第 4 条：审计只留"发生过一次隐私删除"，**不记标识、不记正文**
  dao.audit(db, {
    id: nextId(),
    at: now,
    op: 'hard_delete',
    outcome: 'ok',
    memoryId: null,
    meta: { count: 1 },
  })
  return updated
}

/**
 * 恢复后的重新计时天数。
 *
 * 与写入侧 `expiresAtFor()` 共用 `episodic_retention_days`：之前这里硬编码 30 天，
 * 会让「过期按配置、恢复按 30 天」变成两套时钟 —— 把配置改成 7 天后，用户恢复出来的
 * 条目 30 天后才过期，与清单文案说的 7 天自相矛盾。
 */
function reArmDays(db: Db): number {
  const configured = getNumber(db, 'episodic_retention_days', 30)
  return configured > 0 ? configured : 30
}

/**
 * 恢复（T-6 / T-4）。
 *
 * - 软删 → 回到**删除前状态**（`previousStatusOf`，不猜）；
 * - 已过期 → 回 active，**重新计时 30 天**（D-5 Q4）。
 */
export function restore(deps: ManageDeps, id: string): MemoryRow {
  const { db, now, nextId, projectKey } = deps
  const row = dao.getById(db, id)
  if (row === null) throw new Error(`restore: 条目不存在（id=${id}）`)

  if (row.status === 'deleted_soft') {
    const target = previousStatusOf(db, id)
    const updated = transition(db, id, target, {
      actor: 'user',
      reason: 'restore',
      at: now,
      nextId,
      expiresAt: target === 'active' && row.layer === 'episodic' ? now + reArmDays(db) * 86_400_000 : null,
    })
    dao.audit(db, { id: nextId(), at: now, op: 'restore', outcome: 'ok', memoryId: id, meta: { to: target } })
    return updated
  }

  if (row.status === 'expired') {
    void projectKey
    const updated = transition(db, id, 'active', {
      actor: 'user',
      reason: 'restore',
      at: now,
      nextId,
      // D-5 Q4：恢复已过期条目后重新计时。
      // 语义层给 null：DDL 的 CHECK(expires_at IS NULL OR layer='episodic') 会拒绝
      // 给语义条目写过期时间（历史夹具里确实存在被标过期的语义条目）。
      expiresAt: row.layer === 'episodic' ? now + reArmDays(db) * 86_400_000 : null,
    })
    dao.audit(db, { id: nextId(), at: now, op: 'restore', outcome: 'ok', memoryId: id, meta: { to: 'active' } })
    return updated
  }

  throw new Error(`restore: 该条目状态为 ${row.status}，不需要恢复`)
}

/**
 * 批量遗忘（F6）：**先预览后执行**（DC-22）。
 *
 * @param ids 预览时用户确认的集合（取消勾选 = 从集合里排除）。
 */
export function batchForget(deps: ManageDeps, ids: readonly string[]): MemoryRow[] {
  const { db, now, nextId } = deps
  const out: MemoryRow[] = []
  for (const id of ids) {
    const row = dao.getById(db, id)
    if (row === null || row.status === 'deleted_soft' || row.status === 'deleted_hard') continue
    out.push(softDelete(deps, id, 'delete'))
  }
  dao.audit(db, {
    id: nextId(),
    at: now,
    op: 'delete',
    outcome: 'ok',
    memoryId: null,
    meta: { tier: 'soft', count: out.length, batch: true },
  })
  return out
}
