/**
 * 形象 · 「光团」（Siri 式不规则变动模块）· v10.68
 *
 * 用户定稿（2026-10-15）：**不需要具体形象**，做成类似 Siri 的、不规则变动的光团。
 *
 * 实现思路（为什么这样最合适）：
 *  · **不画具体形状** —— 它是一团会呼吸、会变形、会被情绪染色的光；
 *    "没有固定形状"恰好最贴合"它还在形成中"的设定，也给 7 种情绪留足了表达空间。
 *  · **不规则感来自"非周期叠加"**：主体 7.3s、内层 11.7s（反向）、光晕 5.9s、自转 23s ——
 *    四个周期互不整除，叠在一起短时间内不会重复，看起来就是"一直在变、但不像循环"。
 *  · **情绪调制靠 CSS 变量 + 父级 mood 类**（`.avatar-box.mood-*` 由逻辑层给），
 *    所以皮肤不需要为 8 种情绪各写一套结构 —— 一份结构 + 一组配色/节奏变量即可。
 *  · **零 CPU 空闲**：全部是 CSS 动画（合成层），静止时不占主线程；逻辑层已负责
 *    `prefers-reduced-motion` 与页面隐藏时暂停。
 */

import type { ReactNode } from 'react'
import type { AvatarGesture, AvatarMood, AvatarSkin } from '../../../bot/avatar/types'

/** 一团光：光晕 + 主体 + 内层 + 高光 + 环游点 + 两道扩散环 */
function Blob() {
  return (
    <div className="blob">
      <span className="blob-halo" />
      <span className="blob-core" />
      <span className="blob-veil" />
      <span className="blob-shine" />
      <span className="blob-orbit" />
      <span className="blob-ripple" />
      <span className="blob-ripple blob-ripple-b" />
    </div>
  )
}

const MOODS: AvatarMood[] = [
  'idle',
  'look',
  'thinking',
  'curious',
  'pleased',
  'offended',
  'sleepy',
  'speaking',
]

/** 8 种情绪共用同一份结构 —— 差异全部由父级 `.mood-*` 的 CSS 变量与节奏决定 */
const moodArt = Object.fromEntries(MOODS.map(m => [m, <Blob key={m} />])) as Record<AvatarMood, ReactNode>

/**
 * 8 种动作：用 CSS 类实现（加类 → 播完移除，并用一次强制重排让动画可重复触发）。
 * 没列出的动作（breathe）由默认 CSS 承担，不需要额外播放。
 */
const GESTURE_MS: Partial<Record<AvatarGesture, number>> = {
  look: 700,
  leanIn: 1200,
  turnAway: 1400,
  nod: 900,
  shiver: 620,
  wake: 760,
}

const gestures = Object.fromEntries(
  (Object.keys(GESTURE_MS) as AvatarGesture[]).map(g => [
    g,
    {
      duration: GESTURE_MS[g],
      play: (el: HTMLElement) => {
        const cls = `g-${g}`
        el.classList.remove(cls)
        // 强制重排：否则连续两次同动作不会重新播放
        void el.offsetWidth
        el.classList.add(cls)
        const t = window.setTimeout(() => el.classList.remove(cls), GESTURE_MS[g] ?? 900)
        return () => {
          window.clearTimeout(t)
          el.classList.remove(cls)
        }
      },
    },
  ]),
) as AvatarSkin['gestures']

export const blobSkin: AvatarSkin = {
  id: 'blob',
  name: '光团',
  hitbox: { w: 96, h: 96 },
  moodArt,
  gestures,
  speaking: 'bob',
  /** 观察中的常驻指示灯：一圈呼吸环 + 右上角带字的胶囊（隐私硬要求：必须画在形象身上） */
  observingBadge: (
    <span className="blob-observe" role="status" aria-label="正在观察屏幕">
      <span className="blob-observe-ring" />
      <span className="blob-observe-pill">
        <span className="blob-observe-dot" />
        观察中
      </span>
    </span>
  ),
}
