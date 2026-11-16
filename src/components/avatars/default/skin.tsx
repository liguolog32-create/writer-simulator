/**
 * 占位形象 · 几何体（v10.67）
 *
 * 这是**临时形象**：让逻辑先跑起来，等真正的形象设计到位后
 * 复制这个文件改一份（`avatars/<你的id>/skin.tsx`）即可替换，**逻辑一行都不用改**。
 *
 * 它演示了皮肤契约该怎么填：8 种情绪各一套表现 + 8 种动作用 CSS 类实现。
 */

import type { AvatarGesture, AvatarMood, AvatarSkin } from '../../../bot/avatar/types'

/** 按 96×96 设计 */
function AvatarArt({ mood, facing }: { mood: AvatarMood; facing: 'left' | 'right' }) {
  const look = facing === 'left' ? -4 : 4

  const eyes = (() => {
    switch (mood) {
      case 'look':
        return (
          <>
            <circle cx={36 + look} cy="50" r="5" fill="#26215C" />
            <circle cx={60 + look} cy="50" r="5" fill="#26215C" />
          </>
        )
      case 'pleased':
        return (
          <>
            <path d="M29 52 Q36 44 43 52" stroke="#26215C" strokeWidth="3" fill="none" strokeLinecap="round" />
            <path d="M53 52 Q60 44 67 52" stroke="#26215C" strokeWidth="3" fill="none" strokeLinecap="round" />
          </>
        )
      case 'offended':
        return (
          <>
            <path d="M29 50 L43 50" stroke="#26215C" strokeWidth="3" fill="none" strokeLinecap="round" />
            <path d="M53 50 L67 50" stroke="#26215C" strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle cx="30" cy="58" r="3" fill="#D4537E" opacity="0.6" />
          </>
        )
      case 'sleepy':
        return (
          <>
            <path d="M29 52 L43 52" stroke="#26215C" strokeWidth="3" fill="none" strokeLinecap="round" />
            <path d="M53 52 L67 52" stroke="#26215C" strokeWidth="3" fill="none" strokeLinecap="round" />
          </>
        )
      case 'thinking':
        return (
          <>
            <circle cx={36} cy="47" r="5" fill="#26215C" />
            <circle cx={60} cy="47" r="5" fill="#26215C" />
            <circle cx="40" cy="16" r="3.5" fill="#534AB7" />
            <circle cx="48" cy="10" r="4" fill="#534AB7" />
            <circle cx="57" cy="15" r="3" fill="#534AB7" />
          </>
        )
      case 'curious':
        return (
          <>
            <circle cx="36" cy="50" r="5" fill="#26215C" />
            <circle cx="60" cy="50" r="7" fill="#26215C" />
            <path d="M52 38 Q61 33 68 38" stroke="#26215C" strokeWidth="2" fill="none" strokeLinecap="round" />
          </>
        )
      case 'speaking':
        return (
          <>
            <circle cx="36" cy="48" r="5" fill="#26215C" />
            <circle cx="60" cy="48" r="5" fill="#26215C" />
            <rect x="41" y="58" width="14" height="8" rx="4" fill="#26215C" className="avatar-mouth" />
          </>
        )
      default:
        return (
          <>
            <circle cx="36" cy="50" r="5" fill="#26215C" />
            <circle cx="60" cy="50" r="5" fill="#26215C" />
          </>
        )
    }
  })()

  return (
    <svg viewBox="0 0 96 96" width="96" height="96" aria-hidden focusable="false">
      <ellipse cx="48" cy="58" rx="30" ry="28" fill="#5DCAA5" />
      <ellipse cx="48" cy="58" rx="30" ry="28" fill="none" stroke="#0F6E56" strokeWidth="1.5" />
      <ellipse cx="48" cy="66" rx="18" ry="12" fill="#9FE1CB" />
      {eyes}
      <circle cx="26" cy="64" r="3.5" fill="#F0997B" opacity="0.55" />
      <circle cx="70" cy="64" r="3.5" fill="#F0997B" opacity="0.55" />
      {mood === 'sleepy' && <text x="72" y="26" fontSize="14" fill="#5F5E5A" className="avatar-zzz">z</text>}
    </svg>
  )
}

/** CSS 类式动作：给元素挂类名，清理时摘掉 */
function classGesture(cls: string, duration = 0) {
  return {
    duration,
    play: (el: HTMLElement) => {
      el.classList.add(cls)
      let timer: number | undefined
      if (duration > 0) timer = window.setTimeout(() => el.classList.remove(cls), duration)
      return () => {
        if (timer) window.clearTimeout(timer)
        el.classList.remove(cls)
      }
    },
  }
}

export const skin: AvatarSkin = {
  id: 'default',
  name: '占位形象 · 几何体',
  hitbox: { w: 96, h: 96 },
  moodArt: {
    idle: <AvatarArt mood="idle" facing="left" />,
    look: <AvatarArt mood="look" facing="left" />,
    thinking: <AvatarArt mood="thinking" facing="left" />,
    curious: <AvatarArt mood="curious" facing="left" />,
    pleased: <AvatarArt mood="pleased" facing="left" />,
    offended: <AvatarArt mood="offended" facing="left" />,
    sleepy: <AvatarArt mood="sleepy" facing="left" />,
    speaking: <AvatarArt mood="speaking" facing="left" />,
  },
  gestures: {
    breathe: classGesture('g-breathe'),
    look: classGesture('g-look'),
    leanIn: classGesture('g-leanin', 2000),
    turnAway: classGesture('g-turnaway', 3000),
    nod: classGesture('g-nod', 3000),
    shiver: classGesture('g-shiver', 3000),
    wake: classGesture('g-wake', 1200),
    none: { duration: 0 },
  },
  speaking: 'bob',
  observingBadge: <span className="avatar-observe-badge">在看</span>,
}

export type { AvatarGesture }
