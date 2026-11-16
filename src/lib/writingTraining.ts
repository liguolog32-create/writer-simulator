/* ============================================================
   写作优化 · 训练模块（对应 docs/writing-optimization-logic.md 训练层）
   ------------------------------------------------------------
   把用户存下来的作品内容「蒸馏」成可复用知识：
     1. analyzeText   —— 从文本抽取轻量指标（不调用 LLM）
     2. deriveWeights —— 由指标推导该用户的七维偏好权重
     3. extractCases  —— 按维度抽取优秀段落作为案例库
     4. buildProfile  —— 合成单用户写作画像
     5. trainAll      —— 聚合全站语料
   纯函数，可编译、可单测；Worker 端负责编排与落库。
   ============================================================ */

import type { SavedBook } from '../types'
import {
  extractBookText,
  normalizeWeights,
  DEFAULT_DIMENSION_WEIGHTS,
  type DimensionWeights,
} from './writingOptimization'

export interface TextMetrics {
  charCount: number
  sentenceCount: number
  avgSentenceLen: number
  sentenceLenStd: number
  dialogueRatio: number
  sceneCueRatio: number
  vocabRichness: number
  fourCharIdiomRatio: number
  paragraphCount: number
  avgParagraphLen: number
  styleTags: string[]
  rhythmProfile: { short: number; medium: number; long: number }
}

export interface WritingCase {
  dimension: string
  text: string
  score: number
}

export interface WritingProfile {
  userId: string
  bookCount: number
  trainedAt: string
  metrics: TextMetrics
  dimensionWeights: DimensionWeights
  sampleCases: WritingCase[]
}

export interface GlobalCorpus {
  version: string
  trainedAt: string
  userCount: number
  bookCount: number
  styleTagDistribution: Record<string, number>
  cases: WritingCase[]
  globalWeights: DimensionWeights
}

/* ---------------- 1. 文本指标抽取 ---------------- */

const SENTENCE_SPLIT = /[。！？!?\n；;]+/
const SCENE_CUES = ['天色', '门外', '屋内', '城', '街', '山', '海', '夜', '晨', '殿', '院', '林', '河', '窗']
const FOUR_CHAR_IDIOM = /([一-龥]{4})(?=[，。！？、\s])/g
const DIALOGUE_QUOTE = /[“"『「][^”"』」]*[”"』」]/g

/** 风格标签规则：命中关键词数量达标即认定该风格 */
const STYLE_TAG_RULES: { tag: string; keywords: string[]; minHits: number }[] = [
  { tag: '古风', keywords: ['之', '亦', '然', '曰', '公子', '姑娘', '殿下', '江湖', '剑客', '天下', '吾', '君', '之乎'], minHits: 3 },
  { tag: '武侠', keywords: ['内力', '招式', '门派', '掌门', '剑法', '轻功', '江湖', '刀', '剑'], minHits: 3 },
  { tag: '玄幻', keywords: ['灵气', '修为', '境界', '宗门', '丹田', '法宝', '渡劫', '神识'], minHits: 3 },
  { tag: '言情', keywords: ['心跳', '脸红', '心动', '喜欢', '拥抱', '吻', '良人', '温柔'], minHits: 2 },
  { tag: '都市', keywords: ['公司', '地铁', '咖啡', '手机', '老板', '职场', '公寓'], minHits: 2 },
  { tag: '悬疑', keywords: ['尸体', '凶手', '密室', '线索', '侦探', '谜底', '案'], minHits: 2 },
  { tag: '幽默', keywords: ['吐槽', '尴尬', '无语', '逗比', '搞笑', '笑死', '服了'], minHits: 2 },
]

export function analyzeText(text: string): TextMetrics {
  const clean = text || ''
  const charCount = clean.length
  if (charCount === 0) {
    return {
      charCount: 0,
      sentenceCount: 0,
      avgSentenceLen: 0,
      sentenceLenStd: 0,
      dialogueRatio: 0,
      sceneCueRatio: 0,
      vocabRichness: 0,
      fourCharIdiomRatio: 0,
      paragraphCount: 0,
      avgParagraphLen: 0,
      styleTags: [],
      rhythmProfile: { short: 0, medium: 0, long: 0 },
    }
  }

  const sentences = clean.split(SENTENCE_SPLIT).map(s => s.trim()).filter(Boolean)
  const sentenceCount = sentences.length || 1
  const lengths = sentences.map(s => s.length)
  const avgSentenceLen = lengths.reduce((a, b) => a + b, 0) / sentenceCount
  const variance = lengths.reduce((a, b) => a + (b - avgSentenceLen) ** 2, 0) / sentenceCount
  const sentenceLenStd = Math.sqrt(variance)

  const dialogueChars = (clean.match(DIALOGUE_QUOTE) || []).join('').length
  const dialogueRatio = dialogueChars / charCount

  const sceneHits = SCENE_CUES.reduce((n, w) => n + (clean.split(w).length - 1), 0)
  const sceneCueRatio = Math.min(1, sceneHits / (charCount / 50))

  const uniqueChars = new Set(clean.replace(/[^\u4e00-\u9fa5]/g, '')).size
  const hanChars = (clean.match(/[\u4e00-\u9fa5]/g) || []).length || 1
  const vocabRichness = uniqueChars / hanChars

  const fourCharMatches = clean.match(FOUR_CHAR_IDIOM) || []
  const fourCharIdiomRatio = fourCharMatches.length / sentenceCount

  const paragraphs = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const paragraphCount = paragraphs.length || 1
  const avgParagraphLen = charCount / paragraphCount

  const styleTags: string[] = []
  for (const rule of STYLE_TAG_RULES) {
    const hits = rule.keywords.reduce((n, k) => n + (clean.split(k).length - 1), 0)
    if (hits >= rule.minHits) styleTags.push(rule.tag)
  }
  if (fourCharIdiomRatio > 0.25 && !styleTags.includes('华丽')) styleTags.push('华丽')
  if (dialogueRatio > 0.25 && !styleTags.includes('对话密集')) styleTags.push('对话密集')

  const short = lengths.filter(l => l <= 15).length / sentenceCount
  const long = lengths.filter(l => l > 40).length / sentenceCount
  const medium = 1 - short - long

  return {
    charCount,
    sentenceCount,
    avgSentenceLen: round1(avgSentenceLen),
    sentenceLenStd: round1(sentenceLenStd),
    dialogueRatio: round2(dialogueRatio),
    sceneCueRatio: round2(sceneCueRatio),
    vocabRichness: round2(vocabRichness),
    fourCharIdiomRatio: round2(fourCharIdiomRatio),
    paragraphCount,
    avgParagraphLen: round1(avgParagraphLen),
    styleTags,
    rhythmProfile: { short: round2(short), medium: round2(medium), long: round2(long) },
  }
}

/* ---------------- 2. 由指标推导七维权重 ---------------- */

export function deriveWeights(m: TextMetrics): DimensionWeights {
  if (m.charCount === 0) return { ...DEFAULT_DIMENSION_WEIGHTS }
  const raw = {
    设定: 0.1 + m.sceneCueRatio * 1.5,
    人物: 0.1 + m.dialogueRatio * 2.5,
    文笔: 0.1 + m.vocabRichness * 1.2 + m.fourCharIdiomRatio * 1.0,
    结构: 0.14,
    篇幅: 0.08 + Math.min(m.avgParagraphLen / 3000, 0.06),
    情节: 0.16,
    节奏: 0.1 + rhythmBalance(m.rhythmProfile) * 0.4,
  }
  return normalizeWeights(raw)
}

/** 节奏均衡度：短/中/长三者越均衡越接近 1 */
function rhythmBalance(r: { short: number; medium: number; long: number }): number {
  const vals = [r.short, r.medium, r.long]
  const mean = 1 / 3
  const dev = vals.reduce((a, v) => a + Math.abs(v - mean), 0)
  return Math.max(0, 1 - dev) // dev 最大 2，最小 0
}

/* ---------------- 3. 抽取优秀案例 ---------------- */

const DIMENSION_KEYWORDS: Record<string, string[]> = {
  设定: ['世界', '大陆', '王朝', '神', '族', '规则', '灵气', '体系'],
  人物: ['他', '她', '眼神', '心跳', '嘴角', '背影', '声音'],
  文笔: ['仿佛', '犹如', '像是', '光影', '风', '月', '霜'],
  情节: ['突然', '就在这时', '不料', '原来', '终于', '却'],
  节奏: ['脚步', '呼吸', '一瞬', '片刻', '转瞬'],
}

function scorePassage(text: string, m: TextMetrics): number {
  let score = 0
  const len = text.length
  // 1) 句子长度适中（15–60 字最佳）
  const dist = Math.abs(len - 38)
  score += Math.max(0, 1 - dist / 80)
  // 2) 含对话加分（人物感）
  if (DIALOGUE_QUOTE.test(text)) score += 0.3
  // 3) 含四字词加分（文笔）
  if ((text.match(FOUR_CHAR_IDIOM) || []).length > 0) score += 0.2
  // 4) 节奏：避免过长段落
  if (len <= 120) score += 0.2
  return round2(Math.min(1.5, score))
}

/** 把一段文本打分并匹配最合适的维度 */
export function extractCases(text: string, limitPerDim = 2): WritingCase[] {
  const m = analyzeText(text)
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length >= 20 && p.length <= 200)
  const buckets: Record<string, { text: string; score: number }[]> = {}
  for (const p of paragraphs) {
    const sc = scorePassage(p, m)
    for (const dim of Object.keys(DIMENSION_KEYWORDS)) {
      const hits = DIMENSION_KEYWORDS[dim].reduce((n, k) => n + (p.split(k).length - 1), 0)
      if (hits > 0) {
        buckets[dim] = buckets[dim] || []
        buckets[dim].push({ text: p.slice(0, 200), score: round2(sc + hits * 0.1) })
      }
    }
  }
  const out: WritingCase[] = []
  for (const dim of Object.keys(buckets)) {
    const top = buckets[dim]
      .sort((a, b) => b.score - a.score)
      .slice(0, limitPerDim)
    for (const t of top) out.push({ dimension: dim, text: t.text, score: t.score })
  }
  return out
}

/* ---------------- 4. 单用户画像 ---------------- */

export function buildProfile(userId: string, books: SavedBook[]): WritingProfile {
  const texts = books.map(b => extractBookText(b)).filter(Boolean)
  const combined = texts.join('\n\n')
  const metrics = analyzeText(combined)
  const sampleCases = extractCases(combined, 2)
  return {
    userId,
    bookCount: books.length,
    trainedAt: new Date().toISOString(),
    metrics,
    dimensionWeights: deriveWeights(metrics),
    sampleCases,
  }
}

/* ---------------- 5. 全局聚合 ---------------- */

export function trainAll(
  profiles: WritingProfile[],
  version = '1.0',
): GlobalCorpus {
  const styleTagDistribution: Record<string, number> = {}
  const cases: WritingCase[] = []
  let bookCount = 0
  const weightAccum: DimensionWeights = { ...DEFAULT_DIMENSION_WEIGHTS }
  for (const p of profiles) {
    bookCount += p.bookCount
    for (const t of p.metrics.styleTags) styleTagDistribution[t] = (styleTagDistribution[t] || 0) + 1
    cases.push(...p.sampleCases)
    for (const d of Object.keys(weightAccum) as (keyof DimensionWeights)[])
      weightAccum[d] += p.dimensionWeights[d]
  }
  const n = Math.max(1, profiles.length)
  const averaged: DimensionWeights = {
    设定: weightAccum.设定 / n,
    人物: weightAccum.人物 / n,
    文笔: weightAccum.文笔 / n,
    结构: weightAccum.结构 / n,
    篇幅: weightAccum.篇幅 / n,
    情节: weightAccum.情节 / n,
    节奏: weightAccum.节奏 / n,
  }
  const globalWeights = normalizeWeights(averaged)
  // 案例按分数去重截顶
  const seen = new Set<string>()
  const deduped = cases.filter(c => {
    const k = c.dimension + ':' + c.text.slice(0, 30)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  deduped.sort((a, b) => b.score - a.score)
  return {
    version,
    trainedAt: new Date().toISOString(),
    userCount: profiles.length,
    bookCount,
    styleTagDistribution,
    cases: deduped.slice(0, 60),
    globalWeights,
  }
}

/* ---------------- 工具 ---------------- */

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 生成给优化引擎用的「该用户历史风格参考」块 */
export function styleReferenceBlock(profile: WritingProfile): string {
  const m = profile.metrics
  const tags = m.styleTags.length ? m.styleTags.join('、') : '暂无显著风格倾向'
  return [
    `【该用户历史风格参考】（由已存作品训练得出，请对齐而非照搬）`,
    `- 风格标签：${tags}`,
    `- 平均句长：${m.avgSentenceLen} 字 · 节奏（短/中/长）：${m.rhythmProfile.short}/${m.rhythmProfile.medium}/${m.rhythmProfile.long}`,
    `- 对话占比：${Math.round(m.dialogueRatio * 100)}% · 词汇丰富度：${m.vocabRichness} · 四字词密度：${m.fourCharIdiomRatio}`,
    `- 偏好权重（七维）：${Object.entries(profile.dimensionWeights)
      .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
      .join(' / ')}`,
  ].join('\n')
}
