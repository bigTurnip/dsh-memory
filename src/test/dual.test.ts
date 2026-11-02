/**
 * 双通道一致性自测（S-1 ~ S-5）+ HTTP 路由的端到端验证。
 *
 * 这些用例的价值：它们**同时**走 HTTP 与 service，因此能抓到
 * "面板一套、对话一套"的实现漂移（S-1/S-2 的核心风险）。
 *
 * 用一个假的 webServer 捕获 handler，再用合成的 IncomingMessage 调用，
 * 不需要真的起 HTTP 服务（也不需要端口）。
 */

import { test, assert, equal } from './harness.js'
import { Readable } from 'node:stream'
import { MemoryService } from '../host/domain/service.js'
import { mountMemoryRoutes, ROUTE_KEYS, type WebServerLike } from '../host/http/routes.js'
import { createTools, type ToolExec } from '../host/tools/index.js'
import { makeService, fixedClock } from './behaviour.test.js'
import { mainFixture, loadFixture, DAY } from './fixtures/data.js'

const PROJ = '/proj/dual'

interface Envelope<T> {
  code: number
  data: T
  message: string
}

/** 用假 webServer 拿 handler，直接合成请求。（导出给 settings.test 复用，避免两份假 webServer） */
export function makeHttp(service: MemoryService): (method: string, path: string, body?: unknown) => Promise<Envelope<unknown>> {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | null = null
  const webServer: WebServerLike = {
    register(route) {
      handler = route.handler as unknown as (req: unknown, res: unknown) => Promise<void>
      return () => {}
    },
  }
  mountMemoryRoutes(webServer, service)

  return async (method, path, body) => {
    if (handler === null) throw new Error('handler 未注册')
    const payload = body === undefined ? '' : JSON.stringify(body)
    const request = Object.assign(Readable.from([Buffer.from(payload)]), {
      url: path,
      method,
      headers: { 'content-type': 'application/json' },
    })
    let captured: Envelope<unknown> | null = null
    const response = {
      headersSent: false,
      writeHead() {},
      end(text: string) {
        captured = JSON.parse(text) as Envelope<unknown>
      },
    }
    await handler(request, response)
    if (captured === null) throw new Error('没有响应')
    return captured
  }
}

function toolsFor(
  service: MemoryService,
  projectKey: string = PROJ,
): { tools: ReturnType<typeof createTools>; exec: ToolExec } {
  const tools = createTools({
    service,
    workingDirectory: {
      get: () => projectKey,
    },
  })
  return {
    tools,
    exec: {
      callId: 'test',
      signal: new AbortController().signal,
      agent: { session: { id: 'dual-session' } },
    },
  }
}

// ============================================================ S-1 单一事实来源

test('S-1', '面板编辑 → 对话检索立即只见新内容', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  const http = makeHttp(service)
  const { tools, exec } = toolsFor(service)

  const written = (await tools[0]!.execute(
    {
      content: '测试命令是 jest',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      eventPhrase: '你说明测试命令时',
      snippet: '测试命令是 jest',
    },
    exec,
  )) as { id: string }

  // 面板通道改内容
  const edited = await http('POST', `/api/memory/edit?projectKey=${encodeURIComponent(PROJ)}`, {
    id: written.id,
    content: '测试命令是 vitest',
  })
  equal(edited.code, 0, `面板编辑应成功，实际 ${edited.message}`)

  // 对话通道立刻检索
  const search = (await tools[1]!.execute({ query: '测试命令是什么' }, exec)) as {
    hits: Array<{ content: string }>
  }
  const contents = search.hits.map((hit) => hit.content)
  assert(contents.some((text) => text.includes('vitest')), '对话应检索到新内容')
  assert(!contents.some((text) => text.includes('jest')), `对话不应检索到旧内容，实际 ${JSON.stringify(contents)}`)
})

test('S-1b', '对话删除 → 面板 V-A 不含、V-B 含', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  // 夹具条目写在 /proj/alpha（mainFixture 的默认 projectKey），查询要用同一个键
  const FIXTURE_KEY = '/proj/alpha'
  loadFixture(service, mainFixture(clock.now()))
  const http = makeHttp(service)

  const before = (await http('GET', `/api/memory/list?projectKey=${encodeURIComponent(FIXTURE_KEY)}`)) as Envelope<{
    counts: { n: number }
  }>
  equal(before.data.counts.n, 6, '初始 N=6')

  // 对话通道删除（service == 工具用的同一个对象）
  service.softDelete('fix-1', FIXTURE_KEY)

  const after = (await http('GET', `/api/memory/list?projectKey=${encodeURIComponent(FIXTURE_KEY)}`)) as Envelope<{
    counts: { n: number }
    entries: Array<{ id: string }>
  }>
  equal(after.data.counts.n, 5, '面板 N 应减 1')
  assert(!after.data.entries.some((entry) => entry.id === 'fix-1'), '面板 V-A 不应含已删条目')

  const recycle = (await http('GET', `/api/memory/recycle?projectKey=${encodeURIComponent(FIXTURE_KEY)}`)) as Envelope<
    Array<{ id: string }>
  >
  assert(recycle.data.some((entry) => entry.id === 'fix-1'), '面板 V-B 应含已删条目（C-3）')
})

// ============================================================ S-2 语义等价

test('S-2', '同一意图两通道结果一致：删除都是软删', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  const http = makeHttp(service)
  const { tools, exec } = toolsFor(service)

  const a = (await tools[0]!.execute(
    {
      content: '第一条要删的',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      eventPhrase: '你说明时',
      snippet: '第一条',
    },
    exec,
  )) as { id: string }
  const b = (await tools[0]!.execute(
    {
      content: '第二条要删的',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      eventPhrase: '你说明时',
      snippet: '第二条',
    },
    exec,
  )) as { id: string }

  // 对话通道：说"删掉" → 软删
  await tools[3]!.execute({ action: 'delete', id: a.id, utterance: '删掉第 1 条' }, exec)
  // 面板通道：点"删除" → 也是软删
  await http('POST', `/api/memory/delete?projectKey=${encodeURIComponent(PROJ)}`, { id: b.id })

  equal(service.getById(a.id)!.status, 'deleted_soft', '对话删除应软删')
  equal(service.getById(b.id)!.status, 'deleted_soft', '面板删除应软删（S-2：档位一致）')
})

test('S-2b', '硬删两通道都要 confirm token', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  const http = makeHttp(service)
  const { tools, exec } = toolsFor(service)

  const written = (await tools[0]!.execute(
    {
      content: '这条要硬删',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      eventPhrase: '你说明时',
      snippet: '硬删目标',
    },
    exec,
  )) as { id: string }

  // 面板：不带 token 直接硬删 → 必须失败
  const forged = await http('POST', `/api/memory/hard-delete?projectKey=${encodeURIComponent(PROJ)}`, {
    id: written.id,
    token: 'forged',
  })
  assert(forged.code !== 0, '伪造 token 必须被拒绝')
  equal(service.getById(written.id)!.status, 'active', '失败后条目应仍是生效')

  // 正常两步
  const prepared = (await http('POST', `/api/memory/hard-delete/prepare?projectKey=${encodeURIComponent(PROJ)}`, {
    id: written.id,
  })) as Envelope<{ token: string; echo: { content: string } }>
  equal(prepared.data.echo.content, '这条要硬删', 'prepare 必须回显正文')
  const done = await http('POST', `/api/memory/hard-delete?projectKey=${encodeURIComponent(PROJ)}`, {
    id: written.id,
    token: prepared.data.token,
  })
  equal(done.code, 0, '带正确 token 应成功')
  equal(service.getById(written.id)!.status, 'deleted_hard', '应进入终态')
})

// ============================================================ S-3 不可绕过

test('S-3', '面板不得提供对话禁止的能力', async () => {
  // 无 create 路由（PB-4）
  assert(!ROUTE_KEYS.some((key) => /create/i.test(key)), '路由表不得有 create')
  // 无回滚路由（DC-27）
  assert(!ROUTE_KEYS.some((key) => /rollback|revert/i.test(key)), '路由表不得有回滚')
  // 无改分层路由（D-5 Q3）
  assert(!ROUTE_KEYS.some((key) => /layer/i.test(key)), '路由表不得有改分层')

  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  const http = makeHttp(service)
  const { tools, exec } = toolsFor(service)
  const written = (await tools[0]!.execute(
    {
      content: '分层不该被改',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      eventPhrase: '你说明时',
      snippet: '分层',
    },
    exec,
  )) as { id: string }

  // 即使请求体里塞 layer，edit 也不认（入参类型没有该字段）
  await http('POST', `/api/memory/edit?projectKey=${encodeURIComponent(PROJ)}`, {
    id: written.id,
    content: '内容变了但分层没变',
    layer: 'episodic',
  })
  equal(service.getById(written.id)!.layer, 'semantic', '面板不得改分层（S-3 / D-5 Q3）')
})

// ============================================================ S-5 判定口径不变

test('S-5', '两通道计数口径一致（D-8 X-2 / X-3）', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  const FIXTURE_KEY = '/proj/alpha'
  loadFixture(service, mainFixture(clock.now()))
  const http = makeHttp(service)
  const { tools, exec } = toolsFor(service, FIXTURE_KEY)

  // 未筛选
  const httpAll = (await http('GET', `/api/memory/list?projectKey=${encodeURIComponent(FIXTURE_KEY)}`)) as Envelope<{
    counts: { n: number; a: number; b: number; c: number; filterLabel: string | null }
  }>
  const toolAll = (await tools[2]!.execute({ view: 'a' }, exec)) as {
    counts: { n: number; a: number; b: number; c: number; filterLabel: string | null }
  }
  equal(httpAll.data.counts, toolAll.counts, '未筛选时两通道计数必须完全一致')
  equal(httpAll.data.counts.filterLabel, null, '未筛选时不得有筛选标签（X-2）')

  // 筛选态：N = 筛选后集合，且必须带标签
  const httpFiltered = (await http(
    'GET',
    `/api/memory/list?projectKey=${encodeURIComponent(FIXTURE_KEY)}&scope=project`,
  )) as Envelope<{ counts: { n: number; filterLabel: string | null } }>
  const toolFiltered = (await tools[2]!.execute({ view: 'a', scope: 'project' }, exec)) as {
    counts: { n: number; filterLabel: string | null }
  }
  equal(httpFiltered.data.counts.n, toolFiltered.counts.n, '筛选态两通道 N 必须一致')
  assert(httpFiltered.data.counts.filterLabel !== null, '筛选态必须有筛选标签（X-2）')
  equal(httpFiltered.data.counts.filterLabel, toolFiltered.counts.filterLabel, '两通道筛选标签必须一致')
})

// ============================================================ S-4 降级

test('S-4', 'GUI 不可用时全部能力仍走对话（工具不依赖 HTTP）', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  const { tools, exec } = toolsFor(service)

  // 完全没有 mount HTTP，只跑工具：写/查/列/删/恢复都要能走完
  const written = (await tools[0]!.execute(
    {
      content: '无 GUI 也要能记',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      eventPhrase: '你说明时',
      snippet: '无 GUI',
    },
    exec,
  )) as { id: string; kind: string }
  equal(written.kind, 'created', '无 GUI 时写入应成功')

  const search = (await tools[1]!.execute({ query: '无 GUI' }, exec)) as { hits: unknown[] }
  assert(search.hits.length > 0, '无 GUI 时检索应可用')

  const listing = (await tools[2]!.execute({ view: 'a' }, exec)) as { counts: { n: number } }
  equal(listing.counts.n, 1, '无 GUI 时清单应可用')

  await tools[3]!.execute({ action: 'delete', id: written.id, utterance: '删掉' }, exec)
  equal(service.getById(written.id)!.status, 'deleted_soft', '无 GUI 时删除应可用')

  await tools[3]!.execute({ action: 'restore', id: written.id, utterance: '恢复' }, exec)
  equal(service.getById(written.id)!.status, 'active', '无 GUI 时恢复应可用')
})

// ============================================================ HTTP 契约

test('HTTP', '路由错误语义：404 / 405 / 缺参数', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(Date.UTC(2026, 10, 1)).now)
  const http = makeHttp(service)

  const notFound = await http('GET', '/api/memory/nope')
  equal(notFound.code, 404, '未知路径应 404')

  const wrongMethod = await http('POST', '/api/memory/list')
  equal(wrongMethod.code, 405, '方法不对应 405')

  const badId = await http('POST', `/api/memory/delete?projectKey=${encodeURIComponent(PROJ)}`, { id: 'no-such' })
  assert(badId.code !== 0, '删除不存在的条目应报错')
})

test('HTTP-health', 'health 暴露 O-1 需要的就绪信息', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(Date.UTC(2026, 10, 1)).now)
  const http = makeHttp(service)
  const health = (await http('GET', '/api/memory/health')) as Envelope<{
    enabled: boolean
    retentionDays: number | null
    ftsAvailable: boolean
    now: number
  }>
  equal(health.data.enabled, true, 'health 应报 enabled')
  equal(health.data.retentionDays, 30, 'health 应报保留期（X-4 文案依据）')
  equal(health.data.ftsAvailable, true, 'health 应报 FTS 可用性')
})

void DAY
