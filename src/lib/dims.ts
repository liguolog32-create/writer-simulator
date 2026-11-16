import type { CanvasDimension } from '../types'

/** 7 个维度 → 画布 id 的映射（与 seed.ts 的画布 id 对应） */
export const DIM_TO_CANVAS: Record<CanvasDimension, string> = {
  设定: 'setting',
  人物: 'character',
  文笔: 'style',
  结构: 'structure',
  篇幅: 'length',
  情节: 'plot',
  节奏: 'rhythm',
}

/** 维度固定顺序（UI 展示与提示词拼装都依赖它） */
export const DIMENSIONS: CanvasDimension[] = ['设定', '人物', '文笔', '结构', '篇幅', '情节', '节奏']

/** 把「维度 → 内容」的补丁转成「画布 id → 内容」 */
export function patchToCanvasIds(patch: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [dim, content] of Object.entries(patch)) {
    const id = DIM_TO_CANVAS[dim as CanvasDimension]
    if (id && content) out[id] = content
  }
  return out
}
