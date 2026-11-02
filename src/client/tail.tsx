/**
 * 对话侧动作（`conversation.chat.turnTail`）。
 *
 * 契约落点：
 * - **PE-09**：仅在含记忆清单/回收站/变更记录答案的轮次出现；其它轮次
 *   **必须返回 null**（宿主文档："entries without content return null"）。
 * - **PE-10**：文案逐字 —— `在面板中打开 · 共 N 条` / `… · 回收站 k 条` / `… · 变更记录 v 个版本`；
 *   点击后**直接落到对应页签**。
 * - **HC-7 / PE-13**：「在对话中定位」**不渲染**（宿主无公开定位接口）。
 *
 * 判定"这一轮是不是记忆轮次"：看助手在该轮的文本里有没有记忆清单的特征标记。
 * 不用启发式猜，只看我们自己的渲染器产生的固定首行/标题。
 */

import type { ReactElement } from 'react'

export type TabKind = 'a' | 'b' | 'c'

export interface TurnTailPayload {
  /** 视图种类。 */
  readonly view: TabKind
  /** 条数（清单=共 N 条；回收站=k；变更记录=版本数）。 */
  readonly count: number
}

/**
 * 从一轮助手文本里提取记忆视图信息。
 *
 * @returns 不是记忆轮次时返回 `null` —— 组件据此返回 `null`，贡献为零（PE-09）。
 */
export function detectMemoryTurn(text: string): TurnTailPayload | null {
  if (text === '') return null

  // 回收站：`回收站 ｜ 共 k 条（可恢复…）`
  const recycle = text.match(/回收站\s*｜\s*共\s*(\d+)\s*条/)
  if (recycle !== null) return { view: 'b', count: Number(recycle[1]) }

  // 变更记录：`第 N 条变更记录` 或版本链输出
  if (/变更记录|版本链/.test(text) && /版本/.test(text)) {
    const versions = text.match(/(\d+)\s*个版本/)
    return { view: 'c', count: versions === null ? 0 : Number(versions[1]) }
  }

  // 主清单：`记忆清单 ｜ 项目 X ｜ 共 N 条（…）`
  const list = text.match(/记忆清单[^\n]*?共\s*(\d+)\s*条/)
  if (list !== null) return { view: 'a', count: Number(list[1]) }

  // 空态也是记忆轮次（用户问了，只是没有）
  if (/目前没有记录任何关于你的记忆。/.test(text)) return { view: 'a', count: 0 }

  return null
}

/** 逐字文案（PE-10）。 */
export function tailLabel(payload: TurnTailPayload): string {
  if (payload.view === 'b') return `在面板中打开 · 回收站 ${payload.count} 条`
  if (payload.view === 'c') return `在面板中打开 · 变更记录 ${payload.count} 个版本`
  return `在面板中打开 · 共 ${payload.count} 条`
}

export interface MemoryTailProps {
  /** 该轮的助手文本。 */
  readonly text: string
  /** 打开面板并落到指定视图。 */
  readonly onOpen: (view: TabKind) => void
}

/**
 * turnTail 组件。
 *
 * **无内容的 entry 返回 null**（宿主要求，也是 PE-09 的实现方式）：
 * 非记忆轮次不渲染任何 DOM，所以"全页不出现记忆按钮"是结构性的，不靠 CSS 隐藏。
 */
export function MemoryTail(props: MemoryTailProps): ReactElement | null {
  const payload = detectMemoryTurn(props.text)
  if (payload === null) return null

  return (
    <div className="mem-tail" data-testid="mem-tail">
      <button
        type="button"
        className="mem-tail__btn"
        data-testid={`mem-tail-open-${payload.view}`}
        data-view={payload.view}
        onClick={() => props.onOpen(payload.view)}
      >
        {tailLabel(payload)}
      </button>
      {/* HC-7：不渲染「在对话中定位」—— 宿主无公开的"滚到某轮"接口 */}
    </div>
  )
}

export const TAIL_CSS = `
.mem-tail { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.mem-tail__btn {
  appearance: none; border: 1px solid var(--dsw-alias-border-l3, #DDD8D2);
  border-radius: 8px; background: 0 0; cursor: pointer;
  min-height: 44px; padding: 0 12px; font: inherit; font-size: 12.5px;
  color: var(--dsw-alias-label-primary, #1B1A18);
}
.mem-tail__btn:hover { background: var(--dsw-alias-interactive-bg-hover, #EAE6E0); }
.mem-tail__btn:focus-visible { outline: 3px solid var(--dsw-focus-ring-color, #0B5FA5); outline-offset: 1px; }
`
