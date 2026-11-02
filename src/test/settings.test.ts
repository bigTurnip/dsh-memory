/**
 * 设置抽屉 + 自动召回注入的自测。
 *
 * 这里要回答三个"界面上看得见、但可能根本没接线"的怀疑：
 * 1. `SETTING_SPECS` 里的范围与后端校验是不是**同一套**？（否则界面能填、保存被拒）
 * 2. `applySettings` 是不是**全有或全无**？（否则界面显示的和库里存的是两回事）
 * 3. `decay_window_days` / `recall_inject` 是不是**真的被读到**？
 *    （历史上有过"schema 里播种了、代码从不读"的先例，见 tech-design F 系列）
 *
 * 最后一条是本文件的核心：设置项写进库 ≠ 生效。必须由行为断言证明。
 */

import { test, assert, equal } from './harness.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTING_KEYS, SETTING_SPECS, normalizeSetting, isFlagOn, isUnlimited } from '../shared/settings.js'
import {
  formatRecallText,
  buildRecallPreview,
  currentUserPrompt,
  recallTextForScope,
  registerRecallInjection,
  RECALL_LIMIT,
  RECALL_CONTENT_MAX,
  RECALL_TEXT_MAX,
  RECALL_CONTEXT_ORDER,
  RECALL_CONTEXT_NAME,
  type RecallScope,
  type RecallHostContext,
} from '../host/domain/recall.js'
import { rerankScore } from '../shared/retrieval-score.js'
import { makeService, fixedClock } from './behaviour.test.js'
import { makeHttp } from './dual.test.js'
import { DAY } from './fixtures/data.js'
import type { MemoryService } from '../host/domain/service.js'

const PROJ = '/proj/settings'
const T0 = Date.UTC(2026, 10, 1, 8, 0, 0)

/** 一个只够注入用的假作用域（不依赖宿主）。 */
function fakeScope(prompt: string | null, projectKey: string | null = PROJ): RecallScope {
  return {
    systemPrompt: { context: () => () => {} },
    ...(prompt === null
      ? {}
      : {
          agents: {
            currentInitiator: () => ({
              session: {
                id: 'session-x',
                deriveMessages: () => [
                  { role: 'assistant', source: { kind: 'agent' }, content: [{ type: 'text', text: '好的' }] },
                  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] },
                ],
              },
            }),
          },
        }),
    ...(projectKey === null ? {} : { workingDirectory: { get: () => projectKey } }),
  }
}

function seedOne(service: MemoryService, content: string, at = T0 - 1 * DAY, layer: 'semantic' | 'episodic' = 'semantic'): string {
  const row = {
    layer,
    content,
    scope: 'project' as const,
    projectKey: PROJ,
    createdAt: at,
    confirmedAt: at,
    eventPhrase: '你说明测试命令时',
    snippet: content,
    expiresAt: layer === 'episodic' ? T0 + 300 * DAY : null,
  }
  return service.seed([row])[0]!
}

// ============================================================ 规格表 + 校验

test('SET-validate', '校验规则：类型/范围/未知键，与形态切换', async () => {
  // flag：文案友好（开/关）优先，未知词必须拒绝，不能"悄悄当成关"
  equal(normalizeSetting('enabled', true), { ok: true, value: '1' }, 'true → 1')
  equal(normalizeSetting('enabled', 'on'), { ok: true, value: '1' }, '"on" → 1')
  equal(normalizeSetting('enabled', 'off'), { ok: true, value: '0' }, '"off" → 0')
  equal(normalizeSetting('enabled', ''), { ok: true, value: '0' }, '空串视为关')
  equal(normalizeSetting('enabled', 'maybe').ok, false, '未知开关词必须拒绝')

  // integer：越界/非整数/非数字都必须拒绝（界面上的 min/max 只是提示，不能当校验）
  equal(normalizeSetting('write_prompt_budget', '5'), { ok: true, value: '5' }, '5 合法')
  equal(normalizeSetting('write_prompt_budget', 0).ok, false, '0 越界（min 1）')
  equal(normalizeSetting('write_prompt_budget', '21').ok, false, '21 越界（max 20）')
  equal(normalizeSetting('write_prompt_budget', '3.5').ok, false, '小数必须拒绝')
  equal(normalizeSetting('write_prompt_budget', 'abc').ok, false, '非数字必须拒绝')
  equal(normalizeSetting('write_prompt_budget', '').ok, false, '空串不是合法整数')

  // nullable-integer：null / "null" / "" 都是「不过期」
  equal(normalizeSetting('retention_days', null), { ok: true, value: 'null' }, 'null → null')
  equal(normalizeSetting('retention_days', ''), { ok: true, value: 'null' }, '空串 → null')
  equal(normalizeSetting('retention_days', 'null'), { ok: true, value: 'null' }, '"null" → null')
  equal(normalizeSetting('retention_days', '30'), { ok: true, value: '30' }, '30 保留')
  equal(normalizeSetting('retention_days', '0').ok, false, '0 天没有意义，必须拒绝')

  // 未知键：设置表不接受"顺手多存一个"的键
  const unknown = normalizeSetting('no_such_setting', '1')
  equal(unknown.ok, false, '未知键必须拒绝')
  assert(!unknown.ok && unknown.message.includes('no_such_setting'), '错误信息应点名键名')

  // 展示用的两个判定（面板渲染依赖它们，不能与校验规则分叉）
  assert(isFlagOn('1') && isFlagOn('true') && !isFlagOn('0') && !isFlagOn(undefined), 'isFlagOn 判定')
  assert(isUnlimited('null') && isUnlimited('') && isUnlimited(undefined) && !isUnlimited('30'), 'isUnlimited 判定')
})

test('SET-specs', '规格表覆盖面板要渲染的全部设置项', async () => {
  // 7 项：6 项既有设置 + 自动召回开关
  equal(SETTING_KEYS.length, 7, `规格表项数，实际 ${SETTING_KEYS.join(',')}`)
  assert(SETTING_KEYS.includes('recall_inject'), '召回开关必须在规格表里（否则面板不渲染它）')
  for (const spec of SETTING_SPECS) {
    assert(spec.label !== '' && spec.hint !== '', `${spec.key} 必须有标签与说明（D-8 X-4：每个值都要能被文案解释）`)
    if (spec.kind !== 'flag') {
      assert(spec.unit !== undefined, `${spec.key} 是数值项，必须有单位`)
      assert(spec.min !== undefined && spec.max !== undefined && spec.min < spec.max, `${spec.key} 必须有合理范围`)
    }
  }
})

// ============================================================ 服务：快照 / 全有或全无 / 召回开关

test('SET-snapshot', '设置快照完整且默认召回关闭', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  const snapshot = service.settingsSnapshot()
  equal(Object.keys(snapshot), [...SETTING_KEYS], '快照必须正好是规格表的键，不多不少')
  equal(snapshot.recall_inject, '0', '自动召回默认必须关闭（R-3.5.1：不常驻上下文）')
  equal(snapshot.enabled, '1', '记忆默认开启')
})

test('SET-atomic', '批量保存全有或全无：一项不合法则一项都不落库', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)
  const before = service.settingsSnapshot()

  let message = ''
  try {
    service.applySettings({ prompt_writes: '0', write_prompt_budget: '999' })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert(message.includes('write_prompt_budget'), `应拒绝并点名越界项，实际「${message}」`)
  equal(service.settingsSnapshot(), before, '校验失败时库里不得有任何变化（含排在前面的合法项）')

  let empty = ''
  try {
    service.applySettings({})
  } catch (error) {
    empty = error instanceof Error ? error.message : String(error)
  }
  assert(empty !== '', '空对象应报错，而不是静默成功')
})

test('SET-apply', '保存后立即生效：提示预算与召回开关都读新值', async () => {
  const { service } = makeService()
  service.setClock(fixedClock(T0).now)

  const applied = service.applySettings({ prompt_writes: '0', write_prompt_budget: '5' })
  equal(applied.changed, ['prompt_writes', 'write_prompt_budget'], 'changed 应列出本次写入的键')
  equal(applied.values.prompt_writes, '0', '返回值是保存后的完整快照')
  equal(service.promptWritesEnabled(), false, 'prompt_writes=0 后提示应关闭')

  equal(service.autoRecallEnabled(), false, '默认不开自动召回')
  service.applySettings({ recall_inject: '1' })
  equal(service.autoRecallEnabled(), true, 'recall_inject=1 后应开启')

  // 总开关优先：关闭记忆时永不注入（否则"关闭后没有可查的记忆"不成立）
  service.applySettings({ enabled: '0' })
  equal(service.enabled(), false, 'enabled=0 生效')
  equal(service.autoRecallEnabled(), false, '关闭记忆必须压过召回开关')
})

// ============================================================ 衰减窗口真的接线了

test('SET-decay', '衰减窗口从设置读到检索：窗口越小老条目分数越低', async () => {
  const { service } = makeService()
  service.setClock(() => T0)
  // 两条内容完全相同的情景记忆，只差"多久没被确认"
  service.seed([
    {
      id: 'old',
      layer: 'episodic',
      content: '发版前必须先跑 pnpm build',
      scope: 'project',
      projectKey: PROJ,
      createdAt: T0 - 200 * DAY,
      confirmedAt: T0 - 200 * DAY,
      eventPhrase: '你说明发版流程时',
      snippet: '发版前必须先跑 pnpm build',
      expiresAt: T0 + 300 * DAY,
    },
    {
      id: 'fresh',
      layer: 'episodic',
      content: '发版前必须先跑 pnpm build',
      scope: 'project',
      projectKey: PROJ,
      createdAt: T0 - 1 * DAY,
      confirmedAt: T0 - 1 * DAY,
      eventPhrase: '你说明发版流程时',
      snippet: '发版前必须先跑 pnpm build',
      expiresAt: T0 + 300 * DAY,
    },
  ])

  const scoreOf = (id: string): number => service.retrieve('发版前要做什么', PROJ, 5).hits.find((hit) => hit.row.id === id)!.score

  service.applySettings({ decay_window_days: '1' })
  const narrow = scoreOf('old')
  service.applySettings({ decay_window_days: '3650' })
  const wide = scoreOf('old')

  // 200 天没确认：窗口 1 天 ≈ 触底 0.5，窗口 3650 天 ≈ 0.97 —— 分数必须差出一大截
  assert(wide > narrow * 1.5, `窗口变大后老条目分数应显著回升，实际 ${narrow.toFixed(4)} → ${wide.toFixed(4)}`)

  // 同一窗口下"近期确认"必然排在"久未确认"前面（衰减只影响档内顺序）
  service.applySettings({ decay_window_days: '30' })
  const hits = service.retrieve('发版前要做什么', PROJ, 5).hits.map((hit) => hit.row.id)
  assert(hits.indexOf('fresh') < hits.indexOf('old'), `新条目应排在前面，实际 ${hits.join(' > ')}`)

  // 语义层不受窗口影响（I-4：只有情景层会自然过期）
  const row = { content: '发版前必须先跑 pnpm build', layer: 'semantic', sourceType: 'explicit', confirmedAt: T0 - 200 * DAY, lastHitAt: null }
  const tokens = new Set(['发版', 'pnpm'])
  equal(
    rerankScore(row, tokens, T0, 1),
    rerankScore(row, tokens, T0, 3650),
    '语义层分数不得随衰减窗口变化',
  )
})

// ============================================================ 注入文本

test('RECALL-format', '注入文本：空命中为空白、带依据、有长度上限', async () => {
  const { service } = makeService()
  service.setClock(() => T0)

  equal(formatRecallText([], T0), '', '没有命中必须返回空串（否则会注入一段"没有记忆"的噪音）')

  seedOne(service, '测试命令是 vitest')
  const hit = service.retrieve('测试命令是什么', PROJ, RECALL_LIMIT).hits[0]
  assert(hit !== undefined, '应命中种子条目')
  const text = formatRecallText([hit], T0)
  assert(text.startsWith('【自动召回的记忆】'), `首行应是标注来源的标题，实际「${text.slice(0, 24)}」`)
  assert(text.includes('测试命令是 vitest'), '必须包含正文')
  assert(text.includes('语义·项目级') && text.includes('你说明测试命令时'), `必须带分层/作用域/依据，实际「${text}」`)
  assert(text.includes('如与当前问题无关就忽略'), '必须有"无关就忽略"的免责行')

  // 单条正文截断（注入的是提示，不是全文）
  const { service: long } = makeService()
  long.setClock(() => T0)
  seedOne(long, `${'很长的记忆'.repeat(60)}结尾标记`)
  const longHit = long.retrieve('很长的记忆', PROJ, RECALL_LIMIT).hits[0]!
  const longText = formatRecallText([longHit], T0)
  assert(longText.includes('…'), '超长正文必须截断并留省略号')
  assert(!longText.includes('结尾标记'), '截断后不应包含尾部内容')
  assert(longText.length < RECALL_CONTENT_MAX + 200, `截断后长度应受控，实际 ${longText.length}`)
  assert(RECALL_TEXT_MAX >= 900, '整段上限至少能装下 3 条短记忆')
  assert(RECALL_CONTEXT_ORDER > 100, '顺序位必须晚于 WORKING_DIRECTORY(100)')
  equal(RECALL_CONTEXT_NAME, 'dsh-memory:recall', '段名固定（宿主用它做快照 diff）')
})

test('RECALL-preview', '预览与注入共用同一份文本（所见即所注入）', async () => {
  const { service } = makeService()
  service.setClock(() => T0)
  seedOne(service, '测试命令是 vitest')

  const preview = buildRecallPreview(service, '测试命令是什么', PROJ)
  equal(preview.query, '测试命令是什么', '预览应回显问题（便于确认检索口径）')
  assert(preview.hits.length > 0, '预览应有命中')
  equal(preview.hits[0]!.ordinal, 1, '序号从 1 开始')
  equal(preview.text, formatRecallText(service.retrieve('测试命令是什么', PROJ, RECALL_LIMIT).hits, T0), '预览文本必须等于注入文本')

  const emptyPreview = buildRecallPreview(service, '完全不相干的火星话题 zzz', PROJ)
  equal(emptyPreview.text, '', '无关话题不注入任何内容')
})

// ============================================================ 本轮输入与三关

test('RECALL-scope', '本轮输入取法 + 三关（开关/会话/降级）', async () => {
  const { service } = makeService()
  service.setClock(() => T0)
  seedOne(service, '测试命令是 vitest')

  // 取本轮输入：只认 role=user 且 source.kind=user 的最后一条
  equal(currentUserPrompt(fakeScope('测试命令是什么')), '测试命令是什么', '应取到最后一条真实用户消息')
  equal(currentUserPrompt(fakeScope(null)), null, '没有 agents 服务时应返回 null（不猜）')
  equal(
    currentUserPrompt({
      systemPrompt: { context: () => () => {} },
      agents: { currentInitiator: () => ({ session: { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] }] } }) },
    }),
    null,
    '纯空白消息不算输入（空串检索会得到任意 top-3）',
  )
  equal(
    currentUserPrompt({
      systemPrompt: { context: () => () => {} },
      agents: { currentInitiator: () => ({ session: { deriveMessages: () => { throw new Error('boom') } } }) },
    }),
    null,
    'deriveMessages 抛错时降级为 null，不能把异常抛到宿主组装流程里',
  )

  // 第一关：开关关闭 → 空串
  equal(recallTextForScope(fakeScope('测试命令是什么'), service), '', '开关关闭时不得注入')

  service.applySettings({ recall_inject: '1' })
  const text = recallTextForScope(fakeScope('测试命令是什么'), service)
  assert(text.includes('测试命令是 vitest'), `开关打开后应注入召回内容，实际「${text}」`)

  // 第二关：拿不到会话 → 空串
  equal(recallTextForScope(fakeScope(null), service), '', '拿不到会话时不得注入')

  // 第三关：检索降级 → 空串（宁可少注入，不注入半份记忆）
  service.faults.retrieveError = true
  equal(recallTextForScope(fakeScope('测试命令是什么'), service), '', '检索降级时不得注入')
  service.faults.retrieveError = false

  // 总开关：关闭记忆 → 即使开关打开也不注入
  service.applySettings({ enabled: '0' })
  equal(recallTextForScope(fakeScope('测试命令是什么'), service), '', '关闭记忆时永不注入')
})

test('RECALL-register', '注册注入：三个服务齐全才挂 context，顺序位与段名固定', async () => {
  const { service } = makeService()
  service.setClock(() => T0)

  const injected: string[][] = []
  const entries: Array<{ name: string; order: number; required?: boolean; text: unknown }> = []
  let disposeLabel = ''
  const ctx: RecallHostContext = {
    inject: (names, callback) => {
      injected.push(names)
      callback(
        fakeScope('测试命令是什么') as RecallScope,
      )
    },
    effect: (reversible, label) => {
      disposeLabel = label ?? ''
      reversible()
    },
  }
  // 用真实 systemPrompt 形状（context 返回 dispose 函数）
  const scopeWithRecorder: RecallScope = {
    ...fakeScope('测试命令是什么'),
    systemPrompt: {
      context: (entry) => {
        entries.push({ name: entry.name, order: entry.order, required: entry.required, text: entry.text })
        return () => {}
      },
    },
  }
  const recordingCtx: RecallHostContext = {
    inject: (names, callback) => {
      injected.push(names)
      callback(scopeWithRecorder)
    },
    effect: ctx.effect,
  }
  registerRecallInjection(recordingCtx, service)

  equal(injected[0], ['systemPrompt', 'agents', 'workingDirectory'], '必须同时注入三个服务（缺一个就不注册）')
  equal(entries.length, 1, '应恰好注册一段 context')
  equal(entries[0]!.name, RECALL_CONTEXT_NAME, '段名固定')
  equal(entries[0]!.order, RECALL_CONTEXT_ORDER, '顺序位固定')
  equal(entries[0]!.required, false, '不是必需段：拿不到内容时宿主可以省略')
  equal(typeof entries[0]!.text, 'function', '文本必须是惰性求值（每轮重新算）')
  equal((entries[0]!.text as () => string)(), '', '开关关闭时求值为空串')
  assert(disposeLabel.includes('recall'), `effect 必须带可读标签，实际「${disposeLabel}」`)
})

// ============================================================ HTTP（面板通道）

test('SET-http', '设置读写与召回预览的 HTTP 契约', async () => {
  const { service } = makeService()
  service.setClock(() => T0)
  seedOne(service, '测试命令是 vitest')
  const http = makeHttp(service)

  const read = (await http('GET', '/api/memory/settings')) as { code: number; data: Record<string, string> }
  equal(read.code, 0, '读设置应成功')
  equal(Object.keys(read.data), [...SETTING_KEYS], 'HTTP 只回规格表里的键（不泄整张表）')
  equal(read.data.recall_inject, '0', '默认关闭')

  const write = (await http('POST', '/api/memory/settings', { values: { recall_inject: '1' } })) as {
    code: number
    data: { changed: string[]; values: Record<string, string> }
  }
  equal(write.code, 0, '写设置应成功')
  equal(write.data.changed, ['recall_inject'], '应回报改了哪些键')
  equal(service.autoRecallEnabled(), true, 'HTTP 写入必须落在同一个 service 上（S-1）')

  const bad = await http('POST', '/api/memory/settings', { values: { recall_inject: 'maybe' } })
  equal(bad.code, 400, '非法值必须 400，而不是 200 + 静默忽略')
  equal((await http('POST', '/api/memory/settings', { values: [] })).code, 400, 'values 不是对象应 400')
  equal((await http('POST', '/api/memory/settings', {})).code, 400, '缺少 values 应 400')

  const preview = (await http('POST', `/api/memory/recall?projectKey=${encodeURIComponent(PROJ)}`, {
    query: '测试命令是什么',
  })) as { code: number; data: { text: string; hits: unknown[]; degraded: boolean | string } }
  equal(preview.code, 0, '召回预览应成功')
  assert(preview.data.text.includes('测试命令是 vitest'), '预览应包含命中正文')
  assert(preview.data.hits.length > 0, '预览应回结构化命中（面板要画列表）')

  equal((await http('POST', `/api/memory/recall?projectKey=${encodeURIComponent(PROJ)}`, { query: '  ' })).code, 400, '空 query 应 400')
})

test('SET-no-create', '设置路由不引入写入记忆的入口（PB-4 不回退）', async () => {
  // 设置是配置，不是记忆：路由表里仍然没有任何 create
  // DSH_MEMORY_SRC_ROOT 指向 src 目录（runner 注入），不是仓库根
  const source = readFileSync(join(process.env.DSH_MEMORY_SRC_ROOT ?? '.', 'host/http/routes.ts'), 'utf8')
  assert(!/'[A-Z]+ \/api\/memory\/create'/.test(source), '路由表不得出现 create')
  assert(source.includes("'GET /api/memory/settings'"), '设置读路由必须存在')
  assert(source.includes("'POST /api/memory/settings'"), '设置写路由必须存在')
})
