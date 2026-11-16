import { analyzeBook, refineField } from './llmClient'
import { dimensionBooks, lookupBook, bookToAnchor } from '../data/aiRecommendations'
import type { ReferenceAnchor } from '../types'

/* ============================================================
   v10.55 · 「AI 帮我填画布」与「AI 检索范文」的共享逻辑
   ------------------------------------------------------------
   画布页（CanvasBlock 空画布提示）与写作页（生效设定侧栏）都调这里，
   避免两处各写一份、以后改提示词要改两遍。
   ============================================================ */

export interface CanvasFillContext {
  /** 当前关联书的书名 */
  bookTitle?: string
  /** 书的简介 */
  bookSynopsis?: string
  /** 书的章纲（每行「第N章 标题：一句话」） */
  bookOutlineText?: string
  /** 其他画布（维度 → 内容），只传有内容的 */
  otherCanvases?: Record<string, string>
  /** v10.59b：用户显式勾选过参考画布 → 指令改为「以参考画布为依据重写」，并放宽上下文截断 */
  strictRefs?: boolean
}

/** 拼「相关上下文」：书名 / 简介 / 章纲 / 其他画布（截断防超长；strictRefs 时放宽到 12000，别把参考掐掉） */
function joinContext(ctx: CanvasFillContext): string {
  const parts: string[] = []
  if (ctx.bookTitle) parts.push(`书名：${ctx.bookTitle}`)
  if (ctx.bookSynopsis) parts.push(`简介：${ctx.bookSynopsis}`)
  if (ctx.bookOutlineText) parts.push(`章纲：\n${ctx.bookOutlineText}`)
  const others = Object.entries(ctx.otherCanvases || {})
  if (others.length) {
    const head = ctx.strictRefs
      ? `参考画布（本次生成/改写的依据，内容必须与它们保持一致，不得矛盾）：\n`
      : `其他画布（保持语境一致，不要照抄）：\n`
    parts.push(head + others.map(([d, c]) => `【${d}】${c}`).join('\n'))
  }
  return parts.join('\n\n').slice(0, ctx.strictRefs ? 12_000 : 3000)
}

/**
 * AI 帮我填（内容为空）/ AI 帮我改（已有内容）。
 * 服务端 refine 对空内容的处理就是「直接按修改要求写出来」，所以这一个调用两种场景都覆盖。
 */
export async function aiFillCanvas(
  input: {
    dimension: string
    current: string
    /** 联网检索同类型范文作参照（默认跟调用方传，不传=false 快且省） */
    webSearch?: boolean
    /** v10.59：外部中断信号（画布页「终止生成」按钮） */
    signal?: AbortSignal
  } & CanvasFillContext,
): Promise<{ refined: string; searched: boolean; searchCount: number }> {
  const empty = !(input.current || '').trim()
  // v10.59b：显式勾选过参考画布 → 指令强调「以参考画布为依据重写」；默认保持原来的温和表述
  const instruction = empty
    ? input.strictRefs
      ? '以参考画布为依据，为这本书生成这个维度的具体内容：内容必须从参考画布推导出来、与它们严格一致（设定、人物、数字、命名都不得矛盾）；不要写方法论或通用建议，不要空话。'
      : '为这本书的这个维度写一版具体、可直接用于写作的内容：写这本书自己的设定，语境与其他画布保持一致；不要写方法论或通用建议，不要空话。'
    : input.strictRefs
      ? '根据参考画布的内容重新生成本维度内容：以勾选的参考画布为改写依据，重写后必须与参考画布严格一致（设定、人物、数字、命名都不得矛盾）；保留与参考不冲突的原有核心设定；不要写方法论或通用建议。'
      : '把这版内容写得更具体、更可执行：保留原有核心设定，补足细节，语境与其他画布保持一致；不要写方法论或通用建议。'
  const { data, searched, searchCount } = await refineField({
    dimension: input.dimension,
    current: input.current || '',
    instruction,
    context: joinContext(input),
    webSearch: input.webSearch === true,
    signal: input.signal,
  })
  return { refined: (data.refined || '').trim(), searched, searchCount }
}

/**
 * AI 检索范文：与画布页高级设置里的「AI 自动检索」同一套 ——
 * 联网 = 让模型分析该维度范文并产出参考锚点；本地 = 先在本地书库里找同类，找不到再走本地知识。
 */
export async function aiSuggestAnchors(input: {
  dimension: string
  /** 检索主题：画布内容优先，空则用标题 */
  topic: string
  useSearch: boolean
}): Promise<{ anchors: ReferenceAnchor[]; note: string }> {
  if (input.useSearch) {
    const { data: llm, searched, searchCount } = await analyzeBook(input.topic, input.dimension, true)
    const anchor: ReferenceAnchor = {
      id: crypto.randomUUID(),
      source: llm.source || input.topic,
      features: llm.features || '',
      examples: llm.examples || '',
    }
    return {
      anchors: [anchor],
      note: searched
        ? `已联网检索 ${searchCount} 次，范文参考已加入「${input.dimension}」画布`
        : `未触发联网检索（模型凭已有知识回答），范文参考已加入「${input.dimension}」画布`,
    }
  }
  const keys = dimensionBooks[input.dimension] || []
  const local: ReferenceAnchor[] = keys
    .map(k => {
      const meta = lookupBook(k)
      if (!meta) return null
      return bookToAnchor(k, meta, input.dimension)
    })
    .filter(Boolean) as ReferenceAnchor[]
  if (local.length) {
    return { anchors: local, note: `本地书库推荐 ${local.length} 本，已加入「${input.dimension}」画布` }
  }
  const { data: llm } = await analyzeBook(input.topic, input.dimension, false)
  const anchor: ReferenceAnchor = {
    id: crypto.randomUUID(),
    source: llm.source || input.topic,
    features: llm.features || '',
    examples: llm.examples || '',
  }
  return { anchors: [anchor], note: `本地知识（书库无匹配），已加入「${input.dimension}」画布` }
}
