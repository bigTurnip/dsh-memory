/**
 * Smoke 的实现体（`test/smoke.mjs` 调用）。
 *
 * 每一行都是 test-engineer 可以直接看的"记忆已就绪"证据。
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { MemoryService } from '../host/domain/service.js'
import { createTools, type ToolExec } from '../host/tools/index.js'
import { ROUTE_KEYS } from '../host/http/routes.js'

const LINE = '='.repeat(72)

export async function smoke(): Promise<boolean> {
  let failures = 0
  const check = (label: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`)
  }

  console.log('\n记忆系统 smoke（O-1）')
  console.log(LINE)

  // 1. 运行环境
  check('宿主运行时', true, `${process.version}（FTS5 需要宿主运行时，系统 node 不可用）`)

  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-smoke-data-'))
  const service = new MemoryService({ dataDir: join(root, 'data') })
  service.setClock(() => Date.UTC(2026, 10, 1))

  // 2. 库与表
  check('数据库打开 + 建表', true, `fts5=${service.rawDb.ftsAvailable}`)
  check('FTS5 可用（AC-10 前提）', service.rawDb.ftsAvailable, service.rawDb.ftsAvailable ? 'yes' : 'no → 检索会退化为纯字面')

  // 3. 默认设置
  check('默认开启（OQ-1=A）', service.enabled(), `enabled=${service.enabled()}`)
  check('保留期 30 天（D-5 Q2 / X-4）', service.retentionDays() === 30, `retention=${service.retentionDays()}`)

  // 4. 工具
  const tools = createTools({ service })
  check('工具数量 = 4', tools.length === 4, tools.map((tool) => tool.name).join(', '))
  const exec: ToolExec = {
    callId: 'smoke-1',
    signal: new AbortController().signal,
    agent: { session: { id: 'smoke-session' } },
  }
  const writeResult = (await tools[0]!.execute(
    {
      content: '发版前必须先跑 pnpm build',
      layer: 'semantic',
      scope: 'project',
      sourceType: 'explicit',
      eventPhrase: '你说明发版流程时',
      snippet: '发版必须先跑 build',
    },
    exec,
  )) as { kind: string; id: string | null }
  check('memory_write 可调用', writeResult.kind === 'created', `kind=${writeResult.kind}`)

  // 5. 路由（PB-4：没有 create）
  check('HTTP 路由已注册', ROUTE_KEYS.length > 0, `${ROUTE_KEYS.length} 条`)
  check(
    '路由里没有 create（PB-4）',
    !ROUTE_KEYS.some((key) => /create/i.test(key)),
    ROUTE_KEYS.filter((key) => /create/i.test(key)).join(',') || '无',
  )

  // 6. 端到端
  const projectKey = '/smoke/project'
  const search = (await tools[1]!.execute({ query: '发版要注意什么' }, exec)) as {
    hits: Array<{ content: string }>
    degraded: unknown
  }
  check(
    '检索能召回刚写入的条目',
    search.hits.some((hit) => (hit.content ?? '').includes('pnpm build')),
    `${search.hits.length} 命中，degraded=${String(search.degraded)}`,
  )

  const listing = (await tools[2]!.execute({ view: 'a' }, exec)) as {
    counts: { n: number; a: number; b: number; c: number }
  }
  check('清单计数 DC-10', listing.counts.a + listing.counts.b + listing.counts.c === listing.counts.n, JSON.stringify(listing.counts))

  const id = writeResult.id!
  await tools[3]!.execute({ action: 'delete', id, utterance: '删掉这条' }, { ...exec, })
  const afterDelete = service.retrieve('发版要注意什么', projectKey)
  check('软删后检索为 0（AC-5 软删档）', afterDelete.hits.length === 0, `${afterDelete.hits.length} 命中`)
  const recycle = service.listB(projectKey)
  check('软删后在回收站可见（C-3 拆分断言）', recycle.some((entry) => entry.row.id === id), `${recycle.length} 条`)

  void projectKey
  service.close()
  rmSync(root, { recursive: true, force: true })

  console.log(LINE)
  console.log(failures === 0 ? '记忆系统已就绪 ✅' : `${failures} 项未通过 ❌`)
  return failures === 0
}
