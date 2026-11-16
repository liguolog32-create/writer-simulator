/**
 * 本地 OCR 封装（机器人「观澜」· v10.65）
 *
 * 为什么自己包一层：
 *  1. **懒加载** —— tesseract.js 的 wasm + 中文语言包有好几 MB，只有用户真的开启
 *     「被动观察」时才下载，不拖慢首屏；
 *  2. **串行化** —— 同一时刻只跑一个识别。屏幕采样是 1.5s 一帧，如果识别比采样慢，
 *     任务会堆积把内存打爆（这是很容易踩的坑）；
 *  3. **路径可覆盖** —— 默认走 CDN（tesseract.js 的默认行为），国内访问慢时可改成
 *     自托管（把 worker/core/lang 三个文件放到自己的 Pages 静态目录即可）。
 *
 * 隔离：本模块只做「像素 → 文字」，**不发任何业务网络请求**，不碰云端同步。
 * （唯一会联网的时刻：首次下载 tesseract 的 wasm 与语言包，可用 configureOcr 改成自托管。）
 */

export interface OcrPaths {
  workerPath?: string
  corePath?: string
  langPath?: string
}

/** tesseract worker 的最小结构（避免把 tesseract.js 的类型拖进来） */
interface OcrWorker {
  recognize(
    image: HTMLCanvasElement,
    opts?: unknown,
    output?: Record<string, boolean>,
  ): Promise<{ data: { text?: string; confidence?: number; tsv?: string } }>
  setParameters(params: Record<string, string>): Promise<unknown>
  terminate(): Promise<unknown>
}

/** TSV（level===5）里的一个词：逐词置信度 + 几何信息（供按行重排与清洗） */
export interface TsvWord {
  level: number
  block: number
  par: number
  line: number
  word: number
  left: number
  top: number
  width: number
  height: number
  conf: number
  text: string
}

/** cleanOcrResult 的返回：清洗后的文本 + 逐词置信度统计 */
export interface CleanOcrText {
  text: string
  meanWordConf: number
  keptRatio: number
}

/** recognizeText 的返回：文字 + MeanTextConf 置信度 + 逐词清洗统计（供上层做质量闸） */
export interface OcrResult {
  text: string
  /** 页面级 MeanTextConf（保留原语义，逐词统计另见 meanWordConf） */
  confidence: number
  /** 清洗后保留词的平均逐词置信度 */
  meanWordConf: number
  /** 保留词数 / 全部词数 */
  keptRatio: number
  /** v10.92：每行保留词的并集几何（供上层做版面区域感知切片）；无 TSV 时缺省 */
  lines?: OcrLine[]
}

/** 一行 OCR 文本：文本 + 该行保留词的并集几何（坐标为 toCanvas 放大后坐标系） */
export interface OcrLine {
  text: string
  x: number
  y: number
  w: number
  h: number
}

/** CJK 表意文字 + 假名 + 谚文（判断脚本边界用；勿加 g 标志，以免 test 带状态） */
export const CJK_RE = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/

/** ASCII 单词（含常见标点/数字）；两个相邻 token 都命中才补空格 */
export const ASCII_WORD_RE = /^[A-Za-z0-9'.,%+\-/]+$/

/** 图像预处理开关：置 false 可 A/B 对比，退回旧的 1:1 贴图像素行为 */
export const OCR_PREPROCESS = true

/**
 * 解析 tesseract TSV，只取 level===5 的词行。
 *
 * 本自托管核心（tesseract-core-simd.wasm.js）产出的 TSV **没有表头**，直接按
 * 12 列固定下标读：level(0)/.../conf(10)/text(11)。未来换核若带表头，则按列名定位。
 * 丢掉空文本、conf 非有限值或负数的行（levels 1-4 的 conf=-1 本就不是词）。
 */
export function parseTsvWords(tsv: string | undefined): TsvWord[] {
  if (!tsv) return []
  const rows = tsv.split(/\r?\n/).filter(l => l.length > 0).map(l => l.split('\t'))
  if (rows.length === 0) return []

  const hasHeader = rows[0][0] === 'level'
  const header: Record<string, number> = {}
  if (hasHeader) {
    rows[0].forEach((name, i) => { header[name] = i })
    rows.shift()
  }
  // 有表头按列名定位，无表头退回 12 列固定下标
  const idx = (name: string, fallback: number): number =>
    hasHeader && Number.isFinite(header[name]) ? header[name] : fallback
  const iLevel = idx('level', 0)
  const iBlock = idx('block_num', 2)
  const iPar = idx('par_num', 3)
  const iLine = idx('line_num', 4)
  const iWord = idx('word_num', 5)
  const iLeft = idx('left', 6)
  const iTop = idx('top', 7)
  const iWidth = idx('width', 8)
  const iHeight = idx('height', 9)
  const iConf = idx('conf', 10)
  const iText = idx('text', 11)

  const num = (r: string[], i: number): number => {
    const v = Number(r[i])
    return Number.isFinite(v) ? v : 0
  }
  const out: TsvWord[] = []
  for (const r of rows) {
    if (Number(r[iLevel]) !== 5) continue
    const text = (r[iText] ?? '').trim()
    if (!text) continue
    const conf = Number(r[iConf])
    if (!Number.isFinite(conf) || conf < 0) continue
    out.push({
      level: 5,
      block: num(r, iBlock),
      par: num(r, iPar),
      line: num(r, iLine),
      word: num(r, iWord),
      left: num(r, iLeft),
      top: num(r, iTop),
      width: num(r, iWidth),
      height: num(r, iHeight),
      conf,
      text,
    })
  }
  return out
}

/** 两个相邻 token 之间要不要补空格：脚本切换（CJK↔非CJK），或两边都是 ASCII 单词 */
function needSpace(prev: string, next: string): boolean {
  if (CJK_RE.test(prev) !== CJK_RE.test(next)) return true
  return ASCII_WORD_RE.test(prev) && ASCII_WORD_RE.test(next)
}

/**
 * 逐词置信度清洗的共享内核：按 conf>=minWordConf 丢掉乱码词，再按 (block,par,line)
 * 分组、行内按 left 排序、行间按 top 排序，用脚本边界规则重排；同时给出每行保留词
 * 的并集几何（v10.92 供上层做版面区域感知）。没有任何合法 TSV 词时退回 data.text。
 */
function cleanOcrInternal(
  data: { text?: string; confidence?: number; tsv?: string } | undefined,
  minWordConf: number,
): CleanOcrText & { lines: OcrLine[] } {
  const all = parseTsvWords(data?.tsv)
  const pageConf = Number(data?.confidence) || 0
  if (all.length === 0) {
    return { text: (data?.text || '').trim(), meanWordConf: pageConf, keptRatio: 1, lines: [] }
  }

  const kept = all.filter(w => w.conf >= minWordConf)
  const keptRatio = kept.length / all.length
  const meanWordConf = kept.length
    ? kept.reduce((sum, w) => sum + w.conf, 0) / kept.length
    : 0

  // 按 (block,par,line) 分组
  const groups = new Map<string, TsvWord[]>()
  for (const w of kept) {
    const key = `${w.block}|${w.par}|${w.line}`
    const group = groups.get(key)
    if (group) group.push(w)
    else groups.set(key, [w])
  }
  const ordered = [...groups.values()].map(group => {
    group.sort((a, b) => a.left - b.left)
    const top = group.reduce((m, w) => Math.min(m, w.top), Infinity)
    return { top: Number.isFinite(top) ? top : 0, group }
  })
  ordered.sort((a, b) => a.top - b.top)

  const lines: OcrLine[] = ordered.map(({ group }) => {
    let line = ''
    for (let i = 0; i < group.length; i++) {
      const t = group[i].text
      line += i === 0 ? t : (needSpace(group[i - 1].text, t) ? ' ' : '') + t
    }
    const x = group.reduce((m, w) => Math.min(m, w.left), Infinity)
    const y = group.reduce((m, w) => Math.min(m, w.top), Infinity)
    const r = group.reduce((m, w) => Math.max(m, w.left + w.width), -Infinity)
    const b = group.reduce((m, w) => Math.max(m, w.top + w.height), -Infinity)
    return {
      text: line,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      w: Number.isFinite(r) ? r - x : 0,
      h: Number.isFinite(b) ? b - y : 0,
    }
  })
  const text = lines.map(l => l.text).join('\n')
  return { text, meanWordConf, keptRatio, lines }
}

/** v10.92：结构化清洗 —— 文本 + 每行保留词并集几何（text 输出与 cleanOcrResult 逐字节一致） */
export function cleanOcrStructured(
  data: { text?: string; confidence?: number; tsv?: string } | undefined,
  minWordConf = 40,
): { text: string; lines: OcrLine[] } {
  const { text, lines } = cleanOcrInternal(data, minWordConf)
  return { text, lines }
}

/**
 * 逐词置信度清洗：按 conf>=minWordConf 丢掉乱码词，再按 (block,par,line) 分组、
 * 行内按 left 排序、行间按 top 排序，用脚本边界规则重排成干净文本。
 * 没有任何合法 TSV 词时退回 data.text（meanWordConf=页面置信度，keptRatio=1）。
 */
export function cleanOcrResult(
  data: { text?: string; confidence?: number; tsv?: string } | undefined,
  minWordConf = 40,
): CleanOcrText {
  const { text, meanWordConf, keptRatio } = cleanOcrInternal(data, minWordConf)
  return { text, meanWordConf, keptRatio }
}

/** 复用的离屏 canvas：ImageData 不能直接喂给 tesseract（它只认 canvas/路径/blob），必须先贴上来 */
let ocrCanvas: HTMLCanvasElement | null = null
/** 源图 scratch：先把原始 ImageData 贴上来，再缩放绘制到 ocrCanvas */
let srcCanvas: HTMLCanvasElement | null = null

/**
 * 只做高画质几何放大，**不做任何阈值化 / 二值化 / 整体反色**。
 *
 * 为什么移除二值化：Tesseract 内部本来就会对输入做自适应二值化；我们再叠一层
 * 全局 Otsu 硬黑白等于「双重二值化」—— 小号 CJK 字形的抗锯齿浅灰笔画被全局
 * 阈值判成白色直接抹掉，识别结果反而退化成拉丁乱码。暗底亮字也不做整体反色：
 * 靠全图平均亮度做的全局猜测，在暗色屏上遇到亮区会翻错。放大后把原始灰度
 * 信息交给 Tesseract 自己判断，小字笔画才留得住。
 */
function toCanvas(image: ImageData): HTMLCanvasElement {
  if (!ocrCanvas) ocrCanvas = document.createElement('canvas')

  // A/B：关掉预处理时完全退回旧行为（1:1 putImageData）
  if (!OCR_PREPROCESS) {
    if (ocrCanvas.width !== image.width || ocrCanvas.height !== image.height) {
      ocrCanvas.width = image.width
      ocrCanvas.height = image.height
    }
    const ctx = ocrCanvas.getContext('2d')
    if (!ctx) throw new Error('无法创建 OCR 画布上下文')
    ctx.putImageData(image, 0, 0)
    return ocrCanvas
  }

  const w = image.width
  const h = image.height
  if (!srcCanvas) srcCanvas = document.createElement('canvas')
  if (srcCanvas.width !== w || srcCanvas.height !== h) {
    srcCanvas.width = w
    srcCanvas.height = h
  }
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true })
  if (!sctx) throw new Error('无法创建 OCR 画布上下文')
  sctx.putImageData(image, 0, 0)

  // 小/中尺寸画面强制约 2× 放大（实测小字可读性全靠 2×，分条带切图无效）；
  // 同时受最长边 3200 与总像素 12MP 双重上限约束，大屏不盲目放大。
  const k = Math.max(1, Math.min(2, 3200 / Math.max(w, h), Math.sqrt(12_000_000 / (w * h))))
  const tw = Math.max(1, Math.round(w * k))
  const th = Math.max(1, Math.round(h * k))

  if (ocrCanvas.width !== tw || ocrCanvas.height !== th) {
    ocrCanvas.width = tw
    ocrCanvas.height = th
  }
  const ctx = ocrCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 OCR 画布上下文')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(srcCanvas, 0, 0, tw, th)
  return ocrCanvas
}

let paths: OcrPaths = {}
let workerPromise: Promise<OcrWorker> | null = null

/** OCR 资源加载状态（UI 用来给明确提示：CDN 被墙时要知道是哪一步挂了） */
export type OcrStatus = 'idle' | 'loading' | 'ready' | 'error'
let ocrStatus: OcrStatus = 'idle'
export function getOcrStatus(): OcrStatus {
  return ocrStatus
}

/**
 * 覆盖资源路径。
 * 默认用**自托管**资源（public/ocr/ 下随站点一起发布，共约 9.5MB）：
 * 国内访问 cdn.jsdelivr.net 经常超时，自托管后「本机认字」才真正可用，
 * 也顺带满足「数据不出本机」——连 OCR 的 wasm/语言包都不走外部 CDN。
 */
export function configureOcr(next: OcrPaths): void {
  paths = { ...paths, ...next }
}

/** 默认路径（自托管，站点部署在根路径 —— Cloudflare Pages 无 base；若将来自建 base 可用 configureOcr 覆盖） */
function defaultPaths(): OcrPaths {
  return {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/tesseract-core-simd.wasm.js',
    langPath: '/ocr/',
  }
}

async function getWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    ocrStatus = 'loading'
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      const p = { ...defaultPaths(), ...paths }
      const opts: Record<string, unknown> = {}
      if (p.workerPath) opts.workerPath = p.workerPath
      if (p.corePath) opts.corePath = p.corePath
      if (p.langPath) opts.langPath = p.langPath
      let timedOut = false
      let createdWorker: OcrWorker | null = null
      // v7 会静默吞掉初始化失败：worker 内部报错时把状态打回 error 并清空缓存，
      // 否则 UI 会一直显示「准备中」而再也不会重试。
      opts.errorHandler = () => {
        ocrStatus = 'error'
        workerPromise = null
        if (createdWorker) void createdWorker.terminate().catch(() => undefined)
      }
      // oem=1：LSTM_only，7.0 默认引擎。createWorker 可能永久挂起，用 30s 超时兜底。
      // 超时只是放弃等待：底层 createWorker 之后仍可能 resolve，那个迟到的 worker
      // 必须就地 terminate，否则 wasm 线程会一直挂着泄漏。
      const creating = createWorker(['chi_sim', 'eng'], 1, opts).then(w => {
        const cw = w as unknown as OcrWorker
        createdWorker = cw
        if (timedOut) void cw.terminate().catch(() => undefined)
        return w
      })
      const w = (await Promise.race([
        creating,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => {
            timedOut = true
            reject(new Error('OCR worker 初始化超时（30s）'))
          }, 30_000),
        ),
      ])) as unknown as OcrWorker
      // 只设一次。不要请求 output.blocks / layoutBlocks —— 自托管的
      // tesseract-core-simd.wasm.js 是旧核，缺 GetJSONText，请求 blocks 会让 recognize 直接 reject。
      await w.setParameters({
        tessedit_pageseg_mode: '11', // PSM.SPARSE_TEXT —— 整屏混杂 UI 文字
        user_defined_dpi: '300', // 截图没有 DPI，压掉 70dpi 回退告警
        preserve_interword_spaces: '1',
      })
      ocrStatus = 'ready'
      return w
    })().catch(err => {
      // 失败要清空缓存，否则一次失败后永远起不来
      workerPromise = null
      ocrStatus = 'error'
      throw err
    })
  }
  return workerPromise
}

/** 串行队列：识别再慢也不会并发堆积 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * 认字。**永远 resolve**（识别失败返回空结果）——
 * 观察是后台功能，OCR 崩了不该把调用方带崩。
 */
export function recognizeText(image: ImageData): Promise<OcrResult> {
  const run = queue.then(async () => {
    const worker = await getWorker()
    // 只要 text + tsv（逐词置信度）；**绝不请求 blocks/layoutBlocks** —— 自托管核
    // 缺 GetJSONText，一请求就 TypeError。乱码词的过滤在 cleanOcrResult 里按 conf 完成。
    const { data } = await worker.recognize(toCanvas(image), {}, { text: true, tsv: true })
    const cleaned = cleanOcrInternal(data, 40)
    return {
      text: cleaned.text,
      confidence: Number(data?.confidence) || 0,
      meanWordConf: cleaned.meanWordConf,
      keptRatio: cleaned.keptRatio,
      lines: cleaned.lines,
    }
  })
  // 队列本身吞掉错误，避免一次失败卡死后续所有识别
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run.then(
    v => v,
    () => ({ text: '', confidence: 0, meanWordConf: 0, keptRatio: 0 }),
  )
}

/** 观察停止时可以释放 wasm 内存（下次开启会重新加载） */
export async function disposeOcr(): Promise<void> {
  const pending = workerPromise
  workerPromise = null
  if (!pending) return
  try {
    const worker = await pending
    await worker.terminate()
  } catch {
    /* 关就关了，terminate 失败无所谓 */
  }
}

/** 供 UI 显示状态用：wasm/语言包是否已就绪 */
export function isOcrReady(): boolean {
  return workerPromise !== null
}
