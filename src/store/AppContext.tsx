import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react'
import type { Action, AppState, Canvas, ChapterWriting, ReferenceAnchor, SavedBook } from '../types'
import { seedCanvases } from '../data/seed'

const STORAGE_KEY = 'writer-simulator-state-v1'

const initialState: AppState = {
  canvases: seedCanvases,
  selectedCanvasId: 'setting',
  mode: 'admin',
  library: [],
}

/** 旧版 localStorage 没有 library 字段，必须补默认值，否则读档后 library 为 undefined 会崩 */
function hydrateState(init: AppState): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AppState>
      return {
        ...init,
        ...saved,
        library: Array.isArray(saved.library) ? saved.library : [],
      }
    }
  } catch (e) {
    console.warn('hydrate failed', e)
  }
  return init
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
    case 'RESET_TO_SEED':
      // 重置只清画布示例数据，保留用户辛苦生成的作品库
      return { ...initialState, mode: state.mode, library: state.library }
    case 'SAVE_BOOK': {
      // 新的排最前，并限制总量避免撑爆 localStorage（约 5MB 上限）
      const MAX = 60
      return { ...state, library: [action.book, ...state.library].slice(0, MAX) }
    }
    case 'REMOVE_BOOK':
      return { ...state, library: state.library.filter(b => b.id !== action.bookId) }
    case 'CLEAR_LIBRARY':
      return { ...state, library: [] }
    case 'UPDATE_CHAPTER': {
      return {
        ...state,
        library: state.library.map(b =>
          b.id === action.bookId
            ? { ...b, chapterWritings: { ...(b.chapterWritings ?? {}), [action.chapterIndex]: action.writing } }
            : b,
        ),
      }
    }
    case 'HYDRATE':
      return action.state
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
    default:
      return state
  }
}

interface ContextValue {
  state: AppState
  dispatch: React.Dispatch<Action>
  selectedCanvas: Canvas | null
  listCanvases: () => Canvas[]
  listDownstreamTargets: (fromId: string) => Canvas[]
  addAnchor: (canvasId: string, source: string, features: string, examples: string) => void
  updateAnchor: (canvasId: string, anchor: ReferenceAnchor) => void
  removeAnchor: (canvasId: string, anchorId: string) => void
  aiAppendAnchors: (canvasId: string, anchors: ReferenceAnchor[]) => void
  reset: () => void
  saveBook: (book: SavedBook) => void
  removeBook: (bookId: string) => void
  clearLibrary: () => void
  updateChapter: (bookId: string, chapterIndex: number, writing: ChapterWriting) => void
}

const AppContext = createContext<ContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, hydrateState)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (e) {
      // localStorage 有 ~5MB 上限，作品库存太多会 QuotaExceededError
      const isQuota =
        e instanceof DOMException &&
        (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      if (isQuota) {
        console.warn('localStorage 已满，尝试裁掉最旧的作品后重试')
        const trimmed: AppState = { ...state, library: state.library.slice(0, 20) }
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
        } catch (e2) {
          console.warn('裁减后仍失败，放弃持久化本次状态', e2)
        }
      } else {
        console.warn('persist failed', e)
      }
    }
  }, [state])

  const selectedCanvas = state.selectedCanvasId
    ? state.canvases[state.selectedCanvasId] ?? null
    : null

  const value: ContextValue = {
    state,
    dispatch,
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
    reset: () => dispatch({ type: 'RESET_TO_SEED' }),
    saveBook: book => dispatch({ type: 'SAVE_BOOK', book }),
    removeBook: bookId => dispatch({ type: 'REMOVE_BOOK', bookId }),
    clearLibrary: () => dispatch({ type: 'CLEAR_LIBRARY' }),
    updateChapter: (bookId, chapterIndex, writing) =>
      dispatch({ type: 'UPDATE_CHAPTER', bookId, chapterIndex, writing }),
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
