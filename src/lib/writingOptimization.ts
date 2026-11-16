/* ============================================================
   写作优化逻辑 · 核心骨架（对应 docs/writing-optimization-logic.md）
   ------------------------------------------------------------
   本文件只放「纯函数 / 类型 / prompt 模板」，不涉及 UI 或 API 调用。
   后续按 Phase 逐步接入 AppContext、章节精修、管理后台。
   ============================================================ */

import type { Canvas, CanvasDimension, SavedBook } from '../types'

export type OptimizationStrategy = 'polish' | 'expand' | 'condense' | 'reorder' | 'calibrate'

export interface DimensionScores {
  设定: number
  人物: number
  文笔: number
  结构: number
  篇幅: number
  情节: number
  节奏: number
}

export type DimensionWeights = DimensionScores

export interface TextChunk {
  role: 'setting' | 'character' | 'plot' | 'style' | 'rhythm' | 'scene'
  span: { start: number; end: number }
  summary: string
  entities: string[]
}

export interface ProblemPattern {
  id: string
  dimension: CanvasDimension
  name: string
  severity: 'high' | 'medium' | 'low'
  suggestedFix: string
  condition: (scores: DimensionScores, chunks: TextChunk[]) => boolean
}

export interface OptimizationRecord {
  id: string
  createdAt: string
  targetType: 'canvas' | 'chapter' | 'book' | 'paragraph'
  targetId: string
  scoresBefore: DimensionScores
  scoresAfter: DimensionScores
  issuesFound: string[]
  strategy: OptimizationStrategy
  userFeedback?: 'accept' | 'reject' | 'manual'
}

export const DIMENSIONS_ORDER: CanvasDimension[] = ['设定', '人物', '文笔', '结构', '篇幅', '情节', '节奏']

export const DEFAULT_DIMENSION_WEIGHTS: DimensionWeights = {
  设定: 0.16,
  人物: 0.16,
  文笔: 0.14,
  结构: 0.14,
  篇幅: 0.10,
  情节: 0.16,
  节奏: 0.14,
}

/** 默认问题模板库（可扩展，也可从平台语料动态加载） */
export const DEFAULT_PROBLEM_PATTERNS: ProblemPattern[] = [
  {
    id: 'PLOT-01',
    dimension: '情节',
    name: '开局冲突出现较晚',
    severity: 'high',
    suggestedFix: '在开头 500 字内明确核心冲突或悬念',
    condition: (_scores, chunks) =>
      chunks.slice(0, 3).every(c => c.role !== 'plot' && !c.summary.includes('冲突')),
  },
  {
    id: 'CHAR-02',
    dimension: '人物',
    name: '人物言行与设定冲突',
    severity: 'medium',
    suggestedFix: '校准对话与动作，使其符合人物画布中的性格标签',
    condition: (scores) => scores.人物 < 60,
  },
  {
    id: 'RHY-03',
    dimension: '节奏',
    name: '叙述段落过长、缺乏停顿',
    severity: 'medium',
    suggestedFix: '拆长段，插入动作、对话或环境切换',
    condition: (scores, chunks) =>
      scores.节奏 < 60 &&
      chunks.filter(c => c.role === 'scene').length < chunks.length * 0.2,
  },
  {
    id: 'SET-04',
    dimension: '设定',
    name: '设定覆盖不足',
    severity: 'high',
    suggestedFix: '在正文中更自然地回扣关键设定',
    condition: (scores) => scores.设定 < 55,
  },
]

/** 把正文按功能块切分（轻量实现，后续可换成更准的模型分段） */
export function segmentStory(text: string): TextChunk[] {
  const chunks: TextChunk[] = []
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
  let cursor = 0
  for (const p of paragraphs) {
    const start = cursor
    const end = cursor + p.length
    const hasQuote = /[“"].*?[”"]/.test(p)
    const hasScene = /(场景|天色|门外|屋内|城|街|山)/.test(p)
    const role: TextChunk['role'] = hasQuote && hasScene ? 'scene' : hasQuote ? 'character' : hasScene ? 'setting' : 'plot'
    const entities = Array.from(new Set((p.match(/[\u4e00-\u9fa5]{2,6}(?=[，。：；\s])/g) || []))).slice(0, 8)
    chunks.push({
      role,
      span: { start, end },
      summary: p.slice(0, 30) + (p.length > 30 ? '…' : ''),
      entities,
    })
    cursor = end + 2
  }
  return chunks
}

/** 七维加权健康度 */
export function healthScore(scores: DimensionScores, weights: DimensionWeights = DEFAULT_DIMENSION_WEIGHTS): number {
  const total = DIMENSIONS_ORDER.reduce((sum, d) => sum + weights[d] * scores[d], 0)
  const weightSum = DIMENSIONS_ORDER.reduce((sum, d) => sum + weights[d], 0)
  return Math.round(total / weightSum)
}

/** 基于评分和文本块做诊断 */
export function diagnose(
  scores: DimensionScores,
  chunks: TextChunk[],
  patterns: ProblemPattern[] = DEFAULT_PROBLEM_PATTERNS,
): ProblemPattern[] {
  return patterns
    .filter(p => p.condition(scores, chunks))
    .sort((a, b) => {
      const sevOrder = { high: 0, medium: 1, low: 2 }
      return sevOrder[a.severity] - sevOrder[b.severity]
    })
}

/** 根据诊断结果推荐策略 */
export function suggestStrategy(issues: ProblemPattern[]): OptimizationStrategy {
  if (!issues.length) return 'polish'
  const top = issues[0].dimension
  if (top === '节奏') return 'condense'
  if (top === '篇幅') return 'expand'
  if (top === '结构') return 'reorder'
  if (top === '文笔') return 'calibrate'
  return 'polish'
}

/** 用 prompt 模板生成给模型的优化指令 */
export function buildOptimizePrompt(args: {
  strategy: OptimizationStrategy
  targetText: string
  canvases: Record<string, Canvas>
  locked: string[]
  issues: ProblemPattern[]
  targetWords?: number
  /** 由用户存下作品训练出的风格画像参考块（见 writingTraining.ts styleReferenceBlock） */
  userStyle?: string
}): string {
  const { strategy, targetText, canvases, locked, issues, targetWords, userStyle } = args
  const setting = canvases.setting?.content || ''
  const character = canvases.character?.content || ''
  const style = canvases.style?.content || ''
  const issueBlock = issues.map((i, idx) => `${idx + 1}. [${i.dimension}] ${i.name}：${i.suggestedFix}`).join('\n')
  const styleBlock = userStyle ? `\n${userStyle}\n` : ''
  const base = `【世界观锚点】\n${setting}\n\n【人物锚点】\n${character}\n\n【文笔要求】\n${style}\n${styleBlock}\n【待优化文本】\n${targetText}\n\n【已锁定 · 绝对不可改动】\n${locked.join('、') || '无'}\n\n【诊断问题】\n${issueBlock || '无明显问题，做一般性润色'}\n`
  if (strategy === 'expand') {
    return `${base}\n请把上方文本扩写到约 ${targetWords ?? '原有 1.5 倍'} 字，补充环境、心理、动作细节，但不得引入设定外的新人物或势力。`
  }
  if (strategy === 'condense') {
    return `${base}\n请把上方文本压缩到约 ${targetWords ?? '原有 0.7 倍'} 字，保留情节骨架与关键对白，删去冗余描写。`
  }
  if (strategy === 'reorder') {
    return `${base}\n请重新排列段落顺序，使情节推进更合理，并补充必要的过渡句。`
  }
  if (strategy === 'calibrate') {
    return `${base}\n请按「文笔要求」对全文做风格校准，保持情节与设定不变。`
  }
  return `${base}\n请精修上方文本，解决诊断问题，保留锁定区原样不动。先给 100 字以内的改动说明，再给改写后的正文。`
}

/** 根据用户反馈更新个人维度权重 */
export function updateDimensionWeight(
  weights: DimensionWeights,
  dimension: CanvasDimension,
  feedback: 'accept' | 'reject' | 'manual',
  strength = 0.005,
): DimensionWeights {
  const delta = feedback === 'accept' ? strength : feedback === 'manual' ? strength * 0.5 : -strength * 1.5
  const next = { ...weights, [dimension]: clamp(weights[dimension] + delta, 0.05, 0.3) }
  return normalizeWeights(next)
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

/** 让七维权重之和归一化为 1.0 */
export function normalizeWeights(weights: DimensionWeights): DimensionWeights {
  const sum = DIMENSIONS_ORDER.reduce((s, d) => s + weights[d], 0)
  if (sum <= 0) return { ...DEFAULT_DIMENSION_WEIGHTS }
  const next: Partial<DimensionWeights> = {}
  for (const d of DIMENSIONS_ORDER) next[d] = weights[d] / sum
  return next as DimensionWeights
}

/** 为一次优化生成记录 */
export function createOptimizationRecord(args: {
  targetType: OptimizationRecord['targetType']
  targetId: string
  scoresBefore: DimensionScores
  scoresAfter: DimensionScores
  issuesFound: ProblemPattern[]
  strategy: OptimizationStrategy
}): OptimizationRecord {
  return {
    id: `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    targetType: args.targetType,
    targetId: args.targetId,
    scoresBefore: args.scoresBefore,
    scoresAfter: args.scoresAfter,
    issuesFound: args.issuesFound.map(i => i.id),
    strategy: args.strategy,
  }
}

/** 从 SavedBook 提取正文用于评分（样章 + 精修章节） */
export function extractBookText(book: SavedBook): string {
  const parts: string[] = []
  if (book.synopsis) parts.push(book.synopsis)
  if (book.sampleChapter?.content) parts.push(book.sampleChapter.content)
  const writings = book.chapterWritings || {}
  for (const idx of Object.keys(writings).sort((a, b) => Number(a) - Number(b))) {
    const w = writings[Number(idx)]
    if (w?.content) parts.push(w.content)
  }
  return parts.join('\n\n')
}

/** 轻量评分：设定画布关键词在正文中的覆盖率（纯规则示例） */
export function scoreSetting(text: string, settingCanvas: Canvas): number {
  const keywords = extractKeywords(settingCanvas.content)
  if (!keywords.length) return 50
  const hit = keywords.filter(k => text.includes(k)).length
  return Math.round((hit / keywords.length) * 100)
}

function extractKeywords(text: string): string[] {
  return text
    .split(/[，。；：、\s]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && s.length <= 8)
    .slice(0, 30)
}
