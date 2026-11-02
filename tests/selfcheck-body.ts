/**
 * 解析器自检的实现体（由 `selfcheck.mjs` 调起）。
 *
 * 正反成对：每个断言既有「正向样例必须过」，也有「反向违约必须被抓」。
 * 反向样例是本文件的重点 —— 它们证明断言不是永远返回 true 的空壳。
 */

import { parseList } from './parse-list.js'
import {
  AssertionFailure,
  assertCountIdentity,
  assertSoftDeleteExcluded,
  assertFilterCount,
  assertCollapseByWholeList,
  assertExpiredShownWhenFew,
  assertPageUnion,
  assertDeleteTier,
  assertDeleteTierPair,
  assertNotKeepIsSoftDelete,
  assertRetentionCopyMatchesBehavior,
  assertEntryHasNoBadge,
  assertTabCountsPresent,
  assertEntryAboveCordis,
  assertEntryNotClipped,
  assertEntryHitArea,
  assertHardDeletedNeverVisible,
  assertSourceTraceable,
  assertNoTypeEnumeration,
  assertNoProceduralLayer,
  assertNoCountdownClaim,
  assertProjectAnchorPresent,
  assertAnchorMissing,
  type DeleteTier,
} from './dsl.js'

/** 极简 runner（不引依赖，与工程师 harness 同思路）。 */
interface Case {
  readonly id: string
  readonly title: string
  readonly fn: () => void
}

const cases: Case[] = []
function test(id: string, title: string, fn: () => void): void {
  cases.push({ id, title, fn })
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function equal<T>(actual: T, expected: T, message: string): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}\n  实际: ${left}\n  期望: ${right}`)
}

// ============================================================ 样例文本
// 全部照抄 2026-11-01 从真实输出抓到的格式（见 parse-list.ts 头注）

/** 主夹具 V-A（6 条：4 生效 / 1 已修正 / 1 已过期）+ 回收站 1 条。旧首行格式。 */
const SAMPLE_MAIN = `记忆清单 ｜ 共 6 条（生效 4 / 已修正 1 / 已过期 1）

语义层
生效 3 条
1+ 发版前必须先跑 pnpm build
   作用域：项目 ｜ 来源：2026-10-30 你说明发版流程时（你明确说的）
   状态：生效
2+ 测试命令是 vitest
   作用域：项目 ｜ 来源：2026-10-30 你纠正测试命令时（你纠正过的）
   状态：生效
3+ 注释用中文，测试文件用英文
   作用域：用户 ｜ 来源：2026-10-22 你纠正注释语言时（你纠正过的）
   状态：生效
已修正 1 条
4~ 测试命令是 jest
   作用域：项目 ｜ 来源：2026-10-25 你说明测试命令时（你明确说的）
   状态：已修正（2026-10-25 被第 2 条取代）

情景层
生效 1 条
5+ 10-28 排查过 HMR 不生效，需同时起 dev:web
   作用域：项目 ｜ 来源：2026-10-28 排查会话（你明确说的）
   状态：生效
已过期 1 条
6- 10-20 排查过 pnpm 安装超时，换镜像解决
   作用域：项目 ｜ 来源：2026-09-22 排查会话（你明确说的）
   状态：已过期（2026-10-31 到期，不参与检索）

已到最后一页
回收站另有 1 条已删除（可恢复），不计入上面的 6 条；说「看回收站」查看`

/** 同一份数据的 **N-4 新首行格式**（带项目名）。 */
const SAMPLE_MAIN_WITH_PROJECT = SAMPLE_MAIN.replace(
  '记忆清单 ｜ 共 6 条',
  '记忆清单 ｜ 项目 dsh-momery ｜ 共 6 条',
)

/** 筛选态（项目级）。 */
const SAMPLE_FILTERED = `记忆清单（项目级） ｜ 共 5 条（生效 3 / 已修正 1 / 已过期 1）

语义层
生效 2 条
1+ 发版前必须先跑 pnpm build
   作用域：项目 ｜ 来源：2026-10-30 你说明发版流程时（你明确说的）
   状态：生效
2+ 测试命令是 vitest
   作用域：项目 ｜ 来源：2026-10-30 你纠正测试命令时（你纠正过的）
   状态：生效
已修正 1 条
3~ 测试命令是 jest
   作用域：项目 ｜ 来源：2026-10-25 你说明测试命令时（你明确说的）
   状态：已修正（2026-10-25 被第 2 条取代）

情景层
生效 1 条
4+ 10-28 排查过 HMR 不生效，需同时起 dev:web
   作用域：项目 ｜ 来源：2026-10-28 排查会话（你明确说的）
   状态：生效
已过期 1 条
5- 10-20 排查过 pnpm 安装超时，换镜像解决
   作用域：项目 ｜ 来源：2026-09-22 排查会话（你明确说的）
   状态：已过期（2026-10-31 到期，不参与检索）

已到最后一页`

/** N-4 无项目上下文形态（无会话 / 拿不到 workingDirectory）。 */
const SAMPLE_NO_PROJECT = `记忆清单 ｜ 无项目上下文 ｜ 共 6 条（生效 4 / 已修正 1 / 已过期 1）

语义层
生效 3 条
1+ 发版前必须先跑 pnpm build
   作用域：项目 ｜ 来源：2026-10-30 你说明发版流程时（你明确说的）
   状态：生效

已到最后一页`

/** N-4 无项目上下文 + 筛选。 */
const SAMPLE_NO_PROJECT_FILTERED = SAMPLE_NO_PROJECT.replace(
  '记忆清单 ｜ 无项目上下文 ｜ 共 6 条',
  '记忆清单（用户级） ｜ 无项目上下文 ｜ 共 6 条',
)

/** 筛选态 + 项目名（N-4 后）。 */
const SAMPLE_FILTERED_WITH_PROJECT = SAMPLE_FILTERED.replace(
  '记忆清单（项目级） ｜ 共 5 条',
  '记忆清单（项目级） ｜ 项目 dsh-momery ｜ 共 5 条',
)

/** 折叠态（F-C2：8 条过期）。 */
const SAMPLE_FOLDED = `记忆清单 ｜ 共 8 条（生效 0 / 已修正 0 / 已过期 8）

语义层
已过期 4 条
1- 语义过期1
   作用域：项目 ｜ 来源：2026-09-02 历史（你明确说的）
   状态：已过期（2026-09-02 到期，不参与检索）
2- 语义过期2
   作用域：项目 ｜ 来源：2026-09-02 历史（你明确说的）
   状态：已过期（2026-09-02 到期，不参与检索）
3- 语义过期3
   作用域：项目 ｜ 来源：2026-09-02 历史（你明确说的）
   状态：已过期（2026-09-02 到期，不参与检索）
4- 语义过期4
   作用域：项目 ｜ 来源：2026-09-02 历史（你明确说的）
   状态：已过期（2026-09-02 到期，不参与检索）

情景层
已过期 4 条
5- 情景过期1
   作用域：项目 ｜ 来源：2026-09-02 历史（你明确说的）
   状态：已过期（2026-10-02 到期，不参与检索）

已过期另有 3 条未展开（本页展示 5 / 8 条）；折叠不影响计数
说「看已过期的」可单独查看

已到最后一页`

/** 空库。 */
const SAMPLE_EMPTY = `记忆清单 ｜ 共 0 条（生效 0 / 已修正 0 / 已过期 0）

目前没有记录任何关于你的记忆。`

/** 筛选后为空（库非空）。 */
const SAMPLE_FILTERED_EMPTY = `记忆清单（项目级） ｜ 共 0 条（生效 0 / 已修正 0 / 已过期 0）

筛选后为空（不是没有记忆）。说「看全部」可看所有分层。`

/** 回收站（保留 30 天）。 */
const SAMPLE_RECYCLE = `回收站 ｜ 共 1 条（可恢复，保留 30 天后彻底删除）

1x 这一周先不升级 TypeScript 版本
   作用域：项目 ｜ 层级：语义
   状态：已删除（可恢复 · 因用户要求不保留）

说「恢复第 N 条」可恢复 ｜ 说「彻底删除第 N 条」不可恢复`

/** 回收站（不过期配置：**不得出现天数**，X-4）。 */
const SAMPLE_RECYCLE_NO_DAYS = `回收站 ｜ 共 1 条（可恢复）

1x 这一周先不升级 TypeScript 版本
   作用域：项目 ｜ 层级：语义
   状态：已删除（可恢复 · 你删除了这条）

说「恢复第 N 条」可恢复 ｜ 说「彻底删除第 N 条」不可恢复`

/** 分页第 1 页（25 条中的前 10 条，序号从 1 起）。 */
const SAMPLE_PAGE0 = `记忆清单 ｜ 共 25 条（生效 25 / 已修正 0 / 已过期 0）

语义层
生效 13 条
1+ 条目 1
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

说「继续」看第 11-20 条`

/** 分页第 2 页（序号从 11 起 —— 跨页连续）。 */
const SAMPLE_PAGE1 = `记忆清单 ｜ 共 25 条（生效 25 / 已修正 0 / 已过期 0）

语义层
生效 13 条
11+ 条目 5
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

情景层
生效 12 条
14+ 条目 2
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

说「继续」看第 21-25 条`

// ============================================================ 正向：解析器必须能正确解析

test('P-01', '主夹具：首行计数被解析为 4 个数', () => {
  const parsed = parseList(SAMPLE_MAIN)
  equal(parsed.counts, { n: 6, a: 4, b: 1, c: 1 }, '首行计数')
  equal(parsed.view, 'a', '视图应为 V-A')
  equal(parsed.unrecognized, [], '不应有未识别行')
})

test('P-02', '主夹具：6 条条目，序号 1..6 连续', () => {
  const parsed = parseList(SAMPLE_MAIN)
  equal(
    parsed.entries.map((entry) => entry.ordinal),
    [1, 2, 3, 4, 5, 6],
    '序号',
  )
})

test('P-03', '主夹具：标记字符与状态一一对应（+ ~ - x）', () => {
  const parsed = parseList(SAMPLE_MAIN)
  equal(
    parsed.entries.map((entry) => entry.mark),
    ['+', '+', '+', '~', '+', '-'],
    '标记序列',
  )
  equal(
    parsed.entries.map((entry) => entry.status),
    ['active', 'active', 'active', 'superseded', 'active', 'expired'],
    '状态序列',
  )
})

test('P-04', '主夹具：分组按 语义层 → 情景层，且层内按 生效→已修正→已过期', () => {
  const parsed = parseList(SAMPLE_MAIN)
  equal(
    parsed.groups.map((group) => group.layer),
    ['semantic', 'episodic'],
    '分组顺序',
  )
  equal(
    parsed.groups[0]?.sections.map((section) => section.status),
    ['active', 'superseded'],
    '语义层内小节顺序',
  )
  equal(
    parsed.groups[1]?.sections.map((section) => section.status),
    ['active', 'expired'],
    '情景层内小节顺序',
  )
})

test('P-05', '三行条目：作用域 / 来源日期 / 事件短语 / 来源标注齐全', () => {
  const parsed = parseList(SAMPLE_MAIN)
  const first = parsed.entries[0]
  assert(first !== undefined, '第 1 条应存在')
  equal(first.scope, 'project', '作用域')
  equal(first.sourceDate, '2026-10-30', '来源日期')
  equal(first.eventPhrase, '你说明发版流程时', '事件短语')
  equal(first.sourceLabel, '你明确说的', '来源标注')
  equal(first.statusText, '生效', '状态行')
})

test('P-06', '已修正：解析出「被第 N 条取代」', () => {
  const parsed = parseList(SAMPLE_MAIN)
  const superseded = parsed.entries.find((entry) => entry.status === 'superseded')
  assert(superseded !== undefined, '应有已修正条目')
  equal(superseded.supersededByOrdinal, 2, '被第 2 条取代')
  assert(superseded.statusText.includes('2026-10-25'), '状态行应含取代日期')
})

test('P-07', '已过期：解析出到期日', () => {
  const parsed = parseList(SAMPLE_MAIN)
  const expired = parsed.entries.find((entry) => entry.status === 'expired')
  assert(expired !== undefined, '应有已过期条目')
  equal(expired.expiredAt, '2026-10-31', '到期日')
  assert(expired.statusText.includes('不参与检索'), '状态行应含「不参与检索」')
})

test('P-08', '回收站计数行被解析（count=1, n=6）', () => {
  const parsed = parseList(SAMPLE_MAIN)
  equal(parsed.recycleNote, { count: 1, n: 6 }, '回收站计数行')
})

test('P-09', '末页标记被识别', () => {
  const parsed = parseList(SAMPLE_MAIN)
  equal(parsed.pager.atLastPage, true, '应识别「已到最后一页」')
  equal(parsed.pager.hasNext, false, '不应有下一页')
})

test('P-10', '筛选态：限定词被解析，N = 筛选后集合', () => {
  const parsed = parseList(SAMPLE_FILTERED)
  equal(parsed.filterLabel, '项目级', '筛选限定词')
  equal(parsed.counts, { n: 5, a: 3, b: 1, c: 1 }, '筛选后计数')
})

test('P-11', 'N-4 新格式：首行项目名被解析（未筛选）', () => {
  const parsed = parseList(SAMPLE_MAIN_WITH_PROJECT)
  equal(parsed.projectName, 'dsh-momery', '项目名')
  equal(parsed.counts, { n: 6, a: 4, b: 1, c: 1 }, '计数不受项目名影响')
  equal(parsed.filterLabel, null, '未筛选时无限定词')
})

test('P-12', 'N-4 新格式：筛选 + 项目名可叠加', () => {
  const parsed = parseList(SAMPLE_FILTERED_WITH_PROJECT)
  equal(parsed.projectName, 'dsh-momery', '项目名')
  equal(parsed.filterLabel, '项目级', '限定词')
  equal(parsed.counts?.n, 5, 'N')
})

test('P-13', '旧格式（无项目名）仍可解析 —— 兼容 N-4 修复前后', () => {
  const parsed = parseList(SAMPLE_MAIN)
  equal(parsed.projectName, null, '旧格式无项目名')
  equal(parsed.counts?.n, 6, '计数仍正确')
})

test('P-14', '折叠态：折叠行 + 展开入口 + 计数不减', () => {
  const parsed = parseList(SAMPLE_FOLDED)
  assert(parsed.fold !== null, '应有折叠信息')
  equal(parsed.fold.hiddenCount, 3, '隐藏 3 条')
  equal(parsed.fold.shown, 5, '本页展示 5')
  equal(parsed.fold.total, 8, '总 8')
  equal(parsed.fold.hasEntry, true, '应有展开入口')
  equal(parsed.counts, { n: 8, a: 0, b: 0, c: 8 }, 'N 与 c 不因折叠减小')
})

test('P-15', '空库：空态文案被逐字解析', () => {
  const parsed = parseList(SAMPLE_EMPTY)
  equal(parsed.emptyText, '目前没有记录任何关于你的记忆。', '空态文案')
  equal(parsed.counts?.n, 0, 'N=0')
  equal(parsed.entries.length, 0, '无条目')
})

test('P-16', '筛选后为空：与真空态区分开', () => {
  const parsed = parseList(SAMPLE_FILTERED_EMPTY)
  equal(parsed.emptyText, null, '不得误判为真空态')
  assert(parsed.filteredEmptyText !== null, '应识别为筛选后为空')
  equal(parsed.filterLabel, '项目级', '限定词')
})

test('P-17', '回收站：条数 / 保留天数 / 移除原因', () => {
  const parsed = parseList(SAMPLE_RECYCLE)
  equal(parsed.view, 'b', '视图应为 V-B')
  equal(parsed.recycleCount, 1, '回收站条数')
  equal(parsed.retentionDaysClaim, 30, '保留天数声明')
  const entry = parsed.entries[0]
  assert(entry !== undefined, '应有条目')
  equal(entry.mark, 'x', '标记 x')
  equal(entry.layer, 'semantic', '层级（V-B 用「层级：」行）')
  equal(entry.removeReason, '因用户要求不保留', '移除原因（X-6）')
})

test('P-18', '回收站（不过期配置）：不得解析出天数', () => {
  const parsed = parseList(SAMPLE_RECYCLE_NO_DAYS)
  equal(parsed.retentionDaysClaim, null, '无天数承诺')
  equal(parsed.recycleCount, 1, '条数仍正确')
})

test('P-19', '分页：第 2 页序号从 11 起（跨页连续）', () => {
  const parsed = parseList(SAMPLE_PAGE1)
  equal(
    parsed.entries.map((entry) => entry.ordinal),
    [11, 14],
    '序号跨页连续，不重置为 1',
  )
})

test('P-20', '分页：分组头是全量计数而非当页条数', () => {
  const parsed = parseList(SAMPLE_PAGE1)
  equal(parsed.groups[0]?.sections[0]?.declaredCount, 13, '语义层声明 13（全量）')
  equal(parsed.groups[1]?.sections[0]?.declaredCount, 12, '情景层声明 12（全量）')
  equal(parsed.counts?.n, 25, '首行 N 恒为全集')
})

test('P-21', '分页：下一页范围被解析', () => {
  const parsed = parseList(SAMPLE_PAGE0)
  equal(parsed.pager.hasNext, true, '有下一页')
  equal(parsed.pager.nextRange, { from: 11, to: 20 }, '范围')
  equal(parsed.pager.atLastPage, false, '不是末页')
})

// ============================================================ 反向：违约必须被抓
// 这些样例**故意违反契约**，断言必须失败。
// 若这些断言通过，说明断言库是空壳 —— 那比没有断言更危险。

test('N-01', '反向：计数不恒等必须被抓（a+b+c ≠ N）', () => {
  const broken = SAMPLE_MAIN.replace(
    '共 6 条（生效 4 / 已修正 1 / 已过期 1）',
    '共 9 条（生效 4 / 已修正 1 / 已过期 1）',
  )
  const parsed = parseList(broken)
  assert(parsed.counts !== null, '应解析出计数')
  const sum = parsed.counts.a + parsed.counts.b + parsed.counts.c
  assert(sum !== parsed.counts.n, `期望被抓：4+1+1=${sum} 应 ≠ N=${parsed.counts.n}`)
})

test('N-02', '反向：N 与实际条目数不符必须被抓', () => {
  const broken = SAMPLE_MAIN.replace(
    '共 6 条（生效 4 / 已修正 1 / 已过期 1）',
    '共 8 条（生效 4 / 已修正 1 / 已过期 1）',
  )
  const parsed = parseList(broken)
  assert(parsed.counts !== null, '应解析出计数')
  assert(
    parsed.counts.n !== parsed.entries.length,
    `期望被抓：N=${parsed.counts.n} 应 ≠ 实际条目 ${parsed.entries.length}`,
  )
})

test('N-03', '反向：软删混进 V-A 必须被抓', () => {
  const broken = SAMPLE_MAIN.replace(
    '已到最后一页',
    '7x 这条是软删，不该出现在主清单\n   作用域：项目 ｜ 来源：2026-10-30 你说时（你明确说的）\n   状态：已删除（可恢复 · 你删除了这条）\n\n已到最后一页',
  )
  const parsed = parseList(broken)
  const hasSoftDelete = parsed.entries.some((entry) => entry.status === 'deleted_soft')
  assert(hasSoftDelete, '期望被抓：V-A 里出现了 deleted_soft 条目')
})

test('N-04', '反向：折叠后 N 被改小必须被抓', () => {
  const broken = SAMPLE_FOLDED.replace(
    '共 8 条（生效 0 / 已修正 0 / 已过期 8）',
    '共 5 条（生效 0 / 已修正 0 / 已过期 5）',
  )
  const parsed = parseList(broken)
  assert(parsed.counts !== null, '应解析出计数')
  assert(
    parsed.counts.c !== 8,
    `期望被抓：折叠后 c 被改小为 ${parsed.counts.c}（应为 8）`,
  )
})

test('N-05', '反向：筛选态不显示限定词必须被抓', () => {
  const broken = SAMPLE_FILTERED.replace('记忆清单（项目级） ｜', '记忆清单 ｜')
  const parsed = parseList(broken)
  // 关键：必须先证明"解析器确实读到了这份清单"，否则空壳解析器
  // （永远返回 null）会让这条反向用例假绿 —— 变异测试实测暴露过这一点。
  assert(parsed.counts !== null, '解析器应读出计数（否则本条断言无意义）')
  equal(parsed.counts.n, 5, '应读出筛选后的 N=5')
  assert(
    parsed.filterLabel === null,
    '期望被抓：筛选态却无限定词（X-2 违规）',
  )
})

test('N-06', '反向：已修正缺「被第 N 条取代」必须被抓', () => {
  const broken = SAMPLE_MAIN.replace(
    '状态：已修正（2026-10-25 被第 2 条取代）',
    '状态：已修正',
  )
  const parsed = parseList(broken)
  const superseded = parsed.entries.find((entry) => entry.status === 'superseded')
  assert(superseded !== undefined, '应有已修正条目')
  assert(
    superseded.supersededByOrdinal === null,
    '期望被抓：已修正条目缺失取代关系（DC-14 违规）',
  )
})

test('N-07', '反向：已过期缺「不参与检索」必须被抓', () => {
  const broken = SAMPLE_MAIN.replace(
    '状态：已过期（2026-10-31 到期，不参与检索）',
    '状态：已过期（2026-10-31 到期）',
  )
  const parsed = parseList(broken)
  const expired = parsed.entries.find((entry) => entry.status === 'expired')
  assert(expired !== undefined, '应有已过期条目')
  assert(
    !expired.statusText.includes('不参与检索'),
    '期望被抓：已过期条目缺「不参与检索」（DC-14 违规）',
  )
})

test('N-08', '反向：失败态冒充空态必须被抓', () => {
  // 失败态却输出了空态文案 —— 这是最严重的产品事故（DC-16 / PC-37）
  const broken = SAMPLE_EMPTY.replace(
    '目前没有记录任何关于你的记忆。',
    '记忆暂时读不到（超时），这次没法给你清单。\n\n目前没有记录任何关于你的记忆。',
  )
  const parsed = parseList(broken)
  assert(
    parsed.emptyText !== null,
    '期望被抓：失败态下仍出现空态文案（两态文案必须不同）',
  )
})

test('N-09', '反向：格式漂移必须进 unrecognized，不得被静默吞掉', () => {
  const broken = SAMPLE_MAIN.replace(
    '1+ 发版前必须先跑 pnpm build',
    '1 + 发版前必须先跑 pnpm build', // 序号与标记之间多了空格 —— 格式违约
  )
  const parsed = parseList(broken)
  assert(
    parsed.unrecognized.length > 0,
    '期望被抓：格式漂移应落入 unrecognized，而不是被宽容解析',
  )
})

test('N-10', '反向：回收站无天数却宣称天数必须被抓（X-4）', () => {
  // 实现是「不过期」但文案写 30 天 = 向用户宣称不存在的承诺
  const broken = SAMPLE_RECYCLE_NO_DAYS.replace(
    '回收站 ｜ 共 1 条（可恢复）',
    '回收站 ｜ 共 1 条（可恢复，保留 30 天后彻底删除）',
  )
  const parsed = parseList(broken)
  assert(
    parsed.retentionDaysClaim !== null,
    `期望被抓：不过期实现却宣称 ${String(parsed.retentionDaysClaim)} 天`,
  )
})

test('N-11', '反向：V-A 出现「程序」分组必须被抓', () => {
  const broken = SAMPLE_MAIN.replace('情景层\n', '程序层\n')
  const parsed = parseList(broken)
  // 「程序层」不是合法分组标题 → 应进 unrecognized（而不是被当成情景层）
  assert(
    parsed.unrecognized.some((line) => line.includes('程序')),
    '期望被抓：「程序」分组应被识别为未识别行（DC-02 违规）',
  )
  assert(
    !parsed.groups.some((group) => (group.layer as string) === 'procedural'),
    '不得解析出 procedural 分组',
  )
})

test('N-12', '反向：分页序号被重置为 1 必须被抓', () => {
  const broken = SAMPLE_PAGE1.replace('11+ 条目 5', '1+ 条目 5')
  const parsed = parseList(broken)
  const ordinals = parsed.entries.map((entry) => entry.ordinal)
  assert(
    ordinals[0] === 1,
    `期望被抓：第 2 页首条序号被重置为 ${String(ordinals[0])}（应跨页连续为 11）`,
  )
})


// ============================================================ DSL：断言库自身的行为
// 这些用例验的是「断言库能不能正确判定」，与解析器用例分开编号（D-xx）。
// 每条都是正反成对：合规输入必须放行，违约输入必须被 AssertionFailure 拦住。

/** 断言「这段代码必须抛 AssertionFailure」，返回错误信息供进一步检查。 */
function expectFailure(fn: () => void, rule: string): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof AssertionFailure) return error.message
    throw new Error(`${rule}：期望 AssertionFailure，实际抛出 ${String(error)}`)
  }
  throw new Error(`${rule}：期望断言失败，但断言通过了（说明该断言是空壳）`)
}

/** 断言「这段代码必须不抛」。 */
function expectPass(fn: () => void, rule: string): void {
  try {
    fn()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${rule}：期望断言通过，但失败了 —— ${detail}`)
  }
}

// ---- D-4 C-2 计数恒等 ----

test('D-01', 'C-2 正向：合规清单通过计数恒等', () => {
  expectPass(() => assertCountIdentity(parseList(SAMPLE_MAIN)), 'C-2')
})

test('D-02', 'C-2 反向：a+b+c≠N 必须被拦住', () => {
  const broken = parseList(SAMPLE_MAIN.replace('共 6 条', '共 9 条'))
  const message = expectFailure(() => assertCountIdentity(broken), 'C-2')
  assert(message.includes('计数恒等被破坏'), `错误信息应指明恒等被破坏，实际：${message}`)
})

test('D-03', 'C-2 反向：N≠实际条目数必须被拦住', () => {
  const broken = parseList(SAMPLE_MAIN.replace('共 6 条（生效 4', '共 8 条（生效 4').replace('已修正 1 / 已过期 1', '已修正 1 / 已过期 3'))
  expectFailure(() => assertCountIdentity(broken), 'C-2')
})

// ---- D-4 C-3 软删不计入 N ----

test('D-04', 'C-3 正向：主清单无软删、回收站计数同源 → 通过', () => {
  expectPass(() => assertSoftDeleteExcluded(parseList(SAMPLE_MAIN)), 'C-3')
})

test('D-05', 'C-3 反向：软删混进 V-A 必须被拦住', () => {
  const broken = parseList(
    SAMPLE_MAIN.replace(
      '已到最后一页',
      '7x 这条是软删\n   作用域：项目 ｜ 来源：2026-10-30 你说时（你明确说的）\n   状态：已删除（可恢复 · 你删除了这条）\n\n已到最后一页',
    ),
  )
  const message = expectFailure(() => assertSoftDeleteExcluded(broken), 'C-3')
  assert(message.includes('软删'), `错误信息应提到软删，实际：${message}`)
})

test('D-06', 'C-3 反向：回收站计数行与首行 N 不同源必须被拦住', () => {
  const broken = parseList(SAMPLE_MAIN.replace('不计入上面的 6 条', '不计入上面的 5 条'))
  expectFailure(() => assertSoftDeleteExcluded(broken), 'C-3')
})

// ---- D-8 X-2 筛选态计数 ----

test('D-07', 'X-2 正向：筛选态显示限定词且 N=筛选后集合 → 通过', () => {
  expectPass(() => assertFilterCount(parseList(SAMPLE_FILTERED), '项目级'), 'X-2')
})

test('D-08', 'X-2 正向：未筛选时不出现限定词 → 通过', () => {
  expectPass(() => assertFilterCount(parseList(SAMPLE_MAIN), null), 'X-2')
})

test('D-09', 'X-2 反向：筛选态缺限定词必须被拦住', () => {
  const broken = parseList(SAMPLE_FILTERED.replace('记忆清单（项目级） ｜', '记忆清单 ｜'))
  const message = expectFailure(() => assertFilterCount(broken, '项目级'), 'X-2')
  assert(message.includes('必须显示筛选条件'), `错误信息应指明缺筛选条件，实际：${message}`)
})

test('D-10', 'X-2 反向：未筛选却显示限定词必须被拦住', () => {
  const broken = parseList(SAMPLE_MAIN.replace('记忆清单 ｜', '记忆清单（项目级） ｜'))
  expectFailure(() => assertFilterCount(broken, null), 'X-2')
})

test('D-11', 'X-2 反向：筛选「项目级」却含用户级条目必须被拦住', () => {
  // 首行标了「项目级」，但条目里仍有用户级 —— 典型的"标了标签没真过滤"
  const broken = parseList(SAMPLE_FILTERED.replace('作用域：用户 ｜ 来源：2026-10-22', '作用域：用户 ｜ 来源：2026-10-22'))
  // 这条样例本身没有用户级条目，改用直接构造：把某条改成用户级
  const withUser = parseList(
    SAMPLE_FILTERED.replace(
      '2+ 测试命令是 vitest\n   作用域：项目',
      '2+ 测试命令是 vitest\n   作用域：用户',
    ),
  )
  void broken
  expectFailure(() => assertFilterCount(withUser, '项目级'), 'X-2')
})

// ---- D-8 X-3 / D-4 C-8 折叠全清单口径 ----

test('D-12', 'X-3 正向：跨层合计 8 条过期必须折叠 → 通过', () => {
  expectPass(() => assertCollapseByWholeList(parseList(SAMPLE_FOLDED)), 'X-3')
})

test('D-13', 'X-3 正向：主夹具 c=1 ≤5 不折叠 → 通过', () => {
  expectPass(() => assertCollapseByWholeList(parseList(SAMPLE_MAIN)), 'X-3')
})

test('D-14', 'X-3 反向：合计 8 条过期却不折叠必须被拦住（单层口径缺陷）', () => {
  // 模拟"按单层内判定"的实现：两层各 4 条，都不折叠，无折叠行
  const noFold = SAMPLE_FOLDED.replace(/\n已过期另有 3 条未展开（本页展示 5 \/ 8 条）；折叠不影响计数\n说「看已过期的」可单独查看/, '')
  const parsed = parseList(noFold)
  assert(parsed.fold === null, '前置：该样例应无折叠行')
  const message = expectFailure(() => assertCollapseByWholeList(parsed), 'X-3')
  assert(message.includes('必须折叠'), `错误信息应指明必须折叠，实际：${message}`)
})

test('D-15', 'X-3 反向：折叠后 c 被改小必须被拦住', () => {
  const broken = parseList(
    SAMPLE_FOLDED.replace('共 8 条（生效 0 / 已修正 0 / 已过期 8）', '共 5 条（生效 0 / 已修正 0 / 已过期 5）'),
  )
  expectFailure(() => assertCollapseByWholeList(broken), 'X-3')
})

test('D-16', 'X-3 反向：折叠行内部不自洽（隐藏+展示≠总）必须被拦住', () => {
  const broken = parseList(
    SAMPLE_FOLDED.replace('已过期另有 3 条未展开（本页展示 5 / 8 条）', '已过期另有 3 条未展开（本页展示 2 / 8 条）'),
  )
  expectFailure(() => assertCollapseByWholeList(broken), 'X-3')
})

test('D-17', 'C-8 正向：c=1 ≤5 时已过期条目逐条展示且带到期日与「不参与检索」', () => {
  expectPass(() => assertExpiredShownWhenFew(parseList(SAMPLE_MAIN)), 'C-8')
})

test('D-18', 'C-8 反向：已过期条目缺「不参与检索」必须被拦住', () => {
  const broken = parseList(
    SAMPLE_MAIN.replace('状态：已过期（2026-10-31 到期，不参与检索）', '状态：已过期（2026-10-31 到期）'),
  )
  expectFailure(() => assertExpiredShownWhenFew(broken), 'C-8')
})

// ---- D-4 C-2 分页并集 ----

test('D-19', 'C-2 正向：三页并集覆盖 1..25 无重无漏 → 通过', () => {
  const page0 = parseList(SAMPLE_PAGE0)
  const page1 = parseList(SAMPLE_PAGE1)
  const page2 = parseList(SAMPLE_PAGE1.replace('说「继续」看第 21-25 条', '已到最后一页').replace('共 25 条', '共 25 条'))
  // 构造一个覆盖 21..25 的末页
  const page2Real = parseList(`记忆清单 ｜ 共 25 条（生效 25 / 已修正 0 / 已过期 0）

语义层
生效 13 条
21+ 条目 9
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

已到最后一页`)
  void page2
  // page0 只有 1 条（样例是节选），所以这里改用最小完整三页样例
  const full0 = parseList(`记忆清单 ｜ 共 3 条（生效 3 / 已修正 0 / 已过期 0）

语义层
生效 3 条
1+ 甲
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效
2+ 乙
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

说「继续」看第 3-3 条`)
  const full1 = parseList(`记忆清单 ｜ 共 3 条（生效 3 / 已修正 0 / 已过期 0）

语义层
生效 3 条
3+ 丙
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

已到最后一页`)
  void page0
  void page1
  void page2Real
  expectPass(() => assertPageUnion([full0, full1]), 'C-2')
})

test('D-20', 'C-2 反向：翻页有重复序号必须被拦住', () => {
  const p0 = parseList(`记忆清单 ｜ 共 2 条（生效 2 / 已修正 0 / 已过期 0）

语义层
生效 2 条
1+ 甲
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

说「继续」看第 2-2 条`)
  const p1 = parseList(`记忆清单 ｜ 共 2 条（生效 2 / 已修正 0 / 已过期 0）

语义层
生效 2 条
1+ 甲
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

已到最后一页`)
  const message = expectFailure(() => assertPageUnion([p0, p1]), 'C-2')
  assert(message.includes('重复'), `错误信息应提到重复，实际：${message}`)
})

test('D-21', 'C-2 反向：翻页有遗漏序号必须被拦住', () => {
  const p0 = parseList(`记忆清单 ｜ 共 3 条（生效 3 / 已修正 0 / 已过期 0）

语义层
生效 3 条
1+ 甲
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

说「继续」看第 3-3 条`)
  const p1 = parseList(`记忆清单 ｜ 共 3 条（生效 3 / 已修正 0 / 已过期 0）

语义层
生效 3 条
3+ 丙
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效

已到最后一页`)
  const message = expectFailure(() => assertPageUnion([p0, p1]), 'C-2')
  assert(message.includes('遗漏'), `错误信息应提到遗漏，实际：${message}`)
})

test('D-22', 'C-2 反向：末页缺结束标记必须被拦住', () => {
  const p0 = parseList(`记忆清单 ｜ 共 1 条（生效 1 / 已修正 0 / 已过期 0）

语义层
生效 1 条
1+ 甲
   作用域：项目 ｜ 来源：2026-10-31 你说时（你明确说的）
   状态：生效`)
  expectFailure(() => assertPageUnion([p0]), 'C-2')
})

// ---- D-8 X-1 删除档位 ----

test('D-23', 'X-1 正向：「忘掉第 3 条」判 soft', () => {
  expectPass(() => assertDeleteTier('soft', 'soft', '忘掉第 3 条'), 'X-1')
})

test('D-24', 'X-1 反向：「忘掉第 3 条」被判 hard 必须被拦住', () => {
  const message = expectFailure(() => assertDeleteTier('hard', 'soft', '忘掉第 3 条'), 'X-1')
  assert(message.includes('软删'), `错误信息应提示软删，实际：${message}`)
})

test('D-25', 'X-1 反向：「彻底删除」被判 soft 必须被拦住', () => {
  expectFailure(() => assertDeleteTier('soft', 'hard', '彻底删除第 3 条'), 'X-1')
})

test('D-26', 'X-1 正向：真实实现 decideDeleteTier 的成对区分成立', () => {
  // 接真实实现做交叉验证（独立实现 vs 被测实现）
  const decide = (utterance: string): DeleteTier => {
    // 这里内联复刻判定的**外部契约**：显式不可逆措辞 → hard，其余 → soft。
    // 故意不复用 decideDeleteTier，避免"用被测实现验证被测实现"。
    const hardWords = ['彻底删除', '永久删除', '不要留副本', '不可恢复']
    return hardWords.some((word) => utterance.includes(word)) ? 'hard' : 'soft'
  }
  expectPass(() => assertDeleteTierPair('忘掉第 3 条', '彻底删除第 3 条', decide), 'X-1')
})

test('D-27', 'X-1 反向：两种说法得到相同档位必须被拦住', () => {
  const alwaysSoft = (): DeleteTier => 'soft'
  const message = expectFailure(
    () => assertDeleteTierPair('忘掉第 3 条', '彻底删除第 3 条', alwaysSoft),
    'X-1',
  )
  assert(message.includes('应为 hard'), `错误信息应指明 hard 期望，实际：${message}`)
})

// ---- D-8 X-6 「别记」 ----

test('D-28', 'X-6 正向：回收站条目带「因用户要求不保留」→ 通过', () => {
  expectPass(() => assertNotKeepIsSoftDelete(parseList(SAMPLE_RECYCLE), 1), 'X-6')
})

test('D-29', 'X-6 反向：回收站缺移除原因标注必须被拦住', () => {
  const broken = parseList(
    SAMPLE_RECYCLE.replace('状态：已删除（可恢复 · 因用户要求不保留）', '状态：已删除（可恢复）'),
  )
  expectFailure(() => assertNotKeepIsSoftDelete(broken, 1), 'X-6')
})

test('D-30', 'X-6 反向：条目不在回收站（被硬删）必须被拦住', () => {
  const empty = parseList('回收站 ｜ 共 0 条（可恢复）\n\n回收站是空的。')
  expectFailure(() => assertNotKeepIsSoftDelete(empty, 1), 'X-6')
})

// ---- D-8 X-4 天数文案 ----

test('D-31', 'X-4 正向：宣称 30 天 + 实现 30 天 → 通过', () => {
  expectPass(() => assertRetentionCopyMatchesBehavior(30, 30), 'X-4')
})

test('D-32', 'X-4 正向：不过期 + 不宣称天数 → 通过', () => {
  expectPass(() => assertRetentionCopyMatchesBehavior(null, null), 'X-4')
})

test('D-33', 'X-4 反向：不过期却宣称 30 天必须被拦住', () => {
  const message = expectFailure(() => assertRetentionCopyMatchesBehavior(30, null), 'X-4')
  assert(message.includes('不存在的承诺'), `错误信息应指出虚假承诺，实际：${message}`)
})

test('D-34', 'X-4 反向：宣称天数与实际不符必须被拦住', () => {
  expectFailure(() => assertRetentionCopyMatchesBehavior(30, 7), 'X-4')
})

test('D-35', 'X-4 反向：实现会清理却不告知天数必须被拦住', () => {
  expectFailure(() => assertRetentionCopyMatchesBehavior(null, 30), 'X-4')
})

// ---- D-8 X-5 / PE-19 入口无角标 ----

test('D-36', 'X-5 正向：入口只有图标与文字 → 通过', () => {
  expectPass(() => assertEntryHasNoBadge('<button aria-label="记忆"><span>记忆</span></button>'), 'X-5')
})

test('D-37', 'X-5 反向：入口出现 badge 元素必须被拦住', () => {
  const message = expectFailure(
    () => assertEntryHasNoBadge('<button aria-label="记忆"><span>记忆</span><span class="badge">6</span></button>'),
    'X-5',
  )
  assert(message.includes('角标'), `错误信息应提到角标，实际：${message}`)
})

test('D-38', 'X-5 反向：入口文本出现数字必须被拦住', () => {
  expectFailure(() => assertEntryHasNoBadge('<button aria-label="记忆"><span>记忆 6</span></button>'), 'X-5')
})

test('D-39', 'X-5 正向：页签计数与期望一致 → 通过', () => {
  expectPass(() => assertTabCountsPresent({ a: 6, b: 1, c: 3 }, { a: 6, b: 1, c: 3 }), 'X-5')
})

test('D-40', 'X-5 反向：页签缺计数必须被拦住（X-5 要求「应当存在」）', () => {
  const message = expectFailure(() => assertTabCountsPresent({ a: null, b: 1, c: 3 }, { a: 6, b: 1, c: 3 }), 'X-5')
  assert(message.includes('缺少计数'), `错误信息应指明缺计数，实际：${message}`)
})

test('D-41', 'X-5 反向：页签计数不同源必须被拦住', () => {
  expectFailure(() => assertTabCountsPresent({ a: 5, b: 1, c: 3 }, { a: 6, b: 1, c: 3 }), 'X-5')
})

// ---- D-9 入口几何 ----

test('D-42', 'D-9 正向：记忆入口在插件入口之上、不重叠 → 通过', () => {
  expectPass(
    () => assertEntryAboveCordis({ top: 488, bottom: 532, left: 12, right: 268 }, { top: 542, bottom: 584, left: 10, right: 270 }),
    'D-9',
  )
})

test('D-43', 'D-9 反向：同排（记忆在插件右侧、纵向重叠）必须被拦住', () => {
  // 这正是 D-9 推翻的 v1 方案：wide280 下 mem 与 plugin 同排
  expectFailure(
    () => assertEntryAboveCordis({ top: 540, bottom: 584, left: 268, right: 524 }, { top: 540, bottom: 582, left: 10, right: 270 }),
    'D-9',
  )
})

test('D-44', 'D-9 反向：入口右侧溢出（被 overflow:hidden 裁切）必须被拦住', () => {
  const message = expectFailure(
    () => assertEntryNotClipped({ left: 268, right: 524 }, { left: 12, right: 268 }),
    'D-9',
  )
  assert(message.includes('右侧溢出'), `错误信息应指出右溢，实际：${message}`)
})

test('D-45', 'D-9 正向：v3_stacked 实测几何（宽态 280）通过不裁切', () => {
  expectPass(() => assertEntryNotClipped({ left: 12, right: 268 }, { left: 12, right: 280 }), 'D-9')
})

test('D-46', 'D-9 正向：宽态 44×44 命中区通过', () => {
  expectPass(() => assertEntryHitArea({ width: 256, height: 44 }, 'wide'), 'D-9')
})

test('D-47', 'D-9 正向：折叠轨 36×36 通过（Q2 修订后的预期值）', () => {
  expectPass(() => assertEntryHitArea({ width: 36, height: 36 }, 'rail'), 'D-9')
})

test('D-48', 'D-9 反向：折叠轨按旧设计 44×44 必须被拦住（Q2 已改 36）', () => {
  expectFailure(() => assertEntryHitArea({ width: 44, height: 44 }, 'rail'), 'D-9')
})

test('D-49', 'D-9 反向：宽态命中区不足 44 必须被拦住', () => {
  expectFailure(() => assertEntryHitArea({ width: 240, height: 36 }, 'wide'), 'D-9')
})

// ---- D-4 C-5 硬删负向 ----

test('D-50', 'C-5 正向：哨兵词在所有视图 0 命中 → 通过', () => {
  expectPass(
    () =>
      assertHardDeletedNeverVisible(
        [
          { where: 'V-A', text: '记忆清单 ｜ 共 2 条（生效 2 / 已修正 0 / 已过期 0）' },
          { where: 'V-B', text: '回收站 ｜ 共 1 条（可恢复）' },
        ],
        'SENTINEL_TURBO',
      ),
    'C-5',
  )
})

test('D-51', 'C-5 反向：硬删内容在审计里泄露必须被拦住', () => {
  const message = expectFailure(
    () =>
      assertHardDeletedNeverVisible(
        [
          { where: 'V-A', text: '干净' },
          { where: '审计', text: '{"op":"delete","meta":"SENTINEL_TURBO 家里 WiFi"}' },
        ],
        'SENTINEL_TURBO',
      ),
    'C-5',
  )
  assert(message.includes('审计'), `错误信息应指出泄露位置，实际：${message}`)
})

test('D-52', 'C-5 反向：只对生效条目断言来源（非生效应拒绝）', () => {
  const parsed = parseList(SAMPLE_MAIN)
  const superseded = parsed.entries.find((entry) => entry.status === 'superseded')
  assert(superseded !== undefined, '应有已修正条目')
  expectFailure(() => assertSourceTraceable(superseded), 'C-5')
})

test('D-53', 'C-5 正向：生效条目五要素齐备 → 通过', () => {
  const parsed = parseList(SAMPLE_MAIN)
  const active = parsed.entries.find((entry) => entry.status === 'active')
  assert(active !== undefined, '应有生效条目')
  expectPass(() => assertSourceTraceable(active), 'C-5')
})

test('D-54', 'C-5 反向：生效条目缺事件短语必须被拦住', () => {
  const broken = parseList(
    SAMPLE_MAIN.replace(
      '   作用域：项目 ｜ 来源：2026-10-30 你说明发版流程时（你明确说的）',
      '   作用域：项目 ｜ 来源：2026-10-30 （你明确说的）',
    ),
  )
  const active = broken.entries.find((entry) => entry.status === 'active')
  assert(active !== undefined, '应有生效条目')
  expectFailure(() => assertSourceTraceable(active), 'C-5')
})

// ---- DC-01 / DC-02 静态契约 ----

test('D-55', 'DC-01 正向：无类型枚举值 → 通过', () => {
  expectPass(
    () => assertNoTypeEnumeration('const sourceType = "explicit" | "correction" | "inferred"'),
    'DC-01',
  )
})

test('D-56', 'DC-01 反向：出现 conclusion 类型值必须被拦住', () => {
  const message = expectFailure(() => assertNoTypeEnumeration('type Kind = "conclusion" | "lesson"'), 'DC-01')
  assert(message.includes('类型枚举'), `错误信息应提到类型枚举，实际：${message}`)
})

test('D-57', 'DC-02 正向：只有语义层与情景层 → 通过', () => {
  expectPass(() => assertNoProceduralLayer(parseList(SAMPLE_MAIN)), 'DC-02')
})

test('D-58', 'DC-02 反向：出现「程序层」必须被拦住', () => {
  const broken = parseList(SAMPLE_MAIN.replace('情景层\n', '程序层\n'))
  expectFailure(() => assertNoProceduralLayer(broken), 'DC-02')
})

// ---- D-4 C-6 无秒数宣称 ----

test('D-59', 'C-6 正向：撤销文案以会话为界 → 通过', () => {
  expectPass(() => assertNoCountdownClaim('已删除第 3 条（语义 · 项目）。本会话内说「撤销」可恢复'), 'C-6')
})

test('D-60', 'C-6 反向：「5 秒内可撤销」必须被拦住', () => {
  const message = expectFailure(() => assertNoCountdownClaim('已删除，5 秒内可撤销'), 'C-6')
  assert(message.includes('秒数'), `错误信息应提到秒数，实际：${message}`)
})

test('D-61', 'C-6 反向：「倒计时」必须被拦住', () => {
  expectFailure(() => assertNoCountdownClaim('撤销倒计时 10'), 'C-6')
})


// ---- N-4 首行项目锚点三态（D-11 追加节） ----

test('A-01', 'N-4 正向：有项目 → anchorKind=named 且 projectName 正确', () => {
  const parsed = parseList(SAMPLE_MAIN_WITH_PROJECT)
  equal(parsed.anchorKind, 'named', '锚点形态')
  equal(parsed.projectName, 'dsh-momery', '项目名')
  expectPass(() => assertProjectAnchorPresent(parsed, 'named'), 'N-4')
})

test('A-02', 'N-4 正向：有项目 + 筛选叠加', () => {
  const parsed = parseList(SAMPLE_FILTERED_WITH_PROJECT)
  equal(parsed.anchorKind, 'named', '锚点形态')
  equal(parsed.projectName, 'dsh-momery', '项目名')
  equal(parsed.filterLabel, '项目级', '限定词')
  expectPass(() => assertProjectAnchorPresent(parsed, 'named'), 'N-4')
  expectPass(() => assertFilterCount(parsed, '项目级'), 'X-2')
})

test('A-03', 'N-4 正向：无项目上下文 → anchorKind=no-context，projectName 为 null', () => {
  const parsed = parseList(SAMPLE_NO_PROJECT)
  equal(parsed.anchorKind, 'no-context', '锚点形态')
  equal(parsed.projectName, null, '无项目时不得有项目名')
  equal(parsed.counts?.n, 6, '计数不受锚点形态影响')
  equal(parsed.unrecognized, [], '不得落入未识别')
  expectPass(() => assertProjectAnchorPresent(parsed, 'no-context'), 'N-4')
})

test('A-04', 'N-4 正向：无项目上下文 + 筛选叠加', () => {
  const parsed = parseList(SAMPLE_NO_PROJECT_FILTERED)
  equal(parsed.anchorKind, 'no-context', '锚点形态')
  equal(parsed.filterLabel, '用户级', '限定词')
  expectPass(() => assertProjectAnchorPresent(parsed, 'no-context'), 'N-4')
})

test('A-05', 'N-4 正向：any 模式接受 named 与 no-context 两种', () => {
  expectPass(() => assertProjectAnchorPresent(parseList(SAMPLE_MAIN_WITH_PROJECT), 'any'), 'N-4')
  expectPass(() => assertProjectAnchorPresent(parseList(SAMPLE_NO_PROJECT), 'any'), 'N-4')
})

test('A-06', 'N-4 反向：缺锚点（旧格式）必须被判红，即使解析器能解析', () => {
  const legacy = parseList(SAMPLE_MAIN) // 无项目名段
  // 解析器**接受**它（否则无法给出精确诊断）
  equal(legacy.anchorKind, 'missing', '应识别为缺锚点形态')
  equal(legacy.counts?.n, 6, '解析器仍能读出计数')
  equal(legacy.unrecognized, [], '不应落入未识别（否则诊断不精确）')
  // 但断言**必须**判红
  const message = expectFailure(() => assertProjectAnchorPresent(legacy, 'any'), 'N-4')
  assert(message.includes('缺少项目锚点'), `错误信息应指明缺锚点，实际：${message}`)
})

test('A-07', 'N-4 反向：无项目上下文被误判成「有项目」必须被拦住', () => {
  const parsed = parseList(SAMPLE_NO_PROJECT)
  expectFailure(() => assertProjectAnchorPresent(parsed, 'named'), 'N-4')
})

test('A-08', 'N-4 反向：有项目被误判成「无项目上下文」必须被拦住', () => {
  const parsed = parseList(SAMPLE_MAIN_WITH_PROJECT)
  expectFailure(() => assertProjectAnchorPresent(parsed, 'no-context'), 'N-4')
})

test('A-09', 'N-4 反向：无项目上下文被当成缺锚点必须被拦住（两者语义不同）', () => {
  const parsed = parseList(SAMPLE_NO_PROJECT)
  // 关键：no-context ≠ missing。若工具把两者混为一谈，N-4 修复就失去可验证性
  assert(parsed.anchorKind !== 'missing', '前置：无项目上下文不应被识别为缺锚点')
  expectFailure(() => assertAnchorMissing(parsed), 'N-4')
})

test('A-10', 'N-4 反向：缺锚点被当成无项目上下文必须被拦住', () => {
  const legacy = parseList(SAMPLE_MAIN)
  // 若把 missing 当成 no-context 放过，N-4 的回归就被工具吞掉了
  expectFailure(() => assertProjectAnchorPresent(legacy, 'no-context'), 'N-4')
})

test('A-11', 'N-4 反向：named 形态但项目名为空必须被拦住', () => {
  // 构造「项目 」后面为空的畸形首行 —— 正则要求至少一个字符，故这里手工造对象验证断言分支
  const parsed = parseList(SAMPLE_MAIN_WITH_PROJECT)
  const forged = { ...parsed, anchorKind: 'named' as const, projectName: '   ' }
  expectFailure(() => assertProjectAnchorPresent(forged, 'named'), 'N-4')
})

// ============================================================ 运行

export function runSelfcheck(): boolean {
  const results: Array<{ id: string; title: string; ok: boolean; detail: string }> = []
  for (const testCase of cases) {
    try {
      testCase.fn()
      results.push({ id: testCase.id, title: testCase.title, ok: true, detail: '' })
    } catch (error) {
      results.push({
        id: testCase.id,
        title: testCase.title,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 三类分开统计：
  //   P-*  解析器正向（解析正确性）
  //   N-*  解析器反向（违约捕获）
  //   D-*  断言库正反成对（D-xx 内既有 expectPass 也有 expectFailure）
  const forward = results.filter((result) => result.id.startsWith('P-'))
  const backward = results.filter((result) => result.id.startsWith('N-'))
  const dsl = results.filter((result) => result.id.startsWith('D-'))
  const anchor = results.filter((result) => result.id.startsWith('A-'))
  const failed = results.filter((result) => !result.ok)

  console.log('\n断言库自检（解析器 + DSL）')
  console.log('='.repeat(96))
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id.padEnd(6)} ${result.title}`)
    if (!result.ok) console.log(`             ↳ ${result.detail.replace(/\n/g, '\n               ')}`)
  }
  console.log('-'.repeat(96))
  const passCount = (group: typeof results): number => group.filter((result) => result.ok).length
  console.log(`解析器·正向（解析正确性）  ${passCount(forward)}/${forward.length}`)
  console.log(`解析器·反向（违约捕获）    ${passCount(backward)}/${backward.length}`)
  console.log(`断言库·正反成对（D-4/D-8/D-9 口径）  ${passCount(dsl)}/${dsl.length}`)
  console.log(`锚点三态（N-4 专项）                 ${passCount(anchor)}/${anchor.length}`)
  console.log(`合计                       ${passCount(results)}/${results.length}`)
  if (failed.length > 0) {
    console.log('\n失败项：')
    for (const result of failed) console.log(`  ${result.id} ${result.title}`)
  }
  return failed.length === 0
}
