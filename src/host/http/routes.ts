/**
 * `/api/memory/*` HTTP 适配层（**薄**）。
 *
 * 这一层只做三件事：解析 JSON、查路由表、包统一信封 `{code,data,message}`。
 * **不含任何业务判断** —— 业务全在 `MemoryService` 里。
 * 这是让"面板看到的数字"与"工具看到的数字"必然相同的原因：
 * 它们不是两份实现，是同一个对象。
 *
 * 路由表里**没有 create**（面板不是写入入口，PB-4 / HC-5）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MemoryService } from '../domain/service.js'
import { buildRecallPreview } from '../domain/recall.js'
import { ERROR_CODE, type Filter, type Layer, type Scope, type Status } from '../../shared/contract.js'

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

interface Envelope<T> {
  readonly code: number
  readonly data: T | null
  readonly message: string
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 1_000_000) throw new HttpError(413, ERROR_CODE.invalid, '请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    throw new HttpError(400, ERROR_CODE.invalid, '请求体不是合法 JSON')
  }
}

export interface RouteContext {
  readonly service: MemoryService
  readonly body: Record<string, unknown>
  readonly query: URLSearchParams
  /** 项目键。面板从宿主取当前会话的工作目录后传入（见 client/transport）。 */
  readonly projectKey: string | null
}

type Handler = (ctx: RouteContext) => unknown

function projectKeyOf(ctx: RouteContext): string | null {
  return ctx.projectKey
}

function filterOf(query: URLSearchParams): Filter | null {
  const filter: Record<string, unknown> = {}
  const scope = query.get('scope')
  const layer = query.get('layer')
  const status = query.get('status')
  const search = query.get('q')
  if (scope === 'project' || scope === 'user') filter.scope = scope as Scope
  if (layer === 'semantic' || layer === 'episodic') filter.layer = layer as Layer
  if (status !== null) filter.status = status as Status
  if (search !== null && search.trim() !== '') filter.query = search
  return Object.keys(filter).length === 0 ? null : (filter as Filter)
}

/** 路由表：**只有读 + 管理**，没有 create（PB-4）。 */
const ROUTES: Record<string, Handler> = {
  // ---- 视图 ----
  'GET /api/memory/list': (ctx) => {
    const view = ctx.service.listA(projectKeyOf(ctx), filterOf(ctx.query))
    return {
      counts: view.counts,
      recycleCount: view.recycleCount,
      emptyText: view.emptyText,
      entries: view.entries.map((entry) => ({
        id: entry.row.id,
        ordinal: entry.ordinal,
        mark: entry.mark,
        content: entry.row.content,
        layer: entry.row.layer,
        scope: entry.row.scope,
        status: entry.row.status,
        statusText: entry.statusText,
        sourceAt: entry.row.sourceRef.at,
        eventPhrase: entry.row.sourceRef.eventPhrase,
        sourceType: entry.row.sourceType,
        snippet: entry.row.sourceRef.snippet,
        sessionId: entry.row.sourceRef.sessionId,
        turnSeq: entry.row.sourceRef.turnSeq,
        reuseCount: entry.row.reuseCount,
        lastHitAt: entry.row.lastHitAt,
        supersededBy: entry.row.supersededBy,
        expiresAt: entry.row.expiresAt,
        sensitivity: entry.row.sensitivity,
      })),
    }
  },

  'GET /api/memory/recycle': (ctx) =>
    ctx.service.listB(projectKeyOf(ctx)).map((entry) => ({
      id: entry.row.id,
      ordinal: entry.ordinal,
      mark: entry.mark,
      content: entry.row.content,
      layer: entry.row.layer,
      scope: entry.row.scope,
      statusText: entry.statusText,
      removeReason: entry.removeReason,
      remainingDays: entry.remainingDays,
      deletedAt: entry.row.deletedAt,
    })),

  'GET /api/memory/changes': (ctx) =>
    ctx.service.listC(projectKeyOf(ctx), ctx.query.get('memoryId')),

  // ---- 管理（无 create） ----
  'POST /api/memory/edit': (ctx) => {
    const input: { id: string; content?: string; scope?: Scope } = { id: String(ctx.body.id ?? '') }
    if (typeof ctx.body.content === 'string') input.content = ctx.body.content
    if (ctx.body.scope === 'project' || ctx.body.scope === 'user') input.scope = ctx.body.scope
    return ctx.service.edit(input, projectKeyOf(ctx))
  },

  'POST /api/memory/delete': (ctx) => {
    const reason = ctx.body.reason === 'user_asked_not_to_keep' ? 'user_asked_not_to_keep' : 'delete'
    return ctx.service.softDelete(String(ctx.body.id ?? ''), projectKeyOf(ctx), reason)
  },

  'POST /api/memory/hard-delete/prepare': (ctx) => {
    const prepared = ctx.service.prepareHardDelete(String(ctx.body.id ?? ''), projectKeyOf(ctx))
    // 回显目标正文（DC-17）；token 交给前端，第二步必须带回来
    return {
      token: prepared.token,
      echo: {
        id: prepared.echo.id,
        content: prepared.echo.content,
        layer: prepared.echo.layer,
        scope: prepared.echo.scope,
        status: prepared.echo.status,
        sourceAt: prepared.echo.sourceRef.at,
      },
    }
  },

  'POST /api/memory/hard-delete': (ctx) =>
    ctx.service.hardDelete(String(ctx.body.id ?? ''), String(ctx.body.token ?? ''), projectKeyOf(ctx)),

  'POST /api/memory/restore': (ctx) =>
    ctx.service.restore(String(ctx.body.id ?? ''), projectKeyOf(ctx)),

  'POST /api/memory/batch-forget': (ctx) => {
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.map(String) : []
    return ctx.service.batchForget(ids, projectKeyOf(ctx))
  },

  // ---- 诊断（O-3 / O-4 / O-8） ----
  'GET /api/memory/audit': (ctx) =>
    ctx.service.queryAudit({
      ...(ctx.query.get('op') === null ? {} : { op: ctx.query.get('op')! }),
      ...(ctx.query.get('limit') === null ? {} : { limit: Number(ctx.query.get('limit')) }),
    }),

  'GET /api/memory/stats': (ctx) => ctx.service.stats(),

  'GET /api/memory/health': (ctx) => ({
    enabled: ctx.service.enabled(),
    retentionDays: ctx.service.retentionDays(),
    ftsAvailable: ctx.service.rawDb.ftsAvailable,
    now: ctx.service.now(),
  }),

  // ---- 设置（面板设置抽屉） ----
  // 读：只回规格表里的键（不把整张 settings 表泄给前端）。
  'GET /api/memory/settings': (ctx) => ctx.service.settingsSnapshot(),

  // 写：**全量校验通过才落库**；未知键/越界一律 400，不做部分成功。
  'POST /api/memory/settings': (ctx) => {
    const values = ctx.body.values
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new HttpError(400, ERROR_CODE.invalid, 'values 必须是一个对象')
    }
    try {
      return ctx.service.applySettings(values as Record<string, unknown>)
    } catch (error) {
      // 校验失败是**调用方的错**（400），不是服务端故障（500）。
      // 面板据此把「值越界」与「服务挂了」分开提示 —— 两者都报 500，用户只会重试。
      throw new HttpError(400, ERROR_CODE.invalid, error instanceof Error ? error.message : String(error))
    }
  },

  /**
   * 召回预览（面板「预览」按钮）。
   *
   * 与注入共用 `buildRecallPreview` → `formatRecallText`，所以"预览看到的"
   * 就是"开启后会被注入的"，不存在预览与实际两套渲染。
   */
  'POST /api/memory/recall': (ctx) => {
    const query = String(ctx.body.query ?? '').trim()
    if (query === '') throw new HttpError(400, ERROR_CODE.invalid, '召回预览需要 query')
    return buildRecallPreview(ctx.service, query, projectKeyOf(ctx))
  },
}

/**
 * 挂载 `/api/memory` 前缀路由。
 *
 * 只注册**一条** prefix 路由、内部自己分派：`webServer.register()` 对同一张表里的
 * 重复路径会抛错，而我们要暴露十几条路径；一条前缀既避免表扩张，
 * 也让"哪些路径属于本插件"在一处可见（与 `@clinexin/dsh-kb` 同做法）。
 */
export function mountMemoryRoutes(webServer: WebServerLike, service: MemoryService): () => void {
  const prefix = '/api/memory'
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? prefix, 'http://127.0.0.1')
    const method = (request.method ?? 'GET').toUpperCase()
    const key = `${method} ${url.pathname}`
    const route = ROUTES[key]

    if (route === undefined) {
      const pathExists = Object.keys(ROUTES).some((candidate) => candidate.endsWith(` ${url.pathname}`))
      const code = pathExists ? 405 : 404
      sendJson(response, code, {
        code,
        data: null,
        message: pathExists ? `${url.pathname} 不支持 ${method}` : `没有这个接口：${url.pathname}`,
      } satisfies Envelope<null>)
      return
    }

    try {
      const body = method === 'GET' ? {} : await readBody(request)
      const projectKey = url.searchParams.get('projectKey') ?? (typeof body.projectKey === 'string' ? body.projectKey : null)
      const data = await route({ service, body, query: url.searchParams, projectKey })
      sendJson(response, 200, { code: 0, data: data ?? null, message: 'ok' } satisfies Envelope<unknown>)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      // 信封的 code 与 HTTP 状态同义（数字）；业务错误码放在 message 之前由前端按 status 判断
      const code = error instanceof HttpError ? error.status : 500
      void ERROR_CODE
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, status, { code, data: null, message } satisfies Envelope<null>)
    }
  }

  return webServer.register({ kind: 'prefix', path: prefix, handler })
}

/** 供自测断言：路由表里不得有 create（HC-5）。 */
export const ROUTE_KEYS = Object.keys(ROUTES)
