/**
 * 测试夹具（docs/design-agent-memory.md §5.3 的 6 条 + 回收站 1 条）。
 *
 * 设计：覆盖 **2 分层 × 2 作用域 × 4 状态**，一套夹具服务 AC-2/3/4/5/6。
 * 另外提供 F-C2（语义 4 过期 + 情景 4 过期）用于 **D-8 X-3** 的折叠口径验证。
 *
 * 所有时间都是相对 `now` 的偏移量，**不依赖真实时钟**（O-2）。
 */

import type { MemoryService, SeedRow } from '../../host/domain/service.js'

export const DAY = 86_400_000

/** 主夹具：V-A 6 条（4 生效 / 1 已修正 / 1 已过期）+ 回收站 1 条。 */
export function mainFixture(now: number, projectKey = '/proj/alpha'): SeedRow[] {
  return [
    {
      id: 'fix-1',
      layer: 'semantic',
      content: '发版前必须先跑 pnpm build',
      scope: 'project',
      projectKey,
      sourceType: 'explicit',
      createdAt: now - 2 * DAY,
      eventPhrase: '你说明发版流程时',
      snippet: '这个仓库发版必须先跑 pnpm build',
    },
    {
      id: 'fix-2',
      layer: 'semantic',
      content: '注释用中文，测试文件用英文',
      scope: 'user',
      sourceType: 'correction',
      createdAt: now - 10 * DAY,
      eventPhrase: '你纠正注释语言时',
      snippet: '注释一律写中文',
    },
    {
      id: 'fix-3',
      layer: 'semantic',
      content: '测试命令是 vitest',
      scope: 'project',
      projectKey,
      sourceType: 'correction',
      createdAt: now - 2 * DAY,
      eventPhrase: '你纠正测试命令时',
      snippet: '测试命令是 vitest，不是 jest',
    },
    {
      id: 'fix-4',
      layer: 'semantic',
      content: '测试命令是 jest',
      scope: 'project',
      projectKey,
      sourceType: 'explicit',
      status: 'superseded',
      supersededBy: 'fix-3',
      createdAt: now - 7 * DAY,
      eventPhrase: '你说明测试命令时',
      snippet: '测试命令是 jest',
    },
    {
      id: 'fix-5',
      layer: 'episodic',
      content: '10-28 排查过 HMR 不生效，需同时起 dev:web',
      scope: 'project',
      projectKey,
      sourceType: 'explicit',
      createdAt: now - 4 * DAY,
      eventPhrase: '排查会话',
      snippet: 'HMR 不生效，要同时起 dev:web',
      expiresAt: now + 26 * DAY,
    },
    {
      id: 'fix-6',
      layer: 'episodic',
      content: '10-20 排查过 pnpm 安装超时，换镜像解决',
      scope: 'project',
      projectKey,
      sourceType: 'explicit',
      status: 'expired',
      createdAt: now - 40 * DAY,
      eventPhrase: '排查会话',
      snippet: 'pnpm 安装超时',
      expiresAt: now - 1 * DAY,
    },
    {
      // 回收站 1 条（软删）
      id: 'fix-7',
      layer: 'semantic',
      content: '这一周先不升级 TypeScript 版本',
      scope: 'project',
      projectKey,
      sourceType: 'explicit',
      status: 'deleted_soft',
      createdAt: now - 3 * DAY,
      eventPhrase: '你说暂时别升级时',
      snippet: '先不升级 TypeScript',
      deletedAt: now - 1 * DAY,
    },
  ]
}

/**
 * **F-C2**：跨层合计 8 条已过期（语义 4 + 情景 4）。
 *
 * 用于 **D-8 X-3**：折叠阈值是「V-A 全清单合计 > 5」。
 * 按"单层内"口径会得到"两层都不折叠"（各 4 条 ≤ 5），
 * 与对话通道的合计口径相反 —— 这条夹具专门抓那个回归。
 */
export function collapseFixture(now: number, projectKey = '/proj/alpha'): SeedRow[] {
  const rows: SeedRow[] = []
  for (let index = 0; index < 4; index += 1) {
    rows.push({
      id: `fc-sem-${index}`,
      layer: 'semantic',
      content: `语义层过期条目 ${index + 1}`,
      scope: 'project',
      projectKey,
      status: 'expired',
      createdAt: now - 60 * DAY,
      eventPhrase: '历史记录',
      snippet: `语义过期 ${index + 1}`,
      // 语义层永不自动过期（I-4）；这条是"被历史流程标为过期"的历史条目，
      // 因此 expiresAt 为 null —— DDL 的 CHECK 也会拒绝给语义层写 expires_at。
      expiresAt: null,
    })
  }
  for (let index = 0; index < 4; index += 1) {
    rows.push({
      id: `fc-epi-${index}`,
      layer: 'episodic',
      content: `情景层过期条目 ${index + 1}`,
      scope: 'project',
      projectKey,
      status: 'expired',
      createdAt: now - 60 * DAY,
      eventPhrase: '历史记录',
      snippet: `情景过期 ${index + 1}`,
      expiresAt: now - 30 * DAY,
    })
  }
  return rows
}

/** 装载夹具（幂等：已存在则跳过）。 */
export function loadFixture(service: MemoryService, rows: readonly SeedRow[]): string[] {
  const existing = new Set(service.rawDb.raw.prepare('SELECT id FROM memories').all().map((row) => String((row as { id: string }).id)))
  const pending = rows.filter((row) => row.id === undefined || !existing.has(row.id))
  return service.seed(pending)
}

/** 清库（自测之间隔离）。 */
export function resetDb(service: MemoryService): void {
  service.rawDb.raw.exec(`
    DELETE FROM memory_changes;
    DELETE FROM memory_audit;
    DELETE FROM memories_fts;
    DELETE FROM memories;
  `)
}
