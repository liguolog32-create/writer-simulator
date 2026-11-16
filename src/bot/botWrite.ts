/**
 * 机器人「代笔」—— 让它以作者身份写一章正文（v10.67）
 *
 * 为什么单开一个文件而不是复用写章接口：
 * 精写走的是「按画布产出符合工程规格的正文」，主语是工具；
 * 代笔的主语是**它自己** —— 提示词第一段是人格卡，第二段是它自己长出来的三观，
 * 然后才是任务。顺序反过来，写出来的就又是通用 AI 腔了。
 */

import { botWriteText } from '../lib/llmClient'
import { retrieve, assembleMemories } from './memory'
import { personaToPrompt } from './persona'
import { valueToPrompt, type ValueState } from './valueFormation'
import type { MemoryItem, PersonaCard } from './types'

export interface BotWriteInput {
  persona: PersonaCard
  value?: ValueState
  memories?: MemoryItem[]
  /** 这一章要写什么 */
  brief: string
  /** 画布 + 前文：它的素材 */
  context: string
  /** 目标字数，缺省 1200（代笔是短章试笔，不追长篇规格） */
  targetWords?: number
}

export interface BotWriteResult {
  content: string
  /** 它这次想起了什么（识海唤醒了哪些条目），用来给用户解释「为什么写成这样」 */
  why: string
}

const DEFAULT_TARGET_WORDS = 1200

export async function botWrite(input: BotWriteInput): Promise<BotWriteResult> {
  const { persona, value, memories = [], brief, context } = input
  const targetWords = input.targetWords ?? DEFAULT_TARGET_WORDS

  // 用本章 brief 去唤醒识海：写什么，就想什么
  const hits = retrieve(memories, brief, { k: 5 })
  const why = hits.length ? assembleMemories(hits).join('\n') : ''

  const instruction = [
    personaToPrompt(persona, hits.map(h => h.memory.content)),
    value ? valueToPrompt(value) : '',
    `【这一章要写什么】\n${brief}`,
    `【你手上的材料】（画布设定与前文，只有这些是你知道的）\n${context || '（无）'}`,
    [
      '【写作要求】',
      '1. 你现在不是助理、不是模型，你是这本书的作者本人。用你自己的性情、审美和偏见来写这一章。',
      '2. 不要模仿通用网文腔：不要套「心中一凛」「嘴角勾起一抹弧度」这类现成腔调，也不要为了讨好读者把话说满。',
      '3. 只输出正文。不要提纲、不要解释、不要「以下是本章」之类的开场白，不要写作者按。',
      `4. 目标字数约 ${targetWords} 字（不必精确，写透即可）。`,
      '5. 若材料里有前文，必须承接其中的人名、设定、时间线，不得另起炉灶或改写既有事实。',
      '6. 你厌恶的写法（见人格卡）一句都不要出现。',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')

  // 走独立的 botWrite 动作：服务端系统提示把主语设成「你本人就是作者」，
  // 而不是 refine 那条「文学分析编辑 / 只改一段 / 保持简洁」——后者会把它写成人话梗概。
  const r = await botWriteText({ instruction })
  const content = (r.data?.content ?? '').trim()

  return { content, why }
}
