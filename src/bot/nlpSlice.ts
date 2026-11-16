/**
 * 识海 · NLP 切片（v10.82）
 *
 * 把一屏 OCR 文本切成「确实过了一遍识别/切片」的可采信内容。
 * 纯函数、零依赖（只借运行环境内置的 Intl.Segmenter），不碰 DOM / 网络，
 * 也不 import screensee.ts / memory.ts（避免循环依赖）。
 *
 * 设计动机（用户 2026-11-08 实测）：
 *   · 旧 topics 是对整屏文本扫 50 词词典，13 条真实云端摘要里 topics 与 gist
 *     重叠 0/29 = 0% —— 命中的全是浏览器 chrome 上的「工作/聊天/消息」；
 *   · Intl.Segmenter 会产生 66 个孤立单字 vs 54 个 ≥2 字词 —— 单字是噪声。
 * 所以：只在「有效可读行」里取词/取话题，单字、停用词、UI chrome 一律剔除。
 */

export interface SliceResult {
  /** 信息词（去重、按词频排序，最多 12） */
  words: string[]
  /** 有效可读行（最多 3） */
  phrases: string[]
  /** 信息量最高的一行；没有则 ''。受隔离硬规则限制，最多 MAX_KEYLINE_CHARS 字 */
  keyLine: string
  /** v10.90 段落级摘录：以 keyLine 为中心合并相邻有效行（跨行段落不再被拆散），≤ MAX_KEYTEXT_CHARS 字 */
  keyText: string
  persons: string[]
  entities: string[]
  topics: string[]
  /** 0..1 */
  score: number
  valid: boolean
  /** v10.93：主区内的说话人（仅主区偏好生效时产出；否则 undefined）。宁可中性也不张冠李戴 */
  keySpeakers?: string[]
  /** v10.93：主区内的切出词（仅主区偏好生效时产出；words/entities/topics 仍保持全量口径） */
  regionWords?: string[]
  /** v10.94：完整度达标的「整体单元」（仅 constrain 时产出）——一条推文/一段消息/一段文章 */
  wholeUnit?: { text: string; score: number; speaker?: string; words: string[] }
  /** v10.94：constrain 且整屏找不到达标单元 → true（宁可漏记不错记）；无几何不产出 */
  noWholeUnit?: boolean
  stats: { lines: number; keptLines: number; words: number; keptWords: number }
}

/* ---------------------- 具名阈值（供单测断言 / 调优） ---------------------- */
export const MIN_LINE_LEN = 8
export const MIN_READABLE_RATIO = 0.65
export const MIN_LINE_WORDS = 2
export const MAX_WORDS = 12
export const MAX_PHRASES = 3
export const MAX_ENTITIES = 6
export const MAX_TOPICS = 6
export const MAX_PERSONS = 3
/** 隔离硬规则：keyLine 只留短语级转述，绝不把整段原文带进上云的 content */
export const MAX_KEYLINE_CHARS = 48
/** v10.90（用户明确要求升级）：识海要能反映「浏览时到底在浏览什么」，
 *  keyLine 的单行短语不够 —— 合并相邻有效行为段落级摘录，上限 220 字。
 *  这仍然是白名单摘录（有上限、过闸门），截图与 OCR 全文依旧只在本机。 */
export const MAX_KEYTEXT_CHARS = 220
/** v10.91：keyText 邻居合并的最低实词覆盖率 —— OCR 乱串（如「黄广内允轨学」切不出实词）
 *  视为段落断裂，不并进摘录。正常中文在 jieba 下 ≥0.5，乱串 <0.25。 */
export const MIN_NEIGHBOR_COVERAGE = 0.3
export const MIN_KEPT_WORDS = 4
export const MIN_KEPT_LINES = 1
export const MIN_SCORE = 0.30
export const MIN_KEYLINE_LEN = 8

/* ---------------------- 可读字符 / 噪声表 ---------------------- */
// 允许的字符 = 中日韩汉字 / 拉丁字母数字 / 常见中英标点 / 空白
const READABLE_RE = /[\u4e00-\u9fa5A-Za-z0-9，。！？、；：“”‘’（）【】《》…—\s,.;:!?()"'\-]/

/** 长而独特的浏览器 / 应用界面文案：行里出现就整行判 UI */
const UI_PHRASES = [
  '正在共享您的屏幕', '所有书签', 'writer-simulator.pages.dev', 'Cloudflare Dashboard',
  'WorkBuddy', '文件传输助手', '管理后台', '今日已领', '资料库', '收藏夹', '服务号', '通讯录',
  // v10.8x：应用窗口常驻在共享屏幕里，会把自己的 setNote 提示语 OCR 回来，
  // 因为「是通顺中文」过了 slice.valid，又被写进识海 / D1（自我反馈回路）。
  // 这些行一律整行剔除；但绝不因出现它们就把整屏判无效 —— 同屏其它真实内容仍可过闸门。
  '看到了但没记', '这一幕没有切出可采信的内容', '未通过 NLP 切片', '这一幕文字太乱',
  '20 分钟内已经记过这一幕', '记下了：', '屏幕上是一篇长文', '读到的要点', '切出：',
  '屏幕上出现了', '屏幕上的群聊里',
  // v10.91：识海卡片本身被 OCR 吃回来（用户开着观察看识海页）→「记忆吃记忆」反哺。
  // 卡片正文模板短语整行剔除；场景级熔断（memory.isSelfAppScreen）再兜一层。
  // 注意不带裸「记下了」——v10.85 契约：含禁用词的行仍要词级选择性过滤（「记下了：」带冒号足够）。
  '屏幕上的对话里', '屏幕内容读到', '有人说到', '读到：「', '我注意到', '长文《',
  // v10.89：WPS/办公套件工具栏。真实观察（2026-11-09）WPS 顶栏按钮被 OCR 合并成一行
  // 「会员专享”表格工具”表格样式论文助手」，因「通顺中文」过了 valid 闸还占了 keyLine/gist。
  '会员专享', '表格工具', '表格样式', '论文助手', '文档工具', '演示工具', '图片工具', '稻壳会员', '输出为PDF',
]
/** 短 UI 词：整行恰好等于它才判 UI；作为词则一律剔除 */
const UI_WORDS = ['连接', '编辑', '显示', '窗口', '帮助']
/** 词级黑名单（短 UI 词 + 可能被切成词的短界面词 + 反馈串里最独特的词，防止混进 words / entities /「切出：」列表） */
const UI_WORD_SET = new Set([
  ...UI_WORDS, '通讯录', '资料库', '收藏夹', '服务号', '所有书签', '管理后台', '今日已领', '文件传输助手',
  '采信', '未通过', '记下了', '看到了', '这一幕', '切片',
  // v10.89：WPS 工具栏词不进 words / entities /「切出：」列表
  '会员专享', '表格工具', '表格样式', '论文助手', '文档工具', '演示工具', '图片工具', '稻壳会员',
])
const STOPWORDS = new Set([
  '的', '了', '和', '在', '是', '有', '也', '就', '但', '还', '把', '被', '为', '不', '很', '更', '相当',
  '这种', '所谓', '无论', '一个', '可以', '什么', '怎么', '自己', '他们', '我们', '你们', '它', '这', '那',
])
/** 资料页字段名：冒号前不是人名 */
const LABEL_KEY_RE = /^(标签|昵称|备注|来源|描述|地区|职位|公司|签名|微信号|邮箱|电话|共同群聊)[:：]/
const SPEAKER_RE = /^([一-龥·]{2,4})[:：]/
/**
 * v10.93：feed 元数据分隔行（「r/stocks. 1 分 10 评论」「3 hours ago 42 comments」这类）。
 * 纯文本判定，零 import —— 只看这一行的字符串本身。
 */
export function isFeedMetaLine(line: string): boolean {
  const l = line.trim()
  if (l.length === 0 || l.length > 48) return false
  return /(^|\s)r\/[A-Za-z0-9_]{2,}\b|\b\d{1,5}\s*(评论|回复|赞|票|分|秒|小时)(\s|$|[,，.。·])|\b\d{1,5}\s*(comments?|points?|votes?|likes?|hours?|mins?)\b/i.test(
    l,
  )
}

/* ==================== v10.94 整元收录 ====================
 * 用户需求：「一张截图，不看里面所有内容，只对其中一部分看起来是一个整体的
 * 内容进行识别并收录」——把屏幕切成候选整体单元（一条推文 / 一段消息 / 一段
 * 文章），给每个单元打完整度分，达标才收录；整屏找不到达标单元就跳过不记。
 */

/** 行首 @handle（Twitter / 微博作者行） */
const UNIT_HANDLE_START_RE = /^@[A-Za-z0-9_]{2,}/
/** 名字+@handle 前缀（「橘子 @Hannah_juzi…」「牛牛不讲理您 @NiuNiu99911…」） */
const UNIT_HANDLE_PREFIX_RE = /^[^\s@:：]{1,12}\s*@[A-Za-z0-9_]{2,}/
/** 单元终止标点（trim 后的 text 结尾） */
const UNIT_TERMINAL_RE = /[。！？…”」』!?]$/
/** 完整度分达标线：≥ 它的单元才算「一个整体」收录（测试用常量校准） */
export const WHOLE_UNIT_MIN_SCORE = 60

/**
 * 单元起始行判定（纯文本，OCR 可能把作者行与正文合并成一行，故行长不设上限，
 * 但 @handle 必须出现在前 40 字符内才认定是作者行 —— 推文正文里 @ 别人不算）。
 */
export function isUnitStartLine(line: string): boolean {
  const l = line.trim()
  if (!l) return false
  if (UNIT_HANDLE_START_RE.test(l)) return true
  if (UNIT_HANDLE_PREFIX_RE.test(l.slice(0, 40))) return true
  // 冒号说话人行（与 sameTurn/detectPersons 同一把 SPEAKER_RE；资料页字段行不算）
  return SPEAKER_RE.test(l) && !LABEL_KEY_RE.test(l)
}

/** 从起始行提取说话人：@handle 前的名字优先（如「橘子」「牛牛不讲理您」），否则 @handle 本身 */
export function unitSpeakerOf(line: string): string | null {
  const l = line.trim()
  if (!l) return null
  const m = l.slice(0, 40).match(/^(?:@([A-Za-z0-9_]{2,})|([^\s@:：]{1,12})\s*@[A-Za-z0-9_]{2,})/)
  if (m) {
    const name = (m[2] || m[1]).replace(/[.。,，!！?？:：;；~…]+$/, '')
    return name || null
  }
  if (SPEAKER_RE.test(l) && !LABEL_KEY_RE.test(l)) return l.match(SPEAKER_RE)![1]
  return null
}
/** 不像人名的常见词尾：风险提示 / 免责声明 / 方案 / 至今 … —— 保守起见一律不当人名 */
const NON_NAME_RE = /(提示|声明|注意|免责|说明|摘要|备注|标题|正文|来源|时间|日期|状态|结果|方案|至今|模失|内容|作者)$/
const CJK_RE = /^[一-龥]+$/
const LATIN_RE = /^[A-Za-z][A-Za-z0-9._/\-]*$/
const CONSONANT_CLUSTER_RE = /[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]{4,}/
/**
 * 真·单字名词后缀：ICU 会把「制造业 / 建筑业」切成 制造/业、建筑/业。
 * 在 CJK 词串**中间**（后面还跟着 CJK）时，只有这些字允许被粘回前一个词；
 * 金 / 避 / 全 / 价 这类其实是下一个词的首字，一律不合并。
 * 位于连续 CJK 串末尾（其后是非 CJK/标点/空白/行尾）的单字不受此表限制。
 */
const MERGE_SUFFIX_CHARS = new Set([
  '业', '化', '性', '度', '率', '型', '感', '力', '品', '界', '学', '家', '员', '者',
])

/** dictTopics 缺省时的小内置词典 */
const BUILTIN_TOPICS = [
  '工作', '加班', '项目', '会议', '客户', '需求', '设计', '写作', '故事', '人物',
  '灵感', '小说', '旅行', '健身', '生病', '朋友', '家人', '聊天', '消息', '群聊',
  '老师', '离职', '代码', '孩子', '学校', '工资', '黄金', '央行', '利率', '读书',
]

type SegmenterCtor = new (
  locale: string,
  opts: { granularity: 'word' },
) => { segment(input: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> }

/** 带原文位置的分词片段：合并判定要靠 start/end 来确认「原文里真的紧邻」 */
interface Tok {
  s: string
  start: number
  end: number
  wordLike: boolean
}

function readableRatio(line: string): number {
  const chars = [...line]
  if (!chars.length) return 0
  let hit = 0
  for (const ch of chars) if (READABLE_RE.test(ch)) hit++
  return hit / chars.length
}

function isUILine(line: string): boolean {
  const lower = line.toLowerCase()
  if (UI_PHRASES.some(p => lower.includes(p.toLowerCase()))) return true
  return UI_WORDS.includes(line.trim())
}

function isBlacklistedWord(w: string): boolean {
  return UI_WORD_SET.has(w) || UI_PHRASES.some(p => p === w)
}

function isInformative(w: string): boolean {
  if (!w || STOPWORDS.has(w) || isBlacklistedWord(w)) return false
  if (!/[一-龥A-Za-z0-9]/.test(w)) return false // 纯标点
  if (CJK_RE.test(w)) return w.length >= 2 // CJK：只留 ≥2 字，孤立单字全丢
  if (LATIN_RE.test(w)) {
    if (w.length < 3) return false
    if (CONSONANT_CLUSTER_RE.test(w)) return false // 4+ 辅音连缀 = 全大写乱码
    return true
  }
  return false
}

/* ---------------------- 分词引擎注入点（sync / async 桥） ----------------------
 * nlpSlice 必须保持纯同步、零 import（memory.ts 的同步调用链与纯 Node 回归都依赖它）。
 * 真正的 jieba-wasm 引擎由 loader 在运行时通过 setSegmenter 注入「分词函数」。
 * 默认 customSegment === null：直接走原来的 Intl.Segmenter 分支，行为逐字节不变。
 */
let customSegment: ((line: string) => string[]) | null = null

/** 注入（传 null 清除）自定义分词器；jieba-wasm 是异步懒加载，就绪后才调用。 */
export function setSegmenter(fn: ((line: string) => string[]) | null): void {
  customSegment = fn
}

/** 诊断用：当前实际生效的分词引擎。 */
export function getSegmenterMode(): 'jieba' | 'icu' {
  return customSegment ? 'jieba' : 'icu'
}

/** 词级切分：优先 Intl.Segmenter('zh', word) 并保留每个片段在原文中的位置；
 *  不支持 Segmenter 的老环境退回带位置的双字切分。 */
function segmentTokens(line: string): Tok[] {
  if (customSegment) {
    try {
      const parts = customSegment(line)
      const out: Tok[] = []
      let pos = 0
      for (const s of parts) {
        if (!s) continue
        // jieba 的 cut 逐字保留原文（含标点/空白），从游标找真实位置，
        // 保证 start/end 与原文一致，CJK 合并规则里的紧邻判断才准。
        let start = line.indexOf(s, pos)
        if (start < 0) start = pos // 兜底：个别字符被归一化时按连续处理
        const end = start + s.length
        out.push({ s, start, end, wordLike: /[一-龥A-Za-z0-9]/.test(s) })
        pos = end
      }
      if (out.length) return out
    } catch {
      /* 注入的分词器抛错 → 回退 ICU，保证观察不中断 */
    }
  }
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter
  if (Seg) {
    try {
      const seg = new Seg('zh', { granularity: 'word' })
      const out: Tok[] = []
      for (const part of seg.segment(line)) {
        out.push({
          s: part.segment,
          start: part.index,
          end: part.index + part.segment.length,
          wordLike: Boolean(part.isWordLike),
        })
      }
      if (out.length) return out
    } catch {
      /* 落到带位置的双字切分 */
    }
  }
  // fallback：CJK 连续段切双字 + 拉丁数字词（位置按原文偏移，双字重叠故不会触发合并）
  const out: Tok[] = []
  for (const m of line.matchAll(/[一-龥]+|[A-Za-z0-9]+/g)) {
    const start = m.index ?? 0
    const s = m[0]
    if (/^[一-龥]+$/.test(s)) {
      if (s.length === 1) out.push({ s, start, end: start + 1, wordLike: true })
      else
        for (let i = 0; i + 1 < s.length; i++)
          out.push({ s: s.slice(i, i + 2), start: start + i, end: start + i + 2, wordLike: true })
    } else {
      out.push({ s, start, end: start + s.length, wordLike: true })
    }
  }
  return out
}

/**
 * 能否把尾随单字 t 粘回前一个 ≥2 字 CJK 词 w。全部满足才合并：
 *  · w、t 在原文里紧邻（w.end === t.start）—— 不跨空格/标点边界；
 *  · t 不是停用词 / UI 词 / 标点，合并后长度 ≤ 4；
 *  · t 后面不能紧跟另一个单字 CJK token（那是下一个词的首字：今天金/资金全）；
 *  · t 是连续 CJK 串的最后一个字符（其后为非 CJK / 标点 / 空白 / 行尾）；
 *    唯一例外：t 是 MERGE_SUFFIX_CHARS 里的真后缀且紧跟一个 ≥2 字词 ——
 *    这样「建筑业也就是」里被 ICU 切成 建筑/业 的 建筑业 才能还原，
 *    而「资金全进来了」的 全 不在后缀表里，不会被拼成 资金全。
 */
function canMerge(w: Tok, t: Tok, next: Tok | undefined, line: string): boolean {
  if (!/^[一-龥]{2,}$/.test(w.s)) return false
  if (!/^[一-龥]$/.test(t.s)) return false
  if (w.end !== t.start) return false
  if (STOPWORDS.has(t.s) || isBlacklistedWord(t.s)) return false
  if ((w.s + t.s).length > 4) return false
  // 单字 t 后面紧跟另一个单字 CJK token → t 属于下一个词，绝不合并
  if (next && next.start === t.end && /^[一-龥]$/.test(next.s)) return false
  const after = line[t.end]
  if (after === undefined || !/[一-龥]/.test(after)) return true // 连续 CJK 串末尾
  if (!MERGE_SUFFIX_CHARS.has(t.s)) return false
  return Boolean(next && next.start === t.end && next.s.length >= 2)
}

/** 返回该行的信息词 + 候选词总数（候选数供 score 的 keptWords/words 比例使用） */
function informativeWordsOf(line: string): { words: string[]; candidateCount: number } {
  const candidates = segmentTokens(line).filter(t => t.wordLike || /[A-Za-z0-9]{2,}/.test(t.s))
  const out: string[] = []
  for (let i = 0; i < candidates.length; i++) {
    const w = candidates[i]
    const t = candidates[i + 1]
    let merged = w.s
    if (t && canMerge(w, t, candidates[i + 2], line)) {
      merged = w.s + t.s
      i++
    }
    if (isInformative(merged)) out.push(merged)
  }
  return { words: out, candidateCount: candidates.length }
}

function rankByCount(words: string[], max: number): string[] {
  const count = new Map<string, number>()
  const first = new Map<string, number>()
  words.forEach((w, i) => {
    count.set(w, (count.get(w) || 0) + 1)
    if (!first.has(w)) first.set(w, i)
  })
  return [...count.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        b[0].length - a[0].length ||
        (first.get(a[0]) as number) - (first.get(b[0]) as number),
    )
    .slice(0, max)
    .map(([w]) => w)
}

/** 人名：保守。① 说话人标记且该行有效；② 顶部独立 2-4 字名字重复 ≥2 次。其余一律 [] */
function detectPersons(lines: string[], validSet: Set<string>): string[] {
  const counts = new Map<string, number>()
  for (const l of lines) counts.set(l.trim(), (counts.get(l.trim()) || 0) + 1)
  const found: string[] = []
  const add = (s: string) => {
    if (!s || found.includes(s)) return
    if (STOPWORDS.has(s) || isBlacklistedWord(s) || BUILTIN_TOPICS.includes(s)) return
    if (NON_NAME_RE.test(s)) return
    found.push(s)
  }
  for (const l of lines) {
    if (!validSet.has(l)) continue
    const m = l.match(SPEAKER_RE)
    if (m && !LABEL_KEY_RE.test(l)) add(m[1])
  }
  for (const l of lines.slice(0, 6)) {
    const t = l.trim()
    if (/^[一-龥·]{2,4}$/.test(t) && (counts.get(t) || 0) >= 2 && !LABEL_KEY_RE.test(t)) add(t)
  }
  return found.slice(0, MAX_PERSONS)
}

/* ---------------------- v10.92 版面区域感知 ----------------------
 * 机器人观察管道把整屏拍平成文本流后，跨 UI 区域的内容会被嫁接进同一条摘录
 * （真实事故：微信左侧 11 个互不相干的聊天列表行与右侧聊天窗内容缝进同一条 keyText）。
 * 修复：利用 OCR TSV 已有的词级坐标做「列 + 区块」两级聚类，keyText 邻行合并与
 * keyLine 选取只在同一版面区域内进行。纯同步、确定性、零 import。
 */

/** 一行 OCR 文本的几何（坐标是 toCanvas 放大后的坐标系，聚类只用相对几何） */
export interface SliceLineGeom { x: number; y: number; w: number; h: number }

/**
 * 把屏幕上的行分进「版面区域」：先按 x 轴未被行投影覆盖的竖直间隙切列
 * （要求两侧各有 ≥3 行、且两侧 y 跨度都贯通 ≥0.6×全高，排除聊天气泡左右交错
 * 造成的假间隙），再在列内按 y 向下扫、行间垂直空隙 > 2.4×medianH 时切块。
 * 返回数组与传入 lines 下标对齐；同 (col,block) 的行共享同一 region id。
 */
export function assignScreenRegions(lines: SliceLineGeom[]): number[] {
  const n = lines.length
  if (n === 0) return []
  const hs = lines.map(l => l.h).filter(h => h > 0).sort((a, b) => a - b)
  const medianH = hs.length
    ? (hs.length % 2 ? hs[(hs.length - 1) / 2] : (hs[hs.length / 2 - 1] + hs[hs.length / 2]) / 2)
    : 0
  const minX = Math.min(...lines.map(l => l.x))
  const maxX = Math.max(...lines.map(l => l.x + l.w))
  const yTop = Math.min(...lines.map(l => l.y))
  const yBottom = Math.max(...lines.map(l => l.y + l.h))
  const xSpan = maxX - minX
  const ySpan = yBottom - yTop

  // 列探测：合并所有行的 x 投影，未被覆盖的区间即候选竖直间隙
  const ivls = lines.map(l => [l.x, l.x + l.w] as [number, number]).sort((a, b) => a[0] - b[0])
  const rawGaps: Array<[number, number]> = []
  let cur = minX
  for (const [a, b] of ivls) {
    if (a > cur) rawGaps.push([cur, Math.min(a, maxX)])
    if (b > cur) cur = b
  }
  const gaps = rawGaps
    .filter(([a, b]) => b - a >= 0.012 * xSpan)
    // 显式相交复检：有行与区间 overlap 则该间隙作废
    .filter(([a, b]) => !lines.some(l => l.x < b && l.x + l.w > a))
    .filter(([a, b]) => {
      const left = lines.filter(l => l.x + l.w <= a + medianH * 0.5)
      const right = lines.filter(l => l.x >= b - medianH * 0.5)
      if (left.length < 3 || right.length < 3) return false
      const ls = Math.max(...left.map(l => l.y + l.h)) - Math.min(...left.map(l => l.y))
      const rs = Math.max(...right.map(l => l.y + l.h)) - Math.min(...right.map(l => l.y))
      return ls >= 0.6 * ySpan && rs >= 0.6 * ySpan
    })

  const colOf = new Array<number>(n)
  lines.forEach((l, i) => {
    const cx = l.x + l.w / 2
    let col = 0
    for (const [, b] of gaps) if (b <= cx) col++
    colOf[i] = col
  })

  // 列内分块：按 y 排序，行间垂直空隙 > 2.4×medianH 时开新块
  const byCol = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const arr = byCol.get(colOf[i])
    if (arr) arr.push(i)
    else byCol.set(colOf[i], [i])
  }
  const region = new Array<number>(n).fill(0)
  for (const idxs of byCol.values()) {
    const sorted = [...idxs].sort((a, b) => lines[a].y - lines[b].y)
    let blockIdx = 0
    let prev: SliceLineGeom | null = null
    for (const i of sorted) {
      const l = lines[i]
      if (prev && l.y - (prev.y + prev.h) > 2.4 * medianH) blockIdx++
      region[i] = colOf[i] * 1000 + blockIdx
      prev = l
    }
  }
  return region
}

export function sliceScreenText(
  text: string,
  dictTopics?: string[],
  lines?: SliceLineGeom[],
  domRegions?: number[],
): SliceResult {
  const empty = (lines: number, words: number): SliceResult => ({
    words: [], phrases: [], keyLine: '', keyText: '', persons: [], entities: [], topics: [],
    score: 0, valid: false,
    stats: { lines, keptLines: 0, words, keptWords: 0 },
  })

  const rawLines = String(text || '')
    .split(/\n+/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (!rawLines.length) return empty(0, 0)

  // v10.92 对齐守卫：仅当 lines 与拆行结果等长时启用区域约束；
  // 否则全部行视为同一哨兵区域，行为与无几何时完全一致（backfill 等回退路径的保证）。
  // v10.93 DOM 桥：domRegions 等长时优先于几何聚类（DOM 结构比 OCR 坐标更可靠）；
  // 长度不符 → 聚类回退。constrain 语义不变。
  const regions =
    domRegions && domRegions.length === rawLines.length
      ? domRegions
      : lines && lines.length === rawLines.length
        ? assignScreenRegions(lines)
        : null
  const regionOf = (rawIdx: number): number => (regions ? regions[rawIdx] : -1)

  let allWords = 0
  const perLine: Array<{ line: string; words: string[]; valid: boolean; ri: number }> = []
  for (let ri = 0; ri < rawLines.length; ri++) {
    const line = rawLines[ri]
    const { words, candidateCount } = informativeWordsOf(line)
    allWords += candidateCount
    const valid =
      line.length >= MIN_LINE_LEN &&
      readableRatio(line) >= MIN_READABLE_RATIO &&
      words.length >= MIN_LINE_WORDS &&
      !isUILine(line)
    perLine.push({ line, words, valid, ri })
  }

  const validEntries = perLine.filter(p => p.valid)
  const keptWords = validEntries.reduce((n, p) => n + p.words.length, 0)
  const keptLines = validEntries.length
  const score = Math.max(
    0,
    Math.min(
      1,
      0.5 * (keptWords / Math.max(allWords, 1)) + 0.5 * (keptLines / Math.max(rawLines.length, 1)),
    ),
  )

  // keyLine：有效行里 (信息词数×2 + min(长度,60)/20) 最高，平手取靠前
  // v10.92 主区偏好：仅当启用区域约束且有效行跨 >1 个 region 时，先按 region
  // 聚合有效行文本长度，取权重最大的 region 为主区（并列取 y 更靠下者），
  // keyLine 候选池先过滤到主区再走既有打分。单区或无几何时完全不变。
  let pool = validEntries
  if (regions) {
    const regionSet = new Set(validEntries.map(p => p.ri).map(regionOf))
    if (regionSet.size > 1) {
      const agg = new Map<number, { w: number; y: number }>()
      for (const p of validEntries) {
        const r = regionOf(p.ri)
        // 主区并列时的 y 平手裁决需要几何；DOM 分区（无 lines）时 y 恒 0，退化为取先出现者
        const y = lines ? (lines as SliceLineGeom[])[p.ri].y : 0
        const a = agg.get(r)
        if (a) {
          a.w += p.line.length
          if (y > a.y) a.y = y
        } else agg.set(r, { w: p.line.length, y })
      }
      let main = -1
      let bestW = -1
      let bestY = -Infinity
      for (const [r, { w, y }] of agg) {
        if (w > bestW || (w === bestW && y > bestY)) {
          main = r
          bestW = w
          bestY = y
        }
      }
      pool = validEntries.filter(p => regionOf(p.ri) === main)
    }
  }
  // v10.93：主区偏好是否生效（constrain 且有效行跨 >1 区 → pool 被过滤）。
  // keySpeakers / regionWords 只在这个条件下产出，其余情况 undefined。
  const mainRegionActive = pool !== validEntries
  let keyLine = ''
  let bestIdx = -1
  let best = -1
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i]
    const s = p.words.length * 2 + Math.min(p.line.length, 60) / 20
    if (s > best) {
      best = s
      bestIdx = i
      keyLine = p.line
    }
  }
  keyLine = keyLine.slice(0, MAX_KEYLINE_CHARS)

  // v10.90 keyText：以 keyLine 为中心向两侧吞并相邻有效行，拼成段落级摘录。
  // OCR 按行吐字，一段话跨多行会被拆散 —— 只读 keyLine 拿到的是半句
  // （用户反馈「抓取的句子往往不完全」）。拼接时 CJK 相邻不加空格。
  // v10.91 三道防嫁接闸（用户二轮反馈「还是差点意思」）：
  //  · 说话人边界 —— 邻居行开了新话头（不同说话人 / keyLine 无主但邻居有主）就停，不跨轮次嫁接；
  //  · 乱码邻居 —— 邻居实词覆盖率过低（OCR 乱串）视为段落断裂；
  //  · v10.92 区域断点 —— 邻居行与 key 行不在同一版面区域（跨 UI 区域嫁接）就停；
  //  · v10.93 feed 断行 —— 邻居行本身是 feed 元数据行，或两邻居之间隔着元数据行
  //    （跨过「r/stocks. 1 分 10 评论」这类分隔就停）。仅 constrain=true 时启用，
  //    保证无几何回退路径逐字节不变；
  //  · 边缘修饰 —— 摘录两端剥引号/@/破折号等 OCR 垃圾符。
  let keyText = ''
  if (bestIdx >= 0) {
    const keySpeaker = keyLine.match(SPEAKER_RE)?.[1] ?? null
    const sameTurn = (line: string) => {
      const sp = line.match(SPEAKER_RE)?.[1] ?? null
      return keySpeaker === null ? sp === null : sp === null || sp === keySpeaker
    }
    const cov = (line: string, words: string[]) =>
      words.reduce((n, w) => n + w.length, 0) / Math.max(line.length, 1)
    const keyRegion = regions ? regionOf(pool[bestIdx].ri) : -1
    const inRegion = (p: { ri: number }) => !regions || regionOf(p.ri) === keyRegion
    // 元数据行跨断：上一收录行与当前邻居之间的 rawLines 里存在 isFeedMetaLine 行
    const feedGap = (fromRi: number, toRi: number): boolean => {
      const [a, b] = fromRi < toRi ? [fromRi, toRi] : [toRi, fromRi]
      for (let k = a + 1; k < b; k++) if (isFeedMetaLine(rawLines[k])) return true
      return false
    }
    const seq: string[] = []
    const lo = Math.max(0, bestIdx - 4)
    const hi = Math.min(pool.length - 1, bestIdx + 4)
    let prevRi = pool[bestIdx].ri
    for (let i = bestIdx; i >= lo; i--) {
      const p = pool[i]
      if (
        i < bestIdx &&
        (!sameTurn(p.line) ||
          cov(p.line, p.words) < MIN_NEIGHBOR_COVERAGE ||
          !inRegion(p) ||
          (regions && (isFeedMetaLine(p.line) || feedGap(p.ri, prevRi))))
      )
        break
      seq.unshift(p.line)
      if (i < bestIdx) prevRi = p.ri
    }
    for (let i = bestIdx + 1; i <= hi; i++) {
      const p = pool[i]
      if (
        !sameTurn(p.line) ||
        cov(p.line, p.words) < MIN_NEIGHBOR_COVERAGE ||
        !inRegion(p) ||
        (regions && (isFeedMetaLine(p.line) || feedGap(prevRi, p.ri)))
      )
        break
      seq.push(p.line)
      prevRi = p.ri
    }
    const cjk = (ch: string | undefined) => !!ch && /[\u4e00-\u9fa5，。！？、；：“”‘’（）【】《》…—]/.test(ch)
    keyText = seq
      .reduce((acc, line) => {
        if (!acc) return line
        const tail = acc[acc.length - 1]
        const head = line[0]
        return acc + (cjk(tail) && cjk(head) ? '' : ' ') + line
      }, '')
      .slice(0, MAX_KEYTEXT_CHARS)
      .replace(/^[\s@~|·•…—"'「『（）【、，。！？]+/, '')
      .replace(/[\s—|·•~"'，。！？、]+$/, '')
    if (!keyText) keyText = keyLine
  }

  const validWords = validEntries.flatMap(p => p.words)
  const words = rankByCount(validWords, MAX_WORDS)
  const phrases = validEntries.slice(0, MAX_PHRASES).map(p => p.line)
  const entities = rankByCount(validWords.filter(w => /^[一-龥]{2,4}$/.test(w)), MAX_ENTITIES)
  const validText = validEntries.map(p => p.line).join('\n')
  const dict = dictTopics && dictTopics.length ? dictTopics : BUILTIN_TOPICS
  const topics = [
    ...new Set(dict.filter(w => w && (validText.includes(w) || validWords.includes(w)))),
  ].slice(0, MAX_TOPICS)
  const persons = detectPersons(rawLines, new Set(validEntries.map(p => p.line)))

  const valid =
    keptWords >= MIN_KEPT_WORDS &&
    keptLines >= MIN_KEPT_LINES &&
    score >= MIN_SCORE &&
    keyLine.length >= MIN_KEYLINE_LEN

  // v10.93：同区产出。words/entities/topics/score 保持全量口径（检索与去重零影响）；
  // keySpeakers 复用 detectPersons，只喂主区行文本；regionWords 只在主区 pool 里排名。
  const regionWords = mainRegionActive
    ? rankByCount(pool.flatMap(p => p.words), MAX_WORDS)
    : undefined
  const keySpeakers = mainRegionActive
    ? detectPersons(pool.map(p => p.line), new Set(pool.map(p => p.line)))
    : undefined

  // ==================== v10.94 整元收录（仅 constrain=true 时计算） ====================
  // 无几何 → wholeUnit/noWholeUnit 均不产出，行为与 v10.93 逐字节一致。
  let wholeUnit: SliceResult['wholeUnit']
  let noWholeUnit: boolean | undefined
  if (regions) {
    interface Unit {
      lineIdx: number[]
      text: string
      speaker: string | null
      hasInternalStart: boolean
      metaInside: boolean
    }
    // 切单元：起始行开新单元；region 变化强制断单元；feed 元数据行自成垃圾单元；
    // 其余行归入当前单元。
    const units: Unit[] = []
    let cur: Unit | null = null
    const closeUnit = () => {
      if (cur) units.push(cur)
      cur = null
    }
    for (let ri = 0; ri < rawLines.length; ri++) {
      const line = rawLines[ri]
      if (isFeedMetaLine(line)) {
        closeUnit()
        units.push({
          lineIdx: [ri], text: line, speaker: null, hasInternalStart: false, metaInside: true,
        })
        continue
      }
      const start = isUnitStartLine(line)
      const regionChanged = cur !== null && regionOf(ri) !== regionOf(cur.lineIdx[0])
      if (!cur || start || regionChanged) {
        closeUnit()
        cur = {
          lineIdx: [ri], text: line, speaker: unitSpeakerOf(line),
          hasInternalStart: false, metaInside: false,
        }
      } else {
        cur.lineIdx.push(ri)
        cur.text += '\n' + line
      }
    }
    closeUnit()

    // 完整度分（0-100）：起始标记 +20 / 终止标点 +25 / 无内部起始行 +15 /
    // 长度 ∈[15,220] +15 / 覆盖率 ≥0.3 +15 / 有内部起始行 −30。
    const covOf = (t: string, ws: string[]) =>
      ws.reduce((n, w) => n + w.length, 0) / Math.max(t.length, 1)
    let best: Unit | null = null
    let bestScore = -1
    let bestWords: string[] = []
    for (const u of units) {
      u.hasInternalStart = u.lineIdx.slice(1).some(k => isUnitStartLine(rawLines[k]))
      const uw = rankByCount(u.lineIdx.flatMap(k => perLine[k].words), MAX_WORDS)
      // v10.94b：UI 词惩罚 —— 机械条件全过的侧栏 UI 块（@handle 起始+长度+覆盖率齐活）
      // 不能凭 65 分混进识海。命中口径：行文本含 UI_PHRASES 条目 + 单元词命中
      // UI_WORD_SET/UI_PHRASES（isBlacklistedWord），去重计数。**只查既有集合**，
      // 不往集合里加词（isBlacklistedWord 喂 isInformative，跑在无几何回退路径上）。
      const uiHits = new Set<string>()
      for (const k of u.lineIdx) {
        const t = rawLines[k].toLowerCase()
        for (const p of UI_PHRASES) if (t.includes(p.toLowerCase())) uiHits.add(p)
      }
      const allUnitWords = u.lineIdx.flatMap(k => perLine[k].words)
      for (const w of allUnitWords) if (isBlacklistedWord(w)) uiHits.add(w)
      let sc = 0
      if (isUnitStartLine(rawLines[u.lineIdx[0]])) sc += 20
      if (UNIT_TERMINAL_RE.test(u.text.trim())) sc += 25
      if (!u.hasInternalStart) sc += 15
      if (u.text.length >= 15 && u.text.length <= 220) sc += 15
      if (covOf(u.text, uw) >= 0.3) sc += 15
      if (u.hasInternalStart) sc -= 30
      if (uiHits.size >= 2) sc -= 30
      else if (uiHits.size === 1) sc -= 10
      // v10.94b 内容词门槛：非 UI 命中的有效 CJK 词去重 <2 → 封顶 40（必低于达标线），
      // 防止「搜索/文件传输助手」这类 UI 词自己凑数过闸。
      const contentCjk = new Set(
        allUnitWords.filter(w => /^[一-龥]{2,}$/.test(w) && !isBlacklistedWord(w)),
      )
      if (contentCjk.size < 2) sc = Math.min(sc, 40)
      if (sc > bestScore || (sc === bestScore && best !== null && u.lineIdx.length > best.lineIdx.length)) {
        best = u
        bestScore = sc
        bestWords = uw
      }
    }
    if (best && bestScore >= WHOLE_UNIT_MIN_SCORE) {
      wholeUnit = {
        text: best.text.slice(0, MAX_KEYTEXT_CHARS),
        score: bestScore,
        ...(best.speaker ? { speaker: best.speaker } : {}),
        words: bestWords,
      }
    } else {
      noWholeUnit = true
    }
  }

  return {
    words, phrases, keyLine, keyText, persons, entities, topics, score, valid,
    ...(regionWords ? { regionWords } : {}),
    ...(keySpeakers ? { keySpeakers } : {}),
    ...(wholeUnit ? { wholeUnit } : {}),
    ...(noWholeUnit ? { noWholeUnit: true } : {}),
    stats: { lines: rawLines.length, keptLines, words: allWords, keptWords },
  }
}
