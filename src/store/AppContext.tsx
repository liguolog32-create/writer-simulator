import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  Action,
  AppState,
  AssetBundle,
  AssetKind,
  AtomicSetting,
  Canvas,
  ChapterWriting,
  EntryMode,
  ReferenceAnchor,
  SavedBook,
  SnapshotCanvas,
  StoryBranch,
  StorySnapshot,
  WorkCollection,
  Worldview,
} from '../types'
import type { StyleCard } from '../data/styleCards'
import { seedCanvases, blankCanvases } from '../data/seed'
import {
  cloudAssetDelete,
  cloudAssetSave,
  cloudAssetsLoad,
  cloudBackupList,
  cloudBackupNow,
  cloudBackupRestore,
  cloudLibraryLoad,
  cloudLoadState,
  cloudSaveState,
  emptyAssets,
  sanitizeAssets,
  sanitizeRemoteState,
  type BackupListResult,
  type CloudStatus,
} from '../lib/cloudSync'
import {
  authChangePassword,
  authLogin,
  authLogout,
  authMe,
  authRegister,
} from '../lib/authClient'
import {
  UNAUTH_EVENT,
  clearSession,
  getCurrentUser,
  isAdminUser,
  isLocalOnly,
  setLocalOnly as persistLocalOnly,
  type AuthUser,
} from '../lib/session'
import { platformGet, type PlatformSettings } from '../lib/adminClient'
import { detectConflicts, type ConflictPair } from '../lib/llmClient'
import { setCorpusOverlay } from '../data/aiRecommendations'

const STORAGE_KEY = 'writer-simulator-state-v1'
/** 单用户时代的老本地存档键，仅用于一次性接管升级 */
const LEGACY_STORAGE_KEY = 'writer-simulator-state-v1'
/** 云同步元信息（最近更新时间 / 是否启用）—— 与业务状态分开存，避免污染 AppState 结构 */
const SYNC_META_KEY = 'writer-simulator-sync-meta-v1'
/** 本地状态按用户分开存，避免同一台电脑切换账号时串数据 */
const stateKeyFor = (uid: string | null) =>
  uid ? `${STORAGE_KEY}::${uid}` : `${STORAGE_KEY}::local`
const assetsKeyFor = (uid: string | null) =>
  `writer-simulator-assets-v1::${uid || 'local'}`
/** 同步元信息同样按用户分开，否则 A 的云端时间戳会挡住 B 的拉取 */
const syncMetaKeyFor = (uid: string | null) => `${SYNC_META_KEY}::${uid || 'local'}`

interface SyncMeta {
  updatedAt?: string
  /** v10.61：本地最后一次「编辑」时间（每次持久化 localStorage 时记录）。拉云端时用它判断本地是否比云端新 ——
   *  以前只记 updatedAt（=上次推送成功时间），编辑后没等 1.5s 防抖推送就关页，本地新稿会被云端旧稿静默覆盖（用户丢过 30 万字篇幅设定）。 */
  localUpdatedAt?: string
  cloudEnabled?: boolean
}
function readSyncMeta(uid: string | null): SyncMeta {
  try {
    return JSON.parse(localStorage.getItem(syncMetaKeyFor(uid)) || '{}') as SyncMeta
  } catch {
    return {}
  }
}
function writeSyncMeta(uid: string | null, meta: SyncMeta) {
  try {
    // v10.61：合并写入，别把已有的 localUpdatedAt / cloudEnabled 抹掉
    const next = { ...readSyncMeta(uid), ...meta }
    localStorage.setItem(syncMetaKeyFor(uid), JSON.stringify(next))
  } catch {
    /* 本地元信息写不进去不影响主流程 */
  }
}

/** v10.53：旧书（v10.50 之前保存、无 canvases 字段）导入时用书自身元数据合成画布。
 *  v10.52 曾把缺失画布全部留空 —— 用户导入旧书后 7 块全「还没填」（0/7 已填），
 *  写作页侧栏和画布页一片空白；v10.51 之前又曾回落演示种子造成「祖器」串书。
 *  正确做法：能从书里推出来的维度就填上 ——
 *  设定←synopsis、文笔←风格标签、结构←大纲章节、情节←各章大纲、篇幅←字数统计；
 *  人物/节奏书中没有独立数据，留空白（显示「还没填」，用户可自己填或 AI 检索）。 */
function deriveCanvasesFromBook(book: SavedBook): Record<string, Canvas> {
  const chapters = book.outline ?? []
  const stats = book.stats
  const structureText = chapters.length
    ? `共 ${stats?.volumes || 1} 卷 ${stats?.chapters || chapters.length} 章。\n` +
      chapters
        .slice(0, 12)
        .map(ch => `- 第${ch.index}章 ${ch.title}${ch.summary ? `：${ch.summary}` : ''}`)
        .join('\n')
    : ''
  const plotText = chapters.length
    ? chapters
        .slice(0, 8)
        .map(ch => `第${ch.index}章 ${ch.title}：${ch.summary || '（暂无大纲）'}`)
        .join('\n')
    : ''
  const total = stats?.totalWords || 0
  const per = chapters.length ? Math.round(total / chapters.length) : 0
  const lengthText = total
    ? `总计约 ${total} 字，共 ${stats?.chapters || chapters.length} 章${per ? `，单章约 ${per} 字` : ''}。`
    : ''
  return {
    setting: { ...blankCanvases.setting, content: book.synopsis || '', anchors: [] },
    style: {
      ...blankCanvases.style,
      content: stats?.styleLabel ? `风格标签：${stats.styleLabel}` : '',
      anchors: [],
    },
    structure: { ...blankCanvases.structure, content: structureText, anchors: [] },
    length: { ...blankCanvases.length, content: lengthText, anchors: [] },
    plot: { ...blankCanvases.plot, content: plotText, anchors: [] },
    character: { ...blankCanvases.character, anchors: [] },
    rhythm: { ...blankCanvases.rhythm, anchors: [] },
  }
}

/** v10.54：书的 canvases 字段「坏数据」修复。
 *  ① v10.52 窗口期导入旧书时画布被留成全空白，若用户此时保存过书，
 *     空白画布就被 SAVE_BOOK 嵌进了书里（book.canvases 存在但内容全空）；
 *  ② v10.51 窗口期导入时画布回落演示种子，若保存过，「祖器」demo 内容也被存进了书里。
 *  这两种情况 book.canvases 都存在，importBook 里的 `??` 永远不会触发 derive 兜底。
 *  逐维度校验：书里存的内容为空白、或与演示种子逐字相同（demo 污染指纹）时，
 *  回落到 deriveCanvasesFromBook 从书元数据合成的内容；有效内容原样保留（含锚点）。 */
function repairBookCanvases(book: SavedBook): Record<string, Canvas> {
  const derived = deriveCanvasesFromBook(book)
  const saved = book.canvases
  if (!saved) return derived
  const demoTexts = new Set(Object.values(seedCanvases).map(s => s.content))
  const merged: Record<string, Canvas> = {}
  for (const [key, der] of Object.entries(derived)) {
    const sc = saved[key]
    const text = (sc?.content || '').trim()
    if (sc && text && !demoTexts.has(sc.content)) {
      // 书里存的内容有效且非 demo —— 原样保留
      merged[key] = sc
    } else {
      // 空白或 demo 污染 —— 用书元数据合成的内容兜底，锚点仍取书里存的
      merged[key] = { ...der, anchors: sc?.anchors ?? [] }
    }
  }
  // 书里有、derive 没覆盖到的维度（异常数据），有内容就保留
  for (const [key, sc] of Object.entries(saved)) {
    if (!merged[key] && (sc.content || '').trim()) merged[key] = sc
  }
  return merged
}

const initialState: AppState = {
  canvases: seedCanvases,
  selectedCanvasId: 'setting',
  mode: 'admin',
  library: [],
  lastMode: null,
  // PRD「支持始终默认上次打开模式记忆开关」——默认关闭，先让用户看到分流页
  rememberMode: false,
  // PRD 功能5：高级工作台画布默认折叠，解决新手信息过载
  collapseCanvases: true,
  customStyleCards: [],
  worldviews: [],
  collections: [],
  linkedBookId: null,
  // 「研墨中」瞬态：正在被 AI 写入的画布 id 集合（不参与快照 / 云同步语义，恢复端兜底）
  aiFillingCanvasIds: [],
}

/** 记下老存档被哪个账号接管，避免同机第二个账号又继承一遍 */
const LEGACY_OWNER_KEY = 'writer-simulator-legacy-owner-v1'

function legacyOwner(): string {
  try {
    return localStorage.getItem(LEGACY_OWNER_KEY) || ''
  } catch {
    return ''
  }
}
function claimLegacy(claimKey: string) {
  try {
    localStorage.setItem(LEGACY_OWNER_KEY, claimKey)
  } catch {
    /* 写不进去就退化成允许重复读，不影响主流程 */
  }
}

/** v10.62：会话启动时画布工作区一律重置为默认态。
 *  用户约定：画布内容属于「本次会话选中的文本」—— 登录/打开网页后还没选择作品时，
 *  7 块画布必须是空白默认态，绝不能带着上一次会话（或另一台设备）的旧内容
 *  （用户截图反馈：登录后还没选文本，画布就带着上一本书的设定/字数分配）。
 *  书的画布仍完整保存在 book.canvases 里，选中导入时经 IMPORT_BOOK 整体载入，数据不丢。
 *  只在「会话启动」路径调用（本地读档 / 切账号 / 云端拉取）；
 *  「还原备份」是显式恢复动作，不走这里（否则备份里的画布被清掉，失去还原意义）。 */
function resetWorkspace(state: AppState): AppState {
  return {
    ...state,
    canvases: blankCanvases,
    linkedBookId: null,
    selectedCanvasId: 'setting',
  }
}

/** 旧版 localStorage 没有 library 字段，必须补默认值，否则读档后 library 为 undefined 会崩 */
function hydrateState(init: AppState, storageKey: string, claimKey: string): AppState {
  const read = (key: string): Partial<AppState> | null => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as Partial<AppState>) : null
    } catch (e) {
      console.warn('hydrate failed', e)
      return null
    }
  }
  let saved = read(storageKey)
  // 本账号还没有存档 → 一次性接管单用户时代的老存档（已被别的账号接管就不再读）
  if (!saved) {
    const owner = legacyOwner()
    if (!owner || owner === claimKey) {
      const legacy = read(LEGACY_STORAGE_KEY)
      if (legacy) {
        saved = legacy
        claimLegacy(claimKey)
        console.info('[本地存储] 已接管单用户时代的本地存档')
      }
    }
  }
  if (saved) {
    // v10.62：本地读档属于会话启动，画布工作区重置为默认（还没选文本 → 7 块全空白）
    return resetWorkspace({
      ...init,
      ...saved,
      library: Array.isArray(saved.library) ? saved.library : [],
      lastMode: saved.lastMode ?? null,
      rememberMode: saved.rememberMode ?? false,
      collapseCanvases: saved.collapseCanvases ?? true,
      customStyleCards: Array.isArray(saved.customStyleCards) ? saved.customStyleCards : [],
      // 「研墨中」瞬态：旧 localStorage 存档可能没有该字段（整棵序列化自动带上的字段也可能坏），
      // 恢复端兜底为空数组 —— 会话启动时本来就不该有「正在写入」的画布
      aiFillingCanvasIds: Array.isArray(saved.aiFillingCanvasIds) ? saved.aiFillingCanvasIds : [],
    })
  }
  // v10.62：全新用户也别看到演示种子画布（seedCanvases 含「祖器」demo），直接给空白默认态
  return resetWorkspace(init)
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SELECT_CANVAS':
      return { ...state, selectedCanvasId: action.id }
    case 'UPDATE_CONTENT':
      return {
        ...state,
        canvases: {
          ...state.canvases,
          [action.id]: { ...state.canvases[action.id], content: action.content },
        },
      }
    case 'ADD_DOWNSTREAM': {
      const c = state.canvases[action.from]
      if (!c || c.downstreams.includes(action.to)) return state
      return {
        ...state,
        canvases: {
          ...state.canvases,
          [action.from]: { ...c, downstreams: [...c.downstreams, action.to] },
        },
      }
    }
    case 'REMOVE_DOWNSTREAM': {
      const c = state.canvases[action.from]
      if (!c) return state
      return {
        ...state,
        canvases: {
          ...state.canvases,
          [action.from]: { ...c, downstreams: c.downstreams.filter(d => d !== action.to) },
        },
      }
    }
    case 'ADD_ANCHOR': {
      const c = state.canvases[action.canvasId]
      if (!c) return state
      return {
        ...state,
        canvases: {
          ...state.canvases,
          [action.canvasId]: { ...c, anchors: [...c.anchors, action.anchor] },
        },
      }
    }
    case 'UPDATE_ANCHOR': {
      const c = state.canvases[action.canvasId]
      if (!c) return state
      return {
        ...state,
        canvases: {
          ...state.canvases,
          [action.canvasId]: {
            ...c,
            anchors: c.anchors.map(a => (a.id === action.anchor.id ? action.anchor : a)),
          },
        },
      }
    }
    case 'REMOVE_ANCHOR': {
      const c = state.canvases[action.canvasId]
      if (!c) return state
      return {
        ...state,
        canvases: {
          ...state.canvases,
          [action.canvasId]: { ...c, anchors: c.anchors.filter(a => a.id !== action.anchorId) },
        },
      }
    }
    case 'SET_MODE':
      return { ...state, mode: action.mode }
    case 'BULK_UPDATE_CONTENT': {
      // 脑洞模式一键导入 / 分支激活：把内容一次性写回（跳过锁定画布）
      const next = { ...state.canvases }
      let changed = false
      for (const [id, content] of Object.entries(action.patch)) {
        const c = next[id]
        if (!c || c.locked) continue
        next[id] = { ...c, content }
        changed = true
      }
      return changed ? { ...state, canvases: next } : state
    }
    case 'TOGGLE_CANVAS_LOCK': {
      const c = state.canvases[action.id]
      if (!c) return state
      return {
        ...state,
        canvases: { ...state.canvases, [action.id]: { ...c, locked: !c.locked } },
      }
    }
    case 'SET_CANVAS_LOCK': {
      const c = state.canvases[action.id]
      if (!c) return state
      return {
        ...state,
        canvases: { ...state.canvases, [action.id]: { ...c, locked: action.locked } },
      }
    }
    case 'APPLY_SNAPSHOT': {
      // 快照回滚：只覆盖快照里有的画布，作品库与偏好保持不动
      const next = { ...state.canvases }
      let touched = 0
      for (const [id, sc] of Object.entries(action.canvases)) {
        const base = next[id]
        if (!base) continue
        next[id] = { ...base, content: sc.content, locked: sc.locked ?? base.locked }
        touched += 1
      }
      return touched ? { ...state, canvases: next } : state
    }
    case 'SET_LAST_MODE':
      return { ...state, lastMode: action.mode }
    case 'SET_REMEMBER_MODE':
      return { ...state, rememberMode: action.remember }
    case 'SET_COLLAPSE_CANVASES':
      return { ...state, collapseCanvases: action.collapse }
    case 'RESET_TO_SEED':
      // 重置只清画布示例数据，保留用户辛苦生成的作品库与模式偏好
      return {
        ...initialState,
        mode: state.mode,
        library: state.library,
        lastMode: state.lastMode,
        rememberMode: state.rememberMode,
        collapseCanvases: state.collapseCanvases,
        // 用户自己做的文风卡是资产，重置画布不该连带删掉
        customStyleCards: state.customStyleCards,
      }
    case 'ADD_STYLE_CARD': {
      const list = state.customStyleCards ?? []
      const rest = list.filter(c => c.id !== action.card.id)
      return { ...state, customStyleCards: [action.card, ...rest].slice(0, 200) }
    }
    case 'REMOVE_STYLE_CARD': {
      const list = state.customStyleCards ?? []
      return { ...state, customStyleCards: list.filter(c => c.id !== action.id) }
    }
    case 'SAVE_BOOK': {
      // 新的排最前，并限制总量避免撑爆 localStorage（约 5MB 上限）
      const MAX = 60
      return { ...state, library: [action.book, ...state.library].slice(0, MAX) }
    }
    case 'IMPORT_BOOK': {
      // v10.51 修复串书：导入必须以种子为底座「整体替换」工作区画布，
      // 而不是 {...state.canvases, ...action.canvases} 合并 —— 合并会让上一本导入的书残留在工作区，
      // 导致这本蒸汽朋克书的「结构」里出现别本书的「祖器」之类设定。
      // 书里有几块就用几块，缺失的维度回落到【空白画布】（content 为空），
      // 绝不退回 seedCanvases 演示种子（含「祖器」仙侠 demo），也绝不保留上一本书的内容。
      // v10.52：原为 { ...seedCanvases, ...action.canvases }，会漏进 demo 设定造成串书污染。
      const merged = { ...blankCanvases, ...action.canvases }
      return {
        ...state,
        canvases: merged,
        linkedBookId: action.bookId,
        selectedCanvasId: state.selectedCanvasId ?? Object.keys(merged)[0] ?? null,
      }
    }
    case 'UNLINK_BOOK':
      // 只取消关联，保留当前画布内容（不回滚）
      return { ...state, linkedBookId: null }
    case 'SET_BOT':
      // v10.65：机器人人格 + 识海记忆。衰减/巩固等逻辑在 src/bot/memory.ts 里算好再进来，
      // 这里只负责存进 AppState（跟着账号走，跨设备一致）。
      return { ...state, bot: action.bot }
    case 'REMOVE_BOOK': {
      // v10.43 DEL-01：软删除 —— 不直接从 library 抹掉，先丢进回收站（30 天可恢复）
      const gone = state.library.find(b => b.id === action.bookId)
      const trash = state.trash ?? []
      return {
        ...state,
        library: state.library.filter(b => b.id !== action.bookId),
        trash: gone
          ? [{ ...gone, deletedAt: new Date().toISOString(), deletedBy: 'author' as const }, ...trash]
          : trash,
      }
    }
    case 'RESTORE_BOOK': {
      const back = (state.trash ?? []).find(b => b.id === action.bookId)
      if (!back) return state
      const { deletedAt: _d, deletedBy: _b, deleteReason: _r, ...book } = back
      return {
        ...state,
        library: [book as SavedBook, ...state.library],
        trash: (state.trash ?? []).filter(b => b.id !== action.bookId),
      }
    }
    case 'PURGE_BOOK':
      return { ...state, trash: (state.trash ?? []).filter(b => b.id !== action.bookId) }
    case 'SAVE_WORLDVIEW': {
      // v10.32 世界观：整份 upsert（按 id），新的排最前
      const wvNow = new Date().toISOString()
      const wv = { ...action.wv, updatedAt: wvNow }
      return {
        ...state,
        worldviews: state.worldviews.some(x => x.id === wv.id)
          ? state.worldviews.map(x => (x.id === wv.id ? wv : x))
          : [wv, ...state.worldviews],
      }
    }
    case 'DELETE_WORLDVIEW':
      return { ...state, worldviews: state.worldviews.filter(x => x.id !== action.id) }
    case 'SAVE_COLLECTION': {
      const colNow = new Date().toISOString()
      const col = { ...action.col, updatedAt: colNow }
      return {
        ...state,
        collections: state.collections.some(x => x.id === col.id)
          ? state.collections.map(x => (x.id === col.id ? col : x))
          : [col, ...state.collections],
      }
    }
    case 'DELETE_COLLECTION':
      return { ...state, collections: state.collections.filter(x => x.id !== action.id) }
    case 'UPDATE_BOOK_OUTLINE': {
      // v10.27/10.28 章节增删：整份替换章纲（+ 可选整份替换正文）。
      // 中间插入/删除会让后面章节重编号，正文也跟着搬 —— 重排逻辑由调用方算好，
      // reducer 只做替换，避免两处各算一遍导致对不上。
      const now = new Date().toLocaleString('zh-CN')
      return {
        ...state,
        library: state.library.map(b => {
          if (b.id !== action.bookId) return b
          return {
            ...b,
            outline: action.outline,
            ...(action.chapterWritings ? { chapterWritings: action.chapterWritings } : {}),
            updatedAt: now,
          }
        }),
      }
    }
    case 'CLEAR_LIBRARY':
      return { ...state, library: [] }
    case 'UPDATE_CHAPTER': {
      const now = new Date().toLocaleString('zh-CN')
      return {
        ...state,
        library: state.library.map(b =>
          b.id === action.bookId
            ? {
                ...b,
                chapterWritings: { ...(b.chapterWritings ?? {}), [action.chapterIndex]: action.writing },
                // 同步刷新书的最后更新时间，资产库会立刻看到
                updatedAt: now,
              }
            : b,
        ),
      }
    }
    case 'HYDRATE':
      // 整体替换 state 的唯一入口（云端拉取 / 备份还原 / 切账号都汇到这里）。
      // 旧快照 / 旧云端数据没有 aiFillingCanvasIds 字段 —— 兜底成空数组，防 undefined.includes 崩溃。
      return {
        ...action.state,
        aiFillingCanvasIds: Array.isArray(action.state.aiFillingCanvasIds)
          ? action.state.aiFillingCanvasIds
          : [],
      }
    case 'AI_APPEND_ANCHORS': {
      const c = state.canvases[action.canvasId]
      if (!c) return state
      return {
        ...state,
        canvases: {
          ...state.canvases,
          [action.canvasId]: { ...c, anchors: [...c.anchors, ...action.anchors] },
        },
      }
    }
    case 'AI_FILLING': {
      // 「研墨中」瞬态信号：on 去重追加 / off 过滤移除，其余 state 原样保留。
      // 只影响 CanvasRail 的卡片渲染，不触碰画布内容与任何持久化数据。
      const cur = Array.isArray(state.aiFillingCanvasIds) ? state.aiFillingCanvasIds : []
      const next = action.on
        ? cur.includes(action.id)
          ? cur
          : [...cur, action.id]
        : cur.filter(id => id !== action.id)
      if (next === cur) return state
      return { ...state, aiFillingCanvasIds: next }
    }
    default:
      return state
  }
}

interface ContextValue {
  state: AppState
  dispatch: React.Dispatch<Action>
  /** 「研墨中」：正在被 AI 写入的画布 id 集合（瞬态，CanvasRail 渲染用） */
  aiFillingCanvasIds: string[]
  selectedCanvas: Canvas | null
  listCanvases: () => Canvas[]
  listDownstreamTargets: (fromId: string) => Canvas[]
  addAnchor: (canvasId: string, source: string, features: string, examples: string) => void
  updateAnchor: (canvasId: string, anchor: ReferenceAnchor) => void
  removeAnchor: (canvasId: string, anchorId: string) => void
  aiAppendAnchors: (canvasId: string, anchors: ReferenceAnchor[]) => void
  reset: () => void
  saveBook: (book: SavedBook) => void
  /** v10.50：从资产库导入某本书到画布页（载入其画布 + 标记关联书） */
  importBook: (bookId: string) => void
  /** v10.50：取消画布页与作品的关联（保留画布内容） */
  unlinkBook: () => void
  /** v10.27/10.28 章节增删：整份替换某本书的章纲；中间插删时正文也要一起传（已重排） */
  updateBookOutline: (
    bookId: string,
    outline: SavedBook['outline'],
    chapterWritings?: SavedBook['chapterWritings'],
  ) => void
  removeBook: (bookId: string) => void
  clearLibrary: () => void
  updateChapter: (bookId: string, chapterIndex: number, writing: ChapterWriting) => void
  /** 脑洞模式一键导入：批量写回多块画布（自动跳过锁定画布） */
  /**
   * v10.31 多块画布批量写入。reason 非空时，会在写入前自动存一份画布版本
   * （AI 覆盖画布是唯一会「静默毁掉设定」的操作，所以这条路上必须留回滚点）。
   */
  bulkUpdateContent: (patch: Record<string, string>, reason?: string) => void
  /** v10.32 世界观 */
  /** v10.43 DEL-01 回收站 */
  restoreBook: (bookId: string) => void
  purgeBook: (bookId: string) => void
  saveWorldview: (wv: Worldview) => void
  deleteWorldview: (id: string) => void
  saveCollection: (col: WorkCollection) => void
  deleteCollection: (id: string) => void
  /** v10.31 手动/自动存一个画布版本；force=true 时跳过「一分钟合并」 */
  autoSnapshot: (reason: string, force?: boolean) => void
  toggleCanvasLock: (id: string) => void
  setCanvasLock: (id: string, locked: boolean) => void
  setLastMode: (mode: EntryMode) => void
  setRememberMode: (remember: boolean) => void
  setCollapseCanvases: (collapse: boolean) => void
  /** 保存（或覆盖同 id）一张自定义文风卡 */
  saveStyleCard: (card: StyleCard) => void
  removeStyleCard: (id: string) => void
  /** 当前被锁定的画布维度列表（喂给 AI，要求绝不改动） */
  lockedDimensions: () => string[]

  /* ---- 账号（多用户模式）---- */
  user: AuthUser | null
  /** 登录/注册请求进行中 */
  authBusy: boolean
  signIn: (username: string, password: string) => Promise<void>
  signUp: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** 修改密码（需原密码）；成功后其他设备的登录态会被服务端清掉 */
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>
  /** 「仅本机使用」模式：跳过云端，只用浏览器本地存储 */
  localOnly: boolean
  setLocalOnlyMode: (on: boolean) => void

  /* ---- 权限与平台数据（v10：角色由服务端下发）---- */
  /**
   * 当前账号是否管理员。
   * ⚠️ 只用于「要不要渲染管理入口」这类展示决策；
   * 真正的权限门禁在 Worker（requireAdmin），前端说什么都不算数。
   */
  isAdmin: boolean
  /**
   * 能否编辑画布。
   * v10 之前这是「只读访客 / 管理后台」两个前端 Tab 控制的 —— 谁都能点一下
   * 把自己变成"管理员"，等于没有权限。现在登录后改的都是自己名下的数据，
   * 一律可写；这个字段留作将来「只读分享链接」的挂点。
   */
  canEdit: boolean
  /** 平台设置（注册开关 / 公告），登录后拉取；未登录或拉取失败为 null */
  platformSettings: PlatformSettings | null
  /** 重新拉平台数据（管理后台保存后调用，让覆盖层立刻生效） */
  reloadPlatform: () => Promise<void>

  /* ---- 云同步状态 ---- */
  cloudStatus: CloudStatus
  cloudSavedAt: string | null
  cloudEnabled: boolean
  setCloudEnabled: (on: boolean) => void
  syncNow: () => Promise<void>
  backupNow: () => Promise<string>
  /** 备份历史（KV 多版本，只含元信息） */
  listBackups: (limit?: number) => Promise<BackupListResult>
  /** 按份还原备份；返回可直接展示的结果文案 */
  restoreBackup: (stamp: string) => Promise<string>

  /* ---- 项目资产：原子设定 / 剧情分支 / 版本快照 ---- */
  assets: AssetBundle
  assetsLoading: boolean
  assetsError: string
  reloadAssets: () => Promise<void>
  /** 新建或更新一条资产（自动打点 updatedAt） */
  saveAsset: (
    kind: AssetKind,
    asset: AtomicSetting | StoryBranch | StorySnapshot,
  ) => Promise<void>
  deleteAsset: (kind: AssetKind, id: string) => Promise<void>
  /** 把快照回滚到画布（只动画布，不动作品库） */
  restoreSnapshot: (id: string) => string
  /** 把分支的 canvasPatch 写回画布（跳过锁定画布） */
  applyBranch: (id: string) => string

  /* ---- v10.57 画布间冲突检测 ---- */
  /** 当前检测到的冲突对（a/b 为画布 id，reason 为用户可见说明） */
  conflicts: ConflictPair[]
  /** 冲突检测进行中（UI 可显示「检测中…」） */
  conflictBusy: boolean
  /** 防抖触发一次冲突检测（编辑画布内容后调用） */
  scheduleConflictCheck: () => void
  /** 立即触发一次冲突检测（AI 写回画布后调用） */
  runConflictCheck: () => void
  /** 清空冲突标记（切换作品 / 重置时调用） */
  clearConflicts: () => void
}

const AppContext = createContext<ContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  // ===== 账号态 =====
  const [user, setUser] = useState<AuthUser | null>(() => getCurrentUser())
  const [localOnly, setLocalOnlyState] = useState<boolean>(() => isLocalOnly())
  const [authBusy, setAuthBusy] = useState(false)

  // 本地状态按用户隔离：账号切换时用不同 key，避免同一台电脑串数据
  const activeUid = user?.userId ?? null
  const storageKey = stateKeyFor(activeUid)

  const [state, dispatch] = useReducer(reducer, { ...initialState }, init =>
    hydrateState(init, storageKey, activeUid ?? 'local'),
  )

  const [cloudStatus, setCloudStatus] = useState<CloudStatus>('idle')
  const [cloudSavedAt, setCloudSavedAt] = useState<string | null>(null)
  const [cloudEnabled, setCloudEnabledState] = useState<boolean>(
    () => readSyncMeta(activeUid).cloudEnabled !== false,
  )
  const skipNextPushRef = useRef(true) // 拉取完成前不回写云端（避免用本地旧数据盖掉云端）
  /** v10.61：持久化计数（跳过首次挂载那次写 localStorage —— 那不是「编辑」） */
  const persistSeenRef = useRef(false)
  /** v10.61：HYDRATE（拉云端 / 切账号 / 还原备份）带来的状态变化不算「本地编辑」，下一次持久化不盖 localUpdatedAt */
  const suppressStampRef = useRef(false)
  /** 首次拉取是否已完成：没完成就绝不上推，防止「本地示例数据 → 覆盖云端真稿」 */
  const [pullDone, setPullDone] = useState(false)
  /* ===== v10.63：回写安全闸（本轮「过往写作资产全没了」事故的根因修复）=====
   * 事故经过：一台本地没有存档的设备（新域名/清过缓存/首次登录）读到的本地状态是空的，
   * 云端读取又没成功，随后「关页兜底推送」把这份**空作品库**状态推了上去，
   * 把云端 6 本作品覆盖成 0 本。
   * 三道闸：① 没成功读过云端 → 绝不回写；② 回写会把「非空作品库」变空 → 拦下；
   * ③ 只有用户显式「清空作品库」才允许把空库推上去。 */
  const pullOkRef = useRef(false)
  /** 最近一次已知的服务端作品库数量（拉取/保存成功后记录） */
  const serverLibCountRef = useRef(0)
  /** 用户本次会话显式清空作品库 → 允许把空库推上去 */
  const libraryClearedRef = useRef(false)
  /** 云端读取重试计数（读取失败后回到页面再试一次） */
  const [pullAttempt, setPullAttempt] = useState(0)
  const stateRef = useRef(state)
  stateRef.current = state

  // ===== v10.57 画布间冲突检测（派生状态，不进 AppState，避免污染 localStorage）=====
  const [conflicts, setConflicts] = useState<ConflictPair[]>([])
  const [conflictBusy, setConflictBusy] = useState(false)
  const conflictTimer = useRef<number | null>(null)

  const runConflictCheck = useCallback(async () => {
    const list = Object.values(stateRef.current.canvases).map(c => ({
      key: c.id,
      name: c.dimension,
      content: c.content || '',
      locked: Boolean(c.locked),
    }))
    // 7 块全空没必要检测；有一块有内容就值得查一遍互相冲突
    if (!list.some(c => c.content.trim())) return
    setConflictBusy(true)
    try {
      const { data } = await detectConflicts({ canvases: list })
      setConflicts(Array.isArray(data?.conflicts) ? data.conflicts : [])
    } catch (e) {
      // 检测失败不影响主流程，静默保留现状（不把旧标记清掉，避免闪烁）
      console.warn('[冲突检测] 调用失败：', e)
    } finally {
      setConflictBusy(false)
    }
  }, [])

  const scheduleConflictCheck = useCallback(() => {
    if (conflictTimer.current) window.clearTimeout(conflictTimer.current)
    conflictTimer.current = window.setTimeout(() => {
      conflictTimer.current = null
      void runConflictCheck()
    }, 900)
  }, [runConflictCheck])

  const clearConflicts = useCallback(() => {
    if (conflictTimer.current) {
      window.clearTimeout(conflictTimer.current)
      conflictTimer.current = null
    }
    setConflicts([])
  }, [])

  // ===== 资产态（分支 / 快照）=====
  // v10.27：「原子设定 / 硬约束」这一页已按用户要求删除。
  // assets.atoms 仍在状态与 KV 里保留（老数据不丢），但没有创建入口，
  // 因此也不会再有「看不见的约束」偷偷影响生成 —— lib/constraints 的同步已拆除。
  const [assets, setAssets] = useState<AssetBundle>(() => emptyAssets())
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [assetsError, setAssetsError] = useState('')
  const assetsKey = assetsKeyFor(activeUid)

  // ===== 权限与平台数据 =====
  /** 角色来自服务端（登录时下发、启动时 authMe 刷新），本地只是一份展示用的副本 */
  const isAdmin = isAdminUser(user)
  const [platformSettings, setPlatformSettings] = useState<PlatformSettings | null>(null)

  /**
   * 拉平台数据：语料覆盖层 + 站点设置。
   * 刻意不抛错 —— 内置语料本来就是完整可用的，拉不到就退回出厂内容，
   * 不能因为一个平台接口把整个页面卡死。
   */
  const loadPlatform = useCallback(async () => {
    if (!user || localOnly) {
      setCorpusOverlay(null)
      setPlatformSettings(null)
      return
    }
    try {
      const snap = await platformGet()
      setCorpusOverlay(snap.corpus.books, {
        updatedAt: snap.corpus.updatedAt,
        updatedBy: snap.corpus.updatedBy,
      })
      setPlatformSettings(snap.settings)
    } catch (e) {
      console.warn('[平台数据] 拉取失败，继续使用内置语料：', e)
    }
  }, [user, localOnly])

  useEffect(() => {
    void loadPlatform()
  }, [loadPlatform])

  /** 本地缓存兜底：断网时资产功能照常可用 */
  const cacheAssets = useCallback(
    (bundle: AssetBundle) => {
      try {
        localStorage.setItem(assetsKey, JSON.stringify(bundle))
      } catch {
        /* 容量不足就放弃缓存，云端仍有 */
      }
    },
    [assetsKey],
  )

  /** 云端可用 = 已登录 且 没选「仅本机使用」 */
  const cloudUsable = Boolean(user) && !localOnly

  const loadAssets = useCallback(async () => {
    // 先上本地缓存，界面不空窗
    try {
      const raw = localStorage.getItem(assetsKey)
      if (raw) setAssets(sanitizeAssets(JSON.parse(raw) as Partial<AssetBundle>))
    } catch {
      /* 缓存坏了就走云端 */
    }
    if (!cloudUsable) return
    setAssetsLoading(true)
    setAssetsError('')
    try {
      const remote = sanitizeAssets(await cloudAssetsLoad())
      setAssets(remote)
      cacheAssets(remote)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setAssetsError(`资产同步失败：${msg}（已显示本地缓存）`)
    } finally {
      setAssetsLoading(false)
    }
  }, [assetsKey, cacheAssets, cloudUsable])

  // 账号切换 / 首次挂载：重新读该账号的资产
  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  // ===== 登录态失效：回到登录页 =====
  useEffect(() => {
    const onUnauth = () => {
      setUser(null)
      setAssets(emptyAssets())
      setCloudStatus('idle')
    }
    window.addEventListener(UNAUTH_EVENT, onUnauth)
    return () => window.removeEventListener(UNAUTH_EVENT, onUnauth)
  }, [])

  // ===== 启动时校验 token（防止拿着过期/被删的会话继续用）=====
  useEffect(() => {
    if (!user) return
    let alive = true
    // 网络抖动时重试一次：v10 之前登录的旧会话本地没有 role 字段，
    // 全靠这次回源把 admin 角色刷进来；一次失败就放弃会让管理入口永远出不来
    const pull = async (): Promise<AuthUser> => {
      try {
        return await authMe()
      } catch {
        await new Promise(r => setTimeout(r, 2500))
        return authMe()
      }
    }
    ;(async () => {
      try {
        const me = await pull()
        if (alive) setUser(me)
      } catch {
        // 401 已在 api 层清过会话并广播；这里只兜底一次
        if (alive) setUser(getCurrentUser())
      }
    })()
    return () => {
      alive = false
    }
    // 只在登录成功后校验一次，避免频繁往返
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.userId])

  /** 启动时拉服务端最新；服务端更新时间更新则覆盖本地 */
  useEffect(() => {
    if (!cloudUsable) {
      setCloudStatus(localOnly ? 'disabled' : 'idle')
      setPullDone(false)
      return
    }
    if (!cloudEnabled) {
      setCloudStatus('disabled')
      setPullDone(false)
      return
    }
    let alive = true
    setPullDone(false)
    setCloudStatus('syncing')
    ;(async () => {
      try {
        const res = await cloudLoadState()
        if (!alive) return
        // v10.61：本地新旧以「最后一次编辑时间」为准（没有才退回上次推送时间）。
        // 以前只比 updatedAt（=上次推送成功时间），编辑后没等防抖推送就关页，本地新稿会被云端旧稿覆盖。
        const meta = readSyncMeta(activeUid)
        const localAt = meta.localUpdatedAt || meta.updatedAt || ''
        const remoteAt = res.updatedAt || ''
        // v10.63：读取成功 —— 记下云端作品库数量（回写闸的判据），并放行后续回写
        pullOkRef.current = true
        serverLibCountRef.current = Array.isArray(res.state?.library) ? res.state.library.length : 0
        // migrated = 服务端把单用户时代的老存档交给了这个新账号，这时要直接接管
        const shouldTake = Boolean(res.state) && Boolean(remoteAt) && (res.migrated || remoteAt > localAt)
        /* v10.64：作品库以「独立储存库」为权威 —— 只要这次拿到的作品库是空的，
           就向 libraryLoad 要一份（服务端独立储存库里的书），任何版本的前端都不该让用户的库变空。 */
        const fetchCanonicalLibrary = async (): Promise<typeof stateRef.current.library> => {
          try {
            const lib = await cloudLibraryLoad()
            return Array.isArray(lib?.library) ? lib.library : []
          } catch (e) {
            console.warn('[云同步] 作品库独立储存库读取失败（忽略，不影响其它同步）：', e)
            return []
          }
        }
        let hydrated = false
        if (shouldTake && res.state) {
          // v10.63：服务端没有 library 字段时用本地作品库兜底（不能当成「云端把作品库清空了」）
          const clean = sanitizeRemoteState(res.state, stateRef.current.library)
          if (clean) {
            // v10.63 自愈：云端作品库为空、本地却有作品 —— 以本地为准（不当清库处理），
            // 随后这次会话的回写会把本地作品推上去，把云端也修回来。
            if (clean.library.length === 0 && stateRef.current.library.length > 0) {
              clean.library = stateRef.current.library
              console.warn(
                `[云同步] 云端作品库为空、本地还有 ${stateRef.current.library.length} 本，已保留本地作品并将在本次会话回写修复云端`,
              )
            }
            // v10.64：两边都空 → 再向独立储存库要一次（历史事故留下的空壳能被这一层救回来）
            if (clean.library.length === 0) {
              const canonical = await fetchCanonicalLibrary()
              if (canonical.length) {
                clean.library = canonical
                console.warn(`[云同步] 作品库已从独立储存库补回 ${canonical.length} 本`)
              }
            }
            suppressStampRef.current = true
            // v10.62：云端拉取也属于会话启动，画布工作区重置为默认 ——
            // 云端的画布是上次会话的残留，登录后没选文本就该是空白
            dispatch({ type: 'HYDRATE', state: resetWorkspace(clean) })
            writeSyncMeta(activeUid, { updatedAt: remoteAt, cloudEnabled: true })
            hydrated = true
            console.info(
              res.migrated
                ? '[云同步] 已接管单用户时代的存档，将在本次登录后落到你的账号名下'
                : '[云同步] 已载入 Cloudflare 上更新的数据',
            )
          }
        } else if (stateRef.current.library.length === 0) {
          /* v10.64：本地状态比云端新（不接管云端状态），但本地作品库是空的 ——
             只把作品库补回来，不动画布与其它数据。作品库只增不减，缺了就补。 */
          const canonical = await fetchCanonicalLibrary()
          if (canonical.length) {
            suppressStampRef.current = true
            dispatch({ type: 'HYDRATE', state: { ...stateRef.current, library: canonical } })
            console.warn(`[云同步] 本地作品库为空、独立储存库有 ${canonical.length} 本，已补回（其它数据不动）`)
          }
        }
        // 刚载入云端数据 → 本轮不回写；迁移接管 / 本地较新 → 允许推上去
        skipNextPushRef.current = res.migrated ? false : hydrated
        setCloudSavedAt(res.serverSavedAt || null)
        setCloudStatus('synced')
      } catch (e) {
        if (!alive) return
        console.warn('[云同步] 拉取失败，继续用本地缓存：', e)
        // v10.63：读取没成功就不许回写 —— 此刻本地很可能只是「还没拿到云端数据」的空壳，
        // 推上去会把云端真实的作品库抹掉（本轮回写安全闸的核心）
        pullOkRef.current = false
        setCloudStatus('offline')
        skipNextPushRef.current = true
      } finally {
        if (alive) setPullDone(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [cloudUsable, cloudEnabled, localOnly, activeUid, pullAttempt])

  /** 账号切换：换成该账号自己的本地存档，绝不沿用上一个账号的画布 */
  const prevUidRef = useRef(activeUid)
  useEffect(() => {
    if (prevUidRef.current === activeUid) return
    prevUidRef.current = activeUid
    skipNextPushRef.current = true
    setPullDone(false)
    suppressStampRef.current = true
    dispatch({
      type: 'HYDRATE',
      state: hydrateState({ ...initialState }, stateKeyFor(activeUid), activeUid ?? 'local'),
    })
  }, [activeUid])

  /**
   * v10.63：回写安全闸 —— 返回非空字符串表示「这次回写必须拦下」，字符串是给用户看的原因。
   * ① 没成功读过云端 → 本地可能只是空壳，回写会覆盖云端真数据；
   * ② 回写会把云端非空作品库变成空 → 拦下（除非用户显式清空过作品库）。
   */
  const pushBlockedReason = useCallback((): string => {
    if (!pullOkRef.current) {
      return '尚未成功读取云端数据，已跳过本次回写（避免用空数据覆盖云端）'
    }
    if (
      !libraryClearedRef.current &&
      stateRef.current.library.length === 0 &&
      serverLibCountRef.current > 0
    ) {
      return `本地作品库为空、云端还有 ${serverLibCountRef.current} 本作品，已拦下本次回写（防止误删云端作品库）`
    }
    return ''
  }, [])

  /** 状态变化 → 防抖 1.5s 回写云端 */
  useEffect(() => {
    if (!cloudUsable || !cloudEnabled || !pullDone) return
    if (skipNextPushRef.current) {
      skipNextPushRef.current = false
      return
    }
    const timer = window.setTimeout(async () => {
      const blocked = pushBlockedReason()
      if (blocked) {
        console.warn('[云同步] 已拦下回写：', blocked)
        setCloudStatus('guarded')
        return
      }
      setCloudStatus('syncing')
      try {
        const res = await cloudSaveState(stateRef.current, { libraryCleared: libraryClearedRef.current })
        writeSyncMeta(activeUid, { updatedAt: res.updatedAt, cloudEnabled: true })
        serverLibCountRef.current = res.libraryCount ?? stateRef.current.library.length
        setCloudSavedAt(res.serverSavedAt)
        setCloudStatus('synced')
      } catch (e) {
        console.warn('[云同步] 回写失败（本地缓存已保留，联网后点「立即同步」）：', e)
        setCloudStatus('offline')
      }
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [state, cloudUsable, cloudEnabled, pullDone, activeUid, pushBlockedReason])

  const syncNow = useCallback(async () => {
    if (!cloudUsable) return
    const blocked = pushBlockedReason()
    if (blocked) {
      console.warn('[云同步] 已拦下手动回写：', blocked)
      setCloudStatus('guarded')
      return
    }
    setCloudStatus('syncing')
    try {
      const res = await cloudSaveState(stateRef.current, { libraryCleared: libraryClearedRef.current })
      writeSyncMeta(activeUid, { updatedAt: res.updatedAt, cloudEnabled: true })
      serverLibCountRef.current = res.libraryCount ?? stateRef.current.library.length
      setCloudSavedAt(res.serverSavedAt)
      setCloudStatus('synced')
    } catch (e) {
      console.warn('[云同步] 手动同步失败：', e)
      setCloudStatus('offline')
    }
  }, [cloudUsable, activeUid, pushBlockedReason])

  /**
   * v10.61：关页 / 切后台前兜底立即推送 —— 1.5s 防抖没跑完就关页是「编辑丢失」的另一半成因。
   * v10.63：改成「隐藏→推送（带安全闸）」+「重新可见→若从没读成功过就补一次读取」，
   * 避免新设备在没拿到云端数据时把空状态推上去（本轮回写安全闸的核心）。
   */
  useEffect(() => {
    const onVisibility = () => {
      if (!cloudUsable || !cloudEnabled || !pullDone) return
      if (document.visibilityState === 'hidden') {
        if (skipNextPushRef.current) return
        void syncNow()
        return
      }
      // 回到前台：还没成功读过云端 → 补一次读取（而不是回写）
      if (!pullOkRef.current) setPullAttempt(n => n + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [cloudUsable, cloudEnabled, pullDone, syncNow])

  const setCloudEnabled = useCallback(
    (on: boolean) => {
      setCloudEnabledState(on)
      writeSyncMeta(activeUid, { ...readSyncMeta(activeUid), cloudEnabled: on })
      if (on) void syncNow()
    },
    [syncNow, activeUid],
  )

  const backupNow = useCallback(async () => {
    if (!cloudUsable) return '⚠️ 未登录，无法触发云端备份'
    try {
      const r = await cloudBackupNow('manual_snapshot')
      const where = r.stored === 'r2' ? 'R2' : 'KV'
      const pruned = r.pruned ? `，已自动清掉 ${r.pruned} 份最旧的` : ''
      return `✅ 备份完成：${r.size} 字节，存于 ${where}（保留键 ${r.stamp}）${pruned}`
    } catch (e) {
      return `❌ 备份失败：${e instanceof Error ? e.message : String(e)}`
    }
  }, [cloudUsable])

  /** 列出可还原的备份（只拿元信息） */
  const listBackups = useCallback(
    async (limit = 30) => {
      if (!cloudUsable) return { items: [], keep: 0, r2Bound: false }
      return await cloudBackupList(limit)
    },
    [cloudUsable],
  )

  /** 还原某份备份：先让服务端回写 KV，再把还原后的状态拉回本机 */
  const restoreBackup = useCallback(
    async (stamp: string) => {
      if (!cloudUsable) return '⚠️ 未登录，无法还原'
      try {
        const r = await cloudBackupRestore(stamp)
        // 服务端已回写 KV，这里同步刷新本机内存态，否则界面还是还原前的样子
        try {
          const loaded = await cloudLoadState()
          const clean = sanitizeRemoteState(loaded.state)
          if (clean) {
            skipNextPushRef.current = true
            suppressStampRef.current = true
            dispatch({ type: 'HYDRATE', state: clean })
            writeSyncMeta(activeUid, { updatedAt: loaded.updatedAt || '', cloudEnabled: true })
          }
        } catch {
          /* 拉取失败不影响还原本身，下次进页面会重新拉 */
        }
        await loadAssets()
        const idx = r.index ? `，重建索引 ${r.index.projects} 本 / ${r.index.chapters} 章` : ''
        return `✅ 已还原到 ${new Date(r.createdAt).toLocaleString('zh-CN')} 的备份（恢复 ${r.kvRestored} 个数据项${idx}）`
      } catch (e) {
        return `❌ 还原失败：${e instanceof Error ? e.message : String(e)}`
      }
    },
    [cloudUsable, activeUid, loadAssets],
  )

  /* ---- 账号动作 ---- */
  const signIn = useCallback(async (username: string, password: string) => {
    setAuthBusy(true)
    try {
      const u = await authLogin(username, password)
      persistLocalOnly(false)
      setLocalOnlyState(false)
      skipNextPushRef.current = true
      setUser(u)
    } finally {
      setAuthBusy(false)
    }
  }, [])

  const signUp = useCallback(async (username: string, password: string) => {
    setAuthBusy(true)
    try {
      const u = await authRegister(username, password)
      persistLocalOnly(false)
      setLocalOnlyState(false)
      skipNextPushRef.current = true
      setUser(u)
    } finally {
      setAuthBusy(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    // 本地优先：先把界面和本地会话清干净，立刻回到登录页。
    // 服务端删 session 只是收尾动作，后台执行——网络再慢也不能把人卡在已登录界面。
    setUser(null)
    setAssets(emptyAssets())
    setCloudSavedAt(null)
    setCloudStatus('idle')
    clearSession()
    try {
      await authLogout()
    } catch {
      /* 服务端删不掉 session 也会按 30 天过期自然失效，不阻塞用户 */
    }
  }, [])

  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    await authChangePassword(oldPassword, newPassword)
  }, [])

  const setLocalOnlyMode = useCallback((on: boolean) => {
    persistLocalOnly(on)
    setLocalOnlyState(on)
  }, [])

  /* ---- 资产动作 ---- */
  const saveAsset = useCallback<ContextValue['saveAsset']>(
    async (kind, asset) => {
      const now = new Date().toISOString()
      const stamped = { ...asset, ...(kind === 'atom' ? { updatedAt: now } : {}), ...(kind === 'branch' ? { updatedAt: now } : {}) }
      // 乐观更新：先落本地，网络失败也不丢用户刚输入的内容
      setAssets(prev => {
        const listKey = kind === 'atom' ? 'atoms' : kind === 'branch' ? 'branches' : 'snaps'
        const list = prev[listKey] as Array<{ id: string; createdAt?: string }>
        const exists = list.some(x => x.id === (stamped as { id: string }).id)
        const nextList = exists
          ? list.map(x => (x.id === (stamped as { id: string }).id ? (stamped as never) : x))
          : [stamped as never, ...list]
        const next: AssetBundle = { ...prev, [listKey]: nextList } as AssetBundle
        cacheAssets(next)
        return next
      })
      if (!cloudUsable) return
      try {
        await cloudAssetSave(kind, stamped as AtomicSetting | StoryBranch | StorySnapshot)
        setAssetsError('')
      } catch (e) {
        setAssetsError(`保存到云端失败：${e instanceof Error ? e.message : String(e)}（本地已保留）`)
      }
    },
    [cacheAssets, cloudUsable],
  )

  const deleteAsset = useCallback(
    async (kind: AssetKind, id: string) => {
      setAssets(prev => {
        const listKey = kind === 'atom' ? 'atoms' : kind === 'branch' ? 'branches' : 'snaps'
        const list = prev[listKey] as Array<{ id: string }>
        const next: AssetBundle = { ...prev, [listKey]: list.filter(x => x.id !== id) } as AssetBundle
        cacheAssets(next)
        return next
      })
      if (!cloudUsable) return
      try {
        await cloudAssetDelete(kind, id)
      } catch (e) {
        setAssetsError(`云端删除失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [cacheAssets, cloudUsable],
  )

  const reloadAssets = useCallback(async () => {
    await loadAssets()
  }, [loadAssets])

  /* ---- v10.31 画布自动版本 ----
     7 块画布是整个产品的唯一真源（所有生成都从它出发），但此前只有「手动存快照」一条路 ——
     真被 AI 改坏的时候手上通常没有存档。现在在**每个会覆盖画布的入口**前自动拍一份：
       · 脑洞长框架写回（bulkUpdateContent 带 reason）
       · 创作台「原文拆解写回画布」（applyToCanvases）
       · 套用文风卡（replace 模式会顶掉原有文笔）
       · 回滚本身（先存一份，免得回滚错了没法回头）
     去重与合并规则见下面注释。 */
  const AUTO_KEEP = 30 // 自动版本最多留这么多份
  const AUTO_COALESCE_MS = 60_000 // 一分钟内的连续自动写入合并成一份

  const assetsRef = useRef(assets)
  assetsRef.current = assets

  const autoSnapshot = useCallback(
    (reason: string, force = false) => {
      const cs = stateRef.current.canvases
      // ⚠️ 键必须是**画布 id**，不是维度名 —— APPLY_SNAPSHOT 是 `next[id]` 这样回滚的，
      // 用维度名做键会导致回滚静默失效（画布看着没变）。
      const canvases: Record<string, SnapshotCanvas> = {}
      for (const c of Object.values(cs)) {
        canvases[c.id] = { content: c.content, locked: Boolean(c.locked) }
      }
      // 画布全空就没什么可回滚的，别占位
      if (!Object.values(canvases).some(v => (v.content || '').trim())) return

      const snaps = assetsRef.current.snaps
      const newest = snaps[0]
      // 内容与最新一份完全一致 → 没必要再存
      if (newest && JSON.stringify(newest.canvases) === JSON.stringify(canvases)) return
      // 同一原因、一分钟内连续写入 → 合并（那一份记的正是这轮写入「之前」的状态，回滚点是对的）。
      // ⚠️ 必须带 reason 一起判：否则「回滚」刚存完紧接着一次「拆解写回」会被吞掉，
      // 那次覆盖就没有回滚点了 —— 实测踩过这个坑。
      if (
        !force &&
        newest?.auto &&
        newest.reason === reason &&
        Date.now() - Date.parse(newest.createdAt) < AUTO_COALESCE_MS
      ) {
        return
      }

      const snap: StorySnapshot = {
        id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: `自动 · ${reason}`,
        note: reason,
        canvases,
        libraryCount: stateRef.current.library.length,
        createdAt: new Date().toISOString(),
        auto: true,
        reason,
      }
      void saveAsset('snap', snap)

      // 自动版本只留最新 AUTO_KEEP 份，其余清掉（手动存的不动）
      const autos = [snap, ...snaps.filter(s => s.auto)]
      for (const old of autos.slice(AUTO_KEEP)) void deleteAsset('snap', old.id)
    },
    [saveAsset, deleteAsset],
  )

  const restoreSnapshot = useCallback(
    (id: string) => {
      const snap = assets.snaps.find(s => s.id === id)
      if (!snap) return '❌ 找不到这个版本'
      // 回滚前先给「现在」拍一份，否则回滚错了就再也回不来
      autoSnapshot('回滚前的自动存档', true)
      dispatch({ type: 'APPLY_SNAPSHOT', canvases: snap.canvases })
      return `✅ 已回滚到「${snap.name}」（${Object.keys(snap.canvases).length} 块画布）`
    },
    [assets.snaps, autoSnapshot],
  )

  const applyBranch = useCallback(
    (id: string) => {
      const br = assets.branches.find(b => b.id === id)
      if (!br) return '❌ 找不到这个分支'
      const lockedIds = Object.values(state.canvases)
        .filter(c => c.locked)
        .map(c => c.id)
      const patch: Record<string, string> = {}
      for (const [dim, content] of Object.entries(br.canvasPatch || {})) {
        const target = Object.values(state.canvases).find(c => c.dimension === dim)
        if (!target) continue
        patch[target.id] = content
      }
      const skipped = Object.keys(patch).filter(k => lockedIds.includes(k)).length
      if (!Object.keys(patch).length) return '⚠️ 这个分支还没有可写回的画布内容'
      dispatch({ type: 'BULK_UPDATE_CONTENT', patch })
      return `✅ 已切到分支「${br.name}」（写回 ${Object.keys(patch).length - skipped} 块画布${
        skipped ? `，跳过 ${skipped} 块锁定画布` : ''
      }）`
    },
    [assets.branches, state.canvases],
  )

  useEffect(() => {
    const firstRun = !persistSeenRef.current
    persistSeenRef.current = true
    try {
      localStorage.setItem(storageKey, JSON.stringify(state))
    } catch (e) {
      // localStorage 有 ~5MB 上限，作品库存太多会 QuotaExceededError
      const isQuota =
        e instanceof DOMException &&
        (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      if (isQuota) {
        console.warn('localStorage 已满，尝试裁掉最旧的作品后重试')
        const trimmed: AppState = { ...state, library: state.library.slice(0, 20) }
        try {
          localStorage.setItem(storageKey, JSON.stringify(trimmed))
        } catch (e2) {
          console.warn('裁减后仍失败，放弃持久化本次状态', e2)
        }
      } else {
        console.warn('persist failed', e)
      }
    }
    // v10.61：真正的「本地编辑」才盖 localUpdatedAt 时间戳。
    // 首次挂载（写回 hydrate 出来的旧状态）和 HYDRATE（云端/切账号/备份还原）都不算编辑，
    // 否则时间戳被顶成"现在"，下次打开会误判「本地比云端新」，拉不到别的设备上的新稿。
    if (firstRun || suppressStampRef.current) {
      suppressStampRef.current = false
      return
    }
    writeSyncMeta(activeUid, { localUpdatedAt: new Date().toISOString() })
  }, [state, storageKey, activeUid])

  const selectedCanvas = state.selectedCanvasId
    ? state.canvases[state.selectedCanvasId] ?? null
    : null

  const value: ContextValue = useMemo(
    () => ({
      state,
      dispatch,
      aiFillingCanvasIds: Array.isArray(state.aiFillingCanvasIds) ? state.aiFillingCanvasIds : [],
      selectedCanvas,
      listCanvases: () => Object.values(state.canvases),
      listDownstreamTargets: (fromId) => {
        const from = state.canvases[fromId]
        if (!from) return []
        return Object.values(state.canvases).filter(c => c.id !== fromId)
      },
      addAnchor: (canvasId, source, features, examples) => {
        dispatch({
          type: 'ADD_ANCHOR',
          canvasId,
          anchor: { id: `a-${Date.now()}`, source, features, examples },
        })
      },
      updateAnchor: (canvasId, anchor) =>
        dispatch({ type: 'UPDATE_ANCHOR', canvasId, anchor }),
      removeAnchor: (canvasId, anchorId) =>
        dispatch({ type: 'REMOVE_ANCHOR', canvasId, anchorId }),
      aiAppendAnchors: (canvasId, anchors) =>
        dispatch({ type: 'AI_APPEND_ANCHORS', canvasId, anchors }),
      reset: () => {
        clearConflicts()
        dispatch({ type: 'RESET_TO_SEED' })
      },
      saveBook: book => dispatch({ type: 'SAVE_BOOK', book: { ...book, canvases: stateRef.current.canvases } }),
      importBook: bookId => {
        const book = stateRef.current.library.find(b => b.id === bookId)
        if (!book) return
        // v10.50 修复：v10.50 之前存的旧书没有 canvases 字段，
        // 原逻辑 `!book.canvases` 会静默 return，用户点「导入作品」毫无反应。
        // v10.53：旧书兜底改用 deriveCanvasesFromBook —— 用书自带的简介/风格/大纲/字数
        // 合成画布内容。v10.52 曾留全空白（用户看到 0/7 已填、设定一片空白），
        // v10.51 之前曾回落演示种子（祖器串书），两个极端都不对。
        // v10.54：书里 canvases 存在但可能是坏数据（全空白 / demo 污染），逐维度修复。
        const canvases: Record<string, Canvas> = repairBookCanvases(book)
        clearConflicts()
        dispatch({ type: 'IMPORT_BOOK', bookId, canvases })
      },
      unlinkBook: () => dispatch({ type: 'UNLINK_BOOK' }),
      updateBookOutline: (bookId, outline, chapterWritings) =>
        dispatch({ type: 'UPDATE_BOOK_OUTLINE', bookId, outline, chapterWritings }),
      removeBook: bookId => dispatch({ type: 'REMOVE_BOOK', bookId }),
      // v10.63：显式清空作品库 → 放行「空库回写」（否则安全闸会把这次清空也拦下）
      clearLibrary: () => {
        libraryClearedRef.current = true
        dispatch({ type: 'CLEAR_LIBRARY' })
      },
      updateChapter: (bookId, chapterIndex, writing) =>
        dispatch({ type: 'UPDATE_CHAPTER', bookId, chapterIndex, writing }),
      restoreBook: bookId => dispatch({ type: 'RESTORE_BOOK', bookId }),
      purgeBook: bookId => dispatch({ type: 'PURGE_BOOK', bookId }),
      saveWorldview: wv => dispatch({ type: 'SAVE_WORLDVIEW', wv }),
      deleteWorldview: id => dispatch({ type: 'DELETE_WORLDVIEW', id }),
      saveCollection: col => dispatch({ type: 'SAVE_COLLECTION', col }),
      deleteCollection: id => dispatch({ type: 'DELETE_COLLECTION', id }),
      bulkUpdateContent: (patch, reason) => {
        // v10.31 先留回滚点，再覆盖画布
        if (reason && Object.keys(patch).length) autoSnapshot(reason)
        dispatch({ type: 'BULK_UPDATE_CONTENT', patch })
        // v10.57 批量写回画布后，延迟检测一次画布间冲突（防抖合并连续写入）
        scheduleConflictCheck()
      },
      autoSnapshot,
      toggleCanvasLock: id => dispatch({ type: 'TOGGLE_CANVAS_LOCK', id }),
      setCanvasLock: (id, locked) => dispatch({ type: 'SET_CANVAS_LOCK', id, locked }),
      setLastMode: mode => dispatch({ type: 'SET_LAST_MODE', mode }),
      setRememberMode: remember => dispatch({ type: 'SET_REMEMBER_MODE', remember }),
      setCollapseCanvases: collapse => dispatch({ type: 'SET_COLLAPSE_CANVASES', collapse }),
      saveStyleCard: card => dispatch({ type: 'ADD_STYLE_CARD', card }),
      removeStyleCard: id => dispatch({ type: 'REMOVE_STYLE_CARD', id }),
      lockedDimensions: () =>
        Object.values(state.canvases)
          .filter(c => c.locked)
          .map(c => c.dimension),

      user,
      authBusy,
      signIn,
      signUp,
      signOut,
      changePassword,
      localOnly,
      setLocalOnlyMode,

      isAdmin,
      canEdit: true,
      platformSettings,
      reloadPlatform: loadPlatform,

      cloudStatus,
      cloudSavedAt,
      cloudEnabled,
      setCloudEnabled,
      syncNow,
      backupNow,
      listBackups,
      restoreBackup,

      assets,
      assetsLoading,
      assetsError,
      reloadAssets,
      saveAsset,
      deleteAsset,
      restoreSnapshot,
      applyBranch,
      conflicts,
      conflictBusy,
      scheduleConflictCheck,
      runConflictCheck,
      clearConflicts,
    }),
    [
      state,
      selectedCanvas,
      user,
      authBusy,
      signIn,
      signUp,
      signOut,
      changePassword,
      localOnly,
      setLocalOnlyMode,
      isAdmin,
      platformSettings,
      loadPlatform,
      cloudStatus,
      cloudSavedAt,
      cloudEnabled,
      setCloudEnabled,
      syncNow,
      backupNow,
      listBackups,
      restoreBackup,
      assets,
      assetsLoading,
      assetsError,
      reloadAssets,
      saveAsset,
      deleteAsset,
      restoreSnapshot,
      applyBranch,
      conflicts,
      conflictBusy,
      scheduleConflictCheck,
      runConflictCheck,
      clearConflicts,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
