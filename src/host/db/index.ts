/**
 * SQLite 连接与事务。
 *
 * 运行环境要求（`tech-design.md` §10.1 F-13，**实测结论**）：
 * 系统 node v23 的 `node:sqlite` 是 3.47.2 但**没有编译 FTS5**（`create virtual table ... using fts5`
 * 报 `no such module: fts5`）；宿主运行时 v24.21.0 **有** FTS5。
 * 所以所有自测必须用宿主运行时跑：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" ...
 *
 * FTS5 缺失时本模块**不静默降级**，而是把 `ftsAvailable=false` 暴露出来，
 * 由检索层只走字面通道 —— 这样在系统 node 上跑单元测试也能工作，
 * 但厂商环境下自测会用断言确认 FTS 真的可用（否则 AC-10 的预算假设不成立）。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DDL, DEFAULT_SETTINGS } from './schema.js'

export interface Db {
  readonly raw: DatabaseSync
  readonly ftsAvailable: boolean
  close(): void
}

/** 打开（或创建）库并建表。`path=':memory:'` 用于单测。 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new DatabaseSync(path)
  // 事务安全：WAL 在内存库上无效但不报错，直接执行无妨
  raw.exec(DDL)

  let ftsAvailable = true
  try {
    raw.prepare('SELECT count(*) FROM memories_fts').get()
  } catch {
    ftsAvailable = false
  }

  const db: Db = { raw, ftsAvailable, close: () => raw.close() }

  // 播种默认设置（只在缺失时写，不覆盖用户改过的值）
  const insert = raw.prepare('INSERT OR IGNORE INTO memory_settings(key,value) VALUES (?,?)')
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value)

  return db
}

/**
 * 在一个事务里执行。失败整体回滚。
 *
 * 用 `BEGIN IMMEDIATE` 而不是裸 `BEGIN`：写入路径要先拿写锁，
 * 避免两个写入在提交时才发现冲突然后重试（记忆写入是短事务，等锁成本很低）。
 *
 * 注意：**不支持嵌套**。所有 domain 写操作都在最外层开事务，
 * 内部函数只接受 `Db`，不自己开事务 —— 这条纪律让"忘记回滚"不可能发生。
 */
export function transact<T>(db: Db, fn: () => T): T {
  db.raw.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.raw.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.raw.exec('ROLLBACK')
    } catch {
      // 回滚失败（例如连接已断）不掩盖原始错误
    }
    throw error
  }
}

/** 读一个设置值（字符串）。 */
export function getSetting(db: Db, key: string): string | null {
  const row = db.raw.prepare('SELECT value FROM memory_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/** 写一个设置值。 */
export function setSetting(db: Db, key: string, value: string): void {
  db.raw
    .prepare(
      'INSERT INTO memory_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value)
}

/** 布尔设置。 */
export function getFlag(db: Db, key: string): boolean {
  const value = getSetting(db, key)
  return value === '1' || value === 'true'
}

/** 数字设置，缺失或非法时用默认值。 */
export function getNumber(db: Db, key: string, fallback: number): number {
  const value = getSetting(db, key)
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 保留期（天）。`null` = 不过期。
 *
 * **D-8 X-4**：这个值与 UI 文案强绑定。若为 null，UI 不得出现任何天数；
 * 自测 HC-10 会在 null 配置下检查文案里没有天数。
 */
export function getRetentionDays(db: Db): number | null {
  const value = getSetting(db, 'retention_days')
  if (value === null || value === '' || value === 'null') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
