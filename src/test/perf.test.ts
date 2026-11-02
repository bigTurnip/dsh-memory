/**
 * H-4 性能实测：AC-10 的 P95 ≤ 300ms @ 1 万条。
 *
 * `tech-design.md` §8.3 规定的验收方式：
 * 生成 10,000 条随机中文记忆（15–60 字，覆盖 2 层 × 2 作用域 × 5 状态），
 * 跑 500 次随机查询，记录 P50/P95/P99。
 *
 * 注意：本用例会建一个 1 万条的库，耗时数秒，单独跑：
 *   ELECTRON_RUN_AS_NODE=1 ".../DeepSeek Harness" test/perf.mjs
 */

import { MemoryService } from '../host/domain/service.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

const WORDS = [
  'pnpm', 'npm', 'yarn', 'vitest', 'jest', 'eslint', 'typescript', 'react', 'node', 'build',
  '发版', '发布', '测试', '注释', '命名', '分支', '镜像', '依赖', '版本', '构建',
  '类型检查', '提交', '规范', '目录', '组件', '接口', '部署', '日志', '缓存', '超时',
  '排查', '修复', '配置', '环境', '变量', '脚本', '命令', '流程', '约定', '文档',
]
const LAYERS = ['semantic', 'episodic'] as const
const SCOPES = ['project', 'user'] as const
const STATUSES = ['active', 'active', 'active', 'superseded', 'expired', 'deleted_soft', 'deleted_hard'] as const

function sentence(random: () => number): string {
  const length = 4 + Math.floor(random() * 8)
  const parts: string[] = []
  for (let index = 0; index < length; index += 1) {
    parts.push(WORDS[Math.floor(random() * WORDS.length)]!)
  }
  return `${parts.join(' ')} 的约定`
}

/** 确定性伪随机（可复现）。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export interface PerfReport {
  readonly total: number
  readonly queries: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly ftsAvailable: boolean
  readonly pass: boolean
}

export function measurePerformance(total = 10_000, queries = 500): PerfReport {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-perf-'))
  const service = new MemoryService({ dataDir: join(root, 'data') })
  const now = Date.UTC(2026, 10, 1, 8, 0, 0)
  service.setClock(() => now)
  const projectKey = '/proj/perf'
  const random = makeRandom(20261101)

  const rows = []
  for (let index = 0; index < total; index += 1) {
    const layer = LAYERS[Math.floor(random() * LAYERS.length)]!
    const scope = SCOPES[Math.floor(random() * SCOPES.length)]!
    const status = STATUSES[Math.floor(random() * STATUSES.length)]!
    rows.push({
      id: `perf-${index}`,
      layer,
      content: sentence(random),
      scope,
      projectKey,
      sourceType: 'explicit' as const,
      createdAt: now - Math.floor(random() * 300) * 86_400_000,
      eventPhrase: '你说明时',
      snippet: sentence(random),
      status,
      expiresAt: layer === 'episodic' ? now + 10 * 86_400_000 : null,
    })
  }

  const seedStart = performance.now()
  // 分批 seed，避免单次事务过大
  for (let offset = 0; offset < rows.length; offset += 500) {
    service.seed(rows.slice(offset, offset + 500))
  }
  const seedMs = Math.round(performance.now() - seedStart)

  const samples: number[] = []
  for (let index = 0; index < queries; index += 1) {
    const words = [WORDS[Math.floor(random() * WORDS.length)]!, WORDS[Math.floor(random() * WORDS.length)]!]
    const query = `${words[0]} ${words[1]}`
    const started = performance.now()
    service.retrieve(query, projectKey, 5)
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  const at = (percentile: number): number =>
    Math.round(samples[Math.min(samples.length - 1, Math.floor((percentile / 100) * samples.length))]! * 100) / 100

  const report: PerfReport = {
    total,
    queries,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: Math.round(samples[samples.length - 1]! * 100) / 100,
    ftsAvailable: service.rawDb.ftsAvailable,
    pass: at(95) <= 300,
  }
  console.log(`\nH-4 性能实测（${total} 条 / ${queries} 次查询）`)
  console.log('='.repeat(96))
  console.log(`seed 耗时: ${seedMs}ms    FTS5 可用: ${report.ftsAvailable}`)
  console.log(`P50 ${report.p50}ms ｜ P95 ${report.p95}ms ｜ P99 ${report.p99}ms ｜ max ${report.max}ms`)
  console.log(`AC-10 判定（P95 ≤ 300ms）: ${report.pass ? 'PASS' : 'FAIL'}`)
  console.log('='.repeat(96))
  service.close()
  return report
}
