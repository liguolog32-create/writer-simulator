/**
 * 形象状态推导（v10.67）—— **纯函数，可单测**
 *
 * 原则：它的表情不是随机的，是**从机器人真实状态算出来的**。
 * 所以"它看起来在想事"= 它真的在处理；"它别过脸"= 它刚刚真的抵抗了你一句。
 */

import type { ClaimOutcome, ValueState } from '../valueFormation'
import type { AvatarGesture, AvatarMood, AvatarPresence } from './types'

export interface PresenceInput {
  value: ValueState | null
  /** LLM 正在生成 */
  busy: boolean
  /** 它正在流式输出（本版用 busy 近似） */
  speaking?: boolean
  /** 屏幕观察中 */
  observing: boolean
  /** 最近一次判定结果 */
  lastOutcome: ClaimOutcome | null
  /** 判定发生的时间（ms）；用于决定表情持续多久 */
  lastOutcomeAt: number | null
  /** 距上次用户互动多久（ms） */
  idleMs: number
  /** 用户正在输入框打字 */
  typing: boolean
  /** 光标是否靠近它（用于"看向"） */
  cursorNear: boolean
  nowMs: number
}

/** 判定结果 → 情绪 的映射（这是形象设计里"什么时候播哪个表情"的依据） */
const OUTCOME_MOOD: Partial<Record<ClaimOutcome, AvatarMood>> = {
  internalized: 'pleased',
  candidate: 'curious',
  reviewed: 'curious',
  impression: 'idle',
  ignored: 'idle',
  resisted: 'offended',
  backfire: 'offended',
}

/** 情绪 → 手势 */
const MOOD_GESTURE: Record<AvatarMood, AvatarGesture> = {
  idle: 'breathe',
  look: 'look',
  thinking: 'breathe',
  curious: 'leanIn',
  pleased: 'nod',
  offended: 'turnAway',
  sleepy: 'breathe',
  speaking: 'breathe',
}

const OUTCOME_TTL_MS = 4000
export const SLEEPY_AFTER_MS = 15 * 60 * 1000

/** 它"有话说"：心里有候选到了该验证的时候，或印象被反复提起 */
export function wantsToSpeak(value: ValueState | null): boolean {
  if (!value) return false
  return value.beliefs.some(
    b => (b.state === 'candidate' && b.mentions >= 2) || (b.state === 'impression' && b.mentions >= 2),
  )
}

export function derivePresence(input: PresenceInput): AvatarPresence {
  const { value, busy, observing, lastOutcome, lastOutcomeAt, idleMs, typing, cursorNear, nowMs } = input
  const warmth = value ? Math.min(1, Math.max(0, 0.5 + (value.credibility - 50) / 100)) : 0.5

  let mood: AvatarMood = 'idle'

  // 判定表情优先（它刚经历了一件事，脸上会带出来）
  const outcomeFresh = lastOutcome !== null && lastOutcomeAt !== null && nowMs - lastOutcomeAt < OUTCOME_TTL_MS
  if (outcomeFresh && lastOutcome) {
    mood = OUTCOME_MOOD[lastOutcome] ?? 'idle'
  } else if (busy) {
    mood = 'thinking'
  } else if (idleMs >= SLEEPY_AFTER_MS) {
    mood = 'sleepy'
  } else if (typing || cursorNear) {
    mood = 'look'
  }

  const gesture = MOOD_GESTURE[mood]
  const hasNews = wantsToSpeak(value)

  return {
    mood,
    gesture,
    wantsToSpeak: hasNews,
    observing,
    lastOutcome: outcomeFresh ? lastOutcome : null,
    warmth,
    status: statusText(mood, hasNews, observing, value),
  }
}

/** hover 时给它的一行人话（不暴露内部数值） */
export function statusText(
  mood: AvatarMood,
  hasNews: boolean,
  observing: boolean,
  value: ValueState | null,
): string {
  if (observing) return '它在看着屏幕（原文只留在你这台设备上）'
  if (mood === 'offended') return '它刚被你顶回去了，正在别扭'
  if (mood === 'pleased') return '它好像想通了一件事'
  if (mood === 'thinking') return '它在想你说的话'
  if (mood === 'sleepy') return '它有点困了'
  if (mood === 'curious') return '它对你反复提的那件事起疑了'
  if (mood === 'look') return '它正看着你'
  if (hasNews) return '它心里有事，想跟你说'
  if (!value || !value.beliefs.length) return '它还没有自己的原则'
  const n = value.beliefs.filter(b => b.state === 'internalized').length
  return n ? `它现在有 ${n} 条自己长出来的原则` : '它还在形成中'
}
