import { postWorkerData } from './api'
import { sanitizeAppStateForSync } from './syncWhitelist'

export { sanitizeAppStateForSync }
import type { AppState, AssetBundle, AssetKind, AtomicSetting, SavedBook, StoryBranch, StorySnapshot } from '../types'
import type { BotState } from '../bot/types'
import { seedCanvases } from '../data/seed'
import { isLocalOnly } from './session'

/**
 * 云同步客户端 —— 对应 PRD《Cloudflare自动化部署版本》
 * 业务数据落在 Cloudflare KV（WRITER_KV，按 user:{uid}: 命名空间隔离），
 * 作品/章节索引进 D1（WRITER_D1，按 user_id 隔离），
 * 浏览器本地存储降级为「离线缓存」：断网照常用，联网后回写。
 *
 * 鉴权由 lib/api.ts 统一处理，这里不再自己拼 token。
 */

export type CloudStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'disabled' | 'guarded'

export interface CloudSaveResult {
  updatedAt: string
  serverSavedAt: string
  projects: number
  chapters: number
  /** v10.64：服务端最终落盘的作品库数量（守卫拦下清空时会是「保留后」的数量） */
  libraryCount?: number
  /** v10.64：本次回写想清空作品库、被服务端守卫拦下了 */
  libraryGuarded?: boolean
}
export interface CloudLoadResult {
  state: AppState | null
  updatedAt: string | null
  serverSavedAt: string | null
  /** 服务端把单用户时代的老存档交给了当前账号（一次性接管） */
  migrated?: boolean
}

/** v10.64：作品库独立储存库的读取结果 */
export interface CloudLibraryResult {
  library: SavedBook[] | null
  count: number
  savedAt: string | null
  /** 历史快照份数（服务端保留最近若干份，可人工恢复） */
  snapshotCount?: number
  /** assets=独立储存库；state-bootstrap=首次升级时从 state 引导；none=都没有 */
  source?: string
}

/**
 * 保存应用状态。
 * v10.64：`libraryCleared` 只有用户**显式点了「清空作品库」**时才传 true ——
 * 服务端据此决定是否允许把作品库写空（否则一律保留已知的非空版本）。
 * v10.65：出口过字段白名单（src/lib/syncWhitelist.ts，独立无依赖、可单测）——
 * 屏幕观察数据若不幸混进 state 也到不了云端。
 */
export const cloudSaveState = (state: AppState, opts: { libraryCleared?: boolean } = {}) =>
  postWorkerData<CloudSaveResult>(
    { action: 'stateSave', state: sanitizeAppStateForSync(state), libraryCleared: opts.libraryCleared === true },
    45_000,
    { requireAuth: true },
  )

export const cloudLoadState = () =>
  postWorkerData<CloudLoadResult>({ action: 'stateLoad' }, 20_000, { requireAuth: true })

/** v10.64：从「用户作品库独立储存库」读回作品库（只读，用于本地库为空时自愈） */
export const cloudLibraryLoad = () =>
  postWorkerData<CloudLibraryResult>({ action: 'libraryLoad' }, 20_000, { requireAuth: true })

export const cloudStorageStats = () =>
  postWorkerData<Record<string, unknown>>({ action: 'storageStats' }, 30_000, { requireAuth: true })

export const cloudBackupNow = (type: 'manual' | 'manual_snapshot' = 'manual_snapshot') =>
  postWorkerData<BackupRunResult>({ action: 'backupNow', type }, 90_000, { requireAuth: true })

/* ============================================================
   KV 多版本备份：历史列表 + 按份还原
   ============================================================ */

export interface BackupRunResult {
  objectPath: string
  size: number
  stored: string
  scope: string
  stamp: string
  /** 本次备份后裁掉了多少份旧备份 */
  pruned?: number
  counts?: Record<string, number | string>
}

export interface BackupItem {
  /** KV 键名，还原时可直接传 */
  key: string
  stamp: string
  type: string
  scope: string
  size: number
  stored: string
  objectPath: string
  createdAt: string
  /** 压缩体是否可用（超出 KV 内联上限时为 false，只能看到元信息） */
  hasData: boolean
  note?: string
  counts?: Record<string, number | string>
}

export interface BackupListResult {
  items: BackupItem[]
  /** 当前设置的保留份数 */
  keep: number
  r2Bound: boolean
}

export interface BackupRestoreResult {
  stamp: string
  createdAt: string
  size: number
  kvRestored: number
  stateFound: boolean
  index: { projects: number; chapters: number } | null
}

export const cloudBackupList = (limit = 30) =>
  postWorkerData<BackupListResult>({ action: 'backupList', limit }, 30_000, { requireAuth: true })

export const cloudBackupRestore = (stamp: string) =>
  postWorkerData<BackupRestoreResult>({ action: 'backupRestore', stamp }, 90_000, {
    requireAuth: true,
  })

/* ============================================================
   项目资产：原子设定 / 剧情分支 / 版本快照（KV 按用户隔离）
   ============================================================ */

export const cloudAssetsLoad = () =>
  postWorkerData<AssetBundle>({ action: 'assetLoad' }, 25_000, { requireAuth: true })

export const cloudAssetSave = <T extends AtomicSetting | StoryBranch | StorySnapshot>(
  kind: AssetKind,
  asset: T,
) =>
  postWorkerData<{ assetId: string; updatedAt: string }>(
    { action: 'assetSave', kind, assetId: asset.id, data: asset },
    25_000,
    { requireAuth: true },
  )

export const cloudAssetDelete = (kind: AssetKind, assetId: string) =>
  postWorkerData<{ deleted: boolean }>(
    { action: 'assetDelete', kind, assetId },
    25_000,
    { requireAuth: true },
  )

/** 仅本机使用模式：云端不可用时也要让资产功能可用 */
export const cloudAvailable = () => !isLocalOnly()

/* ============================================================
   状态净化
   ============================================================ */

/** 服务端回来的状态可能来自更早版本：补齐缺失字段，避免读档后崩溃。
 *  v10.63：`fallbackLibrary` —— 服务端**没有** library 字段（老版本存档 / 半截数据）时，
 *  不能当成「作品库是空的」来处理，用调用方的本地作品库兜底，避免读档即清库。 */
export function sanitizeRemoteState(
  remote: Partial<AppState> | null,
  fallbackLibrary?: SavedBook[],
): AppState | null {
  if (!remote || typeof remote !== 'object') return null
  const remoteCanvases = remote.canvases && typeof remote.canvases === 'object' ? remote.canvases : {}
  // 画布以 seed 为骨架，服务端有内容的覆盖上去
  const canvases: AppState['canvases'] = { ...seedCanvases }
  for (const [id, c] of Object.entries(remoteCanvases)) {
    const base = seedCanvases[id]
    if (!base) continue
    canvases[id] = {
      ...base,
      ...c,
      anchors: Array.isArray(c?.anchors) ? c.anchors : [],
      downstreams: Array.isArray(c?.downstreams) ? c.downstreams : [],
    }
  }
  return {
    canvases,
    selectedCanvasId:
      typeof remote.selectedCanvasId === 'string' && canvases[remote.selectedCanvasId]
        ? remote.selectedCanvasId
        : 'setting',
    mode: remote.mode === 'read' ? 'read' : 'admin',
    library: Array.isArray(remote.library)
      ? remote.library
      : Array.isArray(fallbackLibrary)
        ? fallbackLibrary
        : [],
    trash: Array.isArray(remote.trash) ? remote.trash : [],
    // 「研墨中」瞬态：旧云端存档没有该字段，恢复端兜底为空数组（且恢复时本就不该有写入中的画布）
    aiFillingCanvasIds: Array.isArray(remote.aiFillingCanvasIds) ? remote.aiFillingCanvasIds : [],
    lastMode: remote.lastMode ?? null,
    rememberMode: remote.rememberMode ?? false,
    collapseCanvases: remote.collapseCanvases ?? true,
    customStyleCards: Array.isArray(remote.customStyleCards) ? remote.customStyleCards : [],
    worldviews: Array.isArray(remote.worldviews) ? remote.worldviews : [],
    collections: Array.isArray(remote.collections) ? remote.collections : [],
    // v10.65：机器人人格 + 识海记忆必须跟着走（少了它，登录后机器人就失忆了）
    bot: sanitizeBot(remote.bot),
  }
}

/** v10.65：机器人状态的净化 —— 字段残缺就退到默认值，绝不让半个对象进内存把页面搞崩 */
export function sanitizeBot(raw: unknown): BotState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const b = raw as Partial<BotState>
  const persona =
    b.persona && typeof b.persona === 'object' && typeof b.persona.name === 'string' ? b.persona : null
  const memories = Array.isArray(b.memories)
    ? b.memories
        .filter(m => m && typeof m.content === 'string' && typeof m.createdAt === 'string')
        .slice(0, 400)
    : []
  return {
    persona: persona ?? null,
    memories,
    allowObservedToCloud: b.allowObservedToCloud !== false,
    chatCount: Number(b.chatCount) || 0,
  }
}

/** 资产包净化：过滤掉结构不完整的条目，避免 UI 崩 */
export function sanitizeAssets(raw: Partial<AssetBundle> | null): AssetBundle {
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    atoms: arr<AtomicSetting>(raw?.atoms).filter(a => a && typeof a.id === 'string'),
    branches: arr<StoryBranch>(raw?.branches).filter(b => b && typeof b.id === 'string'),
    snaps: arr<StorySnapshot>(raw?.snaps).filter(s => s && typeof s.id === 'string'),
  }
}

export const emptyAssets = (): AssetBundle => ({ atoms: [], branches: [], snaps: [] })
