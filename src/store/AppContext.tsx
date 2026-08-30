import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react'
import type { Action, AppState, Canvas, ReferenceAnchor } from '../types'
import { seedCanvases } from '../data/seed'

const STORAGE_KEY = 'writer-simulator-state-v1'

const initialState: AppState = {
  canvases: seedCanvases,
  selectedCanvasId: 'setting',
  mode: 'admin',
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
      return { ...initialState, mode: state.mode }
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
}

const AppContext = createContext<ContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) return JSON.parse(raw) as AppState
    } catch (e) {
      console.warn('hydrate failed', e)
    }
    return init
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (e) {
      console.warn('persist failed', e)
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
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
