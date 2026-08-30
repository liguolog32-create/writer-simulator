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

export interface AppState {
  canvases: Record<string, Canvas>
  selectedCanvasId: string | null
  mode: Mode
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
