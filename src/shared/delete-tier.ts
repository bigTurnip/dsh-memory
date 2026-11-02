/**
 * 删除档位判定 —— **全系统唯一的实现**（D-8 X-1 / X-6）。
 *
 * 这是整份契约里最容易被实现错的一条，所以它单独成文件、有专门的单测。
 *
 * ## 裁定原文要点（D-8 X-1）
 * - 带具体指代的单条（「忘掉第 N 条」）→ **普通软删**；
 * - 「忘掉关于 X 的全部记忆」（批量）→ **普通软删 + 预览后执行**；
 * - **只有**「彻底删除 / 永久删除 / 不要留副本」等**显式不可逆措辞**才触发硬删。
 *
 * 理由（裁定原文）：S-2 要求默认档位统一为软删；「忘掉」是日常用词，
 * 若默认硬删，误触代价不可逆，与 OQ-5=C「隐私删除需二次确认」的保护意图相悖。
 *
 * ## 为什么档位判定放在 domain 而不是两条通道各自的意图解析
 * S-2 要求"同一意图两条通道结果一致"。如果对话侧把「忘掉」解析成 soft、
 * 面板侧某个按钮写死 hard，就是 S-2 违规。所以：
 * - 对话通道调 `decideDeleteTier()`；
 * - 面板的「删除」按钮**直接调 `softDelete()`**，根本没有 hard 分支可走；
 * - 面板的「彻底删除」**只能**经由带 confirm token 的 `hardDelete()`。
 *
 * 三处都不需要重新判断档位，因此不存在"两个地方判断不一致"的可能。
 */

/** 删除档位。 */
export type DeleteTier = 'soft' | 'hard'

/**
 * 触发硬删的**显式不可逆措辞**。
 *
 * 判定纪律：只认"明显在说不可逆"的词。宁可多要求一个字，
 * 也不要让「忘掉」这类日常表达滑进硬删 —— 硬删是终态、不可撤销。
 */
const HARD_PHRASES = [
  '彻底删除',
  '彻底删掉',
  '彻底清掉',
  '彻底清除',
  '彻底抹掉',
  '彻底抹除',
  '永久删除',
  '永久删掉',
  '永久清除',
  '不可恢复',
  '不要留任何副本',
  '不要留副本',
  '不留任何副本',
  '不留副本',
  '一点不留',
] as const

/** 日常删除表达（**一律 soft**）。列出来是为了让"我们不认为它是 hard"这件事可读。 */
const SOFT_PHRASES = ['删掉', '删除', '删了', '不要了', '忘掉', '忘记', '移除', '清掉'] as const

/** 指代范围：单条 or 批量。 */
export type DeleteTarget = 'single' | 'batch'

/**
 * 判定删除档位。
 *
 * @param utterance 用户原话（整句）。
 * @param target 指代范围。**注意：它不影响档位**（X-1 前两条都是 soft），
 *   只影响后续是否先预览（批量必须预览，DC-22）。参数保留是为了让调用方
 *   必须显式说明意图，避免把批量当单条处理。
 *
 * @returns `'hard'` 仅当出现显式不可逆措辞；其余一切（含「忘掉」）都是 `'soft'`。
 */
export function decideDeleteTier(utterance: string, target: DeleteTarget): DeleteTier {
  void target

  const text = utterance.trim()
  if (text === '') return 'soft'

  // 显式不可逆措辞优先：即使句子里同时出现「忘掉」，
  // 「彻底忘掉」这类也应当算 hard —— 因为「彻底」本身就是不可逆信号。
  if (HARD_PHRASES.some((phrase) => text.includes(phrase))) return 'hard'

  // 「彻底/永久/不可恢复」+ 任意删除动词（含「忘掉」）同样是不可逆信号。
  // 这一条是「彻底忘掉」的落地：它不在 HARD_PHRASES 里（那里只有「彻底删除」整词），
  // 但语义上明确不可逆，必须判 hard。
  const hasIrreversibleAdverb = /(彻底|永久|不可恢复|不可撤销)/.test(text)
  const hasDeleteVerb = SOFT_PHRASES.some((phrase) => text.includes(phrase))
  if (hasIrreversibleAdverb && hasDeleteVerb) return 'hard'

  // 「忘掉」「删掉」等日常词：**明确是 soft**。
  // 这行不是省略，是把 X-1 的裁定写成可读的代码：
  // 任何人想把它改成 hard，都必须先删掉这三行与它的单测。
  if (SOFT_PHRASES.some((phrase) => text.includes(phrase))) return 'soft'

  // 没有识别到任何删除表达 → 默认 soft（S-2：默认档位统一软删）。
  return 'soft'
}

/**
 * 「别记」类表达的判定（**D-8 X-6 / N-2 / DC-24**）。
 *
 * 裁定：走**软删**，但回收站必须标注「因用户要求不保留」，且**不触发硬删**。
 *
 * @returns 是否属于"用户要求别记/不要保留"这一档。
 */
export function isUserAskedNotToKeep(utterance: string): boolean {
  const text = utterance.trim()
  if (text === '') return false
  return (
    /别记|不要记|不用记|不要保存|别保存|别存|不要存|这段忘掉|这句话别记/.test(text) ||
    /(这个|这段|这条|这句)(不|别)(要|用)?(记|保存|存)/.test(text)
  )
}
