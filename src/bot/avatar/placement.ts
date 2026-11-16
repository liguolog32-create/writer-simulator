/**
 * 位置与移动计算（v10.67）—— **纯函数，可单测**
 *
 * 规则（见 docs/bot-avatar-module.md 第五节）：
 *   · 用户拖动 > 自主移动；拖动后一段时间内它不再自己乱走
 *   · 靠边自动吸附（半收起）；恢复时做视口边界校验
 *   · 自主移动必须"走"过去（由 UI 层加过渡动画），这里只算目标点
 */

import type { AvatarDock, AvatarPlacement } from './types'

export interface Size {
  w: number
  h: number
}
export interface Point {
  x: number
  y: number
}

export const DEFAULT_SIZE: Size = { w: 96, h: 96 }
export const EDGE_MARGIN = 24
export const SNAP_THRESHOLD = 40
/** 用户拖动后，它多久不再自主移动 */
export const RESPECT_DRAG_MS = 30 * 60 * 1000

export function defaultPlacement(viewport: Size, size: Size = DEFAULT_SIZE): AvatarPlacement {
  return {
    x: Math.max(EDGE_MARGIN, viewport.w - size.w - EDGE_MARGIN),
    y: Math.max(EDGE_MARGIN, viewport.h - size.h - EDGE_MARGIN),
    scale: 1,
    facing: 'left',
    docked: 'none',
  }
}

/** 把坐标夹到可视区内（换屏 / 改窗口大小后要用） */
export function clampToViewport(pos: Point, viewport: Size, size: Size = DEFAULT_SIZE): Point {
  const maxX = Math.max(0, viewport.w - size.w)
  const maxY = Math.max(0, viewport.h - size.h)
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY),
  }
}

/** 靠边就吸附：返回吸附后的坐标与停靠方向 */
export function snapToEdge(
  pos: Point,
  viewport: Size,
  size: Size = DEFAULT_SIZE,
  threshold = SNAP_THRESHOLD,
): { pos: Point; docked: AvatarDock } {
  const p = clampToViewport(pos, viewport, size)
  const distLeft = p.x
  const distRight = viewport.w - (p.x + size.w)
  const distBottom = viewport.h - (p.y + size.h)

  if (distLeft <= threshold && distLeft <= distRight) {
    return { pos: { x: 0, y: p.y }, docked: 'left' }
  }
  if (distRight <= threshold) {
    return { pos: { x: Math.max(0, viewport.w - size.w), y: p.y }, docked: 'right' }
  }
  if (distBottom <= threshold) {
    return { pos: { x: p.x, y: Math.max(0, viewport.h - size.h) }, docked: 'bottom' }
  }
  return { pos: p, docked: 'none' }
}

/** 停靠态下的目标位置（贴边） */
export function dockTarget(dock: AvatarDock, viewport: Size, size: Size = DEFAULT_SIZE, currentY = 0): Point {
  if (dock === 'left') return clampToViewport({ x: 0, y: currentY }, viewport, size)
  if (dock === 'right') return clampToViewport({ x: viewport.w - size.w, y: currentY }, viewport, size)
  if (dock === 'bottom') return clampToViewport({ x: viewport.w - size.w - EDGE_MARGIN, y: viewport.h - size.h }, viewport, size)
  return clampToViewport({ x: viewport.w - size.w - EDGE_MARGIN, y: viewport.h - size.h - EDGE_MARGIN }, viewport, size)
}

export type MoveReason = 'wantsToSpeak' | 'lonely' | 'typing' | 'offended' | 'wake' | 'none'

export interface AutonomousInput {
  placement: AvatarPlacement
  viewport: Size
  size?: Size
  /** 光标位置（可能不在容器内） */
  cursor: Point | null
  reason: MoveReason
  /** 上次用户拖动的时间戳 */
  lastDraggedAt: number
  nowMs: number
}

/**
 * 自主移动：算出它想去哪。
 * · 用户刚拖过 → 不动（尊重摆放），除非它有话说
 * · 有话说 → 走到靠光标的那一侧（并稍微靠近，但不压到光标上）
 * · 被冷落 → 退到最近的角落
 * · 你在打字 → 沿边退开 48px（不挡视线）
 * · 被冒犯 → 朝远离光标方向挪 40–80px
 */
export function autonomousTarget(input: AutonomousInput): Point | null {
  const { placement, viewport, cursor, reason, lastDraggedAt, nowMs } = input
  const size = input.size ?? DEFAULT_SIZE
  const cur: Point = { x: placement.x, y: placement.y }
  if (reason === 'none') return null
  const recentlyDragged = nowMs - lastDraggedAt < RESPECT_DRAG_MS
  if (recentlyDragged && reason !== 'wantsToSpeak') return null

  const dock = placement.docked
  switch (reason) {
    case 'wantsToSpeak': {
      if (!cursor) return null
      const onLeftHalf = cursor.x < viewport.w / 2
      // 贴到靠近光标的那一侧，纵向跟着光标但留出距离
      const y = Math.min(Math.max(EDGE_MARGIN, cursor.y - size.h / 2), viewport.h - size.h - EDGE_MARGIN)
      const x = onLeftHalf ? EDGE_MARGIN : viewport.w - size.w - EDGE_MARGIN
      return clampToViewport({ x, y }, viewport, size)
    }
    case 'lonely':
      return dockTarget(dock === 'none' ? 'bottom' : dock, viewport, size, placement.y)
    case 'typing': {
      if (!cursor) return null
      const away = cursor.x < viewport.w / 2 ? 48 : -48
      return clampToViewport({ x: cur.x + away, y: placement.y }, viewport, size)
    }
    case 'offended': {
      if (!cursor) return null
      const dx = cur.x + (cur.x < cursor.x ? -64 : 64)
      return clampToViewport({ x: dx, y: placement.y }, viewport, size)
    }
    case 'wake':
      return clampToViewport({ x: cur.x, y: Math.max(EDGE_MARGIN, placement.y - 8) }, viewport, size)
    default:
      return null
  }
}

/** 隐身到期判断（隐身 1 小时 / 今天别打扰） */
export function isHiddenUntil(untilMs: number | null, nowMs: number): boolean {
  return untilMs !== null && untilMs > nowMs
}

export function hiddenUntilFor(kind: 'hour' | 'today', nowMs: number): number {
  if (kind === 'hour') return nowMs + 3600 * 1000
  const d = new Date(nowMs)
  d.setHours(24, 0, 0, 0) // 到当天 24:00
  return d.getTime()
}

/* ------------------------------ 持久化 ------------------------------ */

const KEY = 'writer-sim-avatar-placement-v1'

export interface StoredPlacement {
  x: number
  y: number
  scale: number
  docked: AvatarDock
  hiddenUntil: number | null
}

export function readStoredPlacement(uid: string | null): StoredPlacement | null {
  try {
    const raw = localStorage.getItem(`${KEY}::${uid || 'local'}`)
    return raw ? (JSON.parse(raw) as StoredPlacement) : null
  } catch {
    return null
  }
}

export function writeStoredPlacement(uid: string | null, p: StoredPlacement): void {
  try {
    localStorage.setItem(`${KEY}::${uid || 'local'}`, JSON.stringify(p))
  } catch {
    /* 存不进去不影响使用 */
  }
}
