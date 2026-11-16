/**
 * 上云 payload 的字段白名单（v10.65 · 第三道隔离闸）
 *
 * 用户 2026-10-14 的硬要求：屏幕观察抓到的数据不能被存放到 Cloudflare 后台。
 * 三道闸：① 观察数据不进 React state / 不进 AppState；② 本模块在**出口**放行白名单；
 * ③ worker 端再剥一次未知字段。这一道的意义是：即使将来某个 bug 误把观察数据塞进了
 * state，它也到不了云端 —— 出口只放行已知字段，其余一律剥掉。
 *
 * ⚠️ AppState 新增字段时，这里必须同步加进来，否则该字段会静默不参与云同步。
 * （独立成文件、零依赖，是为了能在 Node 里直接单测。）
 */

import type { AppState } from '../types'

export const SYNC_WHITELIST = [
  'canvases',
  'selectedCanvasId',
  'mode',
  'library',
  'trash',
  'lastMode',
  'rememberMode',
  'collapseCanvases',
  'customStyleCards',
  'worldviews',
  'collections',
  'linkedBookId',
  // 机器人的人格卡 + 识海记忆（它的本体，跨设备要一致）
  'bot',
] as const

/** 只保留白名单字段；其余（包括误塞进来的观察数据）一律剥掉 */
export function sanitizeAppStateForSync(state: AppState): AppState {
  const src = state as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of SYNC_WHITELIST) {
    if (key in src) out[key] = src[key]
  }
  return out as unknown as AppState
}
