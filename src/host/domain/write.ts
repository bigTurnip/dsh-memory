/**
 * 写入管线：五道闸门（`tech-design.md` §5）。
 *
 *   ① 抽取 → ② 拒写(N-1~N-6) → ③ 显著性 → ④ 去重/合并/冲突 → ⑤ 落库
 *
 * 顺序不可换。特别是 **②在③之前**：一条命中凭据的候选，即使显著性满分也不能写。
 */

import type { Db } from '../db/index.js'
import * as dao from '../db/dao.js'
import { getNumber } from '../db/index.js'
import { transition } from './state.js'
import type { Layer, MemoryRow, Scope, SourceRef, SourceType } from '../../shared/contract.js'
import { jaccard, tokenSet } from '../../shared/retrieval-score.js'

/** 候选事实（抽取的产物）。 */
export interface Candidate {
  readonly content: string
  readonly layer: Layer
  readonly scope: Scope
  readonly sourceType: SourceType
  readonly sourceRef: SourceRef
}

/** 拒写类别（N-1~N-6）。 */
export type RejectCategory =
  | 'credential'
  | 'explicit_dont'
  | 'temporary'
  | 'third_party_pii'
  | 'sensitive_attribute'
  | 'vent'

/**
 * ② 拒写判定。
 *
 * **fail-closed**：判不准时返回非 null（不写）。理由：误记不可撤回地影响信任，
 * 而漏记只是少一条增益。
 */
export function classifyReject(content: string): RejectCategory | null {
  const text = content.trim()
  if (text === '') return 'temporary'

  // N-1 凭据类：模式命中即拒（宁可错杀，不可写入）
  if (
    /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/.test(
      text,
    ) ||
    /BEGIN [A-Z ]*PRIVATE KEY/.test(text) ||
    /(password|passwd|pwd)\s*[:=]\s*\S{4,}/i.test(text) ||
    /:\/\/[^\s/:@]+:[^\s/@]+@/.test(text) ||
    /(token|secret|api[_-]?key)\s*[:=]\s*\S{8,}/i.test(text)
  ) {
    return 'credential'
  }

  // N-4 第三方个人信息：手机号 / 身份证 / 详细住址
  if (
    /(?<!\d)1[3-9]\d{9}(?!\d)/.test(text) ||
    /(?<!\d)\d{17}[\dXx](?!\d)/.test(text) ||
    /(身份证|身份证号|护照号)\s*[:：]?\s*[A-Za-z0-9]{6,}/.test(text)
  ) {
    return 'third_party_pii'
  }

  // N-5 敏感属性（W3：不推断、不存储）
  if (/(我(有|患|得了)|确诊)\s*(抑郁|焦虑症|糖尿病|癌|艾滋|乙肝)/.test(text)) {
    return 'sensitive_attribute'
  }
  if (/(信|信仰)\s*(佛教|基督教|伊斯兰教|天主教)|(我是|我是個)(同性恋|双性恋|跨性别)/.test(text)) {
    return 'sensitive_attribute'
  }
  if (/(政治立场|支持.{0,4}党|投票给)/.test(text)) return 'sensitive_attribute'

  // N-3 临时草稿
  if (/(随口|临时|先记一下|待会儿删|草稿|测试用)/.test(text)) return 'temporary'

  // N-6 对 agent 的负面宣泄（无人称事实的纯情绪）
  if (/(你(真|太|好)(笨|蠢|差)|垃圾|废物|傻[逼比])/.test(text)) {
    if (!/(以后|一律|必须|约定|规范)/.test(text)) return 'vent'
  }

  return null
}

/** ③ 显著性权重。 */
export const SALIENCE = {
  explicit: 1.0,
  correction: 0.9,
  repeated: 0.7,
  constraint: 0.8,
  inferred: 0.35,
} as const

export const SALIENCE_THRESHOLD = 0.6

/**
 * 显著性判定。
 *
 * 关键：`inferred` 单独永远不足（0.35 < 0.6），必须叠加。
 * 这样"系统猜测"不可能被写成与"用户明说"同等强度的记忆（PRD §3.2 显著性要求）。
 */
export function isSalient(input: {
  sourceType: SourceType
  content: string
  occurrences?: number
}): boolean {
  const occurrences = input.occurrences ?? 1
  let score = SALIENCE[input.sourceType as keyof typeof SALIENCE] ?? 0.35
  // 含约束词（以后/一律/必须/不要）加一点
  if (/(以后|一律|必须|不要|禁止|约定|规范|统一)/.test(input.content)) score += 0.1
  // 重复出现叠加（推断类靠这个才可能过线）
  if (occurrences >= 2) score += 0.2 * Math.min(3, occurrences - 1)
  return score >= SALIENCE_THRESHOLD
}

/** ④ 关系判定结果。 */
export type Relation = 'new' | 'exact' | 'equivalent' | 'conflict' | 'refine'

/** 否定极性归一（H-3 的缓解手段）。 */
function polarity(content: string): 'positive' | 'negative' {
  return /(不要|别|禁止|避免|不能|不许|不用)/.test(content) ? 'negative' : 'positive'
}

/** 归一化：去空白与标点、统一小写。 */
function normaliseForCompare(text: string): string {
  return text
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、；：""''（）()【】《》,.!?;:'"()\[\]{}]/g, '')
    .toLowerCase()
}

/**
 * 两条陈述的**共同前缀长度**（归一化后，按字符计）。
 *
 * 为什么用前缀而不是"主语+谓词槽位"：中文里没有可靠的词边界，
 * 而 `用` 这种字会出现在 `用户` 里（早期版本按动词切分，把「用户偏好用 pnpm」
 * 切成空槽位，导致任何两条都"同槽位"）。前缀长度没有这个问题：
 * 它只依赖"同一件事的两种说法通常共享开头"这个更弱但更稳的假设。
 */
function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length)
  let index = 0
  while (index < max && left[index] === right[index]) index += 1
  return index
}

/**
 * 是否"同一件事的不同说法"（冲突候选）。
 *
 * 判据：归一化后共同前缀 ≥ 3 字符，且覆盖较短一方 ≥ 40%。
 * 这两个阈值让「测试命令是 jest / vitest」「用户偏好用 pnpm / npm」都能命中，
 * 而「发版前必须先跑 pnpm build / 测试命令是 vitest」这类无关条目不会误判。
 */
export function sharesSubject(left: string, right: string): boolean {
  const a = normaliseForCompare(left)
  const b = normaliseForCompare(right)
  if (a.length === 0 || b.length === 0) return false
  const prefix = commonPrefixLength(a, b)
  const shorter = Math.min(a.length, b.length)
  return prefix >= 3 && prefix / shorter >= 0.4
}

/**
 * 判定候选与既有条目的关系。
 *
 * 判定顺序：exact → equivalent → conflict → refine → new。
 * 判不出冲突时**退化为 new**（宁可留两条由精排排序，也不误覆盖用户的历史说法）。
 */
export function classifyRelation(candidate: Candidate, existing: MemoryRow): Relation {
  const left = candidate.content.trim()
  const right = (existing.content ?? '').trim()

  const normalisedLeft = normaliseForCompare(left)
  const normalisedRight = normaliseForCompare(right)

  if (normalisedLeft === normalisedRight) return 'exact'

  const leftTokens = tokenSet(left)
  const rightTokens = tokenSet(right)
  if (jaccard(leftTokens, rightTokens) >= 0.85) return 'equivalent'

  // 否定极性翻转 + 词汇高度重叠 → 一定冲突（H-3）。
  // 单靠前缀抓不到「不要自动改版本号」vs「可以自动改版本号」（首字就不同），
  // 但它们的 token 高度重叠，所以用重叠度兜住这一档。
  if (polarity(left) !== polarity(right) && jaccard(leftTokens, rightTokens) >= 0.4) {
    return 'conflict'
  }

  // 冲突：同一件事的不同说法
  if (sharesSubject(left, right)) {
    // 极性相反 → 一定是冲突（「别改版本号」vs「可以改版本号」）
    if (polarity(left) !== polarity(right)) return 'conflict'
    // 否则若较短一方是较长的真前缀，且差异在尾部，也视为冲突（值被替换）
    if (normalisedLeft !== normalisedRight) {
      const isPrefix = normalisedRight.startsWith(normalisedLeft) || normalisedLeft.startsWith(normalisedRight)
      if (isPrefix) {
        // 「测试命令是jest」是「测试命令是jest且…」的前缀 → 这是细化，不是冲突
        const longer = normalisedLeft.length > normalisedRight.length ? leftTokens : rightTokens
        const shorterTokens = normalisedLeft.length > normalisedRight.length ? rightTokens : leftTokens
        let superset = true
        for (const token of shorterTokens) {
          if (!longer.has(token)) {
            superset = false
            break
          }
        }
        if (!superset) return 'conflict'
      } else {
        return 'conflict'
      }
    }
  }

  // 细化：既有 token 是候选的子集
  let subset = true
  for (const token of rightTokens) {
    if (!leftTokens.has(token)) {
      subset = false
      break
    }
  }
  if (subset && rightTokens.size > 0 && leftTokens.size > rightTokens.size) return 'refine'

  return 'new'
}

export interface WriteResult {
  readonly kind: 'created' | 'updated' | 'superseded' | 'merged' | 'rejected' | 'not-salient' | 'duplicate'
  readonly memory: MemoryRow | null
  readonly category?: RejectCategory
  /** 被取代的旧条目（V-C 用）。 */
  readonly replaced?: MemoryRow
}

export interface WriteDeps {
  readonly db: Db
  readonly now: number
  readonly nextId: () => string
  readonly projectKey: string | null
}

/**
 * ⑤ 落库（已在事务内调用；本函数不自己开事务）。
 */
export function writeCandidate(deps: WriteDeps, candidate: Candidate): WriteResult {
  const { db, now, nextId, projectKey } = deps

  // ② 拒写
  const rejected = classifyReject(candidate.content)
  if (rejected !== null) {
    dao.audit(db, {
      id: nextId(),
      at: now,
      op: 'reject',
      outcome: 'rejected',
      memoryId: null,
      meta: { category: rejected }, // 不含正文（AC-7）
    })
    return { kind: 'rejected', memory: null, category: rejected }
  }

  // ③ 显著性
  if (!isSalient({ sourceType: candidate.sourceType, content: candidate.content })) {
    return { kind: 'not-salient', memory: null }
  }

  // ④ 同槽位比对（作用域 + 项目 + 分层必须一致）
  if (candidate.scope === 'project' && projectKey === null) {
    // Q3 的 fail-closed：拿不到 projectKey 就不写项目级，避免串味（AC-8）
    return { kind: 'rejected', memory: null, category: 'temporary' }
  }

  const sameSlotRows = dao
    .listByStatuses(db, {
      statuses: ['active'],
      projectKey,
    })
    .filter(
      (row) =>
        row.scope === candidate.scope &&
        row.layer === candidate.layer &&
        row.projectKey === (candidate.scope === 'project' ? projectKey : null),
    )

  let relation: Relation = 'new'
  let target: MemoryRow | null = null
  for (const row of sameSlotRows) {
    const found = classifyRelation(candidate, row)
    if (found !== 'new') {
      relation = found
      target = row
      break
    }
  }

  if (target !== null && (relation === 'exact' || relation === 'equivalent')) {
    // 完全重复 / 语义等价：更新最近确认时间，不新增（W-d）
    db.raw.prepare('UPDATE memories SET confirmed_at = ? WHERE id = ?').run(now, target.id)
    const updated = dao.getById(db, target.id)
    return { kind: 'duplicate', memory: updated }
  }

  if (target !== null && relation === 'refine') {
    // 细化：合并进同一条
    const merged = candidate.content.length > (target.content ?? '').length ? candidate.content : target.content!
    dao.updateContent(db, target.id, merged, now)
    const updated = dao.getById(db, target.id)
    return { kind: 'merged', memory: updated }
  }

  if (target !== null && relation === 'conflict') {
    // 冲突：T-2 新覆盖旧（OQ-4=A）。旧条目标已修正，**不回滚**（DC-27）
    const newId = nextId()
    dao.insert(db, {
      id: newId,
      layer: candidate.layer,
      content: candidate.content,
      scope: candidate.scope,
      projectKey: candidate.scope === 'project' ? projectKey : null,
      sourceType: candidate.sourceType,
      sourceRef: candidate.sourceRef,
      createdAt: now,
      confirmedAt: now,
      status: 'active',
      expiresAt: expiresAtFor(candidate.layer, now, db),
      sensitivity: 'normal',
    })
    const superseded = transition(db, target.id, 'superseded', {
      actor: 'user',
      reason: 'conflict',
      at: now,
      nextId,
      supersededBy: newId,
      detail: { replacedBy: newId },
    })
    const created = dao.getById(db, newId)
    dao.audit(db, {
      id: nextId(),
      at: now,
      op: 'write',
      outcome: 'ok',
      memoryId: newId,
      meta: { layer: candidate.layer, scope: candidate.scope, relation: 'conflict' },
    })
    return { kind: 'superseded', memory: created, replaced: superseded }
  }

  // 新建（T-1）
  const id = nextId()
  dao.insert(db, {
    id,
    layer: candidate.layer,
    content: candidate.content,
    scope: candidate.scope,
    projectKey: candidate.scope === 'project' ? projectKey : null,
    sourceType: candidate.sourceType,
    sourceRef: candidate.sourceRef,
    createdAt: now,
    confirmedAt: now,
    status: 'active',
    expiresAt: expiresAtFor(candidate.layer, now, db),
    sensitivity: 'normal',
  })
  dao.audit(db, {
    id: nextId(),
    at: now,
    op: 'write',
    outcome: 'ok',
    memoryId: id,
    meta: { layer: candidate.layer, scope: candidate.scope, relation: 'new' },
  })
  const created = dao.getById(db, id)
  return { kind: 'created', memory: created }
}

/** 情景层的过期时间（语义层永不自动过期，I-4）。 */
export function expiresAtFor(layer: Layer, now: number, db: Db): number | null {
  if (layer !== 'episodic') return null
  const days = getNumber(db, 'episodic_retention_days', 30)
  return now + days * 86_400_000
}
