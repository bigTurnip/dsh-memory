/**
 * 真实输出回归的实现体（由 `live.mjs` 在宿主运行时调起）。
 *
 * 直接驱动 `MemoryService` + `createTools`，拿 `memory_list` / `memory_manage`
 * 的**真实返回文本**，喂给解析器与断言库。这是解析器与实现之间的活体契约。
 *
 * 所有夹具用 `seed()` + `setClock()` 构造，不靠等真实时间（O-2）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseList } from './parse-list.js'
import {
  AssertionFailure,
  assertCountIdentity,
  assertSoftDeleteExcluded,
  assertFilterCount,
  assertCollapseByWholeList,
  assertExpiredShownWhenFew,
  assertPageUnion,
  assertProjectAnchorPresent,
  assertNotKeepIsSoftDelete,
  assertRetentionCopyMatchesBehavior,
  assertSourceTraceable,
  assertNoProceduralLayer,
  assertNoCountdownClaim,
} from './dsl.js'

const DAY = 86_400_000
/** 固定「现在」，与工程师自测同一时点，便于对账。 */
const NOW = Date.UTC(2026, 10, 1)
const PROJECT_KEY = '/proj/dsh-momery'

interface Case {
  readonly id: string
  readonly title: string
  readonly fn: () => Promise<void> | void
}

const cases: Case[] = []
function test(id: string, title: string, fn: () => Promise<void> | void): void {
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
function expectPass(fn: () => void, rule: string): void {
  try {
    fn()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${rule}：期望断言通过，但失败了 —— ${detail}`)
  }
}

/** 夹具行（与 `src/test/fixtures/data.ts` 的 mainFixture 同构，但独立定义）。 */
function mainRows(): Array<Record<string, unknown>> {
  return [
    { id: 'lv-1', layer: 'semantic', content: '发版前必须先跑 pnpm build', scope: 'project', projectKey: PROJECT_KEY, createdAt: NOW - 2 * DAY, eventPhrase: '你说明发版流程时' },
    { id: 'lv-2', layer: 'semantic', content: '注释用中文，测试文件用英文', scope: 'user', createdAt: NOW - 10 * DAY, sourceType: 'correction', eventPhrase: '你纠正注释语言时' },
    { id: 'lv-3', layer: 'semantic', content: '测试命令是 vitest', scope: 'project', projectKey: PROJECT_KEY, createdAt: NOW - 2 * DAY, sourceType: 'correction', eventPhrase: '你纠正测试命令时' },
    { id: 'lv-4', layer: 'semantic', content: '测试命令是 jest', scope: 'project', projectKey: PROJECT_KEY, status: 'superseded', supersededBy: 'lv-3', createdAt: NOW - 7 * DAY, eventPhrase: '你说明测试命令时' },
    { id: 'lv-5', layer: 'episodic', content: '10-28 排查过 HMR 不生效，需同时起 dev:web', scope: 'project', projectKey: PROJECT_KEY, createdAt: NOW - 4 * DAY, expiresAt: NOW + 26 * DAY, eventPhrase: '排查会话' },
    { id: 'lv-6', layer: 'episodic', content: '10-20 排查过 pnpm 安装超时，换镜像解决', scope: 'project', projectKey: PROJECT_KEY, status: 'expired', createdAt: NOW - 40 * DAY, expiresAt: NOW - DAY, eventPhrase: '排查会话' },
    { id: 'lv-7', layer: 'semantic', content: '这一周先不升级 TypeScript 版本', scope: 'project', projectKey: PROJECT_KEY, status: 'deleted_soft', createdAt: NOW - 3 * DAY, deletedAt: NOW - DAY, eventPhrase: '你说暂时别升级时', removeReason: 'user_asked_not_to_keep' },
  ]
}

/** 折叠夹具：语义 4 过期 + 情景 4 过期（合计 8，X-3 专项）。 */
function collapseRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (let index = 0; index < 4; index += 1) {
    rows.push({ id: `lv-cs-${index}`, layer: 'semantic', content: `语义层过期条目 ${index + 1}`, scope: 'project', projectKey: PROJECT_KEY, status: 'expired', createdAt: NOW - 60 * DAY, expiresAt: null, eventPhrase: '历史记录' })
  }
  for (let index = 0; index < 4; index += 1) {
    rows.push({ id: `lv-ce-${index}`, layer: 'episodic', content: `情景层过期条目 ${index + 1}`, scope: 'project', projectKey: PROJECT_KEY, status: 'expired', createdAt: NOW - 60 * DAY, expiresAt: NOW - 30 * DAY, eventPhrase: '历史记录' })
  }
  return rows
}

/** 分页夹具：25 条生效。 */
function pagedRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (let index = 0; index < 25; index += 1) {
    rows.push({
      id: `lv-p-${index}`,
      layer: index % 2 === 0 ? 'semantic' : 'episodic',
      content: `分页条目 ${index + 1}`,
      scope: 'project',
      projectKey: PROJECT_KEY,
      createdAt: NOW - DAY,
      eventPhrase: '你说时',
    })
  }
  return rows
}

/**
 * 建一个隔离环境：独立临时数据目录 + 固定时钟。
 * 返回 service 与一个 `listText(args, opts)` 便捷函数。
 */
async function makeEnv(
  root: string,
  rows: Array<Record<string, unknown>>,
): Promise<{
  listText: (args: Record<string, unknown>) => Promise<string>
  recycleText: () => Promise<string>
  manage: (args: Record<string, unknown>) => Promise<unknown>
  close: () => void
}> {
  const hostEntry = join(root, 'lib', 'host', 'index.js')
  const toolsEntry = join(root, 'lib', 'host', 'tools', 'index.js')
  const { MemoryService } = (await import(pathToFileURL(hostEntry).href)) as {
    MemoryService: new (options: { dataDir: string }) => {
      setClock: (clock: (() => number) | null) => void
      seed: (rows: readonly Record<string, unknown>[]) => string[]
      close: () => void
    }
  }
  const { createTools } = (await import(pathToFileURL(toolsEntry).href)) as {
    createTools: (deps: Record<string, unknown>) => Array<{
      name: string
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
    }>
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-live-data-'))
  const service = new MemoryService({ dataDir: join(dir, 'data') })
  service.setClock(() => NOW)
  service.seed(rows)

  const tools = createTools({ service, workingDirectory: { get: () => PROJECT_KEY } })
  const exec = { callId: 'live', signal: new AbortController().signal, agent: { session: { id: 'live-session' } } }

  const listTool = tools.find((tool) => tool.name === 'memory_list')
  const manageTool = tools.find((tool) => tool.name === 'memory_manage')
  assert(listTool !== undefined, 'memory_list 工具未注册')
  assert(manageTool !== undefined, 'memory_manage 工具未注册')

  return {
    listText: async (args) => {
      const result = (await listTool.execute(args, exec)) as { text?: string }
      assert(typeof result.text === 'string', 'memory_list 未返回 text')
      return result.text
    },
    recycleText: async () => {
      const result = (await listTool.execute({ view: 'b' }, exec)) as { text?: string }
      assert(typeof result.text === 'string', 'memory_list view=b 未返回 text')
      return result.text
    },
    manage: (args) => manageTool.execute(args, exec),
    close: () => {
      service.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ============================================================ 真实输出用例

test('L-01', '真实 V-A 输出可被解析（无未识别行）', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const text = await env.listText({ view: 'a' })
    const parsed = parseList(text)
    equal(parsed.unrecognized, [], '真实输出不应有解析不了的行')
    equal(parsed.counts, { n: 6, a: 4, b: 1, c: 1 }, '首行计数')
    equal(parsed.entries.length, 6, '条目数')
  } finally {
    env.close()
  }
})

test('L-02', '真实 V-A：N-4 锚点为 named 且项目名 = 目录名', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const parsed = parseList(await env.listText({ view: 'a' }))
    equal(parsed.anchorKind, 'named', '锚点形态')
    equal(parsed.projectName, 'dsh-momery', '项目名应为工作目录最后一段')
    expectPass(() => assertProjectAnchorPresent(parsed, 'named'), 'N-4')
  } finally {
    env.close()
  }
})

test('L-03', '真实 V-A：计数恒等 + 软删不计入 N（D-4 C-2 / C-3）', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const parsed = parseList(await env.listText({ view: 'a' }))
    expectPass(() => assertCountIdentity(parsed), 'C-2')
    expectPass(() => assertSoftDeleteExcluded(parsed), 'C-3')
  } finally {
    env.close()
  }
})

test('L-04', '真实 V-A：已过期 ≤5 条逐条展示且带到期日（D-4 C-8）', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const parsed = parseList(await env.listText({ view: 'a' }))
    expectPass(() => assertExpiredShownWhenFew(parsed), 'C-8')
  } finally {
    env.close()
  }
})

test('L-05', '真实 V-A：生效条目五要素齐备（D-4 C-5 / X-7）', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const parsed = parseList(await env.listText({ view: 'a' }))
    const active = parsed.entries.filter((entry) => entry.status === 'active')
    assert(active.length > 0, '应有生效条目')
    for (const entry of active) expectPass(() => assertSourceTraceable(entry), 'C-5')
  } finally {
    env.close()
  }
})

test('L-06', '真实筛选态：限定词 + N=筛选后集合（D-8 X-2）', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const parsed = parseList(await env.listText({ view: 'a', scope: 'project' }))
    equal(parsed.filterLabel, '项目级', '限定词')
    expectPass(() => assertFilterCount(parsed, '项目级'), 'X-2')
  } finally {
    env.close()
  }
})

test('L-07', '真实折叠态：跨层合计 8 条过期必须折叠（D-8 X-3）', async () => {
  const env = await makeEnv(ROOT, collapseRows())
  try {
    const parsed = parseList(await env.listText({ view: 'a' }))
    equal(parsed.counts?.c, 8, '已过期合计 8')
    expectPass(() => assertCollapseByWholeList(parsed), 'X-3')
  } finally {
    env.close()
  }
})

test('L-08', '真实分页：三页并集无重无漏（D-4 C-2 / DC-15）', async () => {
  const env = await makeEnv(ROOT, pagedRows())
  try {
    const pages: ReturnType<typeof parseList>[] = []
    for (const page of [0, 1, 2]) {
      pages.push(parseList(await env.listText({ view: 'a', page })))
    }
    expectPass(() => assertPageUnion(pages), 'C-2')
  } finally {
    env.close()
  }
})

test('L-09', '真实 V-B：条数 / 保留天数 / 移除原因（X-4 / X-6）', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const parsed = parseList(await env.recycleText())
    equal(parsed.view, 'b', '视图')
    equal(parsed.recycleCount, 1, '回收站条数')
    // 实现是 30 天清理（tech-design §3.4 选择），文案必须写 30 天
    expectPass(() => assertRetentionCopyMatchesBehavior(parsed.retentionDaysClaim, 30), 'X-4')
    expectPass(() => assertNotKeepIsSoftDelete(parsed, 1), 'X-6')
  } finally {
    env.close()
  }
})

test('L-10', '真实 V-A：无「程序」分组（DC-02）', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const text = await env.listText({ view: 'a' })
    expectPass(() => assertNoProceduralLayer(parseList(text)), 'DC-02')
  } finally {
    env.close()
  }
})

test('L-11', '真实删除回执：无秒数宣称（D-4 C-6）', async () => {
  const env = await makeEnv(ROOT, mainRows())
  try {
    const result = (await env.manage({ action: 'delete', id: 'lv-1', utterance: '删掉这条' })) as {
      kind?: string
      row?: { content?: string }
    }
    equal(result.kind, 'deleted', '删除回执 kind')
    const receipt = JSON.stringify(result)
    expectPass(() => assertNoCountdownClaim(receipt), 'C-6')
  } finally {
    env.close()
  }
})

test('L-12', '真实无项目上下文：显式声明锚点而非静默省略（N-4）', async () => {
  // 用不带 workingDirectory 的 tools 驱动：resolveScope 拿不到 projectKey → fail-closed
  const hostEntry = join(ROOT, 'lib', 'host', 'index.js')
  const toolsEntry = join(ROOT, 'lib', 'host', 'tools', 'index.js')
  const { MemoryService } = (await import(pathToFileURL(hostEntry).href)) as {
    MemoryService: new (options: { dataDir: string }) => {
      setClock: (clock: (() => number) | null) => void
      seed: (rows: readonly Record<string, unknown>[]) => string[]
      close: () => void
    }
  }
  const { createTools } = (await import(pathToFileURL(toolsEntry).href)) as {
    createTools: (deps: Record<string, unknown>) => Array<{
      name: string
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
    }>
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-live-noproj-'))
  const service = new MemoryService({ dataDir: join(dir, 'data') })
  service.setClock(() => NOW)
  // 只放用户级条目，避免项目级在无 projectKey 时不可见造成干扰
  service.seed([
    { id: 'np-1', layer: 'semantic', content: '用户级偏好：回答用中文', scope: 'user', createdAt: NOW - DAY, eventPhrase: '你说时' },
  ])
  const tools = createTools({ service }) // 故意不传 workingDirectory
  const listTool = tools.find((tool) => tool.name === 'memory_list')
  assert(listTool !== undefined, 'memory_list 未注册')
  try {
    // 不传 agent → sessionId 与 projectKey 都为 null
    const result = (await listTool.execute({ view: 'a' }, { callId: 'x', signal: new AbortController().signal })) as {
      text?: string
    }
    assert(typeof result.text === 'string', '未返回 text')
    const parsed = parseList(result.text)
    equal(parsed.anchorKind, 'no-context', '无项目上下文时 anchorKind 应为 no-context')
    equal(parsed.projectName, null, '不应有项目名')
    equal(parsed.unrecognized, [], '真实无项目输出不应有解析不了的行')
    expectPass(() => assertProjectAnchorPresent(parsed, 'no-context'), 'N-4')
  } finally {
    service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================ 运行

let ROOT = ''

export async function runLive(root: string): Promise<boolean> {
  ROOT = root
  const results: Array<{ id: string; title: string; ok: boolean; detail: string }> = []

  for (const testCase of cases) {
    try {
      await testCase.fn()
      results.push({ id: testCase.id, title: testCase.title, ok: true, detail: '' })
    } catch (error) {
      results.push({
        id: testCase.id,
        title: testCase.title,
        ok: false,
        detail: error instanceof AssertionFailure ? error.message : error instanceof Error ? error.message : String(error),
      })
    }
  }

  console.log('\n真实输出回归（解析器 ↔ 实现 活体契约）')
  console.log('='.repeat(96))
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id.padEnd(6)} ${result.title}`)
    if (!result.ok) console.log(`             ↳ ${result.detail.replace(/\n/g, '\n               ')}`)
  }
  console.log('-'.repeat(96))
  const passed = results.filter((result) => result.ok).length
  console.log(`合计  ${passed}/${results.length}`)

  const failed = results.filter((result) => !result.ok)
  if (failed.length > 0) {
    console.log('\n失败项：')
    for (const result of failed) console.log(`  ${result.id} ${result.title}`)
  }
  return failed.length === 0
}
