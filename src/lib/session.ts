/**
 * 登录态本地存储 —— 多用户模式的地基
 *
 * 会话 token 存在浏览器本地存储（键 writer-simulator-auth-v1），
 * 所有对 Worker 的请求由 lib/api.ts 自动带上 token，
 * 业务代码不需要关心鉴权细节。
 */

import type { UserRole } from '../types'

const AUTH_KEY = 'writer-simulator-auth-v1'
/** 用户主动选择「仅本机使用」时置位：跳过云端同步，但功能不残废 */
const LOCAL_ONLY_KEY = 'writer-simulator-local-only-v1'

export interface AuthUser {
  userId: string
  username: string
  /**
   * 角色。本地这份是「上次服务端告诉我的样子」，只用于渲染决策；
   * 每次启动都会用 authMe 覆盖它，所以服务端一改（提权/降权）前端立刻跟上。
   */
  role: UserRole
}

export interface AuthSession {
  token: string
  expiresAt: string
  user: AuthUser
}

/** 登录态失效时广播，UI 据此跳回登录页 */
export const UNAUTH_EVENT = 'writer-simulator-unauthorized'

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 本地存储写不进去不影响本次会话（内存里仍有） */
  }
}

let session: AuthSession | null = readJson<AuthSession>(AUTH_KEY)

/**
 * 老会话（v10 之前写入的）里没有 role 字段 —— 一律按普通用户处理。
 * 这里必须「缺省即最低权限」而不是「缺省即管理员」：越权判定不能靠猜。
 */
function normalizeUser(u: AuthUser | null | undefined): AuthUser | null {
  if (!u?.userId) return null
  return {
    userId: u.userId,
    username: u.username || '',
    role: u.role === 'admin' ? 'admin' : 'user',
  }
}

if (session) {
  const normalized = normalizeUser(session.user)
  if (normalized) session = { ...session, user: normalized }
  else session = null
}

/** 过期会话启动时直接丢弃，避免拿着死 token 反复 401 */
if (session && session.expiresAt && Date.parse(session.expiresAt) < Date.now()) {
  session = null
  try {
    localStorage.removeItem(AUTH_KEY)
  } catch {
    /* 清理失败无妨，内存里已置空 */
  }
}

export function getSession(): AuthSession | null {
  return session
}

export function getToken(): string {
  return session?.token || ''
}

export function getCurrentUser(): AuthUser | null {
  return normalizeUser(session?.user)
}

/** 角色工具：全站唯一判定入口，避免各处各写一遍字符串比较 */
export function isAdminUser(u: AuthUser | null | undefined): boolean {
  return u?.role === 'admin'
}

export function setSession(next: AuthSession) {
  session = next
  writeJson(AUTH_KEY, next)
}

export function clearSession() {
  session = null
  try {
    localStorage.removeItem(AUTH_KEY)
  } catch {
    /* 同上 */
  }
}

export function isLocalOnly(): boolean {
  return readJson<boolean>(LOCAL_ONLY_KEY) === true
}

export function setLocalOnly(on: boolean) {
  if (on) writeJson(LOCAL_ONLY_KEY, true)
  else {
    try {
      localStorage.removeItem(LOCAL_ONLY_KEY)
    } catch {
      /* 同上 */
    }
  }
}

export function notifyUnauthorized() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTH_EVENT))
  }
}
