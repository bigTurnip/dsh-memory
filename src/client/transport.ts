/**
 * 与 Host 的唯一通信适配层。
 *
 * 纪律（S-1 / §6.2）：这里只做字节搬运，**不加工数值**。
 * 特别是 `counts`：Host 已经用 `countVisible` 算好，前端只允许原样渲染，
 * 不允许再算一遍（那就会出现"两处数字打架"）。
 *
 * 面板**没有本地持久化**：没有 localStorage 副本、没有 IndexedDB。
 * 状态只活在 React state，刷新即重取 —— 这是 S-1「单一事实来源」的落地方式。
 */

import type { Counts } from '../shared/counting.js'

const PREFIX = '/api/memory'

export class MemoryApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'MemoryApiError'
    this.status = status
  }
}

interface Envelope<T> {
  readonly code: number
  readonly data: T
  readonly message: string
}

async function call<T>(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const method = init?.method ?? 'GET'
  const response = await fetch(`${PREFIX}${path}`, {
    method,
    ...(method === 'POST'
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init?.body ?? {}) }
      : {}),
    credentials: 'same-origin',
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
  })

  let payload: Envelope<T> | null = null
  try {
    payload = (await response.json()) as Envelope<T>
  } catch {
    payload = null
  }

  if (!response.ok || payload === null || payload.code !== 0) {
    const message =
      payload?.message !== undefined && payload.message !== ''
        ? payload.message
        : response.status === 0
          ? '连接中断，宿主可能正在重启'
          : `请求失败（HTTP ${response.status}）`
    throw new MemoryApiError(payload?.code ?? response.status, message)
  }
  return payload.data
}

// ---------------------------------------------------------------- 线上类型

export interface ListEntry {
  readonly id: string
  readonly ordinal: number
  readonly mark: string
  readonly content: string | null
  readonly layer: 'semantic' | 'episodic'
  readonly scope: 'project' | 'user'
  readonly status: 'active' | 'superseded' | 'expired'
  readonly statusText: string
  readonly sourceAt: number
  readonly eventPhrase: string
  readonly sourceType: string
  readonly snippet: string
  readonly sessionId: string
  readonly turnSeq: number
  readonly reuseCount: number
  readonly lastHitAt: number | null
  readonly supersededBy: string | null
  readonly expiresAt: number | null
  readonly sensitivity: string
}

export interface ListResponse {
  readonly counts: Counts
  readonly recycleCount: number
  readonly emptyText: string | null
  readonly entries: readonly ListEntry[]
}

export interface RecycleEntry {
  readonly id: string
  readonly ordinal: number
  readonly mark: string
  readonly content: string | null
  readonly layer: 'semantic' | 'episodic'
  readonly scope: 'project' | 'user'
  readonly statusText: string
  readonly removeReason: string
  readonly remainingDays: number | null
  readonly deletedAt: number | null
}

export interface ChangeEntry {
  readonly id: string
  readonly memoryId: string
  /** 该版本节点的内容（Host 从 detail 或当前 row 取；缺失时为 null）。 */
  readonly content: string | null
  readonly fromStatus: string
  readonly toStatus: string
  readonly reason: string
  readonly actor: string
  readonly at: number
  readonly detail: Record<string, unknown> | null
}

export interface ChangesResponse {
  readonly choices: readonly { memoryId: string; content: string; status: string; versions: number }[]
  readonly chain: readonly ChangeEntry[]
  readonly current: ListEntry | null
}

export interface HardDeletePrepare {
  readonly token: string
  readonly echo: {
    readonly id: string
    readonly content: string | null
    readonly layer: string
    readonly scope: string
    readonly status: string
    readonly sourceAt: number
  }
}

export interface HealthResponse {
  readonly enabled: boolean
  readonly retentionDays: number | null
  readonly ftsAvailable: boolean
  readonly now: number
}

export interface RecallPreviewHit {
  readonly ordinal: number
  readonly id: string
  readonly content: string
  readonly layer: string
  readonly scope: string
  readonly basis: string
}

export interface RecallPreview {
  readonly query: string
  readonly hits: readonly RecallPreviewHit[]
  readonly text: string
  readonly elapsedMs: number
  readonly degraded: false | 'timeout' | 'error'
}

export interface SettingsSaveResult {
  readonly changed: readonly string[]
  readonly values: Record<string, string>
}

const qs = (projectKey: string | null, extra: Record<string, string | undefined> = {}): string => {
  const params = new URLSearchParams()
  if (projectKey !== null) params.set('projectKey', projectKey)
  for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== '') params.set(key, value)
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

/** 面板要用的全部接口。 */
export const api = {
  health: (): Promise<HealthResponse> => call<HealthResponse>(`/health${qs(null)}`),

  list: (
    projectKey: string | null,
    filter: { scope?: string; layer?: string; status?: string; q?: string },
    signal?: AbortSignal,
  ): Promise<ListResponse> => call<ListResponse>(`/list${qs(projectKey, filter)}`, { signal }),

  recycle: (projectKey: string | null): Promise<RecycleEntry[]> =>
    call<RecycleEntry[]>(`/recycle${qs(projectKey)}`),

  changes: (projectKey: string | null, memoryId: string | null): Promise<ChangesResponse> =>
    call<ChangesResponse>(`/changes${qs(projectKey, memoryId === null ? {} : { memoryId })}`),

  edit: (projectKey: string | null, body: { id: string; content?: string; scope?: string }) =>
    call<unknown>(`/edit${qs(projectKey)}`, { method: 'POST', body: { ...body, projectKey } }),

  remove: (projectKey: string | null, id: string, reason?: 'user_asked_not_to_keep') =>
    call<unknown>(`/delete${qs(projectKey)}`, { method: 'POST', body: { id, projectKey, ...(reason ? { reason } : {}) } }),

  prepareHardDelete: (projectKey: string | null, id: string): Promise<HardDeletePrepare> =>
    call<HardDeletePrepare>(`/hard-delete/prepare${qs(projectKey)}`, { method: 'POST', body: { id, projectKey } }),

  hardDelete: (projectKey: string | null, id: string, token: string) =>
    call<unknown>(`/hard-delete${qs(projectKey)}`, { method: 'POST', body: { id, token, projectKey } }),

  restore: (projectKey: string | null, id: string) =>
    call<unknown>(`/restore${qs(projectKey)}`, { method: 'POST', body: { id, projectKey } }),

  batchForget: (projectKey: string | null, ids: readonly string[]) =>
    call<unknown>(`/batch-forget${qs(projectKey)}`, { method: 'POST', body: { ids, projectKey } }),

  // ---- 设置（面板设置抽屉） ----
  settings: (): Promise<Record<string, string>> => call<Record<string, string>>(`/settings${qs(null)}`),

  saveSettings: (values: Record<string, string>): Promise<SettingsSaveResult> =>
    call<SettingsSaveResult>(`/settings${qs(null)}`, { method: 'POST', body: { values } }),

  recallPreview: (projectKey: string | null, query: string): Promise<RecallPreview> =>
    call<RecallPreview>(`/recall${qs(projectKey)}`, { method: 'POST', body: { query, projectKey } }),
}
