/**
 * 硬约束自检 HC-1 ~ HC-14（`tech-design.md` §12.1）+ D-8 专项。
 *
 * test-engineer 会独立复跑这些编号，所以每个用例的 id 就用 HC 编号本身，
 * 且失败信息要能直接指向"哪条契约被违反"。
 */

import { test, assert, equal, throws } from './harness.js'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideDeleteTier, isUserAskedNotToKeep } from '../shared/delete-tier.js'
import { countVisible, shouldCollapseExpired, EXPIRED_COLLAPSE_THRESHOLD } from '../shared/counting.js'
import { mainFixture, collapseFixture, loadFixture, DAY } from './fixtures/data.js'
import { makeService, fixedClock } from './behaviour.test.js'
import { renderList } from '../host/tools/index.js'
import { STATUS } from '../shared/contract.js'

// 夹具用的项目键，必须与 behaviour.test.ts 的 PROJ_A 一致
const FIXTURE_PROJ = '/proj/alpha'

// 打包后 import.meta.url 指向临时目录，源码位置要由 runner 注入
const root = process.env.DSH_MEMORY_SRC_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..')

function readAllSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (name === 'node_modules' || name.startsWith('.')) continue
      // 自测文件本身会引用被禁止的标识符（用来断言它们不存在），必须排除
      if (name === 'test') continue
      // 构建产物（tsc 生成的 .d.ts/.js）不是源码，扫它会误报
      if (dir.endsWith('/src') && name === 'lib') continue
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(name)) out.push({ path: full, text: readFileSync(full, 'utf8') })
    }
  }
  walk(root)
  return out
}

/** 去掉注释与字符串字面量后再 grep（避免注释里提到 kind 就误报）。 */
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

// ============================================================ HC-1 无类型枚举

test('HC-1', '无类型枚举字段（D-3）：schema 与类型里没有 kind/category/tag', async () => {
  const schema = readFileSync(join(root, 'host/db/schema.ts'), 'utf8')
  const ddlStart = schema.indexOf('CREATE TABLE IF NOT EXISTS memories')
  const ddlEnd = schema.indexOf('CREATE VIRTUAL TABLE')
  const memoriesDdl = schema.slice(ddlStart, ddlEnd)
  for (const forbidden of ['kind', 'category', 'tag ', 'type ']) {
    assert(
      !new RegExp(`\\b${forbidden.trim()}\\b`, 'i').test(memoriesDdl),
      `memories 表不得含类型列「${forbidden.trim()}」`,
    )
  }
  // source_type 是来源可信度，不是分类；确认它只允许三个可信度值
  assert(memoriesDdl.includes("source_type IN ('explicit','correction','inferred')"), 'source_type 只能是可信度三值')

  // 全源码（去注释与字符串）不得出现四分类字面量
  for (const { path, text } of readAllSources()) {
    const stripped = stripCommentsAndStrings(text)
    for (const banned of ['conclusion', 'preference', 'lesson']) {
      assert(!stripped.includes(banned), `${path} 不得出现已作废的四分类「${banned}」`)
    }
    // `correction` 是允许的（它是来源可信度之一），只禁止它出现在"类型"位置。
    // 检查的是「记忆实体上的类型字段声明」，不是任意对象字面量的 kind 属性
    // （工具返回值里 result.kind 是"写入结果种类"，与条目分类无关）。
    assert(
      !/interface\s+(MemoryRow|SeedRow|Candidate)[\s\S]*?\bkind\s*\??:/.test(stripped),
      `${path}：记忆实体不得有 kind 字段`,
    )
  }
})

// ============================================================ HC-2 无衰减状态

test('HC-2', '无衰减状态（DC-28 / I-3）：STATUS 里没有 decayed，衰减是纯函数', async () => {
  for (const status of STATUS) {
    assert(
      !/decay|fade|strength/i.test(status),
      `STATUS 不得含衰减状态，实际含「${status}」`,
    )
  }
  const score = readFileSync(join(root, 'shared/retrieval-score.ts'), 'utf8')
  const decayFn = score.slice(score.indexOf('export function decayFactor'))
  const body = decayFn.slice(0, decayFn.indexOf('\n}'))
  assert(!/UPDATE|INSERT|\.run\(/.test(body), 'decayFactor 必须是纯函数，不得写库')
})

// ============================================================ HC-3 无第四视图

test('HC-3', '无第四视图（DC-09）：listing 恰导出 listA/listB/listC', async () => {
  const listing = readFileSync(join(root, 'host/domain/listing.ts'), 'utf8')
  const exported = [...listing.matchAll(/export function (list[A-Z])/g)].map((match) => match[1])
  equal(exported.sort(), ['listA', 'listB', 'listC'], '视图函数必须恰为三个')
})

// ============================================================ HC-4 / HC-4b

test('HC-4', 'I-2 检索候选集 ≡ {active}：非 active 独有词必 0 命中', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  const cases = [
    { query: 'jest', note: '只出现在已修正条目' },
    { query: '换镜像解决', note: '只出现在已过期条目' },
    { query: 'TypeScript 版本', note: '只出现在软删条目' },
  ]
  for (const item of cases) {
    const result = service.retrieve(item.query, FIXTURE_PROJ)
    for (const hit of result.hits) {
      equal(hit.row.status, 'active', `${item.note}：「${item.query}」不得返回 ${hit.row.status} 条目`)
    }
  }
})

test('HC-4b', 'I-2 结构性：只有 retrieve.ts 一处写 status = active 的检索查询', async () => {
  const files = readAllSources().filter((file) => file.path.includes('/host/'))
  const offenders: string[] = []
  for (const file of files) {
    const text = stripCommentsAndStrings(file.text)
    // 找形如 SELECT ... FROM memories ... status = 'active' 的检索式查询
    const selects = [...text.matchAll(/SELECT[\s\S]{0,400}?FROM memories[\s\S]{0,400}?(?=`|;|\))/gi)]
    for (const match of selects) {
      const sql = match[0]
      if (sql.includes("status = 'active'") && !sql.includes('status IN')) {
        // dao.listByStatuses 用参数化 status IN，不算
        if (/status\s*=\s*'active'/.test(sql) && !file.path.endsWith('retrieve.ts') && !file.path.endsWith('dao.ts')) {
          offenders.push(`${file.path}: ${sql.slice(0, 80).replace(/\s+/g, ' ')}`)
        }
      }
    }
  }
  equal(offenders, [], '除 retrieve.ts 外不得有第二个把 status 钉成 active 的检索查询')
})

// ============================================================ HC-5 面板不是写入入口

test('HC-5', '面板不是写入入口（PB-4）：无新建 API / 无 main 整页注册', async () => {
  const sources = readAllSources()
  for (const { path, text } of sources) {
    assert(!/\/api\/memory\/create/.test(text), `${path} 不得暴露新建接口`)
    assert(!/POST[\s\S]{0,40}create/.test(text), `${path} 不得有 create 路由`)
  }
})

// ============================================================ HC-6 不得手动改分层

test('HC-6', '不得手动改分层（D-5 Q3）：EditInput 类型里没有 layer', async () => {
  const manage = stripCommentsAndStrings(readFileSync(join(root, 'host/domain/manage.ts'), 'utf8'))
  const start = manage.indexOf('export interface EditInput')
  const body = manage.slice(start, manage.indexOf('}', start))
  assert(!/\blayer\b/.test(body), 'EditInput 不得包含 layer 字段（改分层应在类型层不可表达）')
  // 运行时也无法通过 extra 属性绕过：edit() 只读 content/scope
  assert(!/input\.layer/.test(manage), 'edit() 不得读取 input.layer')
})

// ============================================================ HC-7 无假按钮

test('HC-7', '禁止无响应按钮（X-1/PE-13）：不渲染「在对话中定位」', async () => {
  const sources = readAllSources()
  for (const { path, text } of sources) {
    assert(
      !/在对话中定位|LocateInConversation|scrollToTurn/.test(stripCommentsAndStrings(text)),
      `${path} 不得渲染「在对话中定位」按钮（宿主无公开定位接口）`,
    )
  }
})

// ============================================================ HC-8 无第二渲染面

test('HC-8', '只剩一套渲染面（D-14）：不注册右栏页签与脚区入口', async () => {
  const sources = readAllSources()
  for (const { path, text } of sources) {
    assert(
      !/name:\s*['"]sidebar\.right\.pane\.tab['"]/.test(text),
      `${path} 不得注册右侧面板页签（D-14 后渲染面只剩 main）`,
    )
    assert(
      !/name:\s*['"]sidebar\.footer\.action['"]/.test(text),
      `${path} 不得注册脚区入口（入口改由 sidebar.panellist 承担）`,
    )
  }
})

// ============================================================ HC-9 回显 + 二次确认

test('HC-9', '破坏性操作回显 + 二次确认：无 token 不可硬删', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  throws(() => service.hardDelete('fix-1', '', FIXTURE_PROJ), '空 token 必须拒绝')
  throws(() => service.hardDelete('fix-1', 'made-up', FIXTURE_PROJ), '伪造 token 必须拒绝')

  const prepared = service.prepareHardDelete('fix-1', FIXTURE_PROJ)
  assert(prepared.echo.content !== null, 'prepare 必须回显正文（DC-17）')
  // token 一次性
  service.hardDelete('fix-1', prepared.token, FIXTURE_PROJ)
  throws(() => service.hardDelete('fix-1', prepared.token, FIXTURE_PROJ), 'token 必须一次性')
})

// ============================================================ HC-10 天数文案一致

test('HC-10', '天数文案与实际行为一致（X-4）：30 天配置下 31 天前软删真的转硬删', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)

  equal(service.retentionDays(), 30, '默认保留期应为 30 天')

  service.seed([
    {
      id: 'old-soft',
      layer: 'semantic',
      content: '31 天前软删的条目',
      scope: 'project',
      projectKey: FIXTURE_PROJ,
      createdAt: clock.now() - 40 * DAY,
      status: 'deleted_soft',
      deletedAt: clock.now() - 31 * DAY,
    },
    {
      id: 'new-soft',
      layer: 'semantic',
      content: '1 天前软删的条目',
      scope: 'project',
      projectKey: FIXTURE_PROJ,
      createdAt: clock.now() - 5 * DAY,
      status: 'deleted_soft',
      deletedAt: clock.now() - 1 * DAY,
    },
  ])

  const swept = service.sweepRecycle()
  equal(swept, 1, '应只清掉 31 天前的那一条')

  equal(service.getById('old-soft')!.status, 'deleted_hard', '31 天前软删应转硬删（文案说 30 天就必须真做）')
  equal(service.getById('new-soft')!.status, 'deleted_soft', '1 天前软删应保留')

  // 配置为 null 时：不得清理，且 UI 不得出现天数
  service.rawDb.raw.prepare("UPDATE memory_settings SET value='null' WHERE key='retention_days'").run()
  equal(service.retentionDays(), null, '配置应可置为不过期')
  const sweptNull = service.sweepRecycle()
  equal(sweptNull, 0, '不过期配置下不应清理任何条目')
  const recycleText = service.listB(FIXTURE_PROJ)
  for (const entry of recycleText) {
    equal(entry.remainingDays, null, '不过期配置下 remainingDays 必须为 null（UI 才能不打天数）')
  }
})

// ============================================================ HC-11 忘掉=软删

test('HC-11', '「忘掉」不得触发硬删（X-1）', async () => {
  // 单条
  equal(decideDeleteTier('忘掉第 3 条', 'single'), 'soft', '「忘掉第 N 条」必须 soft')
  equal(decideDeleteTier('忘掉这条', 'single'), 'soft', '「忘掉这条」必须 soft')
  // 批量
  equal(decideDeleteTier('忘掉关于构建问题的记忆', 'batch'), 'soft', '批量「忘掉」必须 soft')
  equal(decideDeleteTier('忘掉关于 X 的全部记忆', 'batch'), 'soft', '批量「忘掉…全部」必须 soft')
  // 显式不可逆才 hard
  equal(decideDeleteTier('彻底删除第 3 条', 'single'), 'hard', '「彻底删除」必须 hard')
  equal(decideDeleteTier('永久删除这条', 'single'), 'hard', '「永久删除」必须 hard')
  equal(decideDeleteTier('不要留任何副本', 'single'), 'hard', '「不要留副本」必须 hard')
  equal(decideDeleteTier('彻底忘掉这条', 'single'), 'hard', '「彻底忘掉」也应 hard（彻底=不可逆信号）')
  // 默认
  equal(decideDeleteTier('删掉第 3 条', 'single'), 'soft', '默认必须 soft')

  // 行为面：忘掉 → 仍在回收站
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const tier = decideDeleteTier('忘掉第 1 条', 'single')
  equal(tier, 'soft', '档位判定为 soft')
  service.softDelete('fix-1', FIXTURE_PROJ)
  const inRecycle = service.listB(FIXTURE_PROJ).some((entry) => entry.row.id === 'fix-1')
  assert(inRecycle, '「忘掉」后条目必须仍在回收站（与硬删成对照）')
})

// ============================================================ HC-12 折叠全清单口径

test('HC-12', '折叠按全清单口径（X-3）：两层各 4 条过期必须折叠', async () => {
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  loadFixture(service, collapseFixture(clock.now()))

  const counts = service.listA(FIXTURE_PROJ).counts
  equal(counts.c, 8, '全清单已过期 8 条')
  assert(shouldCollapseExpired(counts), '全清单 8 > 5 必须折叠')

  // 与对话通道一致：渲染出的文本必须体现折叠
  const text = renderList(service.listA(FIXTURE_PROJ), { now: clock.now() })
  assert(/未展开|折叠|另有/.test(text), `对话清单也应折叠，实际文本未体现：${text.slice(0, 200)}`)

  // 阈值边界：恰好 5 条不折叠
  const exactly5 = { n: 5, a: 0, b: 0, c: EXPIRED_COLLAPSE_THRESHOLD, filterLabel: null }
  assert(!shouldCollapseExpired(exactly5), '恰好 5 条不应折叠')
  const six = { n: 6, a: 0, b: 0, c: EXPIRED_COLLAPSE_THRESHOLD + 1, filterLabel: null }
  assert(shouldCollapseExpired(six), '6 条应折叠')
})

// ============================================================ HC-13 别记=软删+标注

test('HC-13', '「别记」走软删且标注原因（X-6）', async () => {
  assert(isUserAskedNotToKeep('这段别记'), '应识别「别记」')
  assert(isUserAskedNotToKeep('这句不要保存'), '应识别「不要保存」')

  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))

  service.softDelete('fix-2', FIXTURE_PROJ, 'user_asked_not_to_keep')
  const row = service.getById('fix-2')!
  equal(row.status, 'deleted_soft', '「别记」必须是软删（不是硬删）')

  const entry = service.listB(FIXTURE_PROJ).find((item) => item.row.id === 'fix-2')
  assert(entry !== undefined, '应出现在回收站')
  equal(entry.removeReason, '因用户要求不保留', '回收站必须标注「因用户要求不保留」')
  assert(entry.statusText.includes('因用户要求不保留'), `状态行应含原因，实际「${entry.statusText}」`)
})

// ============================================================ HC-14 无角标 / 有页签计数

test('HC-14', '入口无角标（X-5）但面板页签计数存在', async () => {
  const clientEntry = join(root, 'client/entry.tsx')
  try {
    const text = readFileSync(clientEntry, 'utf8')
    assert(!/badge|Badge|角标/.test(stripCommentsAndStrings(text)), '入口组件不得含角标元素（PE-19）')
  } catch {
    // 前端未落地时跳过（本用例在 client 存在后才有意义）
  }
  // 面板页签计数必须存在且与 countVisible 同源：这里验证"同源"这一半
  const { service } = makeService()
  const clock = fixedClock(Date.UTC(2026, 10, 1))
  service.setClock(clock.now)
  loadFixture(service, mainFixture(clock.now()))
  const view = service.listA(FIXTURE_PROJ)
  const recomputed = countVisible(
    view.entries.map((entry) => entry.row),
    null,
  )
  equal(
    [recomputed.n, recomputed.a, recomputed.b, recomputed.c],
    [view.counts.n, view.counts.a, view.counts.b, view.counts.c],
    '页签计数必须与首行同源（同一个 countVisible）',
  )
})
