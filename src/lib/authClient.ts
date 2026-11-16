import { postWorker } from './api'
import { clearSession, getCurrentUser, getSession, setSession, type AuthUser } from './session'
import type { UserRole } from '../types'

/**
 * 账号客户端 —— 对应 Worker 的 authRegister / authLogin / authMe / authLogout
 * 密码在浏览器侧从不落盘；本地只存 token + 用户名 + 过期时间。
 */

export interface AuthResult extends AuthUser {
  token: string
  expiresAt: string
}

/** 服务端下发的角色才是权威值；认不出来的角色一律降级成普通用户 */
function toRole(v: unknown): UserRole {
  return v === 'admin' ? 'admin' : 'user'
}

function persist(res: AuthResult): AuthUser {
  const user: AuthUser = { userId: res.userId, username: res.username, role: toRole(res.role) }
  setSession({ token: res.token, expiresAt: res.expiresAt, user })
  return user
}

export async function authRegister(username: string, password: string): Promise<AuthUser> {
  const res = await postWorker<AuthResult>({ action: 'authRegister', username, password }, 30_000)
  return persist(res.data as AuthResult)
}

export async function authLogin(username: string, password: string): Promise<AuthUser> {
  const res = await postWorker<AuthResult>({ action: 'authLogin', username, password }, 30_000)
  return persist(res.data as AuthResult)
}

/**
 * 校验本地 token 是否还有效；失效会抛 unauthorized。
 * 顺带把服务端最新的角色写回本地 —— 管理员在后台改了某人的角色后，
 * 那个人只要重新打开页面就会立刻生效，不需要等 token 过期。
 */
export async function authMe(): Promise<AuthUser> {
  const res = await postWorker<AuthUser>({ action: 'authMe' }, 15_000, { requireAuth: true })
  const me = res.data as AuthUser
  const user: AuthUser = { userId: me.userId, username: me.username, role: toRole(me.role) }
  const cur = getSession()
  if (cur) setSession({ ...cur, user })
  return user
}

/**
 * 修改密码：需要原密码。改完服务端会把其他设备上的登录态全部清掉，
 * 当前这台因为带的是同一条 token，不受影响。
 */
export async function authChangePassword(oldPassword: string, newPassword: string): Promise<void> {
  await postWorker(
    { action: 'authChangePassword', oldPassword, newPassword },
    30_000,
    { requireAuth: true },
  )
}

/** 退出登录：服务端删 session，本地清 token。失败也照样清本地，不能把用户卡住 */
export async function authLogout(): Promise<void> {
  try {
    // 5 秒就够：这只是通知服务端删一行 session；本地在此之前已经清干净了
    await postWorker({ action: 'authLogout' }, 5_000)
  } catch {
    /* 网络失败不阻塞退出：本地 token 已清，死 session 30 天后自然过期 */
  } finally {
    clearSession()
  }
}

export { getCurrentUser, getSession }
