/**
 * 检索用的切词与打分 —— 纯函数，Host 侧与自测共用。
 *
 * 为什么不用 SQLite 的 unicode61：它不切中文（整句当一个 token）。`@clinexin/dsh-kb`
 * 有语义向量兜底，本方案没有向量通道，所以必须自己切。
 *
 * 切法（`tech-design.md` §3.2）：
 * - 中文：**二元组**（bigram）。「测试命令」→ 测试 / 试命 / 命令。
 * - ASCII：保留连续词（`pnpm`、`vitest`、`dev:web` 里的 `dev` 与 `web`），小写归一。
 * - 标点、纯空白丢弃。
 *
 * 二元组的好处：召回与"用户换个说法"的鲁棒性比单字好；代价是索引略大（1 万条无压力）。
 */

/** 中日韩统一表意文字（够 MVP 用；扩展区与兼容区不强求）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

/** 从文本切出 token 列表（可能有重复，调用方自行去重）。 */
export function tokenize(text: string): string[] {
  if (text === '') return []
  const out: string[] = []
  const lower = text.toLowerCase()

  // 逐字符扫描：遇到 CJK 连续段做 bigram，遇到 ASCII 连续段整体保留。
  let cjkRun: string[] = []
  let asciiRun = ''
  const flushCjk = (): void => {
    if (cjkRun.length === 1) out.push(cjkRun[0]!)
    else {
      for (let i = 0; i + 1 < cjkRun.length; i += 1) out.push(cjkRun[i]! + cjkRun[i + 1]!)
    }
    cjkRun = []
  }
  const flushAscii = (): void => {
    if (asciiRun.length >= 2) out.push(asciiRun)
    asciiRun = ''
  }

  for (const ch of lower) {
    if (CJK.test(ch)) {
      flushAscii()
      cjkRun.push(ch)
    } else if (/[a-z0-9_\-.]/.test(ch)) {
      flushCjk()
      // 连字符/点/下划线视为词内字符（`dev:web` 的冒号另论），但首尾不要
      asciiRun += ch
    } else {
      flushCjk()
      flushAscii()
    }
  }
  flushCjk()
  flushAscii()

  // ASCII 词再按连字符/点/下划线拆一遍，让 `dev:web`→dev,web，
  // 同时保留整体（整体命中说明更精确，价值更高，但不在 token 层区分）。
  const extra: string[] = []
  for (const token of out) {
    if (/^[a-z0-9_\-.]{2,}$/.test(token) && /[_\-.]/.test(token)) {
      for (const piece of token.split(/[_\-.]/)) if (piece.length >= 2) extra.push(piece)
    }
  }
  return out.concat(extra)
}

/**
 * 受控同义词表（H-1 的缓解手段，**不是语义模型**）。
 *
 * 为什么需要：纯字面检索对"用户换了个说法"完全无能——实测 H-1 的失败样例里，
 * 「发布流程」搜不到「发版前必须先跑 pnpm build」、「热更新」搜不到「HMR」。
 * 这些不是长尾，而是中文开发语境里最高频的几组等价词。
 *
 * 为什么是受控表而不是 embedding：
 * - 表是**有限的、可审的、零延迟的**，不会把 AC-10 的 300ms 预算吃掉；
 * - 它不会引入"看起来相似但语义相反"的假阳性（模型会）；
 * - 加词只需要改一处并有单测，行为可预测。
 *
 * 边界（必须诚实）：这只覆盖**明确列出的**几组词。没列到的换说法仍然搜不到，
 * 那是 §10.3 说的向量通道该解决的问题，不在 MVP 内。
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['发版', '发布', '上版', 'release'],
  ['测试', '单测', '单元测试', 'test', 'spec'],
  ['热更新', 'hmr', 'hot reload'],
  ['包管理器', 'pnpm', 'npm', 'yarn', '依赖', '装依赖'],
  ['依赖安装', '安装', '装', 'install'],
  ['升级', '不升级', '旧版', '版本', 'ts', 'typescript'],
  ['版本号', 'version', '版本'],
  ['命名', '名字', '名称', 'naming', '大小写', '驼峰', 'camel', 'pascal'],
  ['注释', '注释语言', 'comment'],
  ['分支', 'branch', '分支策略'],
  ['构建', 'build', '编译'],
  ['类型检查', 'typecheck', 'tsc', '类型'],
  ['镜像', '镜像源', 'registry', '源'],
  ['提交', 'commit', '提交规范'],
]

/** 词 → 同组所有词（含自身）。 */
const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const index = new Map<string, Set<string>>()
  for (const group of SYNONYM_GROUPS) {
    const set = new Set(group)
    for (const word of group) {
      const existing = index.get(word)
      if (existing === undefined) index.set(word, new Set(set))
      else for (const item of set) existing.add(item)
    }
  }
  return index
})()

/**
 * 把查询/文本里的词按受控同义词表**双向**展开成多个变体。
 *
 * 返回原文 + 每一种替换一个变体（每次只替换一组，避免组合爆炸）。
 * 变体数量被同义词组长度的乘积控制 —— 实测最多几十个，1 万条规模下开销可忽略。
 */
export function synonymVariants(text: string): string[] {
  const lower = text.toLowerCase()
  const variants = new Set<string>([lower])
  for (const [word, group] of SYNONYM_INDEX) {
    if (!lower.includes(word)) continue
    for (const replacement of group) {
      if (replacement === word) continue
      variants.add(lower.split(word).join(replacement))
      // 上限保护：极端输入不放大
      if (variants.size > 64) return [...variants]
    }
  }
  return [...variants]
}

/** 查询的 token 集合，**含同义词展开**（检索匹配面用这个，不是裸 tokenize）。 */
export function expandedTokenSet(query: string): Set<string> {
  const out = new Set<string>()
  for (const variant of synonymVariants(query)) {
    for (const token of tokenize(variant)) out.add(token)
  }
  return out
}

/** 去重后的 token 集合。 */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

/** Jaccard 相似度（用于去重的"语义等价"判定，tech-design.md §5.5）。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  const union = a.size + b.size - inter
  if (union === 0) return 0
  return inter / union
}

/** 词覆盖率：查询 token 被条目覆盖的比例（精排因子之一）。 */
export function coverage(queryTokens: Set<string>, docTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0
  let hit = 0
  for (const token of queryTokens) if (docTokens.has(token)) hit += 1
  return hit / queryTokens.size
}

/**
 * 命中集中度：命中的查询 token 在正文中是否彼此靠近。
 *
 * 做法：把正文按 token 顺序铺开，记录每个查询 token **首次出现**的位置，
 * 取这些位置的跨度；跨度越小越集中。返回 0..1（1 = 全部紧邻）。
 *
 * 为什么需要它：「测试」和「命令」分别出现在长文的两端，和「测试命令」连在一起说，
 * 语义上是两回事。集中度把后者排前面。
 */
export function concentration(text: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0
  const tokens = tokenize(text)
  const firstAt = new Map<string, number>()
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (queryTokens.has(token) && !firstAt.has(token)) firstAt.set(token, i)
  }
  if (firstAt.size === 0) return 0
  const positions = [...firstAt.values()]
  const span = Math.max(...positions) - Math.min(...positions)
  // 跨度 0 = 完全集中；跨度越大越低。分母用 token 总数，避免长文天然吃亏。
  const denom = Math.max(1, tokens.length)
  return Math.max(0, 1 - span / denom)
}

/** 精排权重（`tech-design.md` §4.3）。改这些数就是改排序，需同步文档。 */
export const RERANK_WEIGHTS = {
  coverage: 0.4,
  concentration: 0.25,
  sourceTrust: 0.2,
  layerPrior: 0.1,
  recency: 0.05,
} as const

/** 来源可信度（explicit > correction > inferred）。 */
export const SOURCE_TRUST: Record<string, number> = {
  explicit: 1.0,
  correction: 0.9,
  inferred: 0.6,
}

/** 分层先验：稳定的偏好优先于一次性事件。 */
export const LAYER_PRIOR: Record<string, number> = {
  semantic: 1.0,
  episodic: 0.85,
}

/** 时效分数：半衰期 90 天，返回 0..1。 */
export function recencyScore(confirmedAt: number, now: number, halfLifeDays = 90): number {
  const days = Math.max(0, (now - confirmedAt) / 86_400_000)
  return Math.pow(0.5, days / halfLifeDays)
}

/**
 * 衰减因子（**不是状态**，I-3 / DC-28）。
 *
 * 只影响排序，不写回任何字段、不改 status、不影响 V-A 可读性。
 * - 语义层不衰减（I-4：只有情景层会自然过期）。
 * - 情景层 90 天窗口，下限 0.5（衰减到一半就不再降，避免老条目永远垫底）。
 */
export function decayFactor(
  row: { layer: string; lastHitAt: number | null; confirmedAt: number },
  now: number,
  windowDays = 90,
): number {
  if (row.layer !== 'episodic') return 1
  const anchor = row.lastHitAt ?? row.confirmedAt
  const idleDays = Math.max(0, (now - anchor) / 86_400_000)
  return 0.5 + 0.5 * Math.exp(-idleDays / windowDays)
}

export interface RerankInput {
  readonly content: string
  readonly layer: string
  readonly sourceType: string
  readonly confirmedAt: number
  readonly lastHitAt: number | null
  /**
   * 预计算的 token 串（空格分隔）。提供时**不再对 content 重新分词** ——
   * 这是检索热路径的关键优化：1 万条下逐条分词是主要成本。
   */
  readonly tokens?: string
}

/**
 * 精排总分（0..1 附近）。
 *
 * 顺序：词法精排 → 叠衰减。衰减是**乘**在最后的，所以它不会改变"完全不相干"与
 * "高度相关"的相对关系，只会在同档内把久未命中的情景条目往后压一点。
 */
export function rerankScore(
  row: RerankInput,
  queryTokens: Set<string>,
  now: number,
  /** 情景层衰减窗口（天）。来自 `memory_settings.decay_window_days`，缺省 90。 */
  windowDays = 90,
): number {
  // 优先用预计算 token；没有才现场分词（单测与临时对象走这条）
  const docTokens =
    row.tokens === undefined || row.tokens === ''
      ? tokenSet(row.content)
      : new Set(row.tokens.split(' ').filter((token) => token !== ''))
  const cov = coverage(queryTokens, docTokens)
  // 集中度仍需要顺序信息，用 token 串（不是集合）——成本远低于重新分词
  const conc = concentration(row.tokens === undefined ? row.content : row.tokens.split(' ').join(' '), queryTokens)
  const trust = SOURCE_TRUST[row.sourceType] ?? 0.6
  const prior = LAYER_PRIOR[row.layer] ?? 0.85
  const rec = recencyScore(row.confirmedAt, now)

  const lexical =
    RERANK_WEIGHTS.coverage * cov +
    RERANK_WEIGHTS.concentration * conc +
    RERANK_WEIGHTS.sourceTrust * trust +
    RERANK_WEIGHTS.layerPrior * prior +
    RERANK_WEIGHTS.recency * rec

  return lexical * decayFactor(row, now, windowDays)
}
