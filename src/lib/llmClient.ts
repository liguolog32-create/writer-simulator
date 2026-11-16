import { LLM_TIMEOUT_MS, WORKER_URL, type LLMEngine } from '../config'
import { postWorker } from './api'
import { enginePayload } from './engine'
import { notifyCreditsChanged } from './creditsClient'
import { getToken } from './session'

export interface AnalyzeResult {
  source: string
  features: string
  examples: string
}

export interface DirectionBrief {
  styleLock?: string
  tone?: string
  rhythmIntent?: string
  hardRules?: string[]
  phasePlan?: Array<{ tag: string; focus: string }>
  chapterDirections?: Array<{ index: number; intent: string }>
  forbidden?: string[]
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
  /** 本次生成用的「方向指令书」（来自方向导演层），前端可用于展示与校准 */
  directionBrief?: DirectionBrief | null
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

/** Worker 的返回，附带是否真的触发了联网搜索 */
export interface LLMResponse<T> {
  data: T
  searched: boolean
  searchCount: number
}

async function callLLM<T>(payload: object, timeoutMs = LLM_TIMEOUT_MS, signal?: AbortSignal): Promise<LLMResponse<T>> {
  // 统一走 lib/api：自动带登录 token，401 自动清会话并回登录页
  // v10.17：引擎选择在这一点统一注入，40 多个业务调用点都不用各自关心
  // v10.59：signal 透传（用户点「终止生成」时中断 fetch）
  const body = await postWorker<T>({ ...payload, ...enginePayload() }, timeoutMs, { signal })
  // v10.23：云端调用会消耗积分 → 广播一次，让顶栏积分显示实时刷新
  notifyCreditsChanged()
  return {
    data: body.data as T,
    searched: Boolean(body.searched),
    searchCount: body.searchCount ?? 0,
  }
}

/* ============================================================
   引擎可用性探针（v10.17）
   ------------------------------------------------------------
   问服务端「云端 / 免费两条通道各通不通」，用来把不可用的选项置灰。
   不消耗任何 AI 额度（服务端在凭证门禁之前就返回了）。
   ============================================================ */
export interface EngineStatus {
  engine: LLMEngine
  /** 云端通道是否可用（服务端配了 DEEPSEEK_API_KEY） */
  cloud: boolean
  /** 免费通道是否可用（Worker 挂了 Workers AI 绑定） */
  free: boolean
  /** 服务端登记的全部免费模型（key → model id） */
  freeModels: Record<string, string>
  defaultFreeModel: string
  usedFreeModel: string | null
}

export async function fetchEngineStatus(): Promise<EngineStatus> {
  const r = await postWorker<EngineStatus>({ action: 'engineStatus', ...enginePayload() }, 15_000)
  return r.data as EngineStatus
}

export interface ReviseResult {
  revised: string
  changes: string[]
  /** 联网开启且模型确实检索到同类型范文时，返回它参考过的来源（作品名/作者），用于 UI 展示 */
  references?: string[]
  webSearch?: boolean
}

export interface ContinueResult {
  continuation: string
  rationale: string
}

export function analyzeBook(
  book: string,
  dimension: string,
  useSearch = true,
  previousResults: AnalyzeResult[] = [],
) {
  return callLLM<AnalyzeResult>({
    action: 'analyze',
    book,
    dimension,
    useSearch,
    previousResults,
  })
}

/**
 * v10.19 · 参考锚点直出
 * 没指定书名时，让服务端**基于用户自己的画布内容**产出这个维度的具体特征 + 具体示例，
 * 而不是回填一句写死的「提示：…」方法论。
 */
export function suggestAnchor(input: {
  dimension: string
  /** 当前画布内容 */
  content: string
  /** 当前画布标题（可选，给模型更多上下文） */
  title?: string
  /** 其他画布（维度 → 内容），作为上下文 */
  canvases?: Record<string, string>
  useSearch?: boolean
  previousResults?: AnalyzeResult[]
}) {
  return callLLM<AnalyzeResult>({
    action: 'anchorSuggest',
    useSearch: true,
    ...input,
  })
}

/** 工作台：把原文拆成 7 个维度（locked=已锁定维度，服务端会直接丢弃这些维度，绝不写回） */
export function dissectText(text: string, locked: string[] = []) {
  return callLLM<Record<string, string>>({ action: 'dissect', text, locked })
}

/** 识别上传的图片（思维导图/大纲/设定图/手写笔记）→ 拆成 7 个维度并分配到画布 */
export function dissectImageLLM(input: {
  imageBase64: string
  mimeType: string
  locked?: string[]
}) {
  return callLLM<Record<string, string>>({ action: 'imageDissect', ...input })
}

/** 工作台：用关键词/要求让 AI 辅助改写某个维度的内容（可开联网检索同类型范文作风格参照） */
export function refineField(input: {
  dimension: string
  current: string
  instruction: string
  context?: string
  /** 联网开关：默认 false（快且省）。开启时模型先检索同类型优秀范文作为风格参照再改写 */
  webSearch?: boolean
  /** v10.59：外部中断信号（画布页「终止生成」按钮） */
  signal?: AbortSignal
}) {
  const { signal, ...rest } = input
  return callLLM<{ refined: string; references?: string[]; webSearch?: boolean }>(
    { action: 'refine', ...rest },
    undefined,
    signal,
  )
}

/**
 * v10.72 机器人代笔：让它以**作者本人**身份写整章正文。
 *
 * 为什么不复用 refineField：refine 的服务端系统提示是「文学分析编辑……只改这一段……
 * 保持简洁」——那是给画布维度润色用的。拿它写整章，机器人的人格会被"编辑腔 +
 * 简洁"覆盖，写出来既不像它，也写不长。所以这里走独立的 worker 动作 botWrite，
 * 系统提示由服务端控制（客户端不能指定 system prompt，这是安全边界）。
 */
export function botWriteText(input: { instruction: string; signal?: AbortSignal }) {
  return callLLM<{ content: string }>(
    { action: 'botWrite', instruction: input.instruction },
    // 整章正文比字段润色长得多，给足时间
    240_000,
    input.signal,
  )
}

/** 工作台：目标章节（让续写/修改明确落到「第几章」） */
export interface ChapterContext {
  index: number
  title: string
  summary: string
}

/** 工作台：按画布设定修改原文（可附用户具体要求 + 参考文件内容 + 锁定维度 + 联网搜索同类型范文） */
export function reviseText(
  text: string,
  canvases: Record<string, string>,
  chapter?: ChapterContext,
  extra?: {
    instruction?: string
    referenceText?: string
    locked?: string[]
    /** 联网开关：默认 true。开启时模型会先检索同类型优秀范文作为风格参照再修改 */
    webSearch?: boolean
    /** 联网检索方向提示（如「武侠/古风」），帮助模型更精准地搜同类型文章 */
    genreHint?: string
    /** 用户明确的「方向意图」，喂给方向导演层，让改写方向更精准 */
    directionIntent?: string
  },
) {
  return callLLM<ReviseResult>({
    action: 'revise',
    text,
    canvases,
    chapter,
    instruction: extra?.instruction ?? '',
    referenceText: extra?.referenceText ?? '',
    locked: extra?.locked ?? [],
    webSearch: extra?.webSearch ?? true,
    genreHint: extra?.genreHint ?? '',
    directionIntent: extra?.directionIntent ?? '',
  })
}

/** 工作台：按画布设定续写（locked=已锁定维度）。webSearch 开启时先检索同类型优秀范文作风格参照 */
export function continueText(
  text: string,
  canvases: Record<string, string>,
  chapter?: ChapterContext,
  locked: string[] = [],
  webSearch = true,
  directionIntent = '',
) {
  return callLLM<ContinueResult & { references?: string[]; webSearch?: boolean }>({
    action: 'continue',
    text,
    canvases,
    chapter,
    locked,
    webSearch,
    directionIntent,
  })
}

/** 章节精修：输入前 N-1 章 + 本章设置 + 画布，输出本章正文 */
export interface WriteChapterInput {
  bookTitle: string
  chapterIndex: number
  chapterTitle: string
  chapterSummary: string
  settings: {
    targetWords: number
    style: string
    /** v10.32 文章目的非必选：空字符串 = 不指定，模型按大纲与画布自己判断 */
    purpose: 'transition' | 'main-plot' | 'reveal' | 'ending' | 'pure-scene' | ''
    extraRequirements: string
  }
  previousChapters: Array<{ title: string; content: string }>
  canvases: Record<string, string>
  /** 已锁定的维度：AI 绝不改动 */
  locked?: string[]
  /** 联网开关：默认 false（精写以画布+前文为准）；开启时先检索同类型优秀范文作为风格参照 */
  webSearch?: boolean
  /** 用户明确的「方向意图」，喂给方向导演层，让精修方向更精准 */
  directionIntent?: string
}

export function writeChapter(input: WriteChapterInput) {
  return callLLM<{ content: string; rationale: string; references?: string[]; webSearch?: boolean }>({
    action: 'writeChapter',
    ...input,
  })
}

export function generateBookLLM(canvases: Record<string, string>, directionIntent = '') {
  return callLLM<GeneratedBookLLM>({ action: 'generate', canvases, directionIntent })
}

/**
 * 生成整本书（流式版）：规划与样章并发，先到先推。
 * - 服务端返回 text/event-stream（SSE），每条 `data: {...}` 一帧：
 *   · { phase: 'plan', book }        规划先到（书名/简介/大纲/规格）
 *   · { phase: 'chapter', book }     样章后到（补上样章正文）
 *   · { done:true, data, searched, searchCount }  合并最终结构
 *   · { error: '...' }               两侧都失败
 * - 若服务端是旧版本（不支持 stream，返回 JSON），自动降级为 onDone 一次性给全量。
 * - 任何阶段的 book 都是「截至当前已到的部分」，UI 直接拿去渲染即可（缺的字段为空兜底）。
 */
export interface GenerateStreamHandlers {
  onPlan?: (book: GeneratedBookLLM) => void
  onChapter?: (book: GeneratedBookLLM) => void
  onDone: (book: GeneratedBookLLM, searched: boolean, searchCount: number) => void
  onError: (msg: string) => void
}

export async function generateBookLLMStream(
  canvases: Record<string, string>,
  handlers: GenerateStreamHandlers,
  timeoutMs = LLM_TIMEOUT_MS,
  directionIntent = '',
  /** v10.22：本次生成指定引擎（「免费 / 付费」两颗按钮用），不传则跟随顶栏偏好 */
  engine?: LLMEngine,
): Promise<void> {
  const token = getToken()
  // v10.17：流式生成也要带引擎参数，否则会绕过引擎选择跑回云端
  const payload = {
    action: 'generate',
    canvases,
    stream: true,
    directionIntent,
    ...enginePayload(engine),
    ...(token ? { token } : {}),
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const resp = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })

    // 旧版本 worker：不支持 stream，返回普通 JSON
    const ct = resp.headers.get('content-type') || ''
    if (!ct.includes('text/event-stream')) {
      if (!resp.ok) {
        handlers.onError(`生成失败（HTTP ${resp.status}）`)
        return
      }
      const j = (await resp.json()) as { ok?: boolean; data?: GeneratedBookLLM; searched?: boolean; searchCount?: number }
      if (j.ok && j.data) {
        handlers.onDone(j.data, Boolean(j.searched), j.searchCount ?? 0)
      } else {
        handlers.onError('生成失败：服务端未返回有效结果')
      }
      return
    }

    if (!resp.ok || !resp.body) {
      handlers.onError(`生成失败（HTTP ${resp.status}）`)
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.trim()
        if (!line.startsWith('data:')) continue
        const json = line.slice(5).trim()
        if (!json) continue
        let evt: Record<string, unknown>
        try {
          evt = JSON.parse(json)
        } catch {
          continue
        }
        if (evt.error) {
          handlers.onError(String(evt.error))
          return
        }
        if (evt.phase === 'plan' && evt.book) handlers.onPlan?.(evt.book as GeneratedBookLLM)
        else if (evt.phase === 'chapter' && evt.book) handlers.onChapter?.(evt.book as GeneratedBookLLM)
        else if (evt.done && evt.data) {
          handlers.onDone(
            evt.data as GeneratedBookLLM,
            Boolean(evt.searched),
            Number(evt.searchCount) || 0,
          )
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      handlers.onError(`请求超时（>${Math.round(timeoutMs / 1000)}s）`)
    } else {
      handlers.onError(e instanceof Error ? e.message : String(e))
    }
  } finally {
    clearTimeout(timer)
    // v10.23：整本书生成会打好几次模型（导演/大纲/样章），跑完统一广播刷新积分
    notifyCreditsChanged()
  }
}

/* ============================================================
   方向导演层 · 前端调用
   ============================================================ */

/** 单独产出「方向指令书」（可生成前预览，或任意时刻查看当前画布会被怎么理解） */
export async function directBookLLM(
  canvases: Record<string, string>,
  directionIntent = '',
): Promise<DirectionBrief | null> {
  const r = await callLLM<DirectionBrief>({ action: 'direct', canvases, directionIntent })
  return r.data ?? null
}

/** 方向校准自检：比对成稿与指令书，返回一致度评分 + 偏离点 + 修正稿 */
export interface CalibrateResult {
  score: number
  deviations: string[]
  fixedText: string
}

export async function calibrateText(
  brief: DirectionBrief | null,
  text: string,
): Promise<CalibrateResult | null> {
  const r = await callLLM<CalibrateResult>({ action: 'calibrate', brief, text })
  return r.data ?? null
}

/* ============================================================
   v10.10 新增一：AI 短剧剧本（把已写正文改成能直接拍的竖屏短剧）
   ============================================================ */

/**
 * 剧本正文按「行」组织，直接对应短剧行业标准格式的七种写法：
 *   beat → △动作/神态/镜头   line → 角色名：（提示）台词
 *   vo   → 角色名VO：台词     os   → 角色名OS：内心独白
 *   sub  → 【字幕：…】/【空镜-…】/ △空镜转场
 */
export type ScriptLineKind = 'beat' | 'line' | 'vo' | 'os' | 'sub'
export interface ScriptLine {
  kind: ScriptLineKind
  speaker: string
  /** 表演提示，写在冒号后的圆括号里；只有 kind='line' 才有 */
  emotion: string
  text: string
}
export interface ScriptScene {
  /** 场景号：集-场，如 "1-1"、"2-3" */
  no: string
  place: string
  /** 日 / 夜 */
  time: string
  /** 内 / 外 / 外内 */
  space: string
  cast: string[]
  lines: ScriptLine[]
  camera: string
  transition: string
}
export interface ScriptEpisode {
  index: number
  title: string
  hook: string
  durationSec: number
  scenes: ScriptScene[]
  cliffhanger: string
}
export interface ScriptCharacter {
  name: string
  identity: string
  voice: string
  look: string
  /** 首次出场字幕，如「苏晚 苏氏独女」 */
  subtitle: string
}
export interface ScriptResult {
  title: string
  /** 类型：女频现言 / 男频逆袭 … */
  genre: string
  /** 卖点标签，如 豪门联姻 / 先婚后爱 / 救赎 */
  tags: string[]
  /** 人设一行：女方一句话 × 男方一句话 */
  castLine: string
  logline: string
  platformTip: string
  characters: ScriptCharacter[]
  episodes: ScriptEpisode[]
  prompts: Array<{ scene: string; prompt: string }>
  notes: string[]
  settings: { episodes: number; secPerEp: number; platform: string }
}

/** 把一行剧本渲染成标准格式的纯文本 */
export function scriptLineToText(l: ScriptLine): string {
  switch (l.kind) {
    case 'beat':
      return `△${l.text}`
    case 'sub':
      return l.text.startsWith('【') || l.text.startsWith('△') ? l.text : `【${l.text}】`
    case 'vo':
      return `${l.speaker}VO：${l.text}`
    case 'os':
      return `${l.speaker}OS：${l.text}`
    default:
      return `${l.speaker}：${l.emotion ? `（${l.emotion}）` : ''}${l.text}`
  }
}

/** 场景头一行：1-1 茶室 日 内 */
export function scriptSceneHead(s: ScriptScene): string {
  return [s.no, s.place, s.time, s.space].filter(Boolean).join(' ')
}

export function toScriptLLM(input: {
  text: string
  canvases?: Record<string, string>
  episodes?: number
  secPerEp?: number
  platform?: string
  styleNote?: string
}) {
  return callLLM<ScriptResult>({ action: 'toScript', ...input }, 180000)
}

/* ============================================================
   v10.10 新增二：文风炼金（用户自己设计一张文风卡）
   ============================================================ */

export interface ForgedStyleCard {
  name: string
  tagline: string
  effect: string
  quotes: string[]
  applyText: string
  sample: string
  warnings: string[]
}

export function forgeStyleCard(input: {
  raw: string
  clarifications?: string[]
  reference?: string
  sampleText?: string
}) {
  return callLLM<ForgedStyleCard>({ action: 'styleForge', ...input })
}

/* ============================================================
   PRD「新手脑洞共创模式」
   ============================================================ */

/** 脑洞步骤2：AI 提取核心四要素 + 生成 4 组选择题 */
export interface BrainElement {
  protagonist: string
  desire: string
  conflict: string
  ending: string
}
export interface BrainOption {
  label: string
  detail: string
}
export interface BrainQuestion {
  key: 'protagonist' | 'conflict' | 'theme' | 'ending'
  label: string
  question: string
  options: BrainOption[]
}
export interface BrainExtractResult {
  readback: string
  elements: BrainElement
  questions: BrainQuestion[]
}

export function brainstormExtract(input: { raw?: string; cards?: Record<string, string> }) {
  return callLLM<BrainExtractResult>({ action: 'brainstormExtract', ...input })
}

/** 脑洞步骤3：分层生长（layer 1→4），每层回传 canvasPatch 用于预填画布 */
export interface BrainGrowResult {
  layer: number
  headline: string
  /** 仅 layer=1 给 3 版一句话梗概供切换 */
  variants: string[]
  /** 给用户看的条目（大白话） */
  display: string[]
  /** 维度名（设定/人物/…）→ 要写进该画布的内容 */
  canvasPatch: Record<string, string>
}

export function brainstormGrow(input: {
  raw?: string
  answers?: Record<string, string>
  chosenVariant?: string
  previousLayers?: string[]
  layer: number
  /** 联网开关：默认 false。开启时先检索同类型优秀作品作参考（仍严格遵守禁用术语约束） */
  webSearch?: boolean
}) {
  return callLLM<BrainGrowResult & { references?: string[]; webSearch?: boolean }>({
    action: 'brainstormGrow',
    ...input,
  })
}

/** 功能2：故事体检校验器 —— 问题 + 2-3 个优化选择题 */
export interface HealthOption {
  label: string
  fix: string
}
export interface HealthIssue {
  id: string
  dimension: string
  problem: string
  why: string
  options: HealthOption[]
}
export interface HealthResult {
  summary: string
  score: number
  issues: HealthIssue[]
}

export function healthCheck(canvases: Record<string, string>) {
  return callLLM<HealthResult>({ action: 'healthCheck', canvases })
}

/* ============================================================
   v10.57 画布间冲突检测
   ============================================================ */
/** 一对互相冲突的画布：a / b 是画布 id（setting / length …），reason 是给用户看的大白话 */
export interface ConflictPair {
  a: string
  b: string
  reason: string
}

/** 传入 7 块画布的 key + 中文维度名 + 内容，返回互相冲突的画布对 */
export function detectConflicts(input: {
  canvases: Array<{ key: string; name: string; content: string; locked?: boolean }>
}) {
  return callLLM<{ conflicts: ConflictPair[] }>({ action: 'detectConflict', ...input }, 120_000)
}

/** 脑洞步骤4前置：把 7 画布变成章节清单（只出清单，不写正文） */
export interface BrainOutlineResult {
  title: string
  synopsis: string
  outline: Array<{
    index: number
    title: string
    summary: string
    tag: '开局' | '推进' | '高潮' | '反转' | '收束'
    words: number
  }>
  stats: {
    totalWords: number
    chapters: number
    volumes: number
    styleLabel: string
    anchorSources: string[]
  }
}

/**
 * v10.29 篇幅体量：决定章节清单的规模。
 * 服务端按它决定「生成多少章、每章多少字、放开的章数上限」——
 * 以前上限写死在 24 章，长篇小说根本长不出来。
 */
export type BookScale = 'short' | 'medium' | 'long' | 'custom'

/**
 * @param scale     篇幅体量；'custom' 表示按用户给的总字数规划
 * @param totalWords scale='custom' 时必填：全书目标总字数（字）
 */
export function brainstormOutline(
  canvases: Record<string, string>,
  webSearch = false,
  scale?: BookScale,
  totalWords?: number,
) {
  return callLLM<BrainOutlineResult & { references?: string[]; webSearch?: boolean }>({
    action: 'brainstormOutline',
    canvases,
    webSearch,
    ...(scale ? { scale } : {}),
    ...(scale === 'custom' && totalWords ? { totalWords } : {}),
  })
}
/* ============================================================
   v10.32 世界观：从用户自己的文本解析出世界观
   ============================================================ */
/** v10.33：主输出是 10 个固定维度 fields；模型偶尔仍给 sections，也一并收下当自定义块 */
export interface ParseWorldviewResult {
  name: string
  summary: string
  artStyle?: string
  fields?: Record<string, string>
  sections?: Array<{ title: string; content: string }>
}

export function parseWorldview(input: { text: string; source?: string }) {
  return callLLM<ParseWorldviewResult>({ action: 'parseWorldview', ...input }, 180_000)
}

/* ============================================================
   v10.33 世界观配图（画风图）
   free → Workers AI（免费额度）；imageEngine='paid' → 即梦 Seedream（按张扣费）
   图片存在服务端 KV，前端只拿 key，再按需取回 base64。
   ============================================================ */
export function genWorldImage(input: {
  prompt: string
  imageEngine?: 'free' | 'paid'
  size?: string
}) {
  return callLLM<{ key: string; engine: string; model: string; bytes: number }>(
    { action: 'genWorldImage', ...input },
    150_000,
  )
}

export function getWorldImage(key: string) {
  return callLLM<{ b64: string }>({ action: 'getWorldImage', key }, 40_000)
}

/* ============================================================
   v10.46 LOOP-01：从一章正文里提取「新设定」建议（反哺画布）
   ============================================================ */
export interface SettingSuggestion {
  id: string
  kind: '人物' | '设定' | '情节' | string
  name: string
  note: string
}

export function extractNewSettings(input: {
  text: string
  canvases: Record<string, string>
}) {
  return callLLM<{ suggestions: SettingSuggestion[] }>(
    { action: 'extractNewSettings', ...input },
    120_000,
  )
}
