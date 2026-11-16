import { postWorkerData } from './api'
import type { BookMeta } from '../data/aiRecommendations'
import type { AppState, AssetKind, SavedBook } from '../types'

/* ============================================================
   管理员客户端 —— 对应 Worker 的管理类 action
   ------------------------------------------------------------
   这里所有函数都只是「调用方」；权限判定不在这层，也不在 UI 层。
   Worker 会用 D1 里的 users.role 再判一次，非管理员一律 403。

   换句话说：把「管理后台」按钮藏起来只是别让人看见入口，
   就算有人手搓一个 POST 打过来，也一样被服务端拦下。
   ============================================================ */

/* ---------------- 平台数据 ---------------- */

export interface PlatformSnap {
  corpus: {
    /** null = 墓碑，表示这本书被站主删掉了（用来盖住打包的默认语料） */
    books: Record<string, BookMeta | null>
    updatedAt: string | null
    updatedBy: string | null
  }
  settings: PlatformSettings
  settingsUpdatedAt: string | null
}

export interface PlatformSettings {
  allowRegister: boolean
  announcement: string
}

/** 读取平台数据：所有登录用户都能读（前端要用它叠加默认语料） */
export const platformGet = () =>
  postWorkerData<PlatformSnap>({ action: 'platformGet' }, 20_000, { requireAuth: true })

/* ---------------- 总览 ---------------- */

export interface AdminOverview {
  version: string
  users: number
  admins: number
  disabled: number
  liveSessions: number
  auditCount: number
  d1Tables: Record<string, number>
  kvKeys: number
  backupFiles: number
  corpusOverride: number
  corpusTombstones: number
  corpusUpdatedAt: string | null
  settings: PlatformSettings
  settingsUpdatedAt: string | null
  backupKeep: number
  r2Bound: boolean
}

export const adminOverview = () =>
  postWorkerData<AdminOverview>({ action: 'adminOverview' }, 30_000, { requireAuth: true })

/* ---------------- 账号治理 ---------------- */

export interface AdminUserRow {
  user_id: string
  username: string
  role: string
  status: string
  note: string
  create_at: string
  last_login_at: string | null
  update_at: string | null
  projects: number
  chapters: number
  live_sessions: number
}

export interface AdminUsersResult {
  items: AdminUserRow[]
  total: number
}

export const adminUserList = () =>
  postWorkerData<AdminUsersResult>({ action: 'adminUsers' }, 30_000, { requireAuth: true })

export const adminUserSetRole = (userId: string, role: 'user' | 'admin') =>
  postWorkerData<{ userId: string; username: string; role: string }>(
    { action: 'adminUserSetRole', userId, role },
    20_000,
    { requireAuth: true },
  )

export const adminUserSetStatus = (userId: string, status: 'active' | 'disabled') =>
  postWorkerData<{ userId: string; username: string; status: string; sessionsCleared: number }>(
    { action: 'adminUserSetStatus', userId, status },
    20_000,
    { requireAuth: true },
  )

export interface ResetPasswordResult {
  userId: string
  username: string
  /** 一次性明文密码，只在这条响应里出现；服务端仍然只存 hash */
  password: string
  sessionsCleared: number
}

export const adminUserResetPassword = (userId: string) =>
  postWorkerData<ResetPasswordResult>({ action: 'adminUserResetPassword', userId }, 30_000, {
    requireAuth: true,
  })

export interface AdminDeleteResult {
  deleted: boolean
  userId: string
  username: string
  kvDeleted: number
  d1Deleted: Record<string, number>
}

/** 删号不可逆，服务端要求 confirm=true 才执行 */
export const adminUserDelete = (userId: string) =>
  postWorkerData<AdminDeleteResult>({ action: 'adminUserDelete', userId, confirm: true }, 60_000, {
    requireAuth: true,
  })

/* ---------------- 平台语料 / 设置写入 ---------------- */

export interface CorpusSaveResult {
  total: number
  submitted: number
  tombstones: number
  updatedAt: string
  updatedBy: string
}

/** books 里传 null 表示删除这本书（写墓碑） */
export const adminCorpusSave = (
  books: Record<string, BookMeta | null>,
  mode: 'merge' | 'replace' = 'merge',
) =>
  postWorkerData<CorpusSaveResult>({ action: 'adminCorpusSave', books, mode }, 60_000, {
    requireAuth: true,
  })

export const adminSettingsSave = (settings: Partial<PlatformSettings>) =>
  postWorkerData<{ settings: PlatformSettings; updatedAt: string; updatedBy: string }>(
    { action: 'adminSettingsSave', settings },
    20_000,
    { requireAuth: true },
  )

/* ---------------- 全平台备份 ---------------- */

export interface AdminBackupItem {
  key: string
  stamp: string
  createdAt: string
  type: string
  size: number
  inline?: boolean
  uid: string
  /** 这份备份属于谁（用户名，或「全站」） */
  owner: string
}

export const adminBackupList = (limit = 60) =>
  postWorkerData<{ items: AdminBackupItem[]; r2Bound: boolean; keep: number }>(
    { action: 'adminBackupList', limit },
    45_000,
    { requireAuth: true },
  )

/** userId 传空字符串 = 全站全量备份 */
export const adminBackupRun = (userId = '') =>
  postWorkerData<{
    uid: string
    ok: boolean
    objectPath?: string
    size?: number
    stored?: string
    stamp?: string
    pruned?: number
    error?: string
  }>({ action: 'adminBackupRun', userId }, 120_000, { requireAuth: true })

export const adminBackupRestore = (userId: string, stamp: string) =>
  postWorkerData<{
    stamp: string
    createdAt?: string
    size?: number
    kvRestored: number
    stateFound: boolean
    sessionsCleared: number
  }>({ action: 'adminBackupRestore', userId, stamp }, 120_000, { requireAuth: true })

/* ---------------- 审计日志 ---------------- */

export interface AuditRow {
  id: number
  actor_id: string
  actor_name: string
  action: string
  target: string
  detail: string
  create_at: string
}

export const adminAuditList = (limit = 100) =>
  postWorkerData<{ items: AuditRow[] }>({ action: 'adminAuditList', limit }, 30_000, {
    requireAuth: true,
  })

/* ---------------- 用户创作数据读取（只读） ---------------- */

export interface UserContentOverview {
  userId: string
  username: string
  role: string
  status: string
  state: {
    exists: boolean
    sizeBytes: number
    updatedAt: string | null
    serverSavedAt: string | null
    canvasCount: number
    canvasChars: number
    libraryCount: number
    libraryWords: number
    chapterWritingWords: number
  }
  assets: { atoms: number; branches: number; snaps: number }
  d1: { projects: number; chapters: number; weightLogs: number; cases: number }
  lastBackup: { stamp: string; createdAt: string; size: number } | null
}

export interface UserStateResult {
  userId: string
  username: string
  state: AppState | null
}

export interface UserBookResult {
  userId: string
  username: string
  book: SavedBook
}

export interface UserAssetMeta {
  id: string
  name: string
  dimension: string | null
  updatedAt: string | null
}

export interface UserAssetsListResult {
  userId: string
  username: string
  atoms: UserAssetMeta[]
  branches: UserAssetMeta[]
  snaps: UserAssetMeta[]
}

export interface UserAssetResult {
  userId: string
  username: string
  kind: AssetKind
  id: string
  data: unknown
}

export const adminUserContentOverview = (userId: string) =>
  postWorkerData<UserContentOverview>({ action: 'adminUserContentOverview', userId }, 30_000, {
    requireAuth: true,
  })

export const adminUserStateGet = (userId: string) =>
  postWorkerData<UserStateResult>({ action: 'adminUserStateGet', userId }, 45_000, {
    requireAuth: true,
  })

export const adminUserBookGet = (userId: string, bookId: string) =>
  postWorkerData<UserBookResult>({ action: 'adminUserBookGet', userId, bookId }, 45_000, {
    requireAuth: true,
  })

export const adminUserAssetsList = (userId: string, kind?: AssetKind) =>
  postWorkerData<UserAssetsListResult>(
    { action: 'adminUserAssetsList', userId, kind },
    30_000,
    { requireAuth: true },
  )

export const adminUserAssetGet = (userId: string, kind: AssetKind, assetId: string) =>
  postWorkerData<UserAssetResult>(
    { action: 'adminUserAssetGet', userId, kind, assetId },
    30_000,
    { requireAuth: true },
  )

/* ---------------- 用存下的作品训练优化模型 ---------------- */

export interface TrainResult {
  trainedAt: string
  userCount: number
  bookCount: number
  caseCount: number
  styleTagDistribution: Record<string, number>
  globalWeights: Record<string, number>
}

export const adminTrainModel = () =>
  postWorkerData<TrainResult>({ action: 'adminTrainModel' }, 120_000, { requireAuth: true })
