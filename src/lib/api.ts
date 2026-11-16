import { WORKER_URL } from '../config'
import { clearSession, getToken, isLocalOnly, notifyUnauthorized } from './session'

/**
 * 统一 Worker 调用入口 —— 多用户模式下的鉴权收口点
 *
 * 职责：
 *  1. 自动带上会话 token（业务层无需关心）
 *  2. 把 HTTP 401 / code=unauthorized 统一翻译成 ApiError(code='unauthorized')，
 *     并清理本地会话 + 广播事件，让 UI 跳回登录页
 *  3. 统一超时与网络错误文案
 */

export type ApiErrorCode =
  | 'unauthorized'
  /** 已登录但权限不足（非管理员调管理接口） */
  | 'forbidden'
  /** 账号被管理员停用 */
  | 'disabled'
  | 'timeout'
  /** v10.59：用户主动终止（非超时） */
  | 'abort'
  | 'network'
  | 'badjson'
  | 'api'
  | 'offline_mode'

export class ApiError extends Error {
  code: ApiErrorCode
  status: number
  constructor(message: string, code: ApiErrorCode = 'api', status = 0) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export interface WorkerBody<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
  version?: string
  /** LLM 类 action 会回传是否真的触发了联网搜索 */
  searched?: boolean
  searchCount?: number
}

/**
 * POST 到 Worker。
 * @param payload 业务参数（不用自己塞 token）
 * @param timeoutMs 超时；LLM 类调用请传大值
 * @param opts.requireAuth 为 true 时，未登录直接抛错（不发请求）
 * @param opts.signal v10.59：外部中断信号（用户点「终止生成」）—— 触发后抛 ApiError('abort')
 */
export async function postWorker<T>(
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
  opts: { requireAuth?: boolean; signal?: AbortSignal } = {},
): Promise<WorkerBody<T>> {
  const token = getToken()
  if (opts.requireAuth && !token) {
    throw new ApiError(
      isLocalOnly() ? '当前是「仅本机使用」模式，云端功能不可用' : '尚未登录',
      'unauthorized',
    )
  }
  const body = token ? { ...payload, token } : { ...payload }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  // v10.59：外部信号（用户终止）也汇到同一个 ctrl 上
  const onOuterAbort = () => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', onOuterAbort)
  }
  let resp: Response
  try {
    resp = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      if (opts.signal?.aborted) {
        throw new ApiError('已终止生成', 'abort')
      }
      throw new ApiError(`请求超时（>${Math.round(timeoutMs / 1000)}s）`, 'timeout')
    }
    throw new ApiError(
      `无法连接 Cloudflare：${e instanceof Error ? e.message : String(e)}。检查网络后重试`,
      'network',
    )
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }

  let parsed: WorkerBody<T>
  try {
    parsed = (await resp.json()) as WorkerBody<T>
  } catch {
    throw new ApiError(`Worker 返回非 JSON（HTTP ${resp.status}）`, 'badjson', resp.status)
  }

  if (resp.status === 401 || parsed.code === 'unauthorized') {
    clearSession()
    notifyUnauthorized()
    throw new ApiError(parsed.error || '登录已过期，请重新登录', 'unauthorized', 401)
  }
  /**
   * 403：登录是好的，只是权限不够（非管理员调管理接口）或账号被停用。
   * 刻意不清 token、不广播未登录事件 —— 那会把人踢回登录页，
   * 而他的登录本身没问题，踢回去只会让人以为是掉线了。
   */
  if (resp.status === 403 || parsed.code === 'forbidden' || parsed.code === 'disabled') {
    const code: ApiErrorCode = parsed.code === 'disabled' ? 'disabled' : 'forbidden'
    throw new ApiError(parsed.error || '没有权限执行这个操作', code, 403)
  }
  if (!parsed.ok) {
    throw new ApiError(parsed.error || 'Worker 返回 ok:false', 'api', resp.status)
  }
  return parsed
}

/** 只要 data 的简化版本 */
export async function postWorkerData<T>(
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
  opts: { requireAuth?: boolean } = {},
): Promise<T> {
  const body = await postWorker<T>(payload, timeoutMs, opts)
  return body.data as T
}
