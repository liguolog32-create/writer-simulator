/**
 * 常驻可移动形象层（v10.67）
 *
 * 挂在 AppShell 上（与页面视图并列）→ **切页面它不消失**，这就是"常驻"。
 * 逻辑全在这里；形象由 AvatarSkin 提供（换形象不改本文件）。
 *
 * 规格见 docs/bot-avatar-module.md：
 *   · 拖动 > 自主移动；拖动后 30 分钟内它不再自己乱走（除非它有话说）
 *   · 靠边吸附（半收起）；位置存本机、不进云同步
 *   · 单击=小面板 / 双击=回机器人页 / 长按或右键=菜单
 *   · 观察中必须在形象上常驻可见（隐私硬要求）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/AppContext'
import { skin as defaultSkin } from './avatars/default/skin'
import { blobSkin } from './avatars/blob/skin'
import { AvatarPanel } from './AvatarPanel'
import { BOT_BUSY_EVENT, BOT_OUTCOME_EVENT } from '../hooks/useBotChat'
import { getObserveState } from '../bot/screensee'
import { derivePresence, SLEEPY_AFTER_MS, type PresenceInput } from '../bot/avatar/presence'
import {
  DEFAULT_SIZE,
  RESPECT_DRAG_MS,
  autonomousTarget,
  clampToViewport,
  defaultPlacement,
  hiddenUntilFor,
  isHiddenUntil,
  readStoredPlacement,
  snapToEdge,
  writeStoredPlacement,
  type MoveReason,
} from '../bot/avatar/placement'
import type { AvatarPlacement, AvatarSkin } from '../bot/avatar/types'
import type { ClaimOutcome } from '../bot/valueFormation'

/** 当前使用的形象（日后可做成设置项切换） */
/** v10.68：默认形象 = 「光团」（Siri 式不规则变动模块）。换形象 = 换这一行。 */
const ACTIVE_SKIN: AvatarSkin = blobSkin

const MIN_WIDTH_FOR_FLOATING = 640
const AUTONOMY_TICK_MS = 4000

interface OutcomeEvent {
  outcome: ClaimOutcome
  at: number
}

export function AvatarLayer() {
  const { state, user } = useApp()
  const bot = state.bot
  const uid = user?.userId ?? null

  const rootRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  const [placement, setPlacement] = useState<AvatarPlacement | null>(null)
  const [docked, setDocked] = useState<AvatarPlacement['docked']>('none')
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [hiddenUntil, setHiddenUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [lastActiveAt, setLastActiveAt] = useState(() => Date.now())
  const [typing, setTyping] = useState(false)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [outcome, setOutcome] = useState<OutcomeEvent | null>(null)
  const [gestureOverride, setGestureOverride] = useState<{ g: keyof NonNullable<AvatarSkin['gestures']>; at: number } | null>(
    null,
  )
  const [moving, setMoving] = useState(false)
  /** 它正在生成（来自 useBotChat 的广播）—— 决定「思考」情绪 */
  const [busy, setBusy] = useState(false)
  /** 屏幕观察中（轮询 screensee 单例）—— 决定形象身上的常驻指示灯（隐私硬要求） */
  const [observing, setObserving] = useState(false)

  const draggingRef = useRef<{ dx: number; dy: number } | null>(null)
  const movedRef = useRef(false)
  /** 记录按下的是哪个键：只有左键才算点击（右键 = 菜单） */
  const buttonRef = useRef(0)
  const lastDraggedAtRef = useRef(0)
  const clickTimerRef = useRef<number | null>(null)
  const longPressRef = useRef<number | null>(null)
  const gestureCleanupRef = useRef<(() => void) | null>(null)

  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  /* ---------------- 视口测量 ---------------- */
  useEffect(() => {
    const measure = () => {
      const el = rootRef.current
      setViewport({ w: el?.clientWidth || window.innerWidth, h: el?.clientHeight || window.innerHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  /* ---------------- 位置初始化 / 持久化 ---------------- */
  useEffect(() => {
    if (!viewport.w || placement) return
    const stored = readStoredPlacement(uid)
    const size = ACTIVE_SKIN.hitbox
    if (stored) {
      const p = clampToViewport({ x: stored.x, y: stored.y }, viewport, size)
      setPlacement({ x: p.x, y: p.y, scale: stored.scale || 1, facing: 'left', docked: stored.docked })
      setDocked(stored.docked)
      if (isHiddenUntil(stored.hiddenUntil, Date.now())) setHiddenUntil(stored.hiddenUntil)
    } else {
      setPlacement(defaultPlacement(viewport, size))
    }
  }, [viewport, placement, uid])

  useEffect(() => {
    if (!placement) return
    writeStoredPlacement(uid, {
      x: placement.x,
      y: placement.y,
      scale: placement.scale,
      docked,
      hiddenUntil,
    })
  }, [placement, docked, hiddenUntil, uid])

  /* ---------------- 交互活跃度 / 打字 / 光标 ---------------- */
  useEffect(() => {
    const touch = () => setLastActiveAt(Date.now())
    const onMove = (e: MouseEvent) => {
      setCursor({ x: e.clientX, y: e.clientY })
      touch()
    }
    const onKey = (e: KeyboardEvent) => {
      touch()
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        setTyping(true)
        if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current)
        typingTimerRef.current = window.setTimeout(() => setTyping(false), 2000)
      }
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', touch, { passive: true })
    window.addEventListener('pointerdown', touch)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', touch)
      window.removeEventListener('pointerdown', touch)
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current)
    }
  }, [])
  const typingTimerRef = useRef<number | null>(null)

  /* ---------------- 判定结果事件（由 useBotChat 广播） ---------------- */
  useEffect(() => {
    const onOutcome = (e: Event) => {
      const d = (e as CustomEvent<OutcomeEvent>).detail
      if (d?.outcome) {
        setOutcome(d)
        setLastActiveAt(Date.now())
      }
    }
    window.addEventListener(BOT_OUTCOME_EVENT, onOutcome)
    return () => window.removeEventListener(BOT_OUTCOME_EVENT, onOutcome)
  }, [])

  /* ---------------- 它是否正在生成（决定「思考」情绪） ---------------- */
  useEffect(() => {
    const onBusy = (e: Event) => {
      const d = (e as CustomEvent<{ busy: boolean }>).detail
      setBusy(Boolean(d?.busy))
    }
    window.addEventListener(BOT_BUSY_EVENT, onBusy)
    return () => window.removeEventListener(BOT_BUSY_EVENT, onBusy)
  }, [])

  /* ---------------- 是否正在观察屏幕（决定形象身上的常驻指示灯 · 隐私硬要求） ----------------
     screensee 是模块单例、没有订阅机制，这里用 1 秒轮询取状态（代价可忽略，
     而且观察开关本身在另一页，轮询比跨组件传 event 更不容易漏）。 */
  useEffect(() => {
    const sync = () => setObserving(getObserveState() === 'on')
    sync()
    const t = window.setInterval(sync, 1000)
    const onVis = () => sync()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  /* ---------------- 心跳（驱动闲置/表情过期） ---------------- */
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    const onVisibility = () => setNow(Date.now())
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const idleMs = now - lastActiveAt

  /* ---------------- 形象状态 ---------------- */
  // v10.68 修复：busy 与 observing 原来被写死成 false，
  // 导致「思考」情绪与「观察中」指示灯这两条路径永远不会触发（隐私硬要求也失效）。
  const presenceInput: PresenceInput = {
    value: bot?.value ?? null,
    busy,
    observing,
    lastOutcome: outcome?.outcome ?? null,
    lastOutcomeAt: outcome?.at ?? null,
    idleMs,
    typing,
    cursorNear: Boolean(cursor && placement && Math.abs(cursor.x - placement.x) < 320),
    nowMs: now,
  }
  const presence = derivePresence(presenceInput)

  /* 被打断瞌睡 → 惊醒一次 */
  const prevSleepyRef = useRef(false)
  useEffect(() => {
    const sleepy = presence.mood === 'sleepy'
    if (prevSleepyRef.current && !sleepy) {
      setGestureOverride({ g: 'wake', at: Date.now() })
      window.setTimeout(() => setGestureOverride(null), 1400)
    }
    prevSleepyRef.current = sleepy
  }, [presence.mood])

  const activeGesture = gestureOverride && now - gestureOverride.at < 2000 ? gestureOverride.g : presence.gesture

  /* ---------------- 动作播放 ---------------- */
  useEffect(() => {
    const el = boxRef.current
    if (!el || reducedMotion) return
    const spec = ACTIVE_SKIN.gestures?.[activeGesture]
    gestureCleanupRef.current?.()
    gestureCleanupRef.current = spec?.play?.(el, { reducedMotion }) ?? null
    return () => {
      gestureCleanupRef.current?.()
      gestureCleanupRef.current = null
    }
  }, [activeGesture, reducedMotion])

  /* ---------------- 自主移动 ---------------- */
  useEffect(() => {
    if (reducedMotion || !placement) return
    const t = window.setInterval(() => {
      if (draggingRef.current || expanded) return
      if (document.visibilityState === 'hidden') return
      const reason: MoveReason = presence.wantsToSpeak
        ? 'wantsToSpeak'
        : presence.mood === 'offended'
          ? 'offended'
          : presence.mood === 'sleepy'
            ? 'lonely'
            : typing
              ? 'typing'
              : 'none'
      const target = autonomousTarget({
        placement,
        viewport,
        size: ACTIVE_SKIN.hitbox,
        cursor,
        reason,
        lastDraggedAt: lastDraggedAtRef.current,
        nowMs: Date.now(),
      })
      if (!target) return
      const dist = Math.hypot(target.x - placement.x, target.y - placement.y)
      if (dist < 12) return
      setMoving(true)
      setPlacement(p => (p ? { ...p, x: target.x, y: target.y } : p))
      window.setTimeout(() => setMoving(false), 2600)
    }, AUTONOMY_TICK_MS)
    return () => window.clearInterval(t)
  }, [placement, viewport, cursor, presence.wantsToSpeak, presence.mood, typing, reducedMotion, expanded])

  /* ---------------- 拖动 ---------------- */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!placement) return
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      draggingRef.current = { dx: e.clientX - placement.x, dy: e.clientY - placement.y }
      movedRef.current = false
      // 只有左键才算"点击/拖动"；右键交给 contextmenu 处理（否则右键会被当成单击，把菜单关掉）
      buttonRef.current = e.button
      if (e.button !== 0) {
        setLastActiveAt(Date.now())
        return
      }
      setLastActiveAt(Date.now())
      longPressRef.current = window.setTimeout(() => {
        if (!movedRef.current) {
          setMenuOpen(true)
          draggingRef.current = null
        }
      }, 600)
    },
    [placement],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = draggingRef.current
      if (!d) return
      movedRef.current = true
      if (longPressRef.current) {
        window.clearTimeout(longPressRef.current)
        longPressRef.current = null
      }
      const p = clampToViewport(
        { x: e.clientX - d.dx, y: e.clientY - d.dy },
        viewport,
        ACTIVE_SKIN.hitbox,
      )
      setPlacement(prev => (prev ? { ...prev, x: p.x, y: p.y, scale: 1.05 } : prev))
    },
    [viewport],
  )

  const onPointerUp = useCallback(() => {
    if (longPressRef.current) {
      window.clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
    const wasDragging = Boolean(draggingRef.current)
    const isLeft = buttonRef.current === 0
    draggingRef.current = null
    if (!placement) return
    if (movedRef.current) {
      lastDraggedAtRef.current = Date.now()
      const snapped = snapToEdge({ x: placement.x, y: placement.y }, viewport, ACTIVE_SKIN.hitbox)
      setPlacement(p => (p ? { ...p, x: snapped.pos.x, y: snapped.pos.y, scale: 1, docked: snapped.docked } : p))
      setDocked(snapped.docked)
      return
    }
    if (wasDragging && isLeft) {
      // 没移动 = 点击：250ms 内再来一次算双击
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
        window.location.hash = '#/bot'
        setMenuOpen(false)
        return
      }
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null
        setExpanded(v => !v)
        setMenuOpen(false)
      }, 250)
    }
  }, [placement, viewport])

  /* ---------------- 隐身 ---------------- */
  const hideFor = (kind: 'hour' | 'today') => {
    const until = hiddenUntilFor(kind, Date.now())
    setHiddenUntil(until)
    setMenuOpen(false)
    setExpanded(false)
  }

  /* ---------------- 不该出现的情况 ---------------- */
  const tooNarrow = viewport.w > 0 && viewport.w < MIN_WIDTH_FOR_FLOATING
  if (!bot?.persona || !placement || tooNarrow || isHiddenUntil(hiddenUntil, now)) return null

  return (
    <div className="avatar-layer" ref={rootRef} aria-hidden={false}>
      {/* 隐身中（只留一个极小的恢复入口，不打扰） */}
      {expanded && <AvatarPanel onClose={() => setExpanded(false)} presence={presence} />}

      <div
        ref={boxRef}
        className={[
          'avatar-box',
          `mood-${presence.mood}`,
          `dock-${docked}`,
          moving ? 'is-moving' : '',
          hovered ? 'is-hover' : '',
          presence.observing ? 'is-observing' : '',
        ].join(' ')}
        style={{
          transform: `translate3d(${placement.x}px, ${placement.y}px, 0) scale(${placement.scale})`,
          transition: draggingRef.current || reducedMotion ? 'none' : 'transform 2.4s cubic-bezier(0.22,0.61,0.36,1)',
          width: ACTIVE_SKIN.hitbox.w,
          height: ACTIVE_SKIN.hitbox.h,
        }}
        role="button"
        tabIndex={0}
        aria-label={bot.persona.name}
        title={presence.status}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={e => {
          e.preventDefault()
          setMenuOpen(true)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') setExpanded(v => !v)
          if (e.key === 'Escape') {
            setExpanded(false)
            setMenuOpen(false)
          }
          const step = e.shiftKey ? 24 : 8
          const size = ACTIVE_SKIN.hitbox
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
            setPlacement(p => {
              if (!p) return p
              const np = clampToViewport({ x: p.x + dx, y: p.y + dy }, viewport, size)
              return { ...p, ...np }
            })
          }
        }}
      >
        <div className="avatar-art">{ACTIVE_SKIN.moodArt[presence.mood]}</div>
        {ACTIVE_SKIN.chrome}
        {presence.observing && ACTIVE_SKIN.observingBadge}
        {presence.wantsToSpeak && !expanded && <span className="avatar-bubble" aria-label="它想说话" />}
        {hovered && !expanded && !menuOpen && <span className="avatar-status">{presence.status}</span>}
      </div>

      {menuOpen && (
        <div
          className="avatar-menu"
          style={{ transform: `translate3d(${placement.x}px, ${placement.y}px, 0)` }}
          onMouseLeave={() => setMenuOpen(false)}
        >
          <button
            className="ghost-btn sm"
            onClick={() => {
              window.location.hash = '#/bot'
              setMenuOpen(false)
            }}
          >
            回它的房间
          </button>
          <button className="ghost-btn sm" onClick={() => hideFor('hour')}>
            隐身 1 小时
          </button>
          <button className="ghost-btn sm" onClick={() => hideFor('today')}>
            今天别打扰
          </button>
          <button
            className="ghost-btn sm"
            onClick={() => {
              const snapped = snapToEdge(
                { x: viewport.w, y: placement.y },
                viewport,
                ACTIVE_SKIN.hitbox,
                999,
              )
              setPlacement(p => (p ? { ...p, x: snapped.pos.x, y: snapped.pos.y, docked: snapped.docked } : p))
              setDocked(snapped.docked)
              setMenuOpen(false)
            }}
          >
            停靠到边上
          </button>
        </div>
      )}

      {/* 尊重系统设置：开了"减少动态效果"就不动，只保留状态与表情 */}
      {reducedMotion && <span className="sr-only">已按系统设置关闭形象动画</span>}
      {/* 用户拖动后的一段静默期（不显示给用户，仅内部标记） */}
      <span className="sr-only">{Date.now() - lastDraggedAtRef.current < RESPECT_DRAG_MS ? '它会待在你放的位置' : ''}</span>
      <span className="sr-only">形象尺寸 {DEFAULT_SIZE.w}×{DEFAULT_SIZE.h}；它睡着的阈值 {SLEEPY_AFTER_MS / 60000} 分钟</span>
    </div>
  )
}
