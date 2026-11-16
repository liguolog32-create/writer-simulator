import type { StyleCard } from './data/styleCards'

export type CanvasDimension = '设定' | '人物' | '文笔' | '结构' | '篇幅' | '情节' | '节奏'

export interface ReferenceAnchor {
  id: string
  source: string
  features: string
  examples: string
}

export interface Canvas {
  id: string
  dimension: CanvasDimension
  title: string
  content: string
  anchors: ReferenceAnchor[]
  downstreams: string[]
  /** 锁定后：AI 改写 / 重新生成 / 拆解 / 续写 绝对不修改这块画布的内容 */
  locked?: boolean
}

/**
 * @deprecated v10 起废弃，UI 已不再读写。
 * 旧版靠「只读访客 / 管理后台」两个前端 Tab 决定能不能编辑画布 ——
 * 那是个纯浏览器本地开关，任何人点一下就能给自己开管理权限。
 * 现在编辑权由 AppContext 的 `canEdit` 统一给出，管理权限由服务端 role 判定。
 * 这个字段保留只为兼容云端存档里的历史值。
 */
export type Mode = 'read' | 'admin'

/**
 * 账号角色。**唯一权威来源是服务端 D1 的 users.role**，
 * 前端拿到的只是展示用的副本 —— 它只决定「要不要渲染管理入口」，
 * 真正能不能调管理接口由 Worker 再判一次。
 */
export type UserRole = 'user' | 'admin'
export type UserStatus = 'active' | 'disabled'

/** 章节精修的写作目的 */
export type ChapterPurpose = 'transition' | 'main-plot' | 'reveal' | 'ending' | 'pure-scene'

/** 单章精修结果 */
export interface ChapterWriting {
  content: string
  settings: {
    targetWords: number
    style: string
    purpose: ChapterPurpose
    extraRequirements: string
  }
  generatedAt: string
  wordCount: number
}

const PURPOSE_LABELS: Record<ChapterPurpose, string> = {
  transition: '承上启下',
  'main-plot': '推进主线',
  reveal: '揭示谜底',
  ending: '交代结局',
  'pure-scene': '纯场景',
}
export const PURPOSE_OPTIONS: { value: ChapterPurpose; label: string }[] = [
  { value: 'transition', label: PURPOSE_LABELS.transition },
  { value: 'main-plot', label: PURPOSE_LABELS['main-plot'] },
  { value: 'reveal', label: PURPOSE_LABELS.reveal },
  { value: 'ending', label: PURPOSE_LABELS.ending },
  { value: 'pure-scene', label: PURPOSE_LABELS['pure-scene'] },
]
export const purposeLabel = (p: ChapterPurpose) => PURPOSE_LABELS[p] ?? p

/** 一次「生成文本」的完整存档 */
export interface SavedBook {
  id: string
  title: string
  synopsis: string
  outline: Array<{
    index: number
    title: string
    summary: string
    tag: '开局' | '推进' | '高潮' | '反转' | '收束'
    words: number
  }>
  sampleChapter: { title: string; content: string; beat: string }
  stats: {
    totalWords: number
    chapters: number
    volumes: number
    styleLabel: string
    anchorSources: string[]
  }
  /** 生成溯源：是否真联网、搜索次数、是否本地兜底、用的哪个引擎 */
  searched: boolean
  searchCount: number
  usedFallback: boolean
  /** deepseek=云端 DeepSeek；free=免费 Workers AI；local=本地模板兜底 */
  engine: 'deepseek' | 'free' | 'local'
  createdAt: string
  /** 最后一次"内容相关操作"的时间（精修章节/补充等）。没改过就 fallback 到 createdAt */
  updatedAt?: string
  /** 章节精修：每章单独精写过的正文。key 是 chapter.index */
  chapterWritings?: Record<number, ChapterWriting>
  /** v10.50：存书时一并记下当时工作区的 7 块画布，导入作品到画布页时完整还原其画布详情 */
  canvases?: Record<string, Canvas>
}

/** 首页两种模式：brain=新手脑洞共创，pro=高级画布工作台 */
export type EntryMode = 'brain' | 'pro' | 'worldview'

/** 被删的书：作者删的进回收站；管理员删的标记出来给作者看 */
export interface TrashedBook extends SavedBook {
  deletedAt: string
  deletedBy: 'author' | 'admin'
  /** 管理员删除时给作者看的原因 */
  deleteReason?: string
}

export interface AppState {
  canvases: Record<string, Canvas>
  selectedCanvasId: string | null
  /** @deprecated 见上面 Mode 的说明；保留仅为兼容历史存档 */
  mode: Mode
  /** 作品库：历次生成的存档，最新的在前 */
  library: SavedBook[]
  /**
   * v10.43 DEL-01 回收站：作者自己删的书先放这里，30 天内可恢复。
   * （原来删除是直接从 library 里 filter 掉，删错了没有后悔药）
   */
  trash?: TrashedBook[]
  /** 首页分流：上次打开的模式 */
  lastMode?: EntryMode | null
  /** 首页分流：「始终默认上次打开模式」记忆开关 */
  rememberMode?: boolean
  /** 高级工作台：画布是否默认折叠（新手减负） */
  collapseCanvases?: boolean
  /** 用户自己设计的文风卡（StyleForge 产出），存这里是为了跟着云同步走 */
  customStyleCards?: StyleCard[]
  /** v10.32 世界观（自由创作 / 从文本解析） */
  worldviews: Worldview[]
  /** v10.32 合集：把世界观 / 作品收纳在一起 */
  collections: WorkCollection[]
  /** v10.50：画布页从资产库导入的当前关联作品 id（写作页据此定书，不再单独设入口） */
  linkedBookId?: string | null
  /**
   * v10.65：机器人「观澜」的人格卡 + 识海记忆。
   * 随 AppState 一起同步（它是机器人的本体，跨设备要一致）。
   * ⚠️ 屏幕观察的**原始画面与 OCR 文字不在这里** —— 它们只存在本地 IndexedDB
   *    隔离区（src/bot/screensee.ts），永不上云。详见 src/bot/types.ts 的数据分层说明。
   */
  bot?: import('./bot/types').BotState
  /**
   * 「研墨中」：正在被 AI 写入的画布 id 集合（瞬态）。
   * 只在本次会话内存里存在 —— 不参与快照 / 云同步 / 作品保存；
   * 整棵 state 序列化会自动带上它，因此旧存档 / 旧云端数据缺该字段时
   * 由恢复端兜底为空数组（见 AppContext 的 hydrateState 与 HYDRATE case）。
   */
  aiFillingCanvasIds: string[]
}

export type Action =
  | { type: 'SELECT_CANVAS'; id: string }
  | { type: 'UPDATE_CONTENT'; id: string; content: string }
  | { type: 'BULK_UPDATE_CONTENT'; patch: Record<string, string> }
  | { type: 'TOGGLE_CANVAS_LOCK'; id: string }
  | { type: 'SET_CANVAS_LOCK'; id: string; locked: boolean }
  | { type: 'ADD_DOWNSTREAM'; from: string; to: string }
  | { type: 'REMOVE_DOWNSTREAM'; from: string; to: string }
  | { type: 'ADD_ANCHOR'; canvasId: string; anchor: ReferenceAnchor }
  | { type: 'UPDATE_ANCHOR'; canvasId: string; anchor: ReferenceAnchor }
  | { type: 'REMOVE_ANCHOR'; canvasId: string; anchorId: string }
  | { type: 'SET_MODE'; mode: Mode }
  | { type: 'SET_LAST_MODE'; mode: EntryMode }
  | { type: 'SET_REMEMBER_MODE'; remember: boolean }
  | { type: 'SET_COLLAPSE_CANVASES'; collapse: boolean }
  | { type: 'RESET_TO_SEED' }
  /** 自定义文风卡：新增 / 覆盖同 id / 删除 */
  | { type: 'ADD_STYLE_CARD'; card: StyleCard }
  | { type: 'REMOVE_STYLE_CARD'; id: string }
  | { type: 'HYDRATE'; state: AppState }
  | { type: 'AI_APPEND_ANCHORS'; canvasId: string; anchors: ReferenceAnchor[] }
  /** 「研墨中」：某块画布开始（on）/ 结束（off）被 AI 写入 —— 瞬态 UI 信号，不落盘 */
  | { type: 'AI_FILLING'; id: string; on: boolean }
  | { type: 'SAVE_BOOK'; book: SavedBook }
  | { type: 'REMOVE_BOOK'; bookId: string }
  /** v10.43 DEL-01：从回收站恢复 */
  | { type: 'RESTORE_BOOK'; bookId: string }
  /** v10.43 DEL-01：从回收站彻底删除 */
  | { type: 'PURGE_BOOK'; bookId: string }
  /**
   * v10.27/10.28 章节增删：替换某本书的章纲。
   * v10.28 起支持「在选中章之后插入 / 从选中章开始删」，中间插删会让后面章节整体重编号，
   * 所以正文（按章节号存的 chapterWritings）也必须一起重排 —— 由调用方算好后整份传入。
   */
  | { type: 'SAVE_WORLDVIEW'; wv: Worldview }
  | { type: 'DELETE_WORLDVIEW'; id: string }
  | { type: 'SAVE_COLLECTION'; col: WorkCollection }
  | { type: 'DELETE_COLLECTION'; id: string }
  | {
      type: 'UPDATE_BOOK_OUTLINE'
      bookId: string
      outline: SavedBook['outline']
      chapterWritings?: SavedBook['chapterWritings']
    }
  | { type: 'CLEAR_LIBRARY' }
  | { type: 'UPDATE_CHAPTER'; bookId: string; chapterIndex: number; writing: ChapterWriting }
  /** 版本快照回滚：只换画布，不动作品库与偏好设置 */
  | { type: 'APPLY_SNAPSHOT'; canvases: Record<string, SnapshotCanvas> }
  /** v10.50：从资产库导入作品到画布页 —— 载入它创作时的 7 块画布，并标记当前关联书 */
  | { type: 'IMPORT_BOOK'; bookId: string; canvases: Record<string, Canvas> }
  /** v10.50：取消画布页与作品的关联（保留当前画布内容，不回滚） */
  | { type: 'UNLINK_BOOK' }
  /** v10.65：机器人「观澜」的人格卡 + 识海记忆整体写入（页面自己管衰减/巩固，这里只负责存） */
  | { type: 'SET_BOT'; bot: import('./bot/types').BotState }

/* ============================================================
   项目资产：原子设定 / 剧情分支 / 版本快照
   数据落在 Cloudflare KV（user:{uid}:atom|branch|snap:{id}），
   浏览器本地存储只做离线缓存。
   ============================================================ */

export type AssetKind = 'atom' | 'branch' | 'snap'

/** 原子设定：最小可复用的设定单元，锁定后 AI 绝不改动 */
export interface AtomicSetting {
  id: string
  name: string
  /** 归属维度（设定/人物/文笔/结构/篇幅/情节/节奏），可留空表示跨维度 */
  dimension: CanvasDimension | ''
  content: string
  /** 锁定的原子设定：喂给 AI 时作为硬约束 */
  locked: boolean
  tags: string[]
  createdAt: string
  updatedAt: string
}

/** 剧情分支：从某个分叉点长出来的另一条故事线 */
export interface StoryBranch {
  id: string
  name: string
  /** 父分支 id，null 表示从主线分叉 */
  parentId: string | null
  /** 从第几章开始分叉；null 表示不按章节切 */
  forkChapterIndex: number | null
  description: string
  /** 该分支要写回的画布内容：维度 → 内容 */
  canvasPatch: Record<string, string>
  createdAt: string
  updatedAt: string
}

/** 快照里的单块画布（只存必要字段，控制体积） */
export interface SnapshotCanvas {
  content: string
  locked?: boolean
}

/** 版本快照：某一时刻全部画布的状态存档，可一键回滚 */
/** v10.32 世界观的一个分块（自由增删；AI 解析出的也放这里） */
export interface WorldviewSection {
  title: string
  content: string
}

/**
 * v10.32 世界观：可以自由创作，也可以从自己的文本里让 AI 解析出来。
 * 保存后可以「以这个世界观为主干」去写小说（写进画布 → 一键生成）。
 */
/**
 * v10.33 世界观的细分维度 —— 比「自由分块」更有东西可填。
 * 用户明确要求能回答这类问题：人们住什么样的房子、城市规模如何、政治制度如何、基础设施如何。
 */
export interface WorldviewFieldDef {
  key: string
  title: string
  hint: string
}

/** 固定的细分维度（顺序即编辑器里的顺序） */
export const WORLDVIEW_FIELDS: WorldviewFieldDef[] = [
  { key: 'tone', title: '世界基调', hint: '一句话定调：这是什么样的世界，读起来什么味道' },
  { key: 'geo', title: '地理与城市规模', hint: '世界有多大？城市怎么分布、人口量级、城区边界在哪' },
  { key: 'building', title: '建筑与居住', hint: '人们住什么样的房子？材料、结构、采光、屋内陈设、贫富差异' },
  { key: 'politics', title: '政治制度', hint: '谁在统治？权力怎么分配？法律与执行机构是什么' },
  { key: 'infra', title: '基础设施', hint: '水电气怎么来？排污、照明、通讯、医疗、消防' },
  { key: 'tech', title: '科技与能源', hint: '核心动力是什么？技术水平到哪一步？有什么禁忌技术' },
  { key: 'class', title: '阶层与经济', hint: '分几层人？钱怎么赚、怎么流通？贫困与特权长什么样' },
  { key: 'traffic', title: '交通与出行', hint: '人和货怎么移动？载具、道路、票价、耗时' },
  { key: 'daily', title: '服饰与日常', hint: '穿什么、吃什么、一天怎么过、有什么娱乐与风气' },
  { key: 'taboo', title: '禁忌与冲突', hint: '这个世界最不能碰的东西，以及主要矛盾从哪来' },
]

/** 画风预设（生成配图时作为风格前缀） */
export const ART_STYLES: string[] = [
  '蒸汽朋克 · 写实厚涂',
  '蒸汽朋克 · 工业手稿',
  '赛博朋克 · 霓虹夜景',
  '水墨国风',
  '日系插画',
  '油画古典',
  '黑白版画',
  '像素游戏',
  '概念设定图（灰模 + 材质）',
]

export interface Worldview {
  id: string
  name: string
  /** 总纲 / 一句话世界观 */
  summary: string
  /** 来源：manual=自由创作；parsed=从文本解析 */
  source: 'manual' | 'parsed'
  /** 来源说明（解析时记录用了哪本书 / 哪段文本） */
  originNote?: string
  /** v10.36 解析自哪本书：用来判重，已经解析过的作品不再重复解析 */
  originBookId?: string
  /** 细分维度内容：WORLDVIEW_FIELDS 的 key → 正文 */
  fields: Record<string, string>
  /** 用户自己加的额外块（固定维度之外） */
  custom: WorldviewSection[]
  /** 画风：生成配图时的风格前缀 */
  artStyle: string
  /** v10.44 WORLD-01：这个世界观下挂着的作品（一个世界观 = 一个系列） */
  bookIds?: string[]
  /** 配图：'cover' 或字段 key → 服务端 KV 里的图片 key（图片不进 state，避免撑爆存储） */
  images: Record<string, string>
  createdAt: string
  updatedAt: string
}

/** v10.32 合集：把世界观 / 作品收纳在一起 */
export interface WorkCollection {
  id: string
  name: string
  note: string
  worldviewIds: string[]
  bookIds: string[]
  createdAt: string
  updatedAt: string
}

export interface StorySnapshot {
  id: string
  name: string
  note: string
  canvases: Record<string, SnapshotCanvas>
  libraryCount: number
  createdAt: string
  /**
   * v10.31 自动版本：AI 要覆盖画布之前系统自动拍的存档。
   * 老数据没有这个字段 = 用户手动存的版本。
   */
  auto?: boolean
  /** 自动版的触发原因，如「原文拆解写回画布」 */
  reason?: string
}

export interface AssetBundle {
  atoms: AtomicSetting[]
  branches: StoryBranch[]
  snaps: StorySnapshot[]
}
