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
}

export type Mode = 'read' | 'admin'

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
  engine: 'deepseek' | 'local'
  createdAt: string
  /** 章节精修：每章单独精写过的正文。key 是 chapter.index */
  chapterWritings?: Record<number, ChapterWriting>
}

export interface AppState {
  canvases: Record<string, Canvas>
  selectedCanvasId: string | null
  mode: Mode
  /** 作品库：历次生成的存档，最新的在前 */
  library: SavedBook[]
}

export type Action =
  | { type: 'SELECT_CANVAS'; id: string }
  | { type: 'UPDATE_CONTENT'; id: string; content: string }
  | { type: 'ADD_DOWNSTREAM'; from: string; to: string }
  | { type: 'REMOVE_DOWNSTREAM'; from: string; to: string }
  | { type: 'ADD_ANCHOR'; canvasId: string; anchor: ReferenceAnchor }
  | { type: 'UPDATE_ANCHOR'; canvasId: string; anchor: ReferenceAnchor }
  | { type: 'REMOVE_ANCHOR'; canvasId: string; anchorId: string }
  | { type: 'SET_MODE'; mode: Mode }
  | { type: 'RESET_TO_SEED' }
  | { type: 'HYDRATE'; state: AppState }
  | { type: 'AI_APPEND_ANCHORS'; canvasId: string; anchors: ReferenceAnchor[] }
  | { type: 'SAVE_BOOK'; book: SavedBook }
  | { type: 'REMOVE_BOOK'; bookId: string }
  | { type: 'CLEAR_LIBRARY' }
  | { type: 'UPDATE_CHAPTER'; bookId: string; chapterIndex: number; writing: ChapterWriting }
