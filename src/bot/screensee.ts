/**
 * 屏幕被动观察模块（机器人「观澜」的眼睛 · v10.65）
 *
 * ============================ 隔离承诺（用户 2026-10-14 硬要求）============================
 * 1. **绝不动屏幕**：`navigator.mediaDevices.getDisplayMedia()` 给的是**只读视频流**，
 *    浏览器压根没有控制鼠标/键盘/切屏的接口 —— 「不操作」是平台级保证，不是自律。
 *    本模块**不引入任何自动化/输入相关 API**，也不往被捕获页面注入任何东西。
 * 2. **原始数据不出本机**：抽帧只为了算差分与认字，**图片即用即弃**（连 ImageData
 *    都不留）；认出的文字只写进本模块自己的 IndexedDB（`screensee-local`，TTL 72h、
 *    最多 500 条），**绝不 import 任何 store / cloudSync / api 模块** —— 不同步的东西
 *    根本没机会进 AppState，自然也进不了上云的 payload。
 * 3. 允许外发的只有「本地启发式摘要」`summarizeLocally()` 的产物（话题/情绪标签），
 *    且由 UI 层决定要不要送 LLM；原文永远留在本机。
 * =========================================================================================
 */

import { recognizeText } from './ocr'
import type { OcrLine } from './ocr'

/* ============================ 纯函数（可单测）============================ */

/** 16 位 dHash：在 9×8 灰度图上算相邻像素大小关系 */
export function frameDiffHash(pixels: Uint8ClampedArray, width: number, height: number): string {
  // 缩到 9×8（dHash 的标准尺寸：宽比高多 1 才能比相邻像素）
  const W = 9
  const H = 8
  const gray = new Float64Array(W * H)
  for (let y = 0; y < H; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / H))
    for (let x = 0; x < W; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / W))
      const i = (sy * width + sx) * 4
      // 亮度：Rec. 601
      gray[y * W + x] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
    }
  }
  let bits = ''
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits += gray[y * W + x] > gray[y * W + x + 1] ? '1' : '0'
    }
  }
  return bits
}

/** 汉明距离（两个等长 01 串） */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length)
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

/**
 * 要不要认字？画面没变就别 OCR（省电的关键）。
 * 阈值 2：容忍光标闪烁、时钟跳动、轻微压缩噪声。
 */
export function shouldOcr(prevHash: string | null, nextHash: string, tolerance = 2): boolean {
  if (!prevHash) return true
  return hamming(prevHash, nextHash) > tolerance
}

/**
 * v10.75：这一帧要不要认字？
 *
 * 原来只看画面差异 —— **读文章时屏幕几乎是静止的**，dHash 永远判"没变"，
 * 机器人就永远读不到用户正在看的文章，也长不出相关认知。
 * 现在加一条兜底节拍：距上次认字超过 FORCE_OCR_MS 就强制认一次，
 * 静止的画面也会被读到（一篇长文通常 1-2 个节拍就能被完整吃进来）。
 */
export const FORCE_OCR_MS = 45_000

/** 两次认字之间的最小间隔：杜绝 ~4.6s 一帧的灌水 */
export const MIN_CAPTURE_GAP_MS = 10_000
/** 抽帧最长边上限：不再压到 1280 把字压糊 */
export const MAX_OCR_EDGE = 2560
/** Tesseract MeanTextConf 下限：低于它直接丢弃这一帧 */
export const MIN_OCR_CONFIDENCE = 45
/** 文本质量下限：低于它判为 OCR 噪声 */
export const MIN_TEXT_QUALITY = 0.38
/** 逐词清洗后保留词比例下限：低于它判为整帧乱码（页面 MeanTextConf 会漏掉零散垃圾词） */
export const MIN_KEPT_RATIO = 0.6
/** 保留词的平均逐词置信度下限 */
export const MIN_WORD_CONF = 60

export function shouldCapture(
  prevHash: string | null,
  nextHash: string,
  lastOcrAt: number,
  now: number,
  minGapMs = 0,
): boolean {
  if (minGapMs > 0 && lastOcrAt > 0 && now - lastOcrAt < minGapMs) return false
  if (shouldOcr(prevHash, nextHash)) return true
  return now - lastOcrAt >= FORCE_OCR_MS
}

/**
 * OCR 文本质量评分：0..1，把「可读文字」和「识别噪声」分开。
 *
 * 基础项沿用设定：可读字符比 / 中文成词比 / 词形比 / 乱炖惩罚。
 * 实测两处调权（否则纯垃圾样本会误判为可读，例如 (b)=0.4028、(c)=0.6225）：
 *   · 乱炖惩罚每次命中 0.06→0.12、上限 0.35→0.45（大小写/数字混杂是噪声主形态）；
 *   · 含中文时新增「孤立单字惩罚」(1 - cjkWordRatio) * 0.9（上限 0.45）——
 *     一堆不成词的单字是中文 OCR 噪声最典型的特征，干净文本几乎为 0。
 * 调权后：干净样例 (a)=0.96、垃圾 (b)=0.3428 / (c)=0.1920；
 * 所有既有的干净回归文本仍 ≥ 0.6750，不会误杀。
 */
export function assessTextQuality(text: string): number {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length < 8) return 0
  const readable = (t.match(/[\u4e00-\u9fa5A-Za-z0-9\s.,:;!?'"()\[\]/，。！？、；：“”‘’（）【】《》…—-]/g) || []).length
  const readableRatio = readable / t.length
  const cjkAll = (t.match(/[\u4e00-\u9fa5]/g) || []).length
  const cjkRuns = t.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const cjkWordRatio = cjkRuns.reduce((s, r) => s + r.length, 0) / (cjkAll || 1)
  const segs = t.split(/\s+/)
  let goodLen = 0
  for (const seg of segs) {
    if (/^[\u4e00-\u9fa5]{2,}$/.test(seg) || /^[A-Za-z]{3,}$/.test(seg) || /^[A-Za-z0-9]{3,}$/.test(seg)) goodLen += seg.length
  }
  const shapeRatio = goodLen / t.length
  const messyPenalty = Math.min(0.45, (t.match(/[A-Za-z][0-9][A-Za-z]|[a-z][A-Z][a-z]|[0-9][A-Z]{2,}/g) || []).length * 0.12)
  const singleCjkPenalty = cjkAll > 0 ? Math.min(0.45, (1 - cjkWordRatio) * 0.9) : 0
  // 全大写拉丁噪声：shapeRatio 会把 [A-Za-z]{3,} 当成成形单词给分，但 OCR 把小字
  // 笔画腐蚀成的「SRNBRAT XREH ARETIUNCHAR」这类长全大写段 / 辅音连簇其实是乱码。
  // 另外纯拉丁串若连一个成形单词都没有（shapeRatio 近 0），非中文分支的
  // readableRatio 基线会把符号/大小写乱炖误抬成可读，也要补一刀压回噪声区。
  const upperSegs = t.split(/\s+/).filter(s => /^[A-Z0-9._\/-]{4,}$/.test(s))
  const legibleUpper = upperSegs.filter(s => (s.replace(/[^A-Z]/g, '').length) < 10)
  const consonantClusters = (t.match(/[BCDFGHJKLMNPQRSTVWXYZ]{4,}/g) || []).length
  const shapelessLatin = cjkAll === 0 && shapeRatio < 0.1 && t.length >= 8 ? 0.12 : 0
  const latinMessPenalty = Math.min(0.45,
    Math.max(0, upperSegs.length - legibleUpper.length) * 0.20 + consonantClusters * 0.10 + shapelessLatin)
  let q: number
  if (cjkAll > 0) {
    q = 0.35 * readableRatio + 0.35 * cjkWordRatio + 0.30 * shapeRatio - messyPenalty - singleCjkPenalty - latinMessPenalty
  } else {
    q = 0.45 * readableRatio + 0.55 * shapeRatio - messyPenalty - latinMessPenalty
  }
  return Math.max(0, Math.min(1, q))
}

/** TTL 淘汰：返回应保留的记录（过期剔除） */
export function pruneByTtl<T extends { at: string }>(
  records: T[],
  nowMs: number,
  ttlMs = TTL_MS,
): T[] {
  const cutoff = nowMs - ttlMs
  return records.filter(r => {
    const t = Date.parse(r.at)
    return Number.isFinite(t) && t > cutoff
  })
}

/** 条数淘汰：只留最新 max 条 */
export function pruneByCount<T extends { at: string }>(records: T[], max = MAX_RECORDS): T[] {
  if (records.length <= max) return records
  const sorted = [...records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return sorted.slice(0, max)
}

/* -------- 本地启发式摘要：唯一允许外发的形态的原料（不调 LLM，纯本地算）-------- */

const TOPIC_WORDS = [
  '工作', '加班', '项目', '会议', '客户', '需求', '上线', 'bug', '代码', '设计',
  '孩子', '学校', '老师', '作业', '家长', '考试', '家里', '父母',
  '房租', '贷款', '装修', '搬家', '工资', '奖金', '面试', '离职',
  '旅行', '机票', '酒店', '吃饭', '健身', '跑步', '生病', '医院', '药',
  '朋友', '家人', '恋爱', '分手', '结婚', '聊天', '群聊', '消息',
  '小说', '写作', '灵感', '故事', '人物', '情节', '设定', '文风',
]
const MOOD_WORDS: Array<[string, number]> = [
  ['疲惫', -0.6], ['累', -0.5], ['烦', -0.5], ['焦虑', -0.7], ['压力', -0.6],
  ['难过', -0.8], ['哭', -0.8], ['崩溃', -0.9], ['孤独', -0.7], ['失眠', -0.6],
  ['开心', 0.7], ['高兴', 0.7], ['轻松', 0.6], ['满足', 0.6], ['期待', 0.5],
  ['平静', 0.2], ['踏实', 0.4], ['兴奋', 0.8], ['温暖', 0.6], ['有意思', 0.5],
]
const ENTITY_RE = /[一-龥]{2,4}(公司|集团|学校|医院|银行|团队|项目|群|部|司)/g

export interface LocalSummary {
  topics: string[]
  entities: string[]
  mood: string
  /** 情绪效价 -1..1（供记忆条目的 valence 用） */
  valence: number
  chars: number
  /** OCR 文本质量 0..1（下游摄入闸据此丢弃噪声） */
  quality: number
}

/** 纯本地摘要：词典 + 词频，不调任何模型 */
export function summarizeLocally(text: string): LocalSummary {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  const chars = clean.length
  if (!chars) return { topics: [], entities: [], mood: '平静', valence: 0, chars: 0, quality: 0 }

  const topics: string[] = []
  for (const w of TOPIC_WORDS) if (clean.includes(w) && !topics.includes(w)) topics.push(w)

  const entities: string[] = []
  const hits = clean.match(ENTITY_RE)
  if (hits) for (const e of hits) if (!entities.includes(e)) entities.push(e)

  // v10.76：独立成行的 2-4 字纯中文 —— 微信资料页/聊天顶栏上的**人名**、短标题。
  // 原来的 ENTITY_RE 只认「XX公司/银行」这类后缀，中文人名（朱鹏辉）永远进不了实体，
  // 机器人就说不出"这是谁"。UI 词（消息/通讯录/朋友圈…）黑名单挡掉误报。
  const UI_LINE_RE = /^(通讯录|公众号|消息|朋友圈|发现|我|微信|标签|昵称|备注|地区|来源|更多|返回|设置|群聊|文件)$/
  const nameHits = String(text || '')
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => /^[一-龥·]{2,4}$/.test(l) && !UI_LINE_RE.test(l) && !TOPIC_WORDS.includes(l))
  for (const n of nameHits) if (!entities.includes(n) && entities.length < 8) entities.push(n)

  let sum = 0
  let n = 0
  for (const [w, v] of MOOD_WORDS) {
    if (clean.includes(w)) {
      sum += v
      n++
    }
  }
  const valence = n ? Math.max(-1, Math.min(1, sum / n)) : 0
  const mood =
    valence <= -0.6 ? '低落' : valence <= -0.2 ? '紧绷' : valence >= 0.6 ? '明亮' : valence >= 0.2 ? '轻快' : '平静'

  return { topics: topics.slice(0, 6), entities: entities.slice(0, 4), mood, valence, chars, quality: assessTextQuality(clean) }
}

/* ============================ 本地隔离存储 ============================ */

export interface LocalObservation {
  id: string
  at: string
  /** OCR 认出的原文（只留本机） */
  text: string
  /** 来源标签：窗口标题（浏览器给的，本机） */
  source: string
}

export const TTL_MS = 72 * 3600 * 1000
export const MAX_RECORDS = 500
const DB_NAME = 'screensee-local'
const STORE = 'frames'

/** 存储适配器：生产用 IndexedDB，单测用内存版 */
export interface StorageAdapter {
  all(): Promise<LocalObservation[]>
  put(rec: LocalObservation): Promise<void>
  delete(id: string): Promise<void>
  clear(): Promise<void>
}

function memStorage(): StorageAdapter {
  const m = new Map<string, LocalObservation>()
  return {
    async all() {
      return [...m.values()]
    },
    async put(rec) {
      m.set(rec.id, rec)
    },
    async delete(id) {
      m.delete(id)
    },
    async clear() {
      m.clear()
    },
  }
}

function idbStorage(): StorageAdapter {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  const tx = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const req = fn(t.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      t.oncomplete = () => db.close()
    })
  }
  return {
    async all() {
      try {
        return (await tx<LocalObservation[]>('readonly', s => s.getAll() as IDBRequest<LocalObservation[]>)) || []
      } catch {
        return []
      }
    },
    async put(rec) {
      await tx('readwrite', s => s.put(rec) as IDBRequest<IDBValidKey>)
    },
    async delete(id) {
      await tx('readwrite', s => s.delete(id) as IDBRequest<undefined>)
    },
    async clear() {
      await tx('readwrite', s => s.clear() as IDBRequest<undefined>)
    },
  }
}

let storage: StorageAdapter | null = null
function getStorage(): StorageAdapter {
  if (!storage) {
    // 没有 IndexedDB（老浏览器/隐私模式）就退化成内存 —— 功能不残废，只是不跨刷新
    storage = typeof indexedDB !== 'undefined' ? idbStorage() : memStorage()
  }
  return storage
}
/** 单测注入用 */
export function __setStorageForTest(adapter: StorageAdapter | null): void {
  storage = adapter
}

async function appendLocal(rec: LocalObservation): Promise<void> {
  const st = getStorage()
  await st.put(rec)
  // 每次写入顺手淘汰（写多读少，避免每次读都全表扫）
  const all = await st.all()
  const kept = pruneByCount(pruneByTtl(all, Date.now()), MAX_RECORDS)
  const keepIds = new Set(kept.map(r => r.id))
  for (const r of all) {
    if (!keepIds.has(r.id)) await st.delete(r.id)
  }
}

/* ============================ 观察会话 ============================ */

export type ObserveState = 'off' | 'requesting' | 'on' | 'error'

export interface ObserveOptions {
  /** 采样间隔 ms，默认 1500 */
  sampleMs?: number
  /** 认出一段文字（原文，仅本机）；v10.92：第 4 参带每行几何（供版面区域感知切片） */
  onText?: (text: string, summary: LocalSummary, source: string, lines?: OcrLine[]) => void
  onError?: (e: unknown) => void
  onStateChange?: (s: ObserveState) => void
}

let session: {
  stream: MediaStream
  video: HTMLVideoElement
  canvas: HTMLCanvasElement
  timer: number
  prevHash: string | null
  lastOcrAt: number
  busy: boolean
} | null = null
let state: ObserveState = 'off'

const setState = (s: ObserveState, onStateChange?: (s: ObserveState) => void) => {
  state = s
  onStateChange?.(s)
}

export function isObserving(): boolean {
  return state === 'on' || state === 'requesting'
}

export function getObserveState(): ObserveState {
  return state
}

/**
 * 开始观察。**必须由用户点击直接调用**（getDisplayMedia 需要用户手势，
 * 且浏览器会弹系统级来源选择器 —— 这个授权是绕不过去的，也正是我们要的安全感）。
 */
export async function startObservation(opts: ObserveOptions = {}): Promise<void> {
  if (session) return
  setState('requesting', opts.onStateChange)
  try {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('当前浏览器不支持屏幕捕获（需要 Chrome/Edge/Safari 14+）')
    }
    // 只要视频，不要音频：我们要的是「看到」，不是「听到」
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: false,
    })
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    // 1px 透明挂在页面上：部分浏览器要求 video 在文档里才会持续出帧；
    // pointer-events:none + 近乎不可见，确保它不干扰任何交互
    video.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1'
    document.body.appendChild(video)
    await video.play().catch(() => undefined)

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('无法创建画布上下文')

    const sampleMs = Math.max(800, opts.sampleMs ?? 1500)
    const stateObj = { stream, video, canvas, timer: 0, prevHash: null as string | null, lastOcrAt: 0, busy: false }
    session = stateObj

    // 用户在浏览器原生 UI 里点「停止共享」时，立刻收手
    stream.getVideoTracks().forEach(track => {
      track.addEventListener('ended', () => stopObservation())
    })

    stateObj.timer = window.setInterval(() => {
      void tick(stateObj, ctx, opts)
    }, sampleMs)

    setState('on', opts.onStateChange)
  } catch (e) {
    setState('error', opts.onStateChange)
    opts.onError?.(e)
  }
}

/**
 * 抓一帧：优先用 ImageCapture.grabFrame() 拿**全分辨率** ImageBitmap（比 video
 * 当前帧清晰，尤其小字），缩放后读回 ImageData；拿不到 / 报错就退回原来的
 * video+drawImage 老路。两个 ImageBitmap 都在 finally 里立即 close —— 像素即用即弃，
 * 绝不缓存、绝不跨帧保留。lib.dom 里那个 ImageCapture 不含 grabFrame，故按结构类型
 * 在 globalThis 上查一个带 grabFrame 的构造签名（不额外加 @types）。
 */
async function captureFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  track: MediaStreamTrack | undefined,
): Promise<ImageData> {
  // 此环境的 lib.dom 也声明了一个（不含 grabFrame 的）ImageCapture，typeof globalThis & {...}
  // 的交集会让 new 命中那个旧构造签名。末尾的 as unknown as 把类型收窄回我们的结构类型
  // （仍是对 globalThis 的结构性查取，不加任何 @types）。
  const ImageCaptureCtor = (globalThis as typeof globalThis & {
    ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> }
  }).ImageCapture as unknown as
    | (new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> })
    | undefined

  if (ImageCaptureCtor && track) {
    let grabbed: ImageBitmap | null = null
    let copy: ImageBitmap | null = null
    try {
      const cap = new ImageCaptureCtor(track)
      const frame: ImageBitmap = await cap.grabFrame()
      grabbed = frame
      const scaled: ImageBitmap = await createImageBitmap(frame)
      copy = scaled
      const scale = Math.min(1, MAX_OCR_EDGE / Math.max(scaled.width, scaled.height))
      canvas.width = Math.max(1, Math.round(scaled.width * scale))
      canvas.height = Math.max(1, Math.round(scaled.height * scale))
      ctx.drawImage(scaled, 0, 0, canvas.width, canvas.height)
      return ctx.getImageData(0, 0, canvas.width, canvas.height)
    } catch {
      // 落到下面的 video 老路
    } finally {
      // 像素即用即弃：两个 bitmap 都必须在返回前关闭，绝不外泄 / 缓存
      try { grabbed?.close() } catch { /* 已关闭 */ }
      try { copy?.close() } catch { /* 已关闭 */ }
    }
  }

  // 退回原来的 video + drawImage + getImageData 路径（同样的 MAX_OCR_EDGE 缩放）
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return ctx.createImageData(1, 1)
  const scale = Math.min(1, MAX_OCR_EDGE / Math.max(vw, vh))
  canvas.width = Math.max(1, Math.round(vw * scale))
  canvas.height = Math.max(1, Math.round(vh * scale))
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

async function tick(
  s: NonNullable<typeof session>,
  ctx: CanvasRenderingContext2D,
  opts: ObserveOptions,
): Promise<void> {
  // 上一帧的 OCR 还没跑完就别再叠一帧（识别比采样慢时防止任务堆积）
  if (s.busy) return
  try {
    s.busy = true
    // 优先全分辨率 grabFrame；拿不到再退回 video+drawImage（详见 captureFrame）
    const image = await captureFrame(s.canvas, ctx, s.video, s.stream.getVideoTracks()[0])
    const hash = frameDiffHash(image.data, image.width, image.height)
    // v10.75：画面没变也按兜底节拍认字（读文章时屏幕是静止的）
    if (!shouldCapture(s.prevHash, hash, s.lastOcrAt, Date.now(), MIN_CAPTURE_GAP_MS)) return
    s.prevHash = hash
    s.lastOcrAt = Date.now()

    const { text, confidence, meanWordConf, keptRatio, lines } = await recognizeText(image)
    if (!text) return
    const summary = summarizeLocally(text)
    // 质量闸：置信度太低 / 文字太乱 / 逐词清洗后保留率或均置信度过低 → 丢帧
    if (
      confidence < MIN_OCR_CONFIDENCE ||
      summary.quality < MIN_TEXT_QUALITY ||
      keptRatio < MIN_KEPT_RATIO ||
      meanWordConf < MIN_WORD_CONF
    ) return
    await appendLocal({
      id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      text,
      source: s.stream.getVideoTracks()[0]?.label || '屏幕',
    })
    opts.onText?.(text, summary, s.stream.getVideoTracks()[0]?.label || '屏幕', lines)
  } catch (e) {
    // 单帧失败不终止整个观察（可能只是切了个全屏动画）
    opts.onError?.(e)
  } finally {
    s.busy = false
  }
}

/** 停止观察并释放一切（视频流、canvas、计时器） */
export function stopObservation(): void {
  if (!session) {
    setState('off')
    return
  }
  const s = session
  session = null
  window.clearInterval(s.timer)
  try {
    s.stream.getTracks().forEach(t => t.stop())
  } catch {
    /* 已经断了 */
  }
  try {
    s.video.srcObject = null
    s.video.remove()
  } catch {
    /* 已经移除 */
  }
  s.canvas.width = 0
  s.canvas.height = 0
  setState('off')
}

/** 一键清空本地观察数据（隐私面板里的「立即清空」） */
export async function clearLocalObservations(): Promise<void> {
  await getStorage().clear()
}

export async function listLocalObservations(limit = 50): Promise<LocalObservation[]> {
  const all = await getStorage().all()
  return all
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit)
}

export async function getLocalStats(): Promise<{ count: number; chars: number; oldestAt: string | null }> {
  const all = await getStorage().all()
  const chars = all.reduce((n, r) => n + (r.text?.length || 0), 0)
  const oldest = all.length ? all.map(r => r.at).sort()[0] : null
  return { count: all.length, chars, oldestAt: oldest }
}

/* ============================ 测试导出 ============================ */

export const __test = {
  frameDiffHash,
  hamming,
  shouldOcr,
  shouldCapture,
  FORCE_OCR_MS,
  MIN_CAPTURE_GAP_MS,
  MAX_OCR_EDGE,
  MIN_OCR_CONFIDENCE,
  MIN_TEXT_QUALITY,
  assessTextQuality,
  quality: assessTextQuality,
  pruneByTtl,
  pruneByCount,
  summarizeLocally,
  memStorage,
}
