/**
 * Host 侧插件入口（`tech-design.md` §1.2 / §1.3）。
 *
 * 三件事：
 * 1. 打开数据库并创建 `MemoryService`；
 * 2. 用 `ctx.inject(['webServer'], ...)` 动态挂载 HTTP 路由
 *    （**不能**写进静态 `inject`：headless profile 没有 webServer，会让整个插件不激活）；
 * 3. 注册 4 个模型可见工具，并通过 `ctx.workingDirectory` 解析 projectKey（Q3 结论）。
 *
 * `ctx.workingDirectory` 与 `ctx.tools` 都写进静态 inject —— 它们在所有 profile 里都有。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryService } from './domain/service.js'
import { createTools, resolveScope, type ToolExec, type ToolDefinition } from './tools/index.js'
import { mountMemoryRoutes, type WebServerLike } from './http/routes.js'
import { sweepExpired, sweepRecycle } from './domain/state.js'
import { registerRecallInjection, type RecallHostContext } from './domain/recall.js'

export interface Config {
  /** 数据目录；留空用 `$DSH_HOME/memory`。 */
  dataDir?: string
  /** 后台扫描间隔（分钟）；0 关闭。 */
  sweepIntervalMinutes?: number
}

export interface ToolRegistryLike {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: unknown
    execute: (args: Record<string, unknown>, exec: ToolExec) => Promise<unknown>
  }): () => void
}

export interface WorkingDirectoryLike {
  get(session: { id: string }): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRegistryLike
    workingDirectory: WorkingDirectoryLike
    webServer?: WebServerLike
  }
}

export const name = 'dsh-memory'

/**
 * 静态依赖。
 *
 * `tools` / `workingDirectory` 是所有 profile 都提供的服务。
 * **`webServer` 刻意不在这里** —— 见文件头注。
 */
export const inject = ['tools', 'workingDirectory']

function resolveDataDir(config: Config): string {
  if (config.dataDir !== undefined && config.dataDir !== '') return config.dataDir
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'memory')
}

export function apply(ctx: Context, config: Config = {}): void {
  const service = new MemoryService({ dataDir: resolveDataDir(config) })

  // 进程退出时关库（cordis 的 effect 在插件卸载时执行）
  ctx.effect(() => () => service.close(), 'agent-memory: close database')

  // 模型可见工具（对话通道）
  const tools = createTools({
    service,
    get workingDirectory() {
      return ctx.workingDirectory
    },
  })
  for (const tool of tools) {
    ctx.effect(
      () =>
        ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          // 宿主强制要求：缺这个字段 register() 直接抛 TypeError，整个插件 failed
          output: tool.output,
          execute: (args, exec) => tool.execute(args, exec),
        }),
      `agent-memory: tool ${tool.name}`,
    )
  }

  // 自动召回注入（设置里的「自动召回注入」开关，默认关）。
  //
  // 走宿主 `systemPrompt` 的 runtime-context：不改 system prompt 本体、不碰历史。
  // 与 HTTP 路由同一纪律——依赖的服务不在就不注册（headless 下可能没有 agents），
  // 增强能力不得让插件整体激活失败。
  registerRecallInjection(ctx as unknown as RecallHostContext, service)

  // HTTP 路由（面板通道）。动态注入：headless 下没有 webServer 就不挂，其余功能照常。
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = (hostCtx as unknown as { webServer: WebServerLike }).webServer
    hostCtx.effect(() => mountMemoryRoutes(webServer, service), 'agent-memory: http routes')
  })

  // 后台扫描（T-3 过期 / T-7 回收站清理）。0 表示关闭，便于测试用注入时钟手动驱动。
  const minutes = config.sweepIntervalMinutes ?? 60
  if (minutes > 0) {
    ctx.effect(() => {
      const timer = setInterval(
        () => {
          try {
            sweepExpired(service.rawDb, service.now(), () => service.nextId())
            sweepRecycle(service.rawDb, service.now(), service.retentionDays(), () => service.nextId())
          } catch (error) {
            ctx.logger?.warn?.(`agent-memory: sweep failed: ${String(error)}`)
          }
        },
        minutes * 60_000,
      )
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'agent-memory: sweep timer')
  }

  // 把 service 注册成宿主服务（供其他插件 / 自测通过 inject 取得）。
  // 直接 `ctx.memory = service` 在 cordis 4 会抛 `cannot set property "memory" without provide`。
  ctx.provide('memory', service)
}

export { MemoryService, resolveScope, type ToolDefinition }
