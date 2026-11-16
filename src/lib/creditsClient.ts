import { postWorkerData } from './api'

/* ============================================================
   积分（付费额度）客户端 —— v10.23
   ------------------------------------------------------------
   计价口径（服务端权威，前端只做展示）：
     · 单价：deepseek-v4-flash 官方分时价（CNY/百万 tokens）
         计费项            空闲     高峰(=2×)
         输入·缓存未命中    ¥1.00   ¥2.00
         输入·缓存命中      ¥0.02   ¥0.04
         输出              ¥4.00   ¥8.00
       高峰 = 周一至周五 09:00–12:00 / 14:00–18:00（北京时间）
     · 用户侧积分 = 真实成本 × 140%（含 40% 溢价）
     · 1 积分 = ¥0.001（1000 积分 = 1 元）
     · 免费引擎（Cloudflare Workers AI）不计积分
   ============================================================ */

export interface CreditUsageRow {
  action: string
  model: string
  tokensMiss: number
  tokensHit: number
  tokensOut: number
  /** 真实成本（元）—— **仅管理员**会下发，普通用户拿到 undefined */
  costCny?: number
  /** 用户侧消耗积分（已含 140% 计价） */
  credits: number
  peak: boolean
  /** 北京时间可读串 */
  at: string
}

export interface CreditStatus {
  userId: string
  /** 累计发放积分 */
  granted: number
  /** 累计消耗积分 */
  used: number
  /** 当前余额 = granted − used */
  balance: number
  /**
   * 站方的成本结构 —— **只有管理员账号会下发**，普通用户这里恒为 undefined。
   * 服务端按 role 决定，不是前端藏起来（翻响应体也看不到）。
   */
  costCny?: number
  /** 累计真实成本 × 140%（元）—— 仅管理员 */
  chargedCny?: number
  /** 溢价倍率 —— 仅管理员 */
  markup?: number
  tokens: number
  calls: number
  todayCredits: number
  todayCalls: number
  cnyPerCredit: number
  recent: CreditUsageRow[]
  /** v10.25 免费模型：今日已用次数 / 每日上限 / 剩余次数（北京时间 0 点重置） */
  freeUsed: number
  freeLimit: number
  freeLeft: number
  /**
   * v10.74：站方临时全免费（所有人、不限次数、不扣积分）。
   * 为 true 时上面的 freeUsed/freeLimit 只是历史口径，界面应显示「当前全部免费」。
   */
  freeForAll?: boolean
}

export interface AdminCreditUser {
  userId: string
  username: string
  role: string
  status: string
  granted: number
  used: number
  balance: number
  costCny: number
  chargedCny: number
  calls: number
  tokens: number
}

export interface AdminCreditsOverview {
  items: AdminCreditUser[]
  totals: {
    granted: number
    used: number
    balance: number
    costCny: number
    chargedCny: number
    calls: number
    tokens: number
  }
  /** 未登录（匿名）调用汇总，单独列出不混进用户账 */
  anon: { costCny: number; calls: number; tokens: number } | null
  markup: number
  cnyPerCredit: number
  priceTable: Record<'idle' | 'peak', { inMiss: number; inHit: number; out: number }>
  peakNow: boolean
}

/** 查自己的积分（余额 / 已消耗 / 明细）。仅本机模式会本地抛 unauthorized，不会广播登出。 */
export function fetchCredits(limit = 20) {
  return postWorkerData<CreditStatus>({ action: 'creditsStatus', limit }, 15_000, { requireAuth: true })
}

/** 管理员：全站每个用户的积分总览 */
export function fetchAdminCredits() {
  return postWorkerData<AdminCreditsOverview>({ action: 'adminCreditsOverview' }, 20_000, {
    requireAuth: true,
  })
}

/** 管理员：给用户发放（add）或校正（set）积分 */
export function grantCredits(input: {
  userId: string
  amount: number
  mode?: 'add' | 'set'
  note?: string
}) {
  return postWorkerData<CreditStatus>({ action: 'adminCreditsGrant', ...input }, 20_000, {
    requireAuth: true,
  })
}

/* ---- 让积分显示「用完 AI 就自动刷新」，不必手动点 ---- */
export const CREDITS_EVENT = 'ws:credits-changed'

export function notifyCreditsChanged() {
  try {
    window.dispatchEvent(new Event(CREDITS_EVENT))
  } catch {
    /* 隐私模式等环境忽略 */
  }
}

export function onCreditsChanged(fn: () => void) {
  window.addEventListener(CREDITS_EVENT, fn)
  return () => window.removeEventListener(CREDITS_EVENT, fn)
}

/** 积分 → 人民币串 */
export function creditsToCny(credits: number, cnyPerCredit = 0.001) {
  const v = credits * cnyPerCredit
  if (v === 0) return '¥0'
  if (v < 0.01) return `¥${v.toFixed(4)}`
  return `¥${v.toFixed(2)}`
}
