/**
 * 检索 —— **全系统唯一允许读 memories 做检索的地方**（I-2 的结构性保证）。
 *
 * 核心纪律（`tech-design.md` §4.1）：
 * 1. `candidates()` 把候选集钉死为 `status = 'active'`，**SQL 里没有 status 插值点**；
 * 2. 函数签名不接受 status 参数 —— 调用方**无法**覆盖它；
 * 3. 作用域条件同时成立：user 全可见，project 只认当前 projectKey（AC-8）。
 *
 * 这是 AC-2/3/4/5 全部「不再返回」断言可判定的根基。
 * 如果有人在这个文件之外写第二个 `SELECT ... FROM memories WHERE status = 'active'`，
 * 就把 §4.1 的保证破坏了 —— 自测里有 grep 级检查（HC-4b）。
 */

import type { Db } from '../db/index.js'
import * as dao from '../db/dao.js'
import type { MemoryRow, SourceRef } from '../../shared/contract.js'
import { rerankScore, tokenSet, tokenize, synonymVariants, expandedTokenSet } from '../../shared/retrieval-score.js'

export interface RetrieveContext {
  readonly projectKey: string | null
  readonly now: number
  /** 返回条数上限。 */
  readonly limit?: number
  /**
   * 情景层衰减窗口（天）。来自 `memory_settings.decay_window_days`。
   *
   * 为什么必须从外面传：这里只负责"怎么用"，不负责"用多少"——
   * 把 90 再写死一遍，面板上那个设置就成了摆设（D-8 X-4 的同一条纪律）。
   */
  readonly decayWindowDays?: number
}

export interface RetrieveHit {
  readonly row: MemoryRow
  readonly score: number
}

export interface RetrieveResult {
  readonly hits: readonly RetrieveHit[]
  /** 是否发生了降级（超时/异常）。DC-31 的三档区分靠它。 */
  readonly degraded: false | 'timeout' | 'error'
  readonly elapsedMs: number
}

/** 精排候选池上限（tech-design.md §4.3）。超过这个数只按廉价证据排序，不逐条精排。 */
export const RERANK_POOL_LIMIT = 200

/** 检索软预算（tech-design.md §4.5）。超过即按 D-2 档降级。 */
export const RETRIEVE_SOFT_BUDGET_MS = 250

/**
 * 候选集：**I-2 的唯一实现**。
 *
 * 注意 SQL 里 `status = 'active'` 是字面量，没有一个 `?` 留给调用方。
 */
function candidates(db: Db, projectKey: string | null): MemoryRow[] {
  // 直接映射，**不要**逐行再 getById —— 那是 N+1 查询，
  // 1 万条规模下会把 5ms 的候选集过滤拖成上百毫秒（实测过）。
  const rows = db.raw
    .prepare(
      `SELECT rowid, * FROM memories
        WHERE status = 'active'
          AND (scope = 'user' OR (scope = 'project' AND project_key = ?))`,
    )
    .all(projectKey) as unknown as dao.RawRow[]
  return rows.map(dao.toMemory)
}

/**
 * 主检索入口。
 *
 * 三通道融合（tech-design.md §4.2）：
 *   ① FTS5 BM25（可用时）→ ② 字面子串 → ③ 分层/作用域先验（在精排权重里）
 * 然后确定性精排 → 叠衰减 → top-K。
 */
export function retrieve(db: Db, query: string, ctx: RetrieveContext): RetrieveResult {
  const started = performance.now()
  const limit = ctx.limit ?? 5
  try {
    const pool = candidates(db, ctx.projectKey)
    if (pool.length === 0) {
      return { hits: [], degraded: false, elapsedMs: elapsedMs(started) }
    }

    // 查询 token 含受控同义词展开（H-1 的缓解；失败样例里「发布流程」搜不到「发版」就是这里）
    const queryTokens = expandedTokenSet(query)
    const variants = synonymVariants(query).map((variant) => variant.trim())
    // **一次** FTS 查询，把同义展开的 token 一起并入 OR 表达式（见 dao.searchFts 注释）
    const ftsRanks = dao.searchFts(db, query, [...queryTokens])
    const loweredList = variants.filter((variant) => variant.length >= 2)

    // ① 廉价证据筛选：只用 O(1) 判断（字面包含 / FTS 名次），**不做分词**。
    //    这一步在 1 万条下是毫秒级；把昂贵的精排留给候选池。
    // 廉价证据：只用 O(1) 判断，**不做分词**。
    //
    // 关键性能取舍：字面匹配只在 **FTS 未命中** 的条目上做，而不是对每个条目
    // 试遍全部同义变体。原因：同义词展开会产生 10+ 个变体，逐条 × 逐变体
    // 的子串扫描在 1 万条下是 16×10000 次 includes（实测把 40ms 拖成 120ms）。
    // 而 FTS 已经覆盖了绝大多数字面命中 —— 字面通道的职责只是兜住
    // "短查询/带连字符的词 FTS 不敏感"这一小类，不需要全量扫。
    const cheap: Array<{ row: MemoryRow; ftsBonus: number; literalHit: boolean }> = []
    for (const row of pool) {
      const ftsRank = ftsRanks.get(row.id)
      let literalHit = false
      if (ftsRank === undefined) {
        const contentLowered = (row.content ?? '').toLowerCase()
        literalHit = loweredList.some((variant) => contentLowered.includes(variant))
        if (!literalHit) continue
      }
      cheap.push({
        row,
        literalHit,
        ftsBonus: ftsRank === undefined ? 0 : 1 - Math.min(1, ftsRank / 500),
      })
    }

    // 精排只跑候选池（tech-design §4.3：候选 ≤ 200 时做确定性精排）。
    // 先按廉价证据排序，取前 RERANK_POOL_LIMIT 条做精排。
    cheap.sort((left, right) => right.ftsBonus - left.ftsBonus)
    const rerankPool = cheap.slice(0, RERANK_POOL_LIMIT)

    const scored: RetrieveHit[] = []
    for (const item of rerankPool) {
      const base = rerankScore(
        {
          content: item.row.content ?? '',
          layer: item.row.layer,
          sourceType: item.row.sourceType,
          confirmedAt: item.row.confirmedAt,
          lastHitAt: item.row.lastHitAt,
          tokens: (item.row as unknown as { tokens?: string }).tokens,
        },
        queryTokens,
        ctx.now,
        ctx.decayWindowDays,
      )
      const score = base * 0.8 + item.ftsBonus * 0.15 + (item.literalHit ? 0.05 : 0)
      scored.push({ row: item.row, score })
    }

    scored.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      // 稳定序：同分时 confirmedAt 新的在前，再同则按 id（保证"两次检索顺序一致"）
      if (right.row.confirmedAt !== left.row.confirmedAt) {
        return right.row.confirmedAt - left.row.confirmedAt
      }
      return left.row.id.localeCompare(right.row.id)
    })

    const elapsed = elapsedMs(started)
    const hits = scored.slice(0, limit)
    // 软预算以**本次调用的墙钟耗时**为准（含上游注入的慢路径）
    const wallClock = performance.now() - started
    return {
      hits,
      degraded: elapsed > RETRIEVE_SOFT_BUDGET_MS || wallClock > RETRIEVE_SOFT_BUDGET_MS ? 'timeout' : false,
      elapsedMs: elapsed,
    }
  } catch {
    return { hits: [], degraded: 'error', elapsedMs: elapsedMs(started) }
  }
}

/**
 * 记录"被实际采用"（DC-23 / O-3）。
 *
 * 只有检索结果真的被用于回答时才调；**列举（V-A 清单）不算命中**，
 * 否则用户常翻清单就会让条目永不衰减，AC-4 的衰减判定会失真。
 */
export function markUsed(db: Db, hits: readonly RetrieveHit[], at: number): void {
  for (const hit of hits) dao.recordHit(db, hit.row.id, at)
}

/**
 * 盲检索（用于"这条记忆的匹配面"诊断，例如批量遗忘的命中预览）。
 *
 * 与 `retrieve` 的区别：**不记命中、不做 top-K 截断**。
 * 实现上仍然复用同一个 `candidates()`，所以 I-2 依然成立。
 */
export function matchAll(db: Db, query: string, ctx: RetrieveContext): RetrieveHit[] {
  const pool = candidates(db, ctx.projectKey)
  const queryTokens = expandedTokenSet(query)
  const variants = synonymVariants(query).map((variant) => variant.trim()).filter((v) => v.length >= 2)
  const ftsRanks = dao.searchFts(db, query, [...queryTokens])
  const out: RetrieveHit[] = []
  for (const row of pool) {
    const content = row.content ?? ''
    const hit =
      variants.some((variant) => content.toLowerCase().includes(variant)) ||
      ftsRanks.has(row.id) ||
      overlappingTokens(queryTokens, tokenSet(content))
    if (!hit) continue
    out.push({
      row,
      score: rerankScore(
        {
          content,
          layer: row.layer,
          sourceType: row.sourceType,
          confirmedAt: row.confirmedAt,
          lastHitAt: row.lastHitAt,
          tokens: (row as unknown as { tokens?: string }).tokens,
        },
        queryTokens,
        ctx.now,
        ctx.decayWindowDays,
      ),
    })
  }
  out.sort((left, right) => right.score - left.score)
  return out
}

/** 至少有一个 token 重叠（批量遗忘的宽匹配面）。 */
function overlappingTokens(queryTokens: Set<string>, docTokens: Set<string>): boolean {
  if (queryTokens.size === 0) return false
  for (const token of queryTokens) if (docTokens.has(token)) return true
  return false
}

/** 把查询切成 token（对外暴露，供诊断与自测）。 */
export function inspectTokens(query: string): string[] {
  return tokenize(query)
}

/** 生成来源摘录（PE-12 / X-1 的降级形态：不做跳转，只给摘录）。 */
export function sourceExcerpt(sourceRef: SourceRef, maxLength = 80): string {
  const snippet = sourceRef.snippet.trim()
  if (snippet === '') return ''
  return snippet.length <= maxLength ? snippet : `${snippet.slice(0, maxLength)}…`
}

function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 1000) / 1000
}
