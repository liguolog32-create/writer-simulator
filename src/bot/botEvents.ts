/**
 * 与常驻形象层通信的事件（v18.7 从 useBotChat 搬入，供对话与观察两条路径共用）
 *
 * 事件名与 AvatarLayer.tsx 的监听完全一致，不得改动。
 */

import type { ClaimOutcome } from './valueFormation'

/** 一次价值判定刚发生 —— 形象层据此做出即时表情（满意 / 被冒犯） */
export const BOT_OUTCOME_EVENT = 'bot-claim-outcome'

export function broadcastOutcome(outcome: ClaimOutcome, at: number): void {
  try {
    window.dispatchEvent(new CustomEvent(BOT_OUTCOME_EVENT, { detail: { outcome, at } }))
  } catch {
    /* SSR / 测试环境没有 window 时忽略 */
  }
}
