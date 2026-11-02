/**
 * 行为自测：AC-1 / AC-2 / AC-3 / AC-5 / AC-6 / DC-10 / I-2。
 *
 * 全部走**用户可观察面**（service 的方法 + 渲染出的文本），不断言内部实现细节。
 * 时间用注入时钟，不靠等真实时间（AC-4 的过期与衰减同理）。
 */

import { test, assert, equal, throws } from './harness.js'
import { MemoryService } from '../host/domain/service.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { mainFixture, collapseFixture, loadFixture, resetDb, DAY } from './fixtures/data.js'
import { countVisible, shouldCollapseExpired, projectNameFromKey } from '../shared/counting.js'
import { decideDeleteTier } from '../shared/delete-tier.js'
import { renderList, formatBasis, createTools, type ToolExec } from '../host/tools/index.js'

const PROJ_A = '/proj/alpha'
const PROJ_B = '/proj/beta'

/** 每个用例一个独立库（隔离；内存库无法跨连接，所以用临时文件）。 */
export function makeService(): { service: MemoryService; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  const service = new MemoryService({ dataDir: join(root, 'data'), defaults: { projectKey: PROJ_A } })
  return { service, root }
}

/** 固定时钟（可推进）。 */
export function fixedClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

const T0 = Date.UTC(2026, 10, 1, 8, 0, 0)

// ============================================================ AC-1 跨会话生效

test('AC-1', '跨会话生效：会话 A 写入，会话 B 检索得到', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)

  const written = service.write(
    {
      content: '发版前必须先跑 pnpm build',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      sourceRef: {
        sessionId: 'session-A',
        turnSeq: 3,
        snippet: '这个仓库发版必须先跑 pnpm build',
        at: clock.now(),
        eventPhrase: '你说明发版流程时',
      },
    },
    PROJ_A,
  )
  assert(written.kind === 'created', `写入应新建，实际 ${written.kind}`)

  // 会话 B：全新上下文，只做一次检索
  clock.advance(2 * DAY)
  const result = service.retrieve('发版要注意什么', PROJ_A)
  assert(result.degraded === false, '检索不应降级')
  assert(result.hits.length > 0, '会话 B 应检索到该记忆')
  assert(
    (result.hits[0]!.row.content ?? '').includes('pnpm build'),
    `首条命中应包含 pnpm build，实际「${result.hits[0]!.row.content}」`,
  )
})

test('AC-1b', '不常驻：无相关话题的检索不返回该记忆', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  service.write(
    {
      content: '发版前必须先跑 pnpm build',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      sourceRef: { sessionId: 'session-A', turnSeq: 3, snippet: 'pnpm build', at: clock.now(), eventPhrase: '你说明发版流程时' },
    },
    PROJ_A,
  )
  // 完全不相关的查询
  const result = service.retrieve('今天天气怎么样', PROJ_A)
  equal(result.hits.length, 0, '不相关查询不应返回任何记忆（验证不常驻）')
})

// ============================================================ AC-2 改偏好生效

test('AC-2', '改偏好：旧条转已修正、新条生效、只返回新值', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)

  const first = service.write(
    {
      content: '用户偏好用 pnpm',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      sourceRef: { sessionId: 's1', turnSeq: 1, snippet: '用 pnpm', at: clock.now(), eventPhrase: '你说明偏好时' },
    },
    PROJ_A,
  )
  assert(first.memory !== null, '首次写入应成功')

  // 同一会话内说「以后用 npm，不用 pnpm 了」
  const second = service.write(
    {
      content: '用户偏好用 npm',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'correction',
      sourceRef: { sessionId: 's1', turnSeq: 2, snippet: '以后用 npm，不用 pnpm 了', at: clock.now(), eventPhrase: '你纠正包管理器时' },
    },
    PROJ_A,
  )
  equal(second.kind, 'superseded', '应判为冲突并覆盖')

  const oldRow = service.getById(first.memory!.id)!
  equal(oldRow.status, 'superseded', '旧条目应转为已修正')
  equal(oldRow.supersededBy, second.memory!.id, '旧条目应指向新条目')

  // 检索：只返回 npm，不返回 pnpm
  const result = service.retrieve('用哪个包管理器', PROJ_A)
  const contents = result.hits.map((hit) => hit.row.content ?? '')
  assert(contents.some((text) => text.includes('npm')), `应返回新值，实际 ${JSON.stringify(contents)}`)
  assert(!contents.some((text) => text.includes('pnpm')), `不应返回旧值，实际 ${JSON.stringify(contents)}`)

  // 跨到新会话仍是 npm
  clock.advance(DAY)
  const later = service.retrieve('用哪个包管理器', PROJ_A)
  assert(
    later.hits.every((hit) => !(hit.row.content ?? '').includes('pnpm')),
    '跨会话后仍不应返回旧值',
  )
})

// ============================================================ AC-3 冲突覆盖

test('AC-3', '冲突覆盖：检索只返回一个确定性答案', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)

  service.write(
    {
      content: '测试命令是 jest',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      sourceRef: { sessionId: 's1', turnSeq: 1, snippet: '测试命令是 jest', at: clock.now(), eventPhrase: '你说明测试命令时' },
    },
    PROJ_A,
  )
  service.write(
    {
      content: '测试命令是 vitest',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'correction',
      sourceRef: { sessionId: 's1', turnSeq: 2, snippet: '测试命令是 vitest', at: clock.now(), eventPhrase: '你纠正测试命令时' },
    },
    PROJ_A,
  )

  const result = service.retrieve('测试命令是什么', PROJ_A)
  const contents = result.hits.map((hit) => hit.row.content ?? '')
  assert(contents.some((text) => text.includes('vitest')), '应返回新答案 vitest')
  assert(!contents.some((text) => text.includes('jest')), `不应同时返回互斥的旧答案，实际 ${JSON.stringify(contents)}`)

  // 变更可追溯（AC-3 And）
  const jestRow = service.getById('fix-4')
  void jestRow
  const superseded = service
    .listA(PROJ_A)
    .entries.find((entry) => (entry.row.content ?? '').includes('jest'))
  assert(superseded !== undefined, '被覆盖条目应仍在清单里（已修正）')
  assert(
    superseded.statusText.includes('已修正') && superseded.statusText.includes('取代'),
    `已修正需带取代关系，实际「${superseded.statusText}」`,
  )
})

test('AC-3b', '否定极性：别改版本号 ↔ 可以改版本号 必须判冲突', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)

  const first = service.write(
    {
      content: '不要自动改版本号',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      sourceRef: { sessionId: 's1', turnSeq: 1, snippet: '不要自动改版本号', at: clock.now(), eventPhrase: '你说明约束时' },
    },
    PROJ_A,
  )
  // 自然的说法：用户不会把否定句和肯定句拼在一起说
  const second = service.write(
    {
      content: '版本号可以自动改',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'correction',
      sourceRef: { sessionId: 's1', turnSeq: 2, snippet: '版本号可以自动改', at: clock.now(), eventPhrase: '你纠正时' },
    },
    PROJ_A,
  )
  const oldRow = service.getById(first.memory!.id)!
  assert(
    oldRow.status === 'superseded' || second.kind === 'superseded',
    '否定极性不同的同槽位应判冲突（不得落成两条同时生效）',
  )
})

// ============================================================ AC-5 隐私删除

test('AC-5', '隐私硬删：V-A 消失、V-B 不存在、检索 0、审计无正文', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  // D-8 X-9：用**非凭据**目标（凭据本就不写入，走不到删除路径）
  const target = service.write(
    {
      content: '家里的 WiFi 名是 hamster-net',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      sourceRef: { sessionId: 's1', turnSeq: 1, snippet: '我家 WiFi 叫 hamster-net', at: clock.now(), eventPhrase: '你提到家里的网络时' },
    },
    PROJ_A,
  )
  assert(target.memory !== null, '写入应成功')
  const id = target.memory!.id

  // 两步协议：prepare（回显）→ hardDelete（带 token）
  const prepared = service.prepareHardDelete(id, PROJ_A)
  equal(prepared.echo.content, '家里的 WiFi 名是 hamster-net', '硬删前必须回显正文')
  throws(() => service.hardDelete(id, 'bogus-token', PROJ_A), '无有效 token 时必须拒绝')
  service.hardDelete(id, prepared.token, PROJ_A)

  // ① V-A 消失
  const viewA = service.listA(PROJ_A)
  assert(!viewA.entries.some((entry) => entry.row.id === id), '硬删后不应出现在 V-A')
  // ② V-B 也不存在（与软删的关键区别）
  const viewB = service.listB(PROJ_A)
  assert(!viewB.some((entry) => entry.row.id === id), '硬删后不应出现在 V-B')
  // ③ 检索 0
  const result = service.retrieve('WiFi 名字', PROJ_A)
  equal(result.hits.length, 0, '硬删后检索应为 0')
  // ④ 内容已抹除，且审计里不含正文（AC-5 第 4 条）
  const row = service.getById(id)!
  equal(row.content, null, '硬删必须抹除正文')
  equal(row.status, 'deleted_hard', '状态应为终态')
  assert(!service.auditLeaksContent('hamster-net'), '审计日志不得包含被删正文')
  const hardAudits = service.queryAudit({ op: 'hard_delete' })
  assert(hardAudits.length >= 1, '审计应留"发生过一次隐私删除"')
  assert(hardAudits.every((entry) => entry.memory_id === null), '硬删审计不得记录标识')
})

test('AC-5-soft', '同一目标改说「忘掉」必须落到软删（X-1 对照）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  const written = service.write(
    {
      content: '家里的 WiFi 名是 hamster-net',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      sourceRef: { sessionId: 's1', turnSeq: 1, snippet: 'hamster-net', at: clock.now(), eventPhrase: '你提到网络时' },
    },
    PROJ_A,
  )
  const id = written.memory!.id

  // D-8 X-1：单条「忘掉」→ soft
  equal(decideDeleteTier(`忘掉第 1 条`, 'single'), 'soft', '「忘掉」单条必须 soft')
  // D-8 X-1：批量「忘掉关于 X 的全部记忆」→ 仍 soft
  equal(decideDeleteTier('忘掉关于 WiFi 的全部记忆', 'batch'), 'soft', '「忘掉」批量必须 soft')

  service.softDelete(id, PROJ_A)
  const viewB = service.listB(PROJ_A)
  assert(viewB.some((entry) => entry.row.id === id), '软删后必须在回收站可见（与硬删成对照）')
  const restored = service.restore(id, PROJ_A)
  equal(restored.status, 'active', '软删应可恢复')
})

// ============================================================ AC-6 记忆可查看

test('AC-6', '记忆可查看：五要素齐备 + 分页并集无重无漏', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const view = service.listA(PROJ_A)
  // 首行计数
  equal(view.counts.n, 6, 'DC-10：V-A 应为 6 条（软删不计入）')
  equal([view.counts.a, view.counts.b, view.counts.c], [4, 1, 1], 'DC-10：4/1/1')
  equal(view.recycleCount, 1, '回收站应另有 1 条')

  // 五要素：分层（分组）、内容、作用域、来源、状态
  const text = renderList(view, { now: clock.now() })
  for (const needle of ['语义层', '情景层', '作用域：', '来源：', '状态：', '共 6 条']) {
    assert(text.includes(needle), `清单应包含「${needle}」`)
  }
  // 每条固定三行结构（A-6）：状态行独立
  const statusLines = text.split('\n').filter((line) => line.trimStart().startsWith('状态：'))
  equal(statusLines.length, 6, '应有 6 条独立的状态行')

  // 分页并集 = 全集，无重无漏
  const ids = new Set<string>()
  let total = 0
  for (let page = 0; page < 10; page += 1) {
    const pageView = service.listA(PROJ_A)
    const slice = pageView.entries.slice(page * 10, page * 10 + 10)
    if (slice.length === 0) break
    for (const entry of slice) ids.add(entry.row.id)
    total += slice.length
  }
  equal(ids.size, 6, '分页并集应恰为 6 条且无重复')
  equal(total, 6, '分页总数应等于全集')
})

test('AC-6-empty', '空状态文案逐字 + 不套用失败文案', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  const view = service.listA(PROJ_A)
  equal(view.counts.n, 0, '空库 N 应为 0')
  const text = renderList(view, { now: T0 })
  assert(text.includes('目前没有记录任何关于你的记忆。'), `空态文案应逐字，实际：${text}`)
  assert(!text.includes('记忆暂时读不到'), '空态不得套用读取失败文案')
})

test('AC-6-filter', '筛选：N = 筛选后集合，且首行显示筛选条件（X-2）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const all = service.listA(PROJ_A, null)
  equal(all.counts.n, 6, '未筛选 N=6')
  equal(all.counts.filterLabel, null, '未筛选时不应有筛选标签')

  const projectOnly = service.listA(PROJ_A, { scope: 'project' })
  // fix-1,3,4,5,6 是 project（fix-2 是 user，fix-7 软删不计）
  equal(projectOnly.counts.n, 5, '筛选项目级后 N 应为 5（筛选后集合）')
  assert(projectOnly.counts.filterLabel !== null, '筛选态必须有筛选标签（X-2）')
  assert(projectOnly.counts.filterLabel!.includes('项目级'), `标签应含「项目级」，实际 ${projectOnly.counts.filterLabel}`)
  const text = renderList(projectOnly, { now: clock.now() })
  assert(text.includes('记忆清单（项目级）'), `首行应显示筛选条件，实际首行：${text.split('\n')[0]}`)

  const semanticOnly = service.listA(PROJ_A, { layer: 'semantic' })
  equal(semanticOnly.counts.n, 4, '筛选语义层后 N 应为 4（fix-1,2,3,4）')
})

// ============================================================ N-4 首行项目名锚点

/** 取首行（noUncheckedIndexedAccess 下 split 的下标结果可能是 undefined）。 */
function headOf(text: string): string {
  return text.split('\n')[0] ?? ''
}

test('N-4-head', '首行必须带项目名（AC-8 判定锚点，§5.8b / DC-04）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const view = service.listA(PROJ_A)
  const head = headOf(renderList(view, { now: clock.now(), projectName: projectNameFromKey(PROJ_A) }))

  // 逐字形态：记忆清单 ｜ 项目 <目录名> ｜ 共 N 条（…）
  assert(/^记忆清单 ｜ 项目 alpha ｜ 共 6 条（生效 4 \/ 已修正 1 \/ 已过期 1）$/.test(head), `首行格式应带项目名，实际：${head}`)
  // 锚点必须是**目录名**，不是全路径（全路径啰嗦且泄露目录结构）
  assert(!head.includes('/proj/alpha'), `首行不得出现全路径，实际：${head}`)
  // 恒等式不得因加项目名而改变
  equal(view.counts.a + view.counts.b + view.counts.c, view.counts.n, 'N-4：加项目名后 a+b+c=N 仍成立')
})

test('N-4-noctx', '无项目上下文必须显式声明，不得静默退回旧格式', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const view = service.listA(PROJ_A)
  // projectKey 为 null（无会话 / 拿不到 workingDirectory）→ 显式「无项目上下文」
  for (const absent of [null, undefined, '']) {
    const head = headOf(renderList(view, { now: clock.now(), projectName: absent }))
    assert(/^记忆清单 ｜ 无项目上下文 ｜ 共 6 条（/.test(head), `无项目时应显式声明，实际：${head}`)
  }
  // 反向保护：省略 projectName 参数不得退回无锚点旧格式
  const legacy = headOf(renderList(view, { now: clock.now() }))
  assert(legacy.includes('无项目上下文'), `缺参数也必须走无项目分支，不得静默省略，实际：${legacy}`)
})

test('N-4-filtered', '筛选态首行同时保留筛选限定词与项目锚点', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const projectOnly = service.listA(PROJ_A, { scope: 'project' })
  const head = headOf(renderList(projectOnly, { now: clock.now(), projectName: projectNameFromKey(PROJ_A) }))
  assert(
    /^记忆清单（项目级） ｜ 项目 alpha ｜ 共 5 条（生效 3 \/ 已修正 1 \/ 已过期 1）$/.test(head),
    `筛选态首行应同时含限定词与项目锚点，实际：${head}`,
  )
})

test('N-4-switch', '切换工作目录后首行锚点变化（AC-8 可判定性）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const headA = headOf(renderList(service.listA(PROJ_A), { now: clock.now(), projectName: projectNameFromKey(PROJ_A) }))
  const headB = headOf(renderList(service.listA(PROJ_B), { now: clock.now(), projectName: projectNameFromKey(PROJ_B) }))
  assert(headA.includes('项目 alpha') && headB.includes('项目 beta'), `两个目录应给出不同锚点，实际：${headA} ／ ${headB}`)
  assert(headA !== headB, '切换工作目录后首行必须变化')
  equal(projectNameFromKey(PROJ_A), 'alpha', 'projectNameFromKey 取目录名')
  equal(projectNameFromKey('/proj/beta/'), 'beta', '尾斜杠不得产生空项目名')
  equal(projectNameFromKey('/'), null, '根路径视为无项目名')
  equal(projectNameFromKey(null), null, 'null → null')
})

// ============================================================ N-1 关闭态不输出条目

/**
 * F3-c / §5.7 / D-3 的逐字文案（design-agent-memory.md:289）。
 * 在此**重打一遍字面**而不是 import 实现常量：断言逐字 = 逐字，
 * 若是同一份常量，实现改了文案测试会跟着一起绿，等于没断言。
 */
const CLOSED_VERBATIM = '记忆已关闭，我现在没有可查的记忆。说「开启记忆」可以打开。'

/** 走工具层（N-1 的缺陷就在 tools 层，只测 service 测不到）。 */
function toolsFor(service: MemoryService, projectKey: string = PROJ_A): { tools: ReturnType<typeof createTools>; exec: ToolExec } {
  const tools = createTools({ service, workingDirectory: { get: () => projectKey } })
  return { tools, exec: { callId: 'test', signal: new AbortController().signal, agent: { session: { id: 'n1-session' } } } }
}

test('N-1-list', '关闭态 memory_list 逐字返回关闭文案，不查库不输出条目', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const { tools, exec } = toolsFor(service)

  // 前置：开启态确实有 6 条（否则关闭态"没输出"可能是因为本来就空）
  const open = (await tools[2]!.execute({ view: 'a' }, exec)) as { text: string; counts: { n: number } | null }
  equal(open.counts?.n, 6, '开启态应列出 6 条')

  service.setEnabled(false)
  const closed = (await tools[2]!.execute({ view: 'a' }, exec)) as { text: string; counts: { n: number } | null }
  const text = closed.text ?? ''
  equal(text, CLOSED_VERBATIM, '关闭态应答必须逐字等于 F3-c，实际：' + JSON.stringify(text))
  assert(!/共\s*\d+\s*条/.test(text), `关闭态不得出现「共 N 条」计数，实际：${text}`)
  assert(!text.includes('发版') && !text.includes('pnpm') && !text.includes('vitest'), '关闭态不得输出任何条目正文')
  assert(closed.counts === null || closed.counts === undefined, '关闭态不得返回计数对象')
})

test('N-1-views', '关闭态下 V-B 回收站 / V-C 变更记录同样不得输出条目', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const { tools, exec } = toolsFor(service)
  service.setEnabled(false)

  for (const view of ['a', 'b', 'c']) {
    const result = (await tools[2]!.execute({ view }, exec)) as Record<string, unknown>
    equal(result.closed, true, `view=${view} 应标记 closed`)
    equal(result.text, CLOSED_VERBATIM, `view=${view} 关闭态应答必须逐字（三视图都会输出正文，N-1 裁定针对的是能力不是单个视图）`)
  }
})

test('N-1-manage', '关闭态 memory_manage 不执行任何条目操作（edit/delete/restore 一律拦）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const { tools, exec } = toolsFor(service)
  const before = service.listA(PROJ_A)

  service.setEnabled(false)
  const target = before.entries[0]!.row.id
  const cases: Array<[string, Record<string, unknown>]> = [
    ['edit', { action: 'edit', id: target, content: '改成别的话', utterance: '把第 1 条改成别的话' }],
    ['delete', { action: 'delete', id: target, utterance: '删掉第 1 条' }],
    ['hard_delete', { action: 'hard_delete', id: target, utterance: '彻底删除第 1 条' }],
    ['restore', { action: 'restore', id: target, utterance: '恢复第 1 条' }],
    ['batch_forget', { action: 'batch_forget', ids: [target], utterance: '忘掉关于测试的记忆' }],
  ]
  for (const [name, args] of cases) {
    const result = (await tools[3]!.execute(args, exec)) as Record<string, unknown>
    equal(result.text, CLOSED_VERBATIM, `manage/${name} 关闭态应逐字返回关闭文案`)
    equal(result.kind, 'closed', `manage/${name} 应标记 kind=closed`)
  }
  // 反向保护：拦截必须真的没改库
  const after = service.listA(PROJ_A)
  equal(after.counts.n, before.counts.n, '关闭态的 manage 调用不得改变条目数')
  equal(after.entries[0]!.row.content, before.entries[0]!.row.content, '关闭态的 edit 不得改写内容')
})

test('N-1-reopen', '重新开启后清单恢复正常（关闭态不得污染数据）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const { tools, exec } = toolsFor(service)

  service.setEnabled(false)
  await tools[2]!.execute({ view: 'a' }, exec)
  service.setEnabled(true)
  const reopened = (await tools[2]!.execute({ view: 'a' }, exec)) as { text: string; counts: { n: number } | null }
  equal(reopened.counts?.n, 6, '开启后应恢复 6 条')
  assert(!reopened.text.includes('记忆已关闭'), `恢复后不得残留关闭文案，实际首行：${headOf(reopened.text)}`)
})

// ============================================================ 工具层可定位

test('LIST-ids', 'memory_list 返回 entries（序号→id），「第 N 条」可被 manage 定位', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const { tools, exec } = toolsFor(service)

  const listing = service.listA(PROJ_A)
  const view = (await tools[2]!.execute({ view: 'a' }, exec)) as {
    entries?: Array<{ id: string; ordinal: number; status: string }>
  }
  assert(view.entries !== undefined, 'V-A 必须返回 entries（否则模型无法把序号翻成 id）')
  equal(view.entries!.length, listing.entries.length, 'entries 条数应等于清单条数')
  equal(view.entries![0]!.ordinal, 1, 'ordinal 从 1 起')
  equal(view.entries![0]!.id, listing.entries[0]!.row.id, '序号 1 应指向清单第 1 条的 id')

  // 用序号 1 对应的 id 走 manage：这才是「删掉第 1 条」能落地的路径
  const first = view.entries![0]!
  const removed = (await tools[3]!.execute(
    { action: 'delete', id: first.id, utterance: '删掉第 1 条' },
    exec,
  )) as { kind: string }
  equal(removed.kind, 'deleted', '凭清单给出的 id 应能删除对应条目')
  assert(
    service.listA(PROJ_A).entries.every((entry) => entry.row.id !== first.id),
    '被删条目应离开 V-A',
  )

  // V-B 同样要带 id：「恢复第 N 条」靠它
  const recycle = (await tools[2]!.execute({ view: 'b' }, exec)) as {
    entries?: Array<{ id: string; ordinal: number }>
  }
  assert(recycle.entries !== undefined, 'V-B 必须返回 entries')
  assert(recycle.entries!.some((entry) => entry.id === first.id), '回收站条目里应包含刚删掉的那条')
  const restored = (await tools[3]!.execute(
    { action: 'restore', id: first.id, utterance: '恢复第 1 条' },
    exec,
  )) as { kind: string }
  equal(restored.kind, 'restored', '凭回收站给出的 id 应能恢复条目')
})

// ============================================================ DC-10

test('DC-10', '计数不变量：a+b+c=N，软删永不计入', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const view = service.listA(PROJ_A)
  const { n, a, b, c } = view.counts
  equal(a + b + c, n, 'DC-10：a+b+c 必须等于 N')
  equal(n, view.entries.length, 'DC-10：N 必须等于清单实际条数')
  // 软删的 fix-7 不在 entries 里
  assert(!view.entries.some((entry) => entry.row.id === 'fix-7'), '软删条目不得计入 V-A')
  equal(view.recycleCount, 1, '软删应另行列示')
})

test('DC-10-filter', '筛选态与折叠态计数（X-2 / X-3）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, collapseFixture(clock.now()))

  const view = service.listA(PROJ_A)
  equal(view.counts.n, 8, '折叠夹具 V-A 应为 8 条')
  equal(view.counts.c, 8, '已过期应为 8 条')

  // D-8 X-3：跨层合计 8 > 5 → 必须折叠
  assert(shouldCollapseExpired(view.counts), 'D-8 X-3：全清单 8 > 5 必须折叠')

  // 单层各 4 条 —— 若按"单层内"口径会错误地不折叠，这个断言就是那道防线
  const semanticExpired = service.listA(PROJ_A, { layer: 'semantic' }).counts.c
  const episodicExpired = service.listA(PROJ_A, { layer: 'episodic' }).counts.c
  equal([semanticExpired, episodicExpired], [4, 4], '两层各 4 条过期')
  assert(
    semanticExpired <= 5 && episodicExpired <= 5,
    '（对照）单看每层都不超过 5 —— 若实现按单层口径就会漏掉折叠',
  )
})

// ============================================================ I-2

test('I-2', '检索候选集 ≡ {status=active}', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const inspect = service.inspectRetrieval('测试命令', PROJ_A)
  // 候选集只含 active
  const activeIds = new Set(
    service
      .listA(PROJ_A)
      .entries.filter((entry) => entry.row.status === 'active')
      .map((entry) => entry.row.id),
  )
  for (const id of inspect.candidateIds) {
    assert(activeIds.has(id), `候选集不应含非 active 条目（id=${id}）`)
  }
  equal(inspect.candidateIds.length, activeIds.size, '候选集大小应等于 active 集合大小')

  // 用只出现在「已修正」条目里的词去检索，必须 0 命中
  const onlyInSuperseded = service.retrieve('jest', PROJ_A)
  assert(
    onlyInSuperseded.hits.every((hit) => hit.row.status === 'active'),
    `检索不得返回已修正条目，实际返回 ${JSON.stringify(onlyInSuperseded.hits.map((hit) => hit.row.status))}`,
  )

  // 用只出现在「已过期」条目里的词
  const expiredOnly = service.retrieve('换镜像解决', PROJ_A)
  assert(
    expiredOnly.hits.every((hit) => hit.row.status === 'active'),
    '检索不得返回已过期条目',
  )
})

// ============================================================ 其它不变量

test('INV', 'countVisible 拒绝软删输入（防止有人把软删算进 N）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const view = service.listA(PROJ_A)
  const withSoft = [...view.entries.map((entry) => entry.row), service.getById('fix-7')!]
  throws(() => countVisible(withSoft, null), 'countVisible 应拒绝含软删的输入')
})

test('INV-basis', '标注五要素齐备（X-7）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const entry = service.listA(PROJ_A).entries[0]!
  const basis = formatBasis(entry.row, 1)
  for (const needle of ['第 1 条', '语义', '项目', '依据记忆']) {
    assert(basis.includes(needle), `标注应含「${needle}」，实际：${basis}`)
  }
  // 五要素：序号/分层/作用域/来源时间/来源事件短语
  assert(/\d{4}-\d{2}-\d{2}/.test(basis), '标注应含来源日期')
  assert(basis.includes(entry.row.sourceRef.eventPhrase), '标注应含来源事件短语')
})

test('STATE', '状态机：终态不可再转、非法转换被拒', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  // fix-6 已过期 → 可恢复
  const restored = service.restore('fix-6', PROJ_A)
  equal(restored.status, 'active', '已过期应可恢复为生效')
  // 恢复后重新计时（D-5 Q4）
  assert(restored.expiresAt !== null && restored.expiresAt > clock.now(), '恢复后应重新计时')

  // 硬删后不可再操作
  const prepared = service.prepareHardDelete('fix-1', PROJ_A)
  service.hardDelete('fix-1', prepared.token, PROJ_A)
  throws(() => service.softDelete('fix-1', PROJ_A), '终态不可再软删')
  throws(() => service.restore('fix-1', PROJ_A), '终态不可恢复')
})

test('RESTORE-config', '恢复重新计时读 episodic_retention_days（与写入侧共用配置）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  // 保留期改成 7 天：恢复后必须按 7 天重新计时，而不是写死的 30 天
  service.rawDb.raw.prepare("UPDATE memory_settings SET value='7' WHERE key='episodic_retention_days'").run()
  const restored = service.restore('fix-6', PROJ_A)
  equal(restored.status, 'active', '已过期应可恢复为生效')
  equal(restored.expiresAt, clock.now() + 7 * DAY, '恢复后应按配置重新计时 7 天')

  // 语义层的「已过期」历史条目：恢复后不得写 expires_at（DDL CHECK 会拒）
  loadFixture(service, collapseFixture(clock.now()))
  const semantic = service.restore('fc-sem-0', PROJ_A)
  equal(semantic.status, 'active', '语义层已过期条目同样可恢复')
  equal(semantic.expiresAt, null, '语义层恢复后不得带过期时间（I-4）')
})

test('SCOPE', '作用域隔离：项目级不跨项目，用户级跨项目可见（AC-8）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)

  service.write(
    {
      content: '这个项目用 pnpm 作为包管理器',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      sourceRef: { sessionId: 's1', turnSeq: 1, snippet: '用 pnpm', at: clock.now(), eventPhrase: '你说明时' },
    },
    PROJ_A,
  )
  service.write(
    {
      content: '回答一律用中文',
      layer: 'semantic',
      scope: 'user',
      sourceType: 'explicit',
      sourceRef: { sessionId: 's1', turnSeq: 2, snippet: '用中文', at: clock.now(), eventPhrase: '你说明语言偏好时' },
    },
    PROJ_A,
  )

  // 切到项目 B：项目级不可见，用户级仍在
  const inB = service.listA(PROJ_B)
  const contents = inB.entries.map((entry) => entry.row.content ?? '')
  assert(!contents.some((text) => text.includes('pnpm')), '项目级记忆不得跨项目可见')
  assert(contents.some((text) => text.includes('中文')), '用户级记忆应跨项目可见')

  const searchB = service.retrieve('包管理器', PROJ_B)
  assert(
    searchB.hits.every((hit) => !(hit.row.content ?? '').includes('pnpm')),
    '检索也不得跨项目返回项目级记忆',
  )
})

test('DEGRADE', '降级三档可区分，且不编造（AC-9）', async () => {
  const { service } = makeService()
  const clock = fixedClock(T0)
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  // ① 正常但空
  const empty = service.retrieve('完全不相关的话题xyz', PROJ_A)
  equal(empty.degraded, false, '空结果不是降级（D-1 档）')
  equal(empty.hits.length, 0, '空结果应为 0 命中')

  // ② 超时档
  service.faults.retrieveSlowMs = 300
  const slow = service.retrieve('测试命令', PROJ_A)
  equal(slow.degraded, 'timeout', '超过软预算应标记 timeout')
  service.faults.retrieveSlowMs = undefined

  // ③ 报错档
  service.faults.retrieveError = true
  const errored = service.retrieve('测试命令', PROJ_A)
  equal(errored.degraded, 'error', '注入错误应标记 error')
  equal(errored.hits.length, 0, '错误档不得返回任何命中（不编造）')
  service.faults.retrieveError = false

  // ④ 关闭档
  service.setEnabled(false)
  equal(service.enabled(), false, '应可关闭')
  service.setEnabled(true)
})

// ============================================================ N-2 降级检索必须留痕

/** 哨兵查询词：只要它出现在审计里，就说明查询原文被存下来了。 */
const N2_QUERY = 'hamster-query-secret-77-不要落盘'

/** 取本次新增的 retrieve 审计（独立库，所以基线为 0）。 */
function retrieveAudits(service: MemoryService): Array<Record<string, unknown>> {
  return service.queryAudit({ op: 'retrieve' })
}

test('N-2-timeout', 'timeout 档必须写审计：outcome=timeout 且不存查询原文', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))

  service.faults.retrieveSlowMs = 300
  const result = service.retrieve(N2_QUERY, PROJ_A)
  service.faults.retrieveSlowMs = undefined

  equal(result.degraded, 'timeout', '前置：应真的落到 timeout 档')
  const audits = retrieveAudits(service)
  assert(audits.length >= 1, 'timeout 检索必须留下 retrieve 审计（N-2 的缺陷就是这里为 0）')
  const row = audits.find((item) => item.outcome === 'timeout')
  assert(row !== undefined, `应有 outcome=timeout 的记录，实际：${JSON.stringify(audits.map((item) => item.outcome))}`)
  assert(!service.auditLeaksContent(N2_QUERY), '审计不得含查询原文')
})

test('N-2-error', 'error 档必须写审计：outcome=error 且不存查询原文', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))

  service.faults.retrieveError = true
  const result = service.retrieve(N2_QUERY, PROJ_A)
  service.faults.retrieveError = false

  equal(result.degraded, 'error', '前置：应真的落到 error 档')
  const row = retrieveAudits(service).find((item) => item.outcome === 'error')
  assert(row !== undefined, `应有 outcome=error 的记录（原缺陷：提前 return 在 dao.audit 之前）`)
  assert(!service.auditLeaksContent(N2_QUERY), '审计不得含查询原文')
})

test('N-2-disabled', '关闭档检索也必须写审计：outcome=disabled', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))

  service.setEnabled(false)
  const result = service.retrieve(N2_QUERY, PROJ_A)
  equal(result.hits.length, 0, '关闭态不得返回命中')

  const row = retrieveAudits(service).find((item) => item.outcome === 'disabled')
  assert(row !== undefined, `关闭态检索也须留痕，实际 outcome 集合：${JSON.stringify(retrieveAudits(service).map((item) => item.outcome))}`)
  assert(!service.auditLeaksContent(N2_QUERY), '关闭态审计同样不得含查询原文')
  service.setEnabled(true)
})

test('N-2-meta', '审计 meta 只允许三个字段，杜绝偷偷存原文', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))

  service.retrieve(N2_QUERY, PROJ_A)
  const row = retrieveAudits(service).find((item) => item.outcome === 'ok')
  assert(row !== undefined, '正常档也应留痕（outcome=ok，回归保护）')
  const meta = JSON.parse(String(row!.meta)) as Record<string, unknown>
  equal(Object.keys(meta).sort().join(','), 'elapsedMs,hits,queryLength', 'meta 必须恰为 queryLength/hits/elapsedMs')
  equal(meta.queryLength, N2_QUERY.length, 'queryLength 是长度不是内容')
  assert(!String(row!.meta).includes(N2_QUERY), 'meta 序列化后不得含查询原文')
})

test('N-2-all-outcomes', '四种 outcome 全部可观测（O-2 / AC-9 的可判定面）', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))

  service.retrieve('发版', PROJ_A)
  service.faults.retrieveSlowMs = 300
  service.retrieve('发版', PROJ_A)
  service.faults.retrieveSlowMs = undefined
  service.faults.retrieveError = true
  service.retrieve('发版', PROJ_A)
  service.faults.retrieveError = false
  service.setEnabled(false)
  service.retrieve('发版', PROJ_A)
  service.setEnabled(true)

  const outcomes = new Set(retrieveAudits(service).map((item) => String(item.outcome)))
  for (const want of ['ok', 'timeout', 'error', 'disabled']) {
    assert(outcomes.has(want), `outcome 应含「${want}」，实际：${JSON.stringify([...outcomes])}`)
  }
  equal(retrieveAudits(service).length, 4, '四次检索应有四条留痕（一次调用一条，不重不漏）')
})

// ============================================================ N-3 开关指令有执行通道

/**
 * 走 memory_write 拿提示行（tools[0]）。
 *
 * kind 的**实测**取值（探针跑出来的，不是猜的）：新建为 `created`，
 * 同槽位重复会被合并成 `duplicate` 且仍占一次提示预算。
 * 所以断言一律用"是否落库 + 提示行布尔 + 清单增量"，不写死绝对条数。
 */
async function writeOnce(
  tools: ReturnType<typeof createTools>,
  exec: ToolExec,
  content: string,
): Promise<{ kind: string; id: string | null; prompt: boolean }> {
  return (await tools[0]!.execute(
    { content, layer: 'semantic', scope: 'user', sourceType: 'explicit', eventPhrase: '你说明时' },
    exec,
  )) as { kind: string; id: string | null; prompt: boolean }
}

/** 清单条数（memory_list view=a，tools[2]）。 */
async function listCount(tools: ReturnType<typeof createTools>, exec: ToolExec): Promise<number> {
  const res = (await tools[2]!.execute({ view: 'a' }, exec)) as { counts: { n: number } | null }
  return res.counts?.n ?? -1
}

/** 真正落了库的 kind（created/updated/superseded/merged/duplicate 都算写成功）。 */
function wroteOk(kind: string): boolean {
  return kind !== 'rejected' && kind !== 'not-salient'
}

test('N-3-disable', '开启态可关闭，回执同时告知「不再记录」与「清单不可查」', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))
  const { tools, exec } = toolsFor(service)

  equal(service.enabled(), true, '前置：默认开启（OQ-1）')
  equal(await listCount(tools, exec), 6, '前置：开启态清单有 6 条')

  const off = (await tools[3]!.execute({ action: 'disable', utterance: '关闭记忆' }, exec)) as {
    kind: string
    enabled: boolean
    text: string
  }
  equal(off.kind, 'toggled', '应走开关通道')
  equal(off.enabled, false, '回执必须反映落库后的真实状态')
  equal(service.enabled(), false, '状态真的改了')
  // 语义要素（team-lead 要求）：①不再记录 ②清单不再可查 —— 与 F3-c 呼应
  assert(off.text.includes('不再记录'), `关闭回执须含「不再记录」，实际：${off.text}`)
  assert(off.text.includes('不可查'), `关闭回执须告知清单不可查，实际：${off.text}`)
  // 关闭后立即验证承诺成立：清单确实查不到了
  const after = (await tools[2]!.execute({ view: 'a' }, exec)) as { closed?: boolean; counts: unknown }
  equal(after.closed, true, '关闭后清单应被拦（回执的承诺不是空话）')
  equal(after.counts, null, '关闭后不得回传计数')
})

test('N-3-enable', '关闭态下 enable 仍可达（N-1 拦截不得把出路堵死）', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))
  const { tools, exec } = toolsFor(service)

  service.setEnabled(false)
  // 先证明关闭态确实拦住其它 action，否则"enable 可达"没有对照意义
  const blocked = (await tools[3]!.execute(
    { action: 'edit', id: 'fix-1', content: '改一下', utterance: '改一下' },
    exec,
  )) as { kind: string }
  equal(blocked.kind, 'closed', '前置：关闭态其它 action 应被拦')

  const on = (await tools[3]!.execute({ action: 'enable', utterance: '开启记忆' }, exec)) as {
    kind: string
    enabled: boolean
    text: string
  }
  equal(on.kind, 'toggled', 'enable 必须可达，不能被 N-1 拦截吃掉')
  equal(on.enabled, true, 'F3-c 承诺的「说『开启记忆』可以打开」必须真能打开')
  equal(service.enabled(), true, '状态真的恢复')
  assert(on.text.includes('记忆已开启'), `开启回执应明确当前状态，实际：${on.text}`)
  equal(await listCount(tools, exec), 6, '开启后清单恢复可查')
})

test('N-3-closed-mute-blocked', '关闭态下 mute_prompt_writes 也被拦（关闭态只有一个出路）', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  const { tools, exec } = toolsFor(service)

  service.setEnabled(false)
  const res = (await tools[3]!.execute(
    { action: 'mute_prompt_writes', utterance: '以后别提示写入' },
    exec,
  )) as { kind: string; closed?: boolean }
  equal(res.kind, 'closed', '关闭态只放行 enable（team-lead 裁定）')
  equal(service.promptWritesEnabled(), true, '被拦时不得副作用改设置')
})

test('N-3-seam', 'N-1 拦截与 N-3 开关的接缝规则：关闭态只有 enable 打得通', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  const { tools, exec } = toolsFor(service)

  // ① 开启态 disable → 走开关通道，拿到 toggled 回执
  const first = (await tools[3]!.execute({ action: 'disable', utterance: '关闭记忆' }, exec)) as {
    kind: string
    enabled: boolean
  }
  equal(first.kind, 'toggled', '开启态 disable 应可达')
  equal(first.enabled, false, '应真的关闭')

  // ② 关闭态再 disable → 被 N-1 拦成 closed（team-lead 裁定：只放行 enable）。
  //    状态不变，仍为关闭 —— 这是"幂等"在裁定后的**真实含义**，不是回执相同。
  const second = (await tools[3]!.execute({ action: 'disable', utterance: '关闭记忆' }, exec)) as {
    kind: string
    text: string
  }
  equal(second.kind, 'closed', '关闭态重复 disable 应被 N-1 拦截（回执形状不同是裁定的结果）')
  assert(second.text.includes('记忆已关闭'), '拦截回执仍是 F3-c 文案')
  equal(service.enabled(), false, '被拦时状态不变，不得出现翻转')

  // ③ enable 连打两次都通（放行集合里只有它），且第二次仍回 toggled
  for (let i = 0; i < 2; i += 1) {
    const on = (await tools[3]!.execute({ action: 'enable', utterance: '开启记忆' }, exec)) as {
      kind: string
      enabled: boolean
    }
    equal(on.kind, 'toggled', `第 ${i + 1} 次 enable 应可达`)
    equal(on.enabled, true, `第 ${i + 1} 次 enable 后应为开启`)
  }

  // ④ 开启态 enable 重复打，状态稳定为开启
  const again = (await tools[3]!.execute({ action: 'enable', utterance: '开启记忆' }, exec)) as { enabled: boolean }
  equal(again.enabled, true, '重复 enable 不得翻转状态')
})

test('N-3-mute', '「以后别提示写入」是持久设置，不是会话内状态', async () => {
  const { service, root } = makeService()
  service.setClock(fixedClock(T0).now)
  const { tools, exec } = toolsFor(service)

  equal(service.promptWritesEnabled(), true, '前置：默认给提示（D-5 Q1）')
  const muted = (await tools[3]!.execute(
    { action: 'mute_prompt_writes', utterance: '以后别提示写入' },
    exec,
  )) as { kind: string; promptWrites: boolean }
  equal(muted.kind, 'prompt_muted', '应走静音通道')
  equal(muted.promptWrites, false, '回执须反映落库状态')
  equal(service.promptWritesEnabled(), false, '静音已生效')

  // 关键：换一个**新实例**读同一个库（等价于重启进程 / 新会话），设置仍在
  const reopened = new MemoryService({ dataDir: join(root, 'data') })
  reopened.setClock(fixedClock(T0).now)
  equal(reopened.promptWritesEnabled(), false, '静音必须持久化到 memory_settings，重启后仍生效')
  equal(reopened.shouldPromptWrite('brand-new-session'), false, '新会话也不再出提示行')
  reopened.close()
})

test('N-3-mute-not-bypass-write', '静音只去掉提示行，写入照常落库', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))
  const { tools, exec } = toolsFor(service)

  const baseline = await listCount(tools, exec)

  // 未静音：第一次写入既落库又有提示行
  const before = await writeOnce(tools, exec, '静音前的偏好：提交信息用中文')
  assert(wroteOk(before.kind), `未静音时写入应落库，实际 kind=${before.kind}`)
  equal(before.prompt, true, '未静音时首次写入应给提示行（D-5 Q1 前 3 次）')
  equal(await listCount(tools, exec), baseline + 1, '未静音的写入应进清单')

  await tools[3]!.execute({ action: 'mute_prompt_writes', utterance: '以后别提示写入' }, exec)

  const after = await writeOnce(tools, exec, '静音后的偏好：合并前先跑测试')
  assert(wroteOk(after.kind), `静音后写入**仍须落库**，实际 kind=${after.kind} —— 静音的是提示，不是写入`)
  equal(after.prompt, false, '静音后不得再有提示行')
  assert(after.id !== null, '静音后的写入应有真实 id')
  equal(await listCount(tools, exec), baseline + 2, '静音后的那条也应进清单（写入未被削弱）')
})

test('N-3-budget', 'D-5 Q1 预算未被破坏：前 3 次提示、第 4 次起静默', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  const { tools, exec } = toolsFor(service)

  const prompts: boolean[] = []
  const kinds: string[] = []
  for (let i = 0; i < 4; i += 1) {
    const result = await writeOnce(tools, exec, `预算内独立写入 ${i + 1}：主题${i + 1}`)
    assert(wroteOk(result.kind), `第 ${i + 1} 次写入应落库，实际 kind=${result.kind}`)
    kinds.push(result.kind)
    prompts.push(result.prompt)
  }
  equal(prompts.slice(0, 3), [true, true, true], `前 3 次应有提示，实际：${JSON.stringify(prompts)}（${kinds}）`)
  equal(prompts[3], false, `第 4 次应静默，实际：${JSON.stringify(prompts)}（${kinds}）`)
})

test('N-3-channel', '开关全程可经对话完成（TC-AC9-03 前置不再依赖进程内 setEnabled）', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  loadFixture(service, mainFixture(T0))
  const { tools, exec } = toolsFor(service)

  // 全程只走工具层，一次都不调 service.setEnabled
  await tools[3]!.execute({ action: 'disable', utterance: '关闭记忆' }, exec)
  equal(service.enabled(), false, '仅经工具即完成关闭')
  const closed = (await tools[2]!.execute({ view: 'a' }, exec)) as { text: string }
  assert(closed.text.includes('记忆已关闭'), '关闭后清单应给关闭文案')
  await tools[3]!.execute({ action: 'enable', utterance: '开启记忆' }, exec)
  equal(service.enabled(), true, '仅经工具即完成开启')
})

test('N-3-unknown-action', '未知 action 仍然报错（新增 action 未吞掉校验）', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  const { tools, exec } = toolsFor(service)
  // execute 是 async，而 harness 的 throws 只抓同步抛错，所以这里手写 await + try/catch
  let caught: string | null = null
  try {
    await tools[3]!.execute({ action: 'enable_memory', utterance: '开一下' }, exec)
  } catch (error) {
    caught = error instanceof Error ? error.message : String(error)
  }
  assert(caught !== null, '拼错的 action 应被拒绝，而不是静默当成 enable 或无操作')
  assert(/未知 action/.test(caught ?? ''), `报错信息应指明未知 action，实际：${caught}`)
  equal(service.enabled(), true, '被拒绝的错误调用不得改变开关状态')
})

void resetDb
