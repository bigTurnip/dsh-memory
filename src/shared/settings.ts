/**
 * 设置项的**唯一规格表**（`memory_settings` 的合法键、类型、范围、文案）。
 *
 * 为什么放 shared：面板要渲染控件、HTTP 要校验、Host 要落库。
 * 三处若各写一份"哪些键合法 / 范围多少"，迟早出现
 * 「界面能填 0、后端拒绝」或「界面没这个开关、库里却生效」这类两处打架的缺陷
 * （S-1 同一条纪律：单一事实来源）。
 *
 * 纪律（与原设计一致）：
 * - 设置**不是记忆条目**，不落 `memories`，不参与检索（D-6 Q5）。
 * - 每个值都必须能被 UI 文案解释：`retention_days=null` 时回收站文案不得出现天数（D-8 X-4）。
 */

export type SettingKind = 'flag' | 'integer' | 'nullable-integer'

export interface SettingSpec {
  readonly key: string
  readonly label: string
  readonly kind: SettingKind
  /** 仅 integer / nullable-integer。 */
  readonly min?: number
  readonly max?: number
  readonly unit?: string
  /** 面板里显示的一行说明：写"改了会发生什么"，不写实现细节。 */
  readonly hint: string
}

export const SETTING_SPECS: readonly SettingSpec[] = [
  {
    key: 'enabled',
    label: '记忆功能',
    kind: 'flag',
    hint: '关闭后不写入、不检索，清单与面板都不可查；开启是关闭态下唯一可执行的操作。',
  },
  {
    key: 'prompt_writes',
    label: '写入提示',
    kind: 'flag',
    hint: '关闭后写入成功不再附带提示行（写入照常进行，只是不提示）。',
  },
  {
    key: 'write_prompt_budget',
    label: '每会话提示次数',
    kind: 'integer',
    min: 1,
    max: 20,
    unit: '次',
    hint: '每个会话前 N 次写入各给一行提示，之后静默。',
  },
  {
    key: 'retention_days',
    label: '回收站保留',
    kind: 'nullable-integer',
    min: 1,
    max: 365,
    unit: '天',
    hint: '到期后彻底删除；勾选「不过期」则回收站永不自动清空（文案也不再出现天数）。',
  },
  {
    key: 'episodic_retention_days',
    label: '情景记忆保留',
    kind: 'integer',
    min: 1,
    max: 3650,
    unit: '天',
    hint: '只作用于情景层。到期转「已过期」，仍可见、可恢复，恢复后按这个天数重新计时。',
  },
  {
    key: 'decay_window_days',
    label: '情景衰减窗口',
    kind: 'integer',
    min: 1,
    max: 3650,
    unit: '天',
    hint: '只影响检索排序，不改变状态：长期未命中的情景条目排序会略靠后（下限 0.5）。',
  },
  {
    key: 'recall_inject',
    label: '自动召回注入',
    kind: 'flag',
    hint: '开启后每轮按你的输入自动召回最多 3 条记忆注入上下文（只注入生效条目；关闭记忆时永不注入）。',
  },
]

export const SETTING_KEYS: readonly string[] = SETTING_SPECS.map((spec) => spec.key)

export type SettingResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string }

function specOf(key: string): SettingSpec | null {
  return SETTING_SPECS.find((spec) => spec.key === key) ?? null
}

const TRUE_WORDS = new Set(['1', 'true', 'on', 'yes'])
const FALSE_WORDS = new Set(['0', 'false', 'off', 'no', ''])
const NULL_WORDS = new Set(['null', 'none', ''])

function normalizeFlag(raw: unknown): SettingResult {
  if (typeof raw === 'boolean') return { ok: true, value: raw ? '1' : '0' }
  if (typeof raw === 'number') return { ok: true, value: raw === 0 ? '0' : '1' }
  if (typeof raw === 'string') {
    const word = raw.trim().toLowerCase()
    if (TRUE_WORDS.has(word)) return { ok: true, value: '1' }
    if (FALSE_WORDS.has(word)) return { ok: true, value: '0' }
  }
  return { ok: false, message: '只接受开 / 关' }
}

function parseInteger(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeInteger(spec: SettingSpec, raw: unknown): SettingResult {
  const parsed = parseInteger(raw)
  if (parsed === null) return { ok: false, message: '必须是一个数字' }
  if (!Number.isInteger(parsed)) return { ok: false, message: '必须是整数' }
  const min = spec.min ?? 1
  const max = spec.max ?? 3650
  if (parsed < min || parsed > max) return { ok: false, message: `必须在 ${min}–${max} 之间` }
  return { ok: true, value: String(parsed) }
}

function normalizeNullableInteger(spec: SettingSpec, raw: unknown): SettingResult {
  if (raw === null || raw === undefined) return { ok: true, value: 'null' }
  if (typeof raw === 'string' && NULL_WORDS.has(raw.trim().toLowerCase())) return { ok: true, value: 'null' }
  return normalizeInteger(spec, raw)
}

/**
 * 校验并归一化一个设置值。
 *
 * @returns 归一化后的字符串（存库格式），或一条给人看的错误。
 *   **未知键一律拒绝**：设置表不接受"顺手多存一个"的键，否则下一个读它的代码
 *   会在不知情的情况下被外部输入影响。
 */
export function normalizeSetting(key: string, raw: unknown): SettingResult {
  const spec = specOf(key)
  if (spec === null) return { ok: false, message: `没有这个设置项：${key}` }
  if (spec.kind === 'flag') return normalizeFlag(raw)
  if (spec.kind === 'nullable-integer') return normalizeNullableInteger(spec, raw)
  return normalizeInteger(spec, raw)
}

/** 展示用：flag 值是否为开。 */
export function isFlagOn(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/** 展示用：nullable 值是否为「不过期」。 */
export function isUnlimited(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'null'
}
