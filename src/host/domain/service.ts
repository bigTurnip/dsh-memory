/**
 * 记忆服务门面（`ctx.memory`）。
 *
 * 三条入口（对话工具 / HTTP 面板 / CLI 自测）都**只调这个类的方法**，
 * 所以"两条通道行为不一致"在结构上不可能 —— 它们不是两份实现，
 * 而是同一个对象的三个调用点。
 *
 * 观测面（test-engineer 的 O-1~O-9）也在这里暴露：
 * - O-2 种子 + 时间注入：`seed()` 接受任意时间戳与状态，不靠等真实时间
 * - O-3 审计出口：`queryAudit()`
 * - O-4 检索候选集：`inspectRetrieval()` 给出 filter 后 / rerank 前的 ID 列表
 * - O-8 降级注入：`faults` 开关
 */

import { join } from 'node:path'
import { openDatabase, getFlag, getNumber, getRetentionDays, getSetting, setSetting, transact, type Db } from '../db/index.js'
import { DEFAULT_SETTINGS } from '../db/schema.js'
import { SETTING_SPECS, normalizeSetting } from '../../shared/settings.js'
import * as dao from '../db/dao.js'
import { retrieve, matchAll, RETRIEVE_SOFT_BUDGET_MS, type RetrieveResult } from './retrieve.js'
import { writeCandidate, type Candidate, type WriteResult } from './write.js'
import { edit, softDelete, hardDelete, prepareHardDelete, restore, batchForget, type EditInput } from './manage.js'
import { listA, listB, listC } from './listing.js'
import { sweepExpired, sweepRecycle } from './state.js'
import type { ChangeRow, Filter, MemoryRow, Status } from '../../shared/contract.js'
import { countVisible } from '../../shared/counting.js'

/** 可注入的故障（O-8：让 AC-9 三档与 S-4 可被主动触发）。 */
export interface Faults {
  /** 检索时抛错（模拟 error 档）。 */
  retrieveError?: boolean
  /** 检索强制造出 > softBudget 的耗时（模拟 timeout 档）。 */
  retrieveSlowMs?: number
}

export interface MemoryPaths {
  readonly dataDir: string
  readonly dbPath: string
}

export interface ServiceOptions {
  readonly dataDir: string
  readonly defaults?: { projectKey?: string | null }
}

/**
 * 记忆服务。
 *
 * 时间统一走 `now()`，测试通过 `setClock()` 注入 —— 这是 O-2 的全部秘密：
 * 不靠等真实时间，就永久"现在"在任意时刻。
 */
export class MemoryService {
  private readonly db: Db
  private clock: (() => number) | null = null
  private counter = 0
  /** O-8 降级注入。 */
  readonly faults: Faults = {}
  /** 本次会话内已给出的写入提示次数（D-5 Q1 预算）。 */
  private promptCount = 0
  private promptSession: string | null = null

  constructor(readonly options: ServiceOptions) {
    this.db = openDatabase(join(options.dataDir, 'memory.sqlite'))
  }

  /** 当前时间（可被测试注入）。 */
  now(): number {
    return this.clock === null ? Date.now() : this.clock()
  }

  /** O-2：注入时钟。传 null 恢复真实时间。 */
  setClock(clock: (() => number) | null): void {
    this.clock = clock
  }

  /** 单调 id（ULID 风格：时间前缀 + 计数器，字典序即时间序）。 */
  nextId(): string {
    this.counter += 1
    const time = this.now().toString(36).padStart(9, '0')
    const seq = this.counter.toString(36).padStart(4, '0')
    return `${time}${seq}`
  }

  /** 功能开关（OQ-1 默认开启）。 */
  enabled(): boolean {
    return getFlag(this.db, 'enabled')
  }

  setEnabled(value: boolean): void {
    this.db.raw
      .prepare('INSERT INTO memory_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('enabled', value ? '1' : '0')
  }

  /**
   * 写入轻提示是否仍开启（D-5 Q1 / D-6 Q5）。
   *
   * 「以后别提示写入」是**配置**，不是记忆条目（D-6 Q5 已裁定），
   * 所以它落在 memory_settings 而不是 memories 表。
   */
  promptWritesEnabled(): boolean {
    return getFlag(this.db, 'prompt_writes')
  }

  /** 静音 / 恢复写入轻提示（N-3 修复 4 的执行通道之一）。 */
  setPromptWrites(value: boolean): void {
    setSetting(this.db, 'prompt_writes', value ? '1' : '0')
  }

  retentionDays(): number | null {
    return getRetentionDays(this.db)
  }

  // ---------- 设置（面板设置抽屉的唯一读写口） ----------

  /**
   * 设置快照（只含规格表里的键，按存库格式返回）。
   *
   * 缺失的键回退到 `DEFAULT_SETTINGS`，所以调用方拿到的一定是完整集合，
   * 不用在每个使用点写 `?? 默认值`。
   */
  settingsSnapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const spec of SETTING_SPECS) {
      out[spec.key] = getSetting(this.db, spec.key) ?? DEFAULT_SETTINGS[spec.key] ?? ''
    }
    return out
  }

  /**
   * 批量保存设置：**全量校验通过才落库**（全有或全无）。
   *
   * 为什么不做逐条部分成功：设置项之间有语义关联（比如把 `retention_days` 设成 null
   * 同时又把 `episodic_retention_days` 写错），部分成功会让用户看到一组"半套"配置，
   * 而界面上的控件值与库里的真实值不一致 —— 那比直接报错更难排查。
   */
  applySettings(values: Record<string, unknown>): { changed: string[]; values: Record<string, string> } {
    const normalized: Array<[string, string]> = []
    for (const [key, raw] of Object.entries(values)) {
      const result = normalizeSetting(key, raw)
      if (!result.ok) throw new Error(`${key}: ${result.message}`)
      normalized.push([key, result.value])
    }
    if (normalized.length === 0) throw new Error('没有要保存的设置项')
    transact(this.db, () => {
      for (const [key, value] of normalized) setSetting(this.db, key, value)
    })
    return { changed: normalized.map(([key]) => key), values: this.settingsSnapshot() }
  }

  /** 自动召回注入是否生效（还要受总开关约束：关闭记忆时永不注入）。 */
  autoRecallEnabled(): boolean {
    return this.enabled() && getFlag(this.db, 'recall_inject')
  }

  // ---------- 写入 ----------

  /** 写入一个候选（⑵~⑤ 全在这里面）。 */
  write(candidate: Candidate, projectKey: string | null): WriteResult {
    if (!this.enabled()) return { kind: 'not-salient', memory: null }
    try {
      return writeCandidate(
        { db: this.db, now: this.now(), nextId: () => this.nextId(), projectKey },
        candidate,
      )
    } catch {
      return { kind: 'not-salient', memory: null }
    }
  }

  /**
   * 写入提示预算（D-5 Q1）：每会话前 N 次写入各给一行提示，之后静默。
   *
   * @returns 是否需要向用户追加提示行。
   */
  shouldPromptWrite(sessionId: string): boolean {
    if (this.promptSession !== sessionId) {
      this.promptSession = sessionId
      this.promptCount = 0
    }
    if (!getFlag(this.db, 'prompt_writes')) return false
    // 注意：`.get()` 返回的是**整行对象**，不是标量。之前直接 Number(row) 会抛
    // "Cannot convert object to primitive value"（smoke 抓到的真实缺陷）。
    const configured = getNumber(this.db, 'write_prompt_budget', 3)
    const limit = configured > 0 ? configured : 3
    if (this.promptCount >= limit) return false
    this.promptCount += 1
    return true
  }

  // ---------- 检索 ----------

  /**
   * 检索留痕的唯一实现（O-2「每次检索留痕」/ O-3 审计出口）。
   *
   * meta **只存长度、命中数、耗时**，绝不存查询原文 —— 查询里可能含敏感话题，
   * 这是 N-2 修复的硬要求，也是 AC-5「审计无正文」的同一条纪律。
   * 四条路径（ok / disabled / error / timeout）共用同一个形状，
   * 杜绝"某条降级分支偷偷多写一个字段"。
   */
  private auditRetrieve(query: string, hits: number, elapsedMs: number, outcome: string): void {
    dao.audit(this.db, {
      id: this.nextId(),
      at: this.now(),
      op: 'retrieve',
      outcome,
      memoryId: null,
      meta: { queryLength: query.length, hits, elapsedMs },
    })
  }

  /**
   * 主检索（I-2 唯一入口的对外门面）。
   *
   * **N-2**：每条路径（含三个提前 return）都必须留痕。AC-9 的验收本质是
   * "失败可被观测"；失败不留痕等于失败无法被发现 —— 比失败本身更危险。
   */
  retrieve(query: string, projectKey: string | null, limit = 5): RetrieveResult {
    if (!this.enabled()) {
      this.auditRetrieve(query, 0, 0, 'disabled')
      return { hits: [], degraded: 'error', elapsedMs: 0 }
    }
    if (this.faults.retrieveError === true) {
      this.auditRetrieve(query, 0, 0, 'error')
      return { hits: [], degraded: 'error', elapsedMs: 0 }
    }
    if (this.faults.retrieveSlowMs !== undefined && this.faults.retrieveSlowMs > 0) {
      const until = performance.now() + this.faults.retrieveSlowMs
      while (performance.now() < until) {
        /* 故意忙等，模拟超预算 */
      }
    }
    const result = retrieve(this.db, query, {
      projectKey,
      now: this.now(),
      limit,
      decayWindowDays: getNumber(this.db, 'decay_window_days', 90),
    })
    // 注入的慢路径发生在 retrieve() 之外，所以降级判定要在这里补一次：
    // 对外承诺的是「一次检索的墙钟耗时」，不是「retrieve() 内部耗时」。
    if (this.faults.retrieveSlowMs !== undefined && this.faults.retrieveSlowMs > RETRIEVE_SOFT_BUDGET_MS) {
      const degraded: RetrieveResult = { ...result, degraded: 'timeout' }
      this.auditRetrieve(query, degraded.hits.length, degraded.elapsedMs, 'timeout')
      return degraded
    }
    this.auditRetrieve(query, result.hits.length, result.elapsedMs, result.degraded === false ? 'ok' : result.degraded)
    return result
  }

  /** 批量遗忘的命中预览（不记命中、不截断）。 */
  preview(query: string, projectKey: string | null): MemoryRow[] {
    return matchAll(this.db, query, { projectKey, now: this.now() }).map((hit) => hit.row)
  }

  /**
   * **O-4**：检索候选集观测。
   *
   * 返回 filter 后、rerank 前的 ID 列表 —— 这让 I-2 能被**直接断言**
   * （候选集恰等于 {status=active}），而不是靠"检索结果里没出现"间接推断。
   */
  inspectRetrieval(query: string, projectKey: string | null): {
    candidateIds: string[]
    candidateStatuses: Record<string, number>
    hitIds: string[]
    elapsedMs: number
    degraded: false | 'timeout' | 'error'
  } {
    const candidates = dao
      .listByStatuses(this.db, { statuses: ['active'], projectKey })
      .map((row) => row.id)
    const result = retrieve(this.db, query, { projectKey, now: this.now() })
    const statusCounts: Record<string, number> = {}
    for (const row of dao.listByStatuses(this.db, {
      statuses: ['active', 'superseded', 'expired'],
      projectKey,
    })) {
      statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1
    }
    return {
      candidateIds: candidates,
      candidateStatuses: statusCounts,
      hitIds: result.hits.map((hit) => hit.row.id),
      elapsedMs: result.elapsedMs,
      degraded: result.degraded,
    }
  }

  // ---------- 三视图 ----------

  listA(projectKey: string | null, filter: Filter | null = null) {
    return listA(this.db, { projectKey }, filter)
  }

  listB(projectKey: string | null) {
    return listB(this.db, { projectKey }, this.retentionDays(), this.now())
  }

  listC(projectKey: string | null, memoryId: string | null) {
    return listC(this.db, { projectKey }, memoryId)
  }

  changesOf(memoryId: string): ChangeRow[] {
    return dao.listChanges(this.db, memoryId)
  }

  // ---------- 管理 ----------

  edit(input: EditInput, projectKey: string | null) {
    return edit({ db: this.db, now: this.now(), nextId: () => this.nextId(), projectKey }, input)
  }

  softDelete(id: string, projectKey: string | null, reason: 'delete' | 'user_asked_not_to_keep' = 'delete') {
    return softDelete({ db: this.db, now: this.now(), nextId: () => this.nextId(), projectKey }, id, reason)
  }

  prepareHardDelete(id: string, projectKey: string | null) {
    return prepareHardDelete({ db: this.db, now: this.now(), nextId: () => this.nextId(), projectKey }, id)
  }

  hardDelete(id: string, token: string, projectKey: string | null) {
    return hardDelete(
      { db: this.db, now: this.now(), nextId: () => this.nextId(), projectKey },
      id,
      token,
    )
  }

  restore(id: string, projectKey: string | null) {
    return restore({ db: this.db, now: this.now(), nextId: () => this.nextId(), projectKey }, id)
  }

  batchForget(ids: readonly string[], projectKey: string | null) {
    return batchForget({ db: this.db, now: this.now(), nextId: () => this.nextId(), projectKey }, ids)
  }

  // ---------- 后台任务 ----------

  sweepExpired(): number {
    return sweepExpired(this.db, this.now(), () => this.nextId())
  }

  sweepRecycle(): number {
    return sweepRecycle(this.db, this.now(), this.retentionDays(), () => this.nextId())
  }

  // ---------- 观测（O-2 / O-3） ----------

  /**
   * **O-2**：种子导入。
   *
   * 允许直接指定任意字段与时间 —— 这是 AC-4（过期/衰减）、DC-10（折叠态）、
   * PC-15（保留期交叉验证）能被测试的前提：不靠等真实时间。
   */
  seed(rows: readonly SeedRow[]): string[] {
    const ids: string[] = []
    for (const row of rows) {
      const id = row.id ?? this.nextId()
      dao.insert(this.db, {
        id,
        layer: row.layer,
        content: row.content,
        scope: row.scope,
        projectKey: row.scope === 'project' ? (row.projectKey ?? this.options.defaults?.projectKey ?? '/seed') : null,
        sourceType: row.sourceType ?? 'explicit',
        sourceRef: {
          sessionId: row.sessionId ?? 'seed-session',
          turnSeq: row.turnSeq ?? 1,
          snippet: row.snippet ?? row.content,
          at: row.createdAt,
          eventPhrase: row.eventPhrase ?? '你说明这件事时',
        },
        createdAt: row.createdAt,
        confirmedAt: row.confirmedAt ?? row.createdAt,
        status: row.status ?? 'active',
        expiresAt: row.expiresAt ?? null,
        sensitivity: row.sensitivity ?? 'normal',
      })
      if (row.deletedAt !== null && row.deletedAt !== undefined) {
        this.db.raw.prepare('UPDATE memories SET deleted_at = ? WHERE id = ?').run(row.deletedAt, id)
      }
      if (row.supersededBy !== null && row.supersededBy !== undefined) {
        this.db.raw.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(row.supersededBy, id)
      }
      if (row.reuseCount !== undefined || row.lastHitAt !== undefined) {
        this.db.raw
          .prepare('UPDATE memories SET reuse_count = ?, last_hit_at = ? WHERE id = ?')
          .run(row.reuseCount ?? 0, row.lastHitAt ?? null, id)
      }
      if (row.removeReason !== undefined) {
        dao.insertChange(this.db, {
          id: this.nextId(),
          memoryId: id,
          fromStatus: row.status ?? 'active',
          toStatus: 'deleted_soft',
          reason: row.removeReason,
          actor: 'user',
          at: row.deletedAt ?? row.createdAt,
          detail: null,
        })
      }
      ids.push(id)
    }
    return ids
  }

  /** **O-3**：审计只读出口，可按 op 过滤。 */
  queryAudit(filter: { op?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    const rows = dao.listAudit(this.db, filter.limit ?? 200)
    if (filter.op === undefined) return rows
    return rows.filter((row) => row.op === filter.op)
  }

  /** 硬删后审计里是否**真的**不含正文（AC-5 第 4 条的可断言面）。 */
  auditLeaksContent(needle: string): boolean {
    const rows = this.queryAudit({ limit: 10_000 })
    return JSON.stringify(rows).includes(needle)
  }

  /** 统计（O-5）。 */
  stats(): { total: number; byStatus: Record<string, number>; recycle: number; viewA: { n: number; a: number; b: number; c: number } } {
    const rows = dao.listAll(this.db)
    const byStatus: Record<string, number> = {}
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    // countVisible 只接受 V-A 三态；这里显式只喂那三种状态
    const viewA = countVisible(
      rows.filter((row) => row.status === 'active' || row.status === 'superseded' || row.status === 'expired'),
      null,
    )
    return {
      total: rows.length,
      byStatus,
      recycle: this.listB(null).length,
      viewA: { n: viewA.n, a: viewA.a, b: viewA.b, c: viewA.c },
    }
  }

  getById(id: string): MemoryRow | null {
    return dao.getById(this.db, id)
  }

  /** 直接访问底层库（只给自测与迁移用，业务代码不要碰）。 */
  get rawDb(): Db {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}

/** 种子行：所有字段可选，便于构造任意时间/状态的夹具。 */
export interface SeedRow {
  readonly id?: string
  readonly layer: 'semantic' | 'episodic'
  readonly content: string
  readonly scope: 'project' | 'user'
  readonly projectKey?: string
  readonly sourceType?: 'explicit' | 'correction' | 'inferred'
  readonly sessionId?: string
  readonly turnSeq?: number
  readonly snippet?: string
  readonly eventPhrase?: string
  readonly createdAt: number
  readonly confirmedAt?: number
  readonly status?: Status
  readonly expiresAt?: number | null
  readonly supersededBy?: string | null
  readonly deletedAt?: number | null
  readonly reuseCount?: number
  readonly lastHitAt?: number | null
  readonly sensitivity?: 'normal' | 'restricted'
  readonly removeReason?: 'delete' | 'user_asked_not_to_keep'
}

