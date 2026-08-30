import { WORKER_URL, LLM_TIMEOUT_MS } from '../config'

export interface AnalyzeResult {
  source: string
  features: string
  examples: string
}

export interface GeneratedBookLLM {
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
}

interface WorkerOk<T> {
  ok: true
  data: T
  searched?: boolean
  searchCount?: number
}
interface WorkerErr { ok: false; error: string }
type WorkerResp<T> = WorkerOk<T> | WorkerErr

/** Worker 的返回，附带是否真的触发了联网搜索 */
export interface LLMResponse<T> {
  data: T
  searched: boolean
  searchCount: number
}

async function callLLM<T>(payload: object, timeoutMs = LLM_TIMEOUT_MS): Promise<LLMResponse<T>> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    let body: WorkerResp<T>
    try {
      body = (await resp.json()) as WorkerResp<T>
    } catch {
      throw new Error(`Worker 返回非 JSON（HTTP ${resp.status}）`)
    }
    if (!body.ok) throw new Error(body.error || 'Worker 返回 ok:false')
    return {
      data: body.data,
      searched: Boolean(body.searched),
      searchCount: body.searchCount ?? 0,
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`LLM 调用超时（>${Math.round(timeoutMs / 1000)}s）`)
    }
    if (e instanceof TypeError) {
      // 网络层错误（CORS / DNS / Worker 不可达）
      throw new Error(`无法连接 Worker：${e.message}。检查网络或 Cloudflare 是否被墙`)
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}

export interface ReviseResult {
  revised: string
  changes: string[]
}

export interface ContinueResult {
  continuation: string
  rationale: string
}

export function analyzeBook(book: string, dimension: string) {
  return callLLM<AnalyzeResult>({ action: 'analyze', book, dimension })
}

/** 工作台：把原文拆成 7 个维度 */
export function dissectText(text: string) {
  return callLLM<Record<string, string>>({ action: 'dissect', text })
}

/** 工作台：按画布设定修改原文 */
export function reviseText(text: string, canvases: Record<string, string>) {
  return callLLM<ReviseResult>({ action: 'revise', text, canvases })
}

/** 工作台：按画布设定续写 */
export function continueText(text: string, canvases: Record<string, string>) {
  return callLLM<ContinueResult>({ action: 'continue', text, canvases })
}

export function generateBookLLM(canvases: Record<string, string>) {
  return callLLM<GeneratedBookLLM>({ action: 'generate', canvases })
}