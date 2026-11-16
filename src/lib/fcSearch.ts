/**
 * 变体A · 联网搜索对话客户端（前端）
 *
 * 红线（文档第 7 节）：
 *   · 前端只调中转层，**永远不碰** LLM Key / 搜索 Key
 *   · 前端不定义、不修改工具 schema（工具只存在于中转层）
 *   · 前端不直接调用搜索 API
 *
 * 走同源 /fc（functions/fc/[[path]].js 反代到 llm-bridge），
 * 这样浏览器只和 pages.dev 通信，不受 *.workers.dev 被屏蔽的影响。
 */

import { FC_BRIDGE_URL } from '../config'
import { getCurrentUser } from './session'

export interface FCMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface FCReply {
  /** 模型的最终回答 */
  content: string
  /** 本次真实发生的搜索次数（0 表示没搜） */
  searchCount: number
}

export class FCError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'FCError'
    this.status = status
  }
}

/** 会话 ID：同一会话内保持稳定，配额与失败缓存都按它计 */
const SESSION_KEY = 'writer-sim-fc-session-v1'

export function getFcSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    sessionStorage.setItem(SESSION_KEY, id)
    return id
  } catch {
    // 隐私模式等场景退化为内存态
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

/** 新开一轮对话时调用：重置会话 ID（配额按会话计，重置即重置配额） */
export function resetFcSession(): string {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* 忽略 */
  }
  return getFcSessionId()
}

export interface FCSearchOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** 覆盖默认会话 ID（一般不用） */
  sessionId?: string
}

/**
 * 发一条消息，允许模型申请联网搜索（是否执行由后端决定）。
 */
export async function fcChat(messages: FCMessage[], opts: FCSearchOptions = {}): Promise<FCReply> {
  if (!messages.length) throw new FCError('消息不能为空', 400)

  const userId = getCurrentUser()?.userId || 'local'
  const sessionId = opts.sessionId || getFcSessionId()
  const timeoutMs = opts.timeoutMs ?? 120_000

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const onAbort = () => ac.abort()
  opts.signal?.addEventListener('abort', onAbort)

  try {
    const resp = await fetch(FC_BRIDGE_URL.endsWith('/') ? FC_BRIDGE_URL : `${FC_BRIDGE_URL}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, messages }),
      signal: ac.signal,
    })

    const text = await resp.text()
    let data: { ok?: boolean; content?: string; searchCount?: number; error?: string }
    try {
      data = JSON.parse(text)
    } catch {
      throw new FCError(`中转层返回异常（HTTP ${resp.status}）`, resp.status)
    }

    if (!resp.ok || !data.ok) {
      throw new FCError(data.error || `请求失败（HTTP ${resp.status}）`, resp.status)
    }
    return { content: data.content || '', searchCount: Number(data.searchCount) || 0 }
  } catch (e) {
    if (e instanceof FCError) throw e
    if ((e as Error)?.name === 'AbortError') throw new FCError('已取消', 499)
    throw new FCError((e as Error)?.message || '网络错误', 0)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 检索型提问的便捷封装：明确要求"先查证再说，查不到就说查不到"。
 * 用于写作中「查一下这个细节是不是真的」这类场景。
 */
export async function fcAskWithSearch(question: string, history: FCMessage[] = [], opts: FCSearchOptions = {}): Promise<FCReply> {
  const messages: FCMessage[] = [
    ...history,
    {
      role: 'user',
      content: `${question}\n\n（要求：如果涉及事实、年份、人名、数据，请先联网查证；查不到就直说查不到，不要编造。）`,
    },
  ]
  return fcChat(messages, opts)
}

/* ============================================================
   分步生成（CoT）· 五阶段
   ------------------------------------------------------------
   ① 准备输入（题目/已知/限制/格式） → ② 分步计划 → ③ 按计划检索取证
   → ④ 起草 → ⑤ 自检 + 修正 → 只交最终内容
   计划、证据、自检结果都会回传，界面可以把"它怎么想的"折叠展示。
   ============================================================ */

export interface CoTPlan {
  subQuestions: string[]
  needsFacts: string[]
  outputFormat: string
  risks: string[]
}

export interface CoTVerification {
  passed: boolean
  issues: string[]
}

export interface CoTTrace {
  stage: string
  ms: number
  note: string
}

export interface CoTResult {
  content: string
  plan: CoTPlan
  verification: CoTVerification
  evidence: string
  searchCount: number
  trace: CoTTrace[]
}

export interface CoTRequest {
  task: string
  known?: string[]
  constraints?: string[]
  format?: string
}

export async function fcGenerateWithCoT(task: CoTRequest, opts: FCSearchOptions = {}): Promise<CoTResult> {
  const userId = getCurrentUser()?.userId || 'local'
  const sessionId = opts.sessionId || getFcSessionId()
  const timeoutMs = opts.timeoutMs ?? 180_000

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const onAbort = () => ac.abort()
  opts.signal?.addEventListener('abort', onAbort)

  try {
    const resp = await fetch(`${FC_BRIDGE_URL.replace(/\/$/, '')}/cot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...task, sessionId, userId }),
      signal: ac.signal,
    })
    const text = await resp.text()
    let data: Partial<CoTResult> & { ok?: boolean; error?: string }
    try {
      data = JSON.parse(text)
    } catch {
      throw new FCError(`生成服务返回异常（HTTP ${resp.status}）`, resp.status)
    }
    if (!resp.ok || !data.ok) throw new FCError(data.error || `生成失败（HTTP ${resp.status}）`, resp.status)

    return {
      content: data.content || '',
      plan: data.plan || { subQuestions: [], needsFacts: [], outputFormat: '', risks: [] },
      verification: data.verification || { passed: true, issues: [] },
      evidence: data.evidence || '',
      searchCount: Number(data.searchCount) || 0,
      trace: Array.isArray(data.trace) ? data.trace : [],
    }
  } catch (e) {
    if (e instanceof FCError) throw e
    if ((e as Error)?.name === 'AbortError') throw new FCError('已取消', 499)
    throw new FCError((e as Error)?.message || '网络错误', 0)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
