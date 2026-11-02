/**
 * memories / memory_changes / memory_audit 的读写。
 *
 * 这一层只做「行 ↔ 对象」的搬运与 SQL，**不含业务判断**：
 * 状态能不能这么转、档位该不该硬删，都在 domain 里。
 *
 * FTS 同步在这里显式做（不用触发器，理由见 schema.ts 头注）。
 */

import type { Db } from './index.js'
import type {
  ChangeRow,
  ChangeReason,
  Layer,
  MemoryRow,
  Scope,
  Sensitivity,
  SourceRef,
  SourceType,
  Status,
} from '../../shared/contract.js'
import { tokenize } from '../../shared/retrieval-score.js'

export interface RawRow {
  id: string
  layer: string
  content: string | null
  scope: string
  project_key: string | null
  source_type: string
  source_ref: string
  created_at: number
  confirmed_at: number
  status: string
  superseded_by: string | null
  expires_at: number | null
  reuse_count: number
  last_hit_at: number | null
  sensitivity: string
  deleted_at: number | null
  tokens: string
  rowid: number
}

function parseSourceRef(text: string): SourceRef {
  try {
    const parsed = JSON.parse(text) as Partial<SourceRef>
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      turnSeq: typeof parsed.turnSeq === 'number' ? parsed.turnSeq : 0,
      snippet: typeof parsed.snippet === 'string' ? parsed.snippet : '',
      at: typeof parsed.at === 'number' ? parsed.at : 0,
      eventPhrase: typeof parsed.eventPhrase === 'string' ? parsed.eventPhrase : '',
    }
  } catch {
    return { sessionId: '', turnSeq: 0, snippet: '', at: 0, eventPhrase: '' }
  }
}

export function toMemory(raw: RawRow): MemoryRow {
  return {
    id: raw.id,
    layer: raw.layer as Layer,
    content: raw.content,
    scope: raw.scope as Scope,
    projectKey: raw.project_key,
    sourceType: raw.source_type as SourceType,
    sourceRef: parseSourceRef(raw.source_ref),
    createdAt: raw.created_at,
    confirmedAt: raw.confirmed_at,
    status: raw.status as Status,
    supersededBy: raw.superseded_by,
    expiresAt: raw.expires_at,
    reuseCount: raw.reuse_count,
    lastHitAt: raw.last_hit_at,
    sensitivity: raw.sensitivity as Sensitivity,
    deletedAt: raw.deleted_at,
  }
}

const SELECT_ALL = 'SELECT rowid, * FROM memories'

/** 按 id 取一条（含任何状态的内部读取；对外视图必须自己过滤）。 */
export function getById(db: Db, id: string): MemoryRow | null {
  const raw = db.raw.prepare(`${SELECT_ALL} WHERE id = ?`).get(id) as RawRow | undefined
  return raw === undefined ? null : toMemory(raw)
}

/** 取一条的 rowid（FTS 同步用）。 */
function rowidOf(db: Db, id: string): number | null {
  const raw = db.raw.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as
    | { rowid: number }
    | undefined
  return raw?.rowid ?? null
}

export interface InsertInput {
  readonly id: string
  readonly layer: Layer
  readonly content: string
  readonly scope: Scope
  readonly projectKey: string | null
  readonly sourceType: SourceType
  readonly sourceRef: SourceRef
  readonly createdAt: number
  readonly confirmedAt: number
  readonly status: Status
  readonly expiresAt: number | null
  readonly sensitivity: Sensitivity
}

/** 插入一条并同步 FTS。 */
export function insert(db: Db, input: InsertInput): void {
  db.raw
    .prepare(
      `INSERT INTO memories
        (id, layer, content, scope, project_key, source_type, source_ref,
         created_at, confirmed_at, status, superseded_by, expires_at,
         reuse_count, last_hit_at, sensitivity, deleted_at, tokens)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,0,NULL,?,NULL,?)`,
    )
    .run(
      input.id,
      input.layer,
      input.content,
      input.scope,
      input.projectKey,
      input.sourceType,
      JSON.stringify(input.sourceRef),
      input.createdAt,
      input.confirmedAt,
      input.status,
      input.expiresAt,
      input.sensitivity,
      // 预计算 token：正文 + 来源事件短语 + 摘录，一次算好
      tokenize(`${input.content} ${input.sourceRef.eventPhrase} ${input.sourceRef.snippet}`).join(' '),
    )
  syncFts(db, input.id, input.content, input.sourceRef)
}

/** 重写一条的 FTS 行（先删后插；内容为 null 时只删）。 */
export function syncFts(db: Db, id: string, content: string | null, sourceRef?: SourceRef): void {
  if (!db.ftsAvailable) return
  const rowid = rowidOf(db, id)
  if (rowid === null) return
  db.raw.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid)
  if (content === null || content === '') return
  const text = sourceRef === undefined ? content : `${content} ${sourceRef.eventPhrase} ${sourceRef.snippet}`
  const tokens = tokenize(text).join(' ')
  if (tokens === '') return
  db.raw.prepare('INSERT INTO memories_fts(rowid, tokens) VALUES (?,?)').run(rowid, tokens)
}

/** 更新状态与相关字段（**只由 domain 的 transition 调用**）。 */
export function updateStatus(
  db: Db,
  id: string,
  status: Status,
  patch: {
    supersededBy?: string | null
    deletedAt?: number | null
    expiresAt?: number | null
  } = {},
): void {
  db.raw
    .prepare(
      `UPDATE memories SET
         status = ?,
         superseded_by = COALESCE(?, superseded_by),
         deleted_at = ?,
         expires_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      patch.supersededBy ?? null,
      patch.deletedAt ?? null,
      patch.expiresAt ?? null,
      id,
    )
  // 状态变化可能伴随内容清除（硬删），由调用方在需要时再 syncFts
}

/** 改正文（编辑路径）。 */
export function updateContent(db: Db, id: string, content: string, confirmedAt: number): void {
  const row = getById(db, id)
  const tokens = tokenize(`${content} ${row?.sourceRef.eventPhrase ?? ''} ${row?.sourceRef.snippet ?? ''}`).join(' ')
  db.raw
    .prepare('UPDATE memories SET content = ?, confirmed_at = ?, tokens = ? WHERE id = ?')
    .run(content, confirmedAt, tokens, id)
  syncFts(db, id, content, row?.sourceRef)
}

/** 改作用域（编辑路径的一部分）。 */
export function updateScope(
  db: Db,
  id: string,
  scope: Scope,
  projectKey: string | null,
  confirmedAt: number,
): void {
  db.raw
    .prepare('UPDATE memories SET scope = ?, project_key = ?, confirmed_at = ? WHERE id = ?')
    .run(scope, projectKey, confirmedAt, id)
}

/** 记录一次命中（只有检索实际采用时调，DC-23）。 */
export function recordHit(db: Db, id: string, at: number): void {
  db.raw
    .prepare('UPDATE memories SET reuse_count = reuse_count + 1, last_hit_at = ? WHERE id = ?')
    .run(at, id)
}

/**
 * 隐私硬删（T-8）：抹掉一切可识别信息，**不删行**。
 *
 * 为什么不 DELETE：`memory_changes` 外键指向它，且"审计只留发生过一次隐私删除"
 * 需要一个锚点。但内容类字段必须全 NULL，且清掉 FTS 行 —— 否则还能被搜到，
 * 那就是 AC-5 的直接违反。
 */
export function scrubToHardDeleted(db: Db, id: string, at: number): void {
  db.raw
    .prepare(
      `UPDATE memories SET
         status = 'deleted_hard',
         content = NULL,
         source_ref = '{}',
         superseded_by = NULL,
         expires_at = NULL,
         project_key = NULL,
         scope = 'user',
         reuse_count = 0,
         last_hit_at = NULL,
         sensitivity = 'restricted',
         deleted_at = ?,
         tokens = ''
       WHERE id = ?`,
    )
    .run(at, id)
  syncFts(db, id, null)
}

export interface ListOptions {
  readonly statuses: readonly Status[]
  readonly projectKey: string | null
  /** 是否包含 user 级（默认 true）。 */
  readonly includeUser?: boolean
}

/**
 * 按状态集合取行。
 *
 * **注意**：这是给**视图**用的（V-A / V-B），不是检索。
 * 检索的候选集在 `domain/retrieve.ts` 里另有唯一实现（I-2 的要求）。
 */
export function listByStatuses(db: Db, options: ListOptions): MemoryRow[] {
  const includeUser = options.includeUser ?? true
  const statuses = options.statuses
  if (statuses.length === 0) return []
  const placeholders = statuses.map(() => '?').join(',')
  const scopeClause = includeUser
    ? `(scope = 'user' OR (scope = 'project' AND project_key = ?))`
    : `(scope = 'project' AND project_key = ?)`
  const rows = db.raw
    .prepare(`${SELECT_ALL} WHERE status IN (${placeholders}) AND ${scopeClause}`)
    .all(...statuses, options.projectKey) as unknown as RawRow[]
  return rows.map(toMemory)
}

/** 取全部硬删以外的行（自测与诊断用；生产视图不要用它）。 */
export function listAll(db: Db): MemoryRow[] {
  const rows = db.raw.prepare(`${SELECT_ALL} WHERE status != 'deleted_hard'`).all() as unknown as RawRow[]
  return rows.map(toMemory)
}

/**
 * FTS 全文查询，返回 id → 排名（越小越相关）。
 *
 * `extraTokens` 用于一次性并入同义展开的 token：**一次 MATCH 扫全部**，
 * 而不是每个变体各查一次。后者在 1 万条下是 16 次全表 MATCH（实测 40ms+），
 * 前者是 1 次（~3ms），召回完全等价（OR 语义相同）。
 */
export function searchFts(db: Db, query: string, extraTokens: readonly string[] = []): Map<string, number> {
  const result = new Map<string, number>()
  if (!db.ftsAvailable) return result
  const tokens = [...new Set([...tokenize(query), ...extraTokens])]
  if (tokens.length === 0) return result
  // 用 OR 连接：召回优先，精排负责把不相关的压下去。
  // 上限保护：表达式过长会拖慢解析，取前 64 个（覆盖已远超必要召回面）。
  const expression = tokens
    .slice(0, 64)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ')
  try {
    const rows = db.raw
      .prepare(
        `SELECT m.id AS id, bm25(memories_fts) AS rank
           FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
          WHERE memories_fts MATCH ?
          ORDER BY rank
          LIMIT 500`,
      )
      .all(expression) as Array<{ id: string; rank: number }>
    rows.forEach((row, index) => result.set(row.id, index))
  } catch {
    // MATCH 语法错误（例如全是标点）不致命，退化为纯字面通道
  }
  return result
}

/** 写一条变更记录（V-C）。 */
export function insertChange(
  db: Db,
  input: {
    id: string
    memoryId: string
    fromStatus: Status
    toStatus: Status
    reason: ChangeReason
    actor: 'user' | 'system'
    at: number
    detail: Record<string, unknown> | null
  },
): void {
  db.raw
    .prepare(
      `INSERT INTO memory_changes(id, memory_id, from_status, to_status, reason, actor, at, detail)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.id,
      input.memoryId,
      input.fromStatus,
      input.toStatus,
      input.reason,
      input.actor,
      input.at,
      input.detail === null ? null : JSON.stringify(input.detail),
    )
}

/** 取某条目的版本链（V-C，按时间正序）。 */
export function listChanges(db: Db, memoryId: string): ChangeRow[] {
  const rows = db.raw
    .prepare('SELECT * FROM memory_changes WHERE memory_id = ? ORDER BY at ASC')
    .all(memoryId) as Array<{
    id: string
    memory_id: string
    from_status: string
    to_status: string
    reason: string
    actor: string
    at: number
    detail: string | null
  }>
  return rows.map((raw) => ({
    id: raw.id,
    memoryId: raw.memory_id,
    fromStatus: raw.from_status as Status,
    toStatus: raw.to_status as Status,
    reason: raw.reason as ChangeReason,
    actor: raw.actor as 'user' | 'system',
    at: raw.at,
    detail: raw.detail === null ? null : (JSON.parse(raw.detail) as Record<string, unknown>),
  }))
}

/** 写审计（O-1~O-4）。**硬删路径 memoryId 必须传 null**。 */
export function audit(
  db: Db,
  input: {
    id: string
    at: number
    op: string
    outcome: string
    memoryId: string | null
    meta: Record<string, unknown> | null
  },
): void {
  db.raw
    .prepare('INSERT INTO memory_audit(id, at, op, outcome, memory_id, meta) VALUES (?,?,?,?,?,?)')
    .run(
      input.id,
      input.at,
      input.op,
      input.outcome,
      input.memoryId,
      input.meta === null ? null : JSON.stringify(input.meta),
    )
}

export function listAudit(db: Db, limit = 200): Array<Record<string, unknown>> {
  const rows = db.raw.prepare('SELECT * FROM memory_audit ORDER BY at DESC LIMIT ?').all(limit) as Array<
    Record<string, unknown>
  >
  return rows
}

/** 取某条目的变更原因为"用户要求不保留"的记录（回收站标注用，D-8 X-6）。 */
export function findRemoveReason(db: Db, memoryId: string): ChangeReason | null {
  const row = db.raw
    .prepare(
      `SELECT reason FROM memory_changes
        WHERE memory_id = ? AND reason IN ('delete','user_asked_not_to_keep')
        ORDER BY at DESC LIMIT 1`,
    )
    .get(memoryId) as { reason: string } | undefined
  return row === undefined ? null : (row.reason as ChangeReason)
}

/** 过期扫描：只取 active + episodic + 到期。**语义层永不进入**（I-4）。 */
export function findExpirable(db: Db, now: number): string[] {
  const rows = db.raw
    .prepare(
      `SELECT id FROM memories
        WHERE status = 'active' AND layer = 'episodic' AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .all(now) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

/** 回收站扫描：软删且超过保留期。 */
export function findRecyclable(db: Db, cutoff: number): string[] {
  const rows = db.raw
    .prepare(
      `SELECT id FROM memories
        WHERE status = 'deleted_soft' AND deleted_at IS NOT NULL AND deleted_at <= ?`,
    )
    .all(cutoff) as Array<{ id: string }>
  return rows.map((row) => row.id)
}
