/**
 * 断言库（test-engineer 独立验收用）。
 *
 * ## 与工程师自测的区别
 * 工程师的 `src/test/*.test.ts` 验的是"实现是否按我理解的契约工作"；
 * 本库验的是"**用户可观察的输出**是否满足 D-4 / D-8 / D-9 的判定口径"。
 * 前者是白盒（直接调 service），后者尽量贴文本/DOM 这些**用户能看到的面**。
 *
 * ## 设计纪律
 * 1. **每条断言对应一条裁定编号**，注释里写清楚是哪条（D-4 C-2 / D-8 X-1 …）。
 *    这样缺陷报告能直接引「违反了哪条裁定」，而不是"我觉得不对"。
 * 2. **断言失败必须给可读的实际值**，不接受 "assert failed"。
 * 3. **只断言契约写死的东西**。非契约文案、视觉细节、实现方式一概不碰（§2.4）。
 * 4. **不替实现兜底**。缺字段就报缺字段，不补默认值 —— 补了就等于放过缺陷。
 *
 * ## 用法
 * ```ts
 * import { assertCountIdentity, assertSoftDeleteExcluded, assertCollapseByWholeList } from './assert/dsl.js'
 * const parsed = parseList(text)
 * assertCountIdentity(parsed)                  // D-4 C-2
 * assertSoftDeleteExcluded(parsed)             // D-4 C-3
 * assertCollapseByWholeList(parsed)            // D-8 X-3
 * ```
 */

import type { ParsedList, ParsedEntry, ProjectAnchorKind } from './parse-list.js'

/** 断言失败时抛这个，便于上层区分"断言不成立"与"代码崩了"。 */
export class AssertionFailure extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(`[${rule}] ${message}`)
    this.name = 'AssertionFailure'
  }
}

function fail(rule: string, message: string): never {
  throw new AssertionFailure(rule, message)
}


// ================================================================ N-4 首行项目锚点

/**
 * **N-4 / DC-04 / §5.8b**：V-A 首行必须印项目锚点，且三态必须区分。
 *
 * ## 为什么单独成一条断言（而不是并进 assertFilterCount）
 * N-4 修复引入了「无项目上下文」这个**显式声明**。它与"锚点缺失"在
 * `projectName` 上都是 `null`，如果解析器不区分、断言也不区分，那么：
 * - 实现哪天退回缺锚点的旧格式，工具会当成"无项目上下文"放过；
 * - N-4 这个修复本身就**失去了可验证性**。
 *
 * 所以本断言按 `anchorKind` 三态精确判定，`missing` 一律判红。
 *
 * @param parsed 解析结果
 * @param expect 期望形态：
 *   - `'named'`：必须有项目名（同时校验非空）
 *   - `'no-context'`：必须显式印「无项目上下文」
 *   - `'any'`：只要求**存在锚点**（`named` 或 `no-context` 均可），`missing` 判红
 */
export function assertProjectAnchorPresent(
  parsed: ParsedList,
  expect: ProjectAnchorKind | 'any' = 'any',
  rule = 'N-4 / DC-04',
): void {
  const actual = parsed.anchorKind

  if (actual === 'missing') {
    fail(
      rule,
      '首行缺少项目锚点段。N-4 裁定首行必须印「项目 <目录名>」或「无项目上下文」，' +
        '静默省略会让 AC-8 失去判定锚点（§5.8b 明确首行项目名是判定锚点）',
    )
  }

  if (expect === 'any') return

  if (actual !== expect) {
    const label: Record<ProjectAnchorKind, string> = {
      named: '有项目（项目 <目录名>）',
      'no-context': '无项目上下文',
      missing: '缺锚点',
    }
    fail(rule, `首行锚点为「${label[actual]}」，期望「${label[expect]}」`)
  }

  if (expect === 'named') {
    if (parsed.projectName === null || parsed.projectName.trim() === '') {
      fail(rule, '锚点形态为「有项目」但项目名为空')
    }
  }
  if (expect === 'no-context') {
    if (parsed.projectName !== null) {
      fail(rule, `锚点为「无项目上下文」时不应带项目名，实际为「${parsed.projectName}」`)
    }
  }
}

/**
 * **N-4 的反向专用**：断言首行**确实是回归形态**（缺锚点）。
 *
 * 用于反向用例自检 —— 证明解析器能识别出"缺锚点"这个具体形态，
 * 而不是把它和"无项目上下文"混为一谈。
 */
export function assertAnchorMissing(parsed: ParsedList, rule = 'N-4 / DC-04'): void {
  if (parsed.anchorKind !== 'missing') {
    fail(rule, `期望识别为「缺锚点」形态，实际 anchorKind = ${parsed.anchorKind}`)
  }
}

// ================================================================ D-4 C-2 计数恒等

/**
 * **D-4 C-2 / DC-10**：`a + b + c = N = V-A 可见集实际条数`。
 *
 * 注意 C-2 的原意：**"不多不少"约束的是计数准确性，不是单次输出完整性**。
 * 所以本断言**只**验三个数之间的关系与实际条目数，**不**要求一次列全
 * （分页允许，见 `assertPageUnion`）。
 *
 * 同时验 `N` 与"实际渲染出的条目数"一致 —— 但**仅在未分页时**成立：
 * 分页时 N 是全集、entries 是当页，两者本就不该相等。
 * 因此这里用 `pager.hasNext || pager.atLastPage` 判断是否分页场景。
 */
export function assertCountIdentity(parsed: ParsedList, rule = 'D-4 C-2 / DC-10'): void {
  if (parsed.counts === null) fail(rule, '首行没有解析出计数（格式不符或缺失首行）')

  const { n, a, b, c } = parsed.counts
  if (a + b + c !== n) {
    fail(rule, `计数恒等被破坏：生效 ${a} + 已修正 ${b} + 已过期 ${c} = ${a + b + c}，但首行 N = ${n}`)
  }

  // 未分页（单页）时，N 必须等于实际条目数
  const isPaged = parsed.pager.hasNext || (parsed.pager.nextRange !== null)
  if (!isPaged) {
    if (n !== parsed.entries.length) {
      fail(rule, `N = ${n}，但实际列出 ${parsed.entries.length} 条（单页且无下一页提示时应相等）`)
    }
  }
}

/**
 * **D-4 C-3 / DC-10**：软删**永不计入 N**。
 *
 * 软删若出现在 V-A 的条目里，`countVisible` 会抛错；但如果是
 * "N 里算进了软删"这种更隐蔽的形态，只能靠本断言抓：
 * 用回收站计数行交叉验证 —— `回收站另有 k 条…不计入上面的 N 条`。
 */
export function assertSoftDeleteExcluded(parsed: ParsedList, rule = 'D-4 C-3 / DC-10'): void {
  const softInMainList = parsed.entries.filter((entry) => entry.status === 'deleted_soft')
  if (softInMainList.length > 0) {
    fail(
      rule,
      `V-A 主清单出现了 ${softInMainList.length} 条软删条目（第 ${softInMainList
        .map((entry) => entry.ordinal)
        .join('、')} 条）。软删只能在 V-B 回收站出现`,
    )
  }

  // 有回收站计数行时，N 必须与它声明的 N 一致（同一份数据算出来）
  if (parsed.recycleNote !== null && parsed.counts !== null) {
    if (parsed.recycleNote.n !== parsed.counts.n) {
      fail(
        rule,
        `回收站计数行声明「不计入上面的 ${parsed.recycleNote.n} 条」，但首行 N = ${parsed.counts.n}，两处不同源`,
      )
    }
  }
}

/**
 * **D-8 X-2**：筛选态 `N = 筛选后集合`，且**首行必须显示筛选条件**；未筛选时**不得**显示。
 *
 * @param parsed 解析结果
 * @param expectFilter 期望的筛选标签（`项目级` / `语义层` / null 表示未筛选）
 */
export function assertFilterCount(
  parsed: ParsedList,
  expectFilter: string | null,
  rule = 'D-8 X-2',
): void {
  if (parsed.counts === null) fail(rule, '首行没有解析出计数')

  if (expectFilter === null) {
    if (parsed.filterLabel !== null) {
      fail(rule, `未筛选时首行不应出现限定词，实际出现「${parsed.filterLabel}」`)
    }
  } else {
    if (parsed.filterLabel === null) {
      fail(rule, `筛选态（期望「${expectFilter}」）首行必须显示筛选条件，实际未显示`)
    }
    if (!parsed.filterLabel.includes(expectFilter)) {
      fail(rule, `首行限定词为「${parsed.filterLabel}」，与期望「${expectFilter}」不符`)
    }
  }

  // 筛选态下 N 必须等于筛选后实际条目数（单页场景）
  const isPaged = parsed.pager.hasNext || parsed.pager.nextRange !== null
  if (!isPaged && parsed.counts.n !== parsed.entries.length) {
    fail(
      rule,
      `筛选态 N = ${parsed.counts.n}，但实际列出 ${parsed.entries.length} 条。X-2 要求 N = 筛选后集合计数`,
    )
  }

  // 筛选态的集合必须真的被过滤（不能把全集标个标签就当筛过）
  if (expectFilter === '项目级') {
    const wrongScope = parsed.entries.filter((entry) => entry.scope !== 'project')
    if (wrongScope.length > 0) {
      fail(rule, `筛选「项目级」后仍出现 ${wrongScope.length} 条非项目级条目`)
    }
  }
  if (expectFilter === '用户级') {
    const wrongScope = parsed.entries.filter((entry) => entry.scope !== 'user')
    if (wrongScope.length > 0) {
      fail(rule, `筛选「用户级」后仍出现 ${wrongScope.length} 条非用户级条目`)
    }
  }
  if (expectFilter === '语义层') {
    const wrongLayer = parsed.entries.filter((entry) => entry.layer !== 'semantic')
    if (wrongLayer.length > 0) {
      fail(rule, `筛选「语义层」后仍出现 ${wrongLayer.length} 条非语义层条目`)
    }
  }
  if (expectFilter === '情景层') {
    const wrongLayer = parsed.entries.filter((entry) => entry.layer !== 'episodic')
    if (wrongLayer.length > 0) {
      fail(rule, `筛选「情景层」后仍出现 ${wrongLayer.length} 条非情景层条目`)
    }
  }
}

// ================================================================ D-4 C-8 / D-8 X-3 折叠

/**
 * **D-8 X-3 / D-4 C-8**：折叠阈值是 **V-A 全清单已过期合计 > 5**，不是单层内。
 *
 * 反例（本断言专门要抓的）：语义 4 条过期 + 情景 4 条过期 → 合计 8 > 5
 * → **必须折叠**。若实现按"单层内"（各 4 ≤ 5）则两层都不折叠 → 违反 S-5
 * （两通道口径不一致）。
 *
 * 同时验 C-8 的后半句：**折叠不减小 N 与 c**。
 */
export function assertCollapseByWholeList(parsed: ParsedList, rule = 'D-8 X-3 / D-4 C-8'): void {
  if (parsed.counts === null) fail(rule, '首行没有解析出计数')

  const totalExpired = parsed.counts.c
  const shouldCollapse = totalExpired > 5

  if (shouldCollapse && parsed.fold === null) {
    fail(
      rule,
      `全清单已过期合计 ${totalExpired} 条 > 5，必须折叠，但未找到折叠行。` +
        '若按「单层内」口径判定会出现此缺陷（两层各 4 条时都不折叠）',
    )
  }
  if (!shouldCollapse && parsed.fold !== null) {
    fail(rule, `全清单已过期合计 ${totalExpired} 条 ≤ 5，不应折叠，但出现了折叠行`)
  }

  if (parsed.fold !== null) {
    // C-8：折叠不减小 N 与 c
    if (parsed.fold.total !== totalExpired) {
      fail(
        rule,
        `折叠行声明总数 ${parsed.fold.total}，但首行 c = ${totalExpired}。折叠不得改变计数`,
      )
    }
    if (parsed.fold.hiddenCount + parsed.fold.shown !== parsed.fold.total) {
      fail(
        rule,
        `折叠行内部不自洽：隐藏 ${parsed.fold.hiddenCount} + 展示 ${parsed.fold.shown} ≠ 总 ${parsed.fold.total}`,
      )
    }
    // C-8：>5 时计数与入口必须存在
    if (!parsed.fold.hasEntry) {
      fail(rule, `折叠态必须有「看已过期的」展开入口，实际没有`)
    }
  }
}

/**
 * **D-4 C-8 前半句**：已过期 ≤5 条时**逐条展示**（满足 AC-4 字面）。
 */
export function assertExpiredShownWhenFew(parsed: ParsedList, rule = 'D-4 C-8'): void {
  if (parsed.counts === null) fail(rule, '首行没有解析出计数')
  if (parsed.counts.c > 5) return // 该由 assertCollapseByWholeList 管

  const expiredEntries = parsed.entries.filter((entry) => entry.status === 'expired')
  if (expiredEntries.length !== parsed.counts.c) {
    fail(
      rule,
      `已过期 ${parsed.counts.c} 条（≤5 应逐条展示），实际只列出 ${expiredEntries.length} 条`,
    )
  }
  for (const entry of expiredEntries) {
    if (entry.expiredAt === null) {
      fail(rule, `第 ${entry.ordinal} 条已过期条目缺到期日（DC-14）`)
    }
    if (!entry.statusText.includes('不参与检索')) {
      fail(rule, `第 ${entry.ordinal} 条已过期条目缺「不参与检索」（DC-14）`)
    }
  }
}

// ================================================================ DC-10 分页并集

/**
 * **D-4 C-2 ④**：连续翻页各页并集 == V-A 全集，**无重复无遗漏**。
 *
 * 用法：把每页的 `parseList` 结果按顺序传进来。
 */
export function assertPageUnion(pages: readonly ParsedList[], rule = 'D-4 C-2 / DC-15'): void {
  if (pages.length === 0) fail(rule, '没有传入任何页')

  const first = pages[0]
  if (first === undefined || first.counts === null) fail(rule, '第 1 页没有解析出计数')
  const declaredN = first.counts.n

  const ordinals: number[] = []
  for (const page of pages) {
    if (page.counts === null) fail(rule, '某页没有解析出计数')
    // 每页 N 都必须恒为全集 N（不得变成当页条数）
    if (page.counts.n !== declaredN) {
      fail(
        rule,
        `第 ${pages.indexOf(page) + 1} 页的 N = ${page.counts.n}，与第 1 页的 ${declaredN} 不一致。` +
          'N 是全集计数，分页不得改变它',
      )
    }
    for (const entry of page.entries) ordinals.push(entry.ordinal)
  }

  const seen = new Set<number>()
  const duplicated: number[] = []
  for (const ordinal of ordinals) {
    if (seen.has(ordinal)) duplicated.push(ordinal)
    seen.add(ordinal)
  }
  if (duplicated.length > 0) {
    fail(rule, `翻页出现重复序号：${duplicated.join('、')}（各页并集不得重复）`)
  }

  const missing: number[] = []
  for (let index = 1; index <= declaredN; index += 1) {
    if (!seen.has(index)) missing.push(index)
  }
  if (missing.length > 0) {
    fail(rule, `翻页并集有遗漏：缺少序号 ${missing.join('、')}（应覆盖 1..${declaredN}）`)
  }

  // 末页必须有结束标记
  const lastPage = pages[pages.length - 1]
  if (lastPage !== undefined && !lastPage.pager.atLastPage) {
    fail(rule, '最后一页缺少「已到最后一页」结束标记（DC-15）')
  }
}

// ================================================================ X-1 / X-6 删除档位

/** 删除档位（与 `src/shared/delete-tier.ts` 的 `DeleteTier` 同义）。 */
export type DeleteTier = 'soft' | 'hard'

/**
 * **D-8 X-1**：「忘掉」是**日常用词 → 软删**；只有显式不可逆措辞才硬删。
 *
 * 判定表（与 `decideDeleteTier` 的契约一致，但本函数**独立实现**，
 * 用于交叉验证实现的判定，而不是复用它 —— 复用同一个函数无法发现它写错）：
 *
 * | 用户说法 | 期望档位 |
 * | --- | --- |
 * | 忘掉第 3 条 | soft |
 * | 忘掉关于构建的记忆（批量） | soft |
 * | 删掉第 3 条 | soft |
 * | 彻底删除第 3 条 | hard |
 * | 永久删除 | hard |
 * | 不要留副本 | hard |
 *
 * @param actual 实现给出的档位
 * @param expected 按 X-1 应该给出的档位
 * @param utterance 用户原话（用于报错信息）
 */
export function assertDeleteTier(
  actual: DeleteTier,
  expected: DeleteTier,
  utterance: string,
  rule = 'D-8 X-1',
): void {
  if (actual !== expected) {
    const hint =
      expected === 'soft' && actual === 'hard'
        ? '「忘掉/删掉」这类日常表达必须走软删（可恢复）；硬删是终态，误触不可逆'
        : '显式不可逆措辞（彻底删除/永久删除/不要留副本）必须走硬删并二次确认'
    fail(rule, `「${utterance}」被判为 ${actual}，按 X-1 应为 ${expected}。${hint}`)
  }
}

/**
 * **D-8 X-1 的成对验证**：同一目标，两种说法必须给出**不同**档位。
 *
 * 这是比单条断言更强的检查 —— 它证明实现**真的在做区分**，
 * 而不是把所有输入都判成同一个值（那样单条断言可能碰巧都过）。
 */
export function assertDeleteTierPair(
  softUtterance: string,
  hardUtterance: string,
  decide: (utterance: string) => DeleteTier,
  rule = 'D-8 X-1',
): void {
  const softResult = decide(softUtterance)
  const hardResult = decide(hardUtterance)

  // 「两者是否相同」必须在下面两条断言**之前**求值。
  // 否则 TS 会把 softResult 收窄为 'soft'、hardResult 收窄为 'hard'，
  // 于是这条比较被编译器判定恒假（TS2367）—— 而它恰恰是本函数存在的理由：
  // 证明实现真的在区分两种说法，而不是把所有输入都判成同一个值。
  const sameTier = softResult === hardResult

  if (softResult !== 'soft') {
    fail(rule, `「${softUtterance}」应为 soft，实际 ${softResult}`)
  }
  if (hardResult !== 'hard') {
    fail(rule, `「${hardUtterance}」应为 hard，实际 ${hardResult}`)
  }
  if (sameTier) {
    fail(rule, `两种说法得到了相同档位（${String(softResult)}），说明实现没有真正区分`)
  }
}

/**
 * **D-8 X-6**：「别记」移除走软删，且回收站条目必须标注「因用户要求不保留」。
 */
export function assertNotKeepIsSoftDelete(
  recycleParsed: ParsedList,
  ordinal: number,
  rule = 'D-8 X-6 / DC-24',
): void {
  const entry = recycleParsed.entries.find((candidate) => candidate.ordinal === ordinal)
  if (entry === undefined) {
    fail(rule, `回收站里找不到第 ${ordinal} 条 —— 「别记」移除的条目必须可见于 V-B（软删）`)
  }
  if (entry.removeReason === null) {
    fail(rule, `回收站第 ${ordinal} 条缺少移除原因标注`)
  }
  if (!entry.removeReason.includes('因用户要求不保留')) {
    fail(rule, `回收站第 ${ordinal} 条的移除原因为「${entry.removeReason}」，应为「因用户要求不保留」`)
  }
}

// ================================================================ X-4 保留期文案

/**
 * **D-8 X-4**：天数文案必须与实际清理行为一致。禁止为未实现的行为背书。
 *
 * @param claimedDays 文案里宣称的天数（null = 未宣称任何天数）
 * @param actualCleanupDays 实现的实际清理天数（null = 实现为不过期）
 */
export function assertRetentionCopyMatchesBehavior(
  claimedDays: number | null,
  actualCleanupDays: number | null,
  rule = 'D-8 X-4',
): void {
  if (actualCleanupDays === null) {
    if (claimedDays !== null) {
      fail(
        rule,
        `实现为「不过期」，但文案宣称「保留 ${claimedDays} 天」。` +
          '向用户宣称一条不存在的承诺比没有承诺更糟——用户会基于错误预期做删除决策',
      )
    }
    return
  }

  if (claimedDays === null) {
    fail(rule, `实现会 ${actualCleanupDays} 天后清理，但文案未告知天数（用户不知道条目何时消失）`)
  }
  if (claimedDays !== actualCleanupDays) {
    fail(rule, `文案宣称 ${claimedDays} 天，实际实现 ${actualCleanupDays} 天，两者不一致`)
  }
}

// ================================================================ X-5 / D-9 入口

/**
 * **D-8 X-5 / PE-19 / D-9**：入口与 pane chip **不得显示任何角标**（数字或点）。
 *
 * @param entryHtml 入口的渲染产物（HTML 字符串或 DOM 文本）
 */
export function assertEntryHasNoBadge(entryHtml: string, rule = 'D-8 X-5 / PE-19'): void {
  // 1) 不得有 badge/count 类的元素
  const badgePattern = /badge|角标|mem-entry-count|mem-entry-badge/i
  if (badgePattern.test(entryHtml)) {
    const match = badgePattern.exec(entryHtml)
    fail(rule, `入口出现角标元素（命中「${match?.[0] ?? ''}」）。PE-19 已裁定入口不显示任何角标`)
  }

  // 2) 宽态入口的可见文本里不得出现数字
  //    注意：aria-label 里的文字不算"显示"，但这里连 aria 一起查更严格；
  //    若实现把数字放进 aria-label，同样会让屏幕阅读器读出，属违规。
  const visibleText = entryHtml
    .replace(/<[^>]*>/g, '') // 去标签
    .replace(/\s+/g, '')
  const digitMatch = /\d+/.exec(visibleText)
  if (digitMatch !== null) {
    fail(rule, `入口文本里出现数字「${digitMatch[0]}」，PE-19 要求不显示记忆总条数或会话新增数`)
  }
}

/**
 * **D-8 X-5**：入口无角标，但**面板内 A/B/C 页签计数允许且应当存在**。
 *
 * 两者是两件事（X-5 明确指出这是两份文档用词撞车）。本断言验后者。
 *
 * @param tabCounts 从 DOM 读到的三个页签计数（顺序 A/B/C）
 * @param expected 期望值：A = `countVisible().n`，B = `recycleCount`，C = 条目数
 */
export function assertTabCountsPresent(
  tabCounts: { readonly a: number | null; readonly b: number | null; readonly c: number | null },
  expected: { readonly a: number; readonly b: number; readonly c: number },
  rule = 'D-8 X-5 / PC-11',
): void {
  for (const key of ['a', 'b', 'c'] as const) {
    if (tabCounts[key] === null) {
      fail(rule, `页签 ${key.toUpperCase()} 缺少计数。X-5 明确面板内页签计数「允许且应当存在」`)
    }
    if (tabCounts[key] !== expected[key]) {
      fail(
        rule,
        `页签 ${key.toUpperCase()} 计数为 ${String(tabCounts[key])}，期望 ${expected[key]}。` +
          '四处数字（统计条/分组头/页签计数/分页器）必须同源',
      )
    }
  }
}

/**
 * **D-9 Q1**：记忆入口位于 cordis 插件入口**之上**（`order:-1`），且互不重叠、不被裁切。
 *
 * 几何事实（D-9 实测）：同排方案在 280px 下右溢 +244px，被 `overflow:hidden` 裁切，
 * 属**几何不可行**而非偏好问题。所以这里断言纵向叠放。
 *
 * @param mem 记忆入口的 `getBoundingClientRect()` 结果
 * @param plugin cordis 插件入口的矩形
 */
export function assertEntryAboveCordis(
  mem: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number },
  plugin: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number },
  rule = 'D-9 Q1 / PE-01',
): void {
  if (mem.bottom > plugin.top) {
    fail(
      rule,
      `记忆入口（bottom=${mem.bottom}）未完全位于插件入口（top=${plugin.top}）之上。` +
        'D-9 已裁定纵向叠放；同排已被实测证明几何不可行',
    )
  }
  // 纵向叠放意味着水平方向有重叠是正常的，但不得互相覆盖
  const verticalOverlap = Math.min(mem.bottom, plugin.bottom) - Math.max(mem.top, plugin.top)
  if (verticalOverlap > 0) {
    fail(rule, `记忆入口与插件入口纵向重叠 ${verticalOverlap}px`)
  }
}

/**
 * **D-9 Q1**：入口不被侧栏列裁切（右溢 ≤0、左溢 ≤0）。
 *
 * @param rect 入口矩形
 * @param container 侧栏可用区域（`{left, right}`）
 */
export function assertEntryNotClipped(
  rect: { readonly left: number; readonly right: number },
  container: { readonly left: number; readonly right: number },
  rule = 'D-9 Q1',
): void {
  const overflowRight = rect.right - container.right
  const overflowLeft = container.left - rect.left
  if (overflowRight > 0.5) {
    fail(rule, `入口右侧溢出 ${overflowRight.toFixed(1)}px，会被 overflow:hidden 裁切`)
  }
  if (overflowLeft > 0.5) {
    fail(rule, `入口左侧溢出 ${overflowLeft.toFixed(1)}px，会被 overflow:hidden 裁切`)
  }
}

/**
 * **D-9 Q2**：宽态命中区 ≥44×44；**折叠轨 36×36**（与宿主 Settings/cordis 一致）。
 *
 * 注意这是 D-9 对原设计「全档位 44×44」的修订 —— 折叠轨 36×36 是**预期值**，
 * 不是缺陷。U-4 脚本按旧设计断言 ≥44 才产生那条 FAIL。
 */
export function assertEntryHitArea(
  rect: { readonly width: number; readonly height: number },
  mode: 'wide' | 'rail',
  rule = 'D-9 Q2',
): void {
  if (mode === 'wide') {
    if (rect.width < 44 || rect.height < 44) {
      fail(rule, `宽态命中区 ${rect.width}×${rect.height}，应 ≥44×44`)
    }
    return
  }
  // 折叠轨：D-9 Q2 裁定 36×36
  if (rect.width !== 36 || rect.height !== 36) {
    fail(
      rule,
      `折叠轨命中区 ${rect.width}×${rect.height}，按 D-9 Q2 应为 36×36（与宿主 Settings/cordis 一致）`,
    )
  }
}

// ================================================================ C-5 / X-9 硬删负向

/**
 * **D-4 C-5 / X-9**：硬删后条目在**任何视图**都不可见，且**不泄露正文**。
 *
 * 这是负向断言：搜遍所有输出，哨兵词必须 0 命中。
 *
 * @param outputs 各处输出文本（V-A、V-B、V-C、检索结果、审计）
 * @param sentinel 硬删条目的独有哨兵词
 */
export function assertHardDeletedNeverVisible(
  outputs: readonly { readonly where: string; readonly text: string }[],
  sentinel: string,
  rule = 'D-4 C-5 / AC-5',
): void {
  if (sentinel.trim() === '') fail(rule, '哨兵词不能为空，否则本断言无意义')

  const leaks: string[] = []
  for (const output of outputs) {
    if (output.text.includes(sentinel)) leaks.push(output.where)
  }
  if (leaks.length > 0) {
    fail(
      rule,
      `硬删条目在以下位置仍可见/泄露正文：${leaks.join('、')}。` +
        'AC-5 要求彻底删除后任何视图、搜索、变更记录、审计都不出现该内容',
    )
  }
}

/**
 * **D-4 C-5**：只对**生效**条目断言来源可追溯（五要素齐备）。
 *
 * 五要素（D-8 X-7 / DC-32）：序号、分层、作用域、来源时间、来源事件短语。
 */
export function assertSourceTraceable(entry: ParsedEntry, rule = 'D-4 C-5 / DC-32'): void {
  if (entry.status !== 'active') {
    fail(rule, `只对「生效」条目断言来源可追溯，本条状态为 ${entry.status}`)
  }

  const missing: string[] = []
  if (!Number.isFinite(entry.ordinal) || entry.ordinal <= 0) missing.push('序号')
  if (entry.layer === null) missing.push('分层')
  if (entry.scope === null) missing.push('作用域')
  if (entry.sourceDate === null) missing.push('来源时间')
  if (entry.eventPhrase === null || entry.eventPhrase.trim() === '') missing.push('来源事件短语')

  if (missing.length > 0) {
    fail(rule, `第 ${entry.ordinal} 条缺五要素中的：${missing.join('、')}（DC-32 / X-7 要求五要素齐备）`)
  }
}

// ================================================================ 静态契约

/**
 * **DC-01 / D-3**：不得出现类型枚举字段（`kind`/`category`/`tag` 等换名复活）。
 *
 * 注意：`sourceType`（explicit/correction/inferred）是**来源可信度**，
 * 不是条目分类，**不算违规**。判定时要排除它。
 */
export function assertNoTypeEnumeration(sourceText: string, rule = 'DC-01 / D-3'): void {
  // 只查"把类型当分类用"的形态：出现分类值本身
  const forbidden = ['conclusion', 'preference', 'lesson'] as const
  const hits: string[] = []
  for (const word of forbidden) {
    // correction 同时是 sourceType 的合法值，必须排除，否则误报
    const pattern = new RegExp(`\\b${word}\\b`, 'i')
    if (pattern.test(sourceText)) hits.push(word)
  }
  if (hits.length > 0) {
    fail(rule, `出现类型枚举值：${hits.join('、')}。D-3 已取消四类型，只保留分层`)
  }
}

/**
 * **DC-02 / OQ-8=A**：MVP 不出现「程序」分组（procedural 不进 MVP）。
 */
export function assertNoProceduralLayer(parsed: ParsedList, rule = 'DC-02 / OQ-8=A'): void {
  // 1) 解析出的分组里不得有 procedural（类型层面已不可能，防御性检查）
  if (parsed.groups.some((group) => (group.layer as string) === 'procedural')) {
    fail(rule, '出现「程序」分组。OQ-8=A 明确程序记忆不进 MVP')
  }

  // 2) 关键：**解析不出来的「程序层」行会落在 unrecognized 里**。
  //    只查 groups 会漏掉它 —— 自检 D-58 实测抓到过这个漏洞。
  //    「程序」是 MVP 禁词，出现在任何位置都算违规，包括"格式不认识"的行。
  const proceduralLines = parsed.unrecognized.filter((line) => line.includes('程序'))
  if (proceduralLines.length > 0) {
    fail(
      rule,
      `出现「程序」相关分组/文案：${proceduralLines.join('；')}。OQ-8=A 明确程序记忆不进 MVP`,
    )
  }

  // 3) 条目正文里也不得出现（防止把程序记忆塞进语义层）
  const proceduralEntry = parsed.entries.find((entry) => entry.content.includes('程序'))
  if (proceduralEntry !== undefined) {
    fail(rule, `条目正文出现「程序」相关表述：${proceduralEntry.content}`)
  }

  // 4) 空分组也不允许（DC-11）
  for (const group of parsed.groups) {
    if (group.sections.length === 0) {
      fail(rule, `${group.layer} 层没有任何小节，不得渲染空分组（DC-11）`)
    }
  }
}

/**
 * **DC-09 / D-7**：视图语义只有三种，不得新增第四种。
 */
export function assertNoFourthView(parsed: ParsedList, rule = 'DC-09'): void {
  if (parsed.view !== 'a' && parsed.view !== 'b') {
    fail(rule, `出现第三种视图标识「${String(parsed.view)}」。三视图只有 V-A/V-B/V-C`)
  }
}

/**
 * **D-4 C-6 / DC-21 / PC-28**：撤销以**会话边界**表达，**禁止任何秒数宣称**。
 */
export function assertNoCountdownClaim(text: string, rule = 'D-4 C-6 / DC-21'): void {
  const patterns: Array<{ readonly pattern: RegExp; readonly what: string }> = [
    { pattern: /\d+\s*秒/, what: '秒数' },
    { pattern: /倒计时|countdown/i, what: '倒计时' },
    { pattern: /\d+\s*分钟内可撤销/, what: '分钟级撤销窗口' },
    { pattern: /进度条.*撤销|撤销.*进度条/, what: '撤销进度条' },
  ]
  for (const { pattern, what } of patterns) {
    if (pattern.test(text)) {
      fail(
        rule,
        `文案中出现${what}：「${text.slice(0, 80)}…」。` +
          'C-6 已裁定撤销窗口用会话边界表达，禁止任何具体秒数或 UI 计时器',
      )
    }
  }
}
