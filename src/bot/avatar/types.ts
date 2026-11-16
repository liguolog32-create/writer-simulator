/**
 * 常驻可移动形象 · 类型契约（v10.67）
 *
 * 分层（见 docs/bot-avatar-module.md）：
 *   AvatarLayer（逻辑）—— 位置、状态、动作、交互、菜单、小面板
 *        ↕ 只通过 AvatarSkin 契约通信
 *   AvatarSkin（形象）—— 素材与播放方式；换形象 = 换一份 skin 文件，逻辑不改
 */

import type { ReactNode } from 'react'
import type { ClaimOutcome } from '../valueFormation'

/** 7 种情绪（+ speaking），全部由机器人真实状态触发，不是随机表情 */
export type AvatarMood =
  | 'idle' // 待机
  | 'look' // 看向光标 / 你在输入
  | 'thinking' // 它正在生成
  | 'curious' // 落点为"复核"
  | 'pleased' // 落点为"内化"
  | 'offended' // 落点为"抵抗 / 回旋镖"
  | 'sleepy' // 长时间无互动
  | 'speaking' // 它正在流式输出

/** 8 种动作（可选素材，没给就用 CSS 兜底） */
export type AvatarGesture =
  | 'none'
  | 'breathe'
  | 'look'
  | 'leanIn' // 凑近
  | 'turnAway' // 别过脸
  | 'nod' // 点头
  | 'shiver' // 轻抖
  | 'wake' // 惊醒

export interface AvatarPresence {
  mood: AvatarMood
  gesture: AvatarGesture
  /** 头顶气泡：它"有话说"（心里的候选/印象到了该复核的时候） */
  wantsToSpeak: boolean
  /** 屏幕观察中 —— 必须在形象上常驻可见（隐私硬要求） */
  observing: boolean
  /** 刚发生的判定（几秒后消退），用于即时表情反馈 */
  lastOutcome: ClaimOutcome | null
  /** 它对用户的亲疏 0..1（影响它愿不愿意靠近） */
  warmth: number
  /** hover 时显示的一行人话 */
  status: string
}

export type AvatarDock = 'none' | 'left' | 'right' | 'bottom'

export interface AvatarPlacement {
  /** 左上角坐标（相对容器） */
  x: number
  y: number
  scale: number
  facing: 'left' | 'right'
  docked: AvatarDock
}

/* ============================ 皮肤契约（等形象设计来填） ============================ */

export interface AvatarGestureSpec {
  /** 播放时长 ms；0 = 持续到状态改变 */
  duration?: number
  /** 程序化动作：改 transform / 换帧 / 播 Lottie 都行；返回清理函数 */
  play?: (el: HTMLElement, opts: { reducedMotion: boolean }) => void | (() => void)
}

export interface AvatarSkin {
  id: string
  name: string
  /** 按 96×96 设计；实际渲染按 scale 缩放 */
  hitbox: { w: number; h: number }
  /** 8 种情绪的表现（图 / 矢量 / 帧序列都行） */
  moodArt: Record<AvatarMood, ReactNode>
  /** 8 种动作：可选 */
  gestures?: Partial<Record<AvatarGesture, AvatarGestureSpec>>
  /** 说话时的表现 */
  speaking?: 'none' | 'bob' | 'mouth'
  /** 围绕形象的装饰（名字牌 / 影子 / 光环） */
  chrome?: ReactNode
  /** 观察中的常驻指示（必须在形象自身上可见） */
  observingBadge: ReactNode
}
