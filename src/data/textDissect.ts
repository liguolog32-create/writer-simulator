import {
  extractWorldNouns,
  extractProtagonist,
  extractRelations,
  extractStyle,
  extractPlotBeats,
} from './bookGenerator'
import type { CanvasDimension } from '../types'

export const DIMENSIONS: CanvasDimension[] = [
  '设定',
  '人物',
  '文笔',
  '结构',
  '篇幅',
  '情节',
  '节奏',
]

export type DissectResult = Record<CanvasDimension, string>

/** 统计文本结构特征 */
function stats(text: string) {
  const trimmed = text.trim()
  const chars = trimmed.length
  const paragraphs = trimmed.split(/\n\s*\n/).filter(p => p.trim()).length
  const sentences = trimmed
    .split(/[。！？!?；;]/)
    .map(s => s.trim())
    .filter(Boolean)
  const avgSentence = sentences.length ? Math.round(chars / sentences.length) : 0
  const dialogues = (trimmed.match(/[""「」"'']/g) || []).length
  return { chars, paragraphs, sentences: sentences.length, avgSentence, dialogues }
}

/**
 * 本地启发式拆解：Worker 不可用时也能把原文拆成 7 个维度。
 * 质量不如 LLM，但保证工作台功能不挂。
 */
export function dissectTextLocally(text: string): DissectResult {
  const s = stats(text)
  const nouns = extractWorldNouns(text)
  const hero = extractProtagonist(text)
  const relations = extractRelations(text)
  const style = extractStyle(text)
  const beats = extractPlotBeats(text)

  const 设定 = nouns.length
    ? `识别到世界观要素：${nouns.slice(0, 6).join('、')}。建议补充时代背景、力量体系与特殊规则。（本地启发式分析，接入 LLM 后更准）`
    : `未在文本中提取到明确的世界观名词。建议补充时代背景与特殊规则。（本地启发式分析）`

  const 人物 = relations.length
    ? `主角疑似：${hero}。识别到 ${relations.length} 组关系：${relations
        .slice(0, 5)
        .map(r => `${r.role} ${r.name}${r.status ? `（${r.status}）` : ''}`)
        .join('；')}。`
    : `主角疑似：${hero}。未识别到结构化的人物关系列表，建议手动补充关键人物与其立场。`

  const 文笔 =
    style.label !== '未指定（默认平实）'
      ? `检测到风格倾向：${style.label}。平均句长约 ${s.avgSentence} 字${
          s.avgSentence <= 15 ? '（偏短句）' : s.avgSentence >= 35 ? '（偏长句）' : '（中等）'
        }，对话标记约 ${s.dialogues} 处。`
      : `平均句长约 ${s.avgSentence} 字${
          s.avgSentence <= 15 ? '（偏短句）' : s.avgSentence >= 35 ? '（偏长句）' : '（中等）'
        }，对话标记约 ${s.dialogues} 处。未检测到明确的风格关键词，建议手动描述语气与句法偏好。`

  const 结构 = `全文约 ${s.paragraphs} 个自然段，${
    s.paragraphs <= 3 ? '篇幅较短，可能是片段' : s.paragraphs <= 10 ? '中等长度' : '篇幅较长'
  }。建议在此明确章节划分、叙事顺序与视角（第一/第三人称）。`

  const 篇幅 = `当前文本 ${s.chars} 字，约 ${s.sentences} 句。建议在此设定目标总字数、单章字数与三段分配（开篇/主体/收束）。`

  const 情节 = beats.length
    ? `提取到 ${beats.length} 个情节片段：${beats.slice(0, 3).join('；')}。建议补充主线冲突与因果链条。`
    : `未提取到明确情节节拍。建议在此写明主线冲突、转折点与悬念设置。`

  const 节奏 = `共 ${s.paragraphs} 段，建议按每 3 段设置一个小高潮、每卷一次反转。当前文本${
    s.dialogues > s.paragraphs ? '对话密集，节奏偏快' : '叙述为主，节奏偏稳'
  }。`

  return { 设定, 人物, 文笔, 结构, 篇幅, 情节, 节奏 }
}
