/**
 * H-1 实测：同一事实的**不同问法**召回率（lead 明确要求的验收数据）。
 *
 * 背景：`tech-design.md` §10.2 A-2 自评"H-1 纯字面检索的召回率是本方案最弱一环，
 * 换问法可能搜不到，是唯一可能达不到 AC-1 体验预期的地方"。
 * 本文件把那个自评变成数字。
 *
 * 方法：固定一组"记忆条目"，对每条构造多组**语义等价但用词不同**的问法，
 * 统计 top-K 命中率。分三档难度：
 *   easy  —— 问法包含条目里的关键词（应当 100%）
 *   medium—— 部分重叠，用户换了个说法（这是 H-1 的真实战场）
 *   hard  —— 几乎不共享字面，纯靠中文二元组或运气（用来标出能力边界）
 *
 * 输出：分档命中率 + 失败样例（失败的问法比成功的更能说明问题）。
 */

import { MemoryService } from '../host/domain/service.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { DAY } from './fixtures/data.js'

interface Probe {
  readonly fact: string
  readonly layer: 'semantic' | 'episodic'
  /** 应当能召回该条目的问法（同一事实的不同表达）。 */
  readonly asks: readonly string[]
  readonly difficulty: 'easy' | 'medium' | 'hard'
}

/** 12 条代表性记忆 × 66 个问法，覆盖偏好/约束/事实/事件四类措辞。 */
const PROBES: readonly Probe[] = [
  {
    fact: '发版前必须先跑 pnpm build',
    layer: 'semantic',
    difficulty: 'easy',
    asks: ['发版前要做什么', 'pnpm build', '发版要注意什么', '发布流程'],
  },
  {
    fact: '测试命令是 vitest',
    layer: 'semantic',
    difficulty: 'easy',
    asks: ['测试命令是什么', '用什么跑测试', 'vitest', '怎么运行单测'],
  },
  {
    fact: '注释一律用中文写，测试文件用英文',
    layer: 'semantic',
    difficulty: 'medium',
    asks: ['注释语言是什么', '代码注释怎么写', '注释用什么语言', '测试文件注释'],
  },
  {
    fact: '这个项目用 pnpm，不要用 npm',
    layer: 'semantic',
    difficulty: 'medium',
    asks: ['包管理器用哪个', '装依赖用什么', 'pnpm 还是 npm', '依赖安装命令'],
  },
  {
    fact: '不要自动改 package.json 里的版本号',
    layer: 'semantic',
    difficulty: 'medium',
    asks: ['版本号能自动改吗', 'package.json 版本', '能不能升级版本', '版本号规则'],
  },
  {
    fact: '提交前必须跑 lint 和类型检查',
    layer: 'semantic',
    difficulty: 'medium',
    asks: ['提交前检查什么', 'lint 要求', '要不要跑类型检查', '代码提交规范'],
  },
  {
    fact: '用户的沟通语言偏好是简体中文',
    layer: 'semantic',
    difficulty: 'hard',
    asks: ['用什么语言回答我', '说话语言', '偏好语言', '回复语言设置'],
  },
  {
    fact: '组件命名统一用大驼峰',
    layer: 'semantic',
    difficulty: 'hard',
    asks: ['组件怎么命名', '命名规范是什么', '文件名大小写', '命名风格'],
  },
  {
    fact: '这个仓库的分支策略是 trunk-based，直接从 main 开短分支',
    layer: 'semantic',
    difficulty: 'hard',
    asks: ['分支策略', '怎么开分支', 'main 还是 develop', '分支模型'],
  },
  {
    fact: '10-28 排查过 HMR 不生效，需要同时起 dev:web',
    layer: 'episodic',
    difficulty: 'medium',
    asks: ['HMR 不生效怎么办', '热更新没反应', 'dev:web 是干嘛的', '上次热更新问题'],
  },
  {
    fact: '10-20 排查过 pnpm 安装超时，换镜像源解决',
    layer: 'episodic',
    difficulty: 'medium',
    asks: ['安装超时', 'pnpm 装不上', '镜像源', '依赖安装很慢'],
  },
  {
    fact: '10-15 决定暂时不升级 TypeScript 到 6.0',
    layer: 'episodic',
    difficulty: 'hard',
    asks: ['TypeScript 版本', '升级 TS 了吗', '为什么还用旧版 TS', 'TypeScript 6.0'],
  },
]

export interface RecallReport {
  readonly total: number
  readonly hit: number
  readonly rate: number
  readonly byDifficulty: Record<string, { total: number; hit: number; rate: number }>
  readonly failures: Array<{ fact: string; ask: string; difficulty: string; got: string[] }>
  readonly missesDetail: Array<{ difficulty: string; examples: string[] }>
}

/** 跑一次 H-1 实测。 */
export function measureRecall(topK = 3): RecallReport {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-recall-'))
  const service = new MemoryService({ dataDir: join(root, 'data') })
  const now = Date.UTC(2026, 10, 1, 8, 0, 0)
  service.setClock(() => now)
  const projectKey = '/proj/recall'

  // 全部条目同一作用域/项目，保证唯一的区分维度就是内容
  service.seed(
    PROBES.map((probe, index) => ({
      id: `recall-${index}`,
      layer: probe.layer,
      content: probe.fact,
      scope: 'project' as const,
      projectKey,
      sourceType: 'explicit' as const,
      createdAt: now - (index + 1) * DAY,
      eventPhrase: '你说明这件事时',
      snippet: probe.fact,
      expiresAt: probe.layer === 'episodic' ? now + 20 * DAY : null,
    })),
  )

  const byDifficulty: Record<string, { total: number; hit: number; rate: number }> = {}
  const failures: RecallReport['failures'] = []
  let total = 0
  let hit = 0

  PROBES.forEach((probe, index) => {
    for (const ask of probe.asks) {
      total += 1
      const bucket = (byDifficulty[probe.difficulty] ??= { total: 0, hit: 0, rate: 0 })
      bucket.total += 1
      const result = service.retrieve(ask, projectKey, topK)
      const ids = result.hits.map((item) => item.row.id)
      if (ids.includes(`recall-${index}`)) {
        hit += 1
        bucket.hit += 1
      } else {
        failures.push({
          fact: probe.fact,
          ask,
          difficulty: probe.difficulty,
          got: result.hits.map((item) => item.row.content ?? ''),
        })
      }
    }
  })

  for (const bucket of Object.values(byDifficulty)) {
    bucket.rate = bucket.total === 0 ? 0 : Math.round((bucket.hit / bucket.total) * 1000) / 10
  }
  service.close()
  return {
    total,
    hit,
    rate: total === 0 ? 0 : Math.round((hit / total) * 1000) / 10,
    byDifficulty,
    failures,
    missesDetail: [],
  }
}

/**
 * H-1 验收阈值：top-K 召回率 ≥ 95% 判 PASS（D-11 修复 5）。
 * 此前 `recall.mjs` 无 `process.exit`，无论召回率多少都退 0，verify-all 的
 * 「H-1 PASS」是假阳性。阈值必须在此显式成立，不可由打印层临时决定。
 */
export const RECALL_THRESHOLD = 95

/** 按阈值判定本次实测是否达标。 */
export function recallPassed(report: RecallReport): boolean {
  return report.rate >= RECALL_THRESHOLD
}

/** 打印成可读报告（交付时贴进汇报）。 */
export function printRecall(report: RecallReport, topK = 3): void {
  console.log(`\nH-1 召回率实测（top-${topK}）`)
  console.log('='.repeat(96))
  console.log(`总体：${report.hit}/${report.total} = ${report.rate}%`)
  console.log(`判定阈值：top-${topK} 召回率 ≥ ${RECALL_THRESHOLD}% → ${recallPassed(report) ? 'PASS' : 'FAIL'}（实际 ${report.rate}%）`)
  for (const [difficulty, bucket] of Object.entries(report.byDifficulty)) {
    console.log(`  ${difficulty.padEnd(7)} ${bucket.hit}/${bucket.total} = ${bucket.rate}%`)
  }
  if (report.failures.length > 0) {
    console.log(`\n未命中样例（${report.failures.length} 个）：`)
    for (const failure of report.failures) {
      console.log(`  [${failure.difficulty}] 问「${failure.ask}」`)
      console.log(`      应为：「${failure.fact}」`)
      console.log(`      实际："${failure.got.slice(0, 2).join(' / ') || '（无命中）'}"`)
    }
  }
  console.log('='.repeat(96))
  console.log(recallPassed(report)
    ? `H-1 判定：PASS（${report.rate}% ≥ ${RECALL_THRESHOLD}%）`
    : `H-1 判定：FAIL（${report.rate}% < ${RECALL_THRESHOLD}%）`)
}
