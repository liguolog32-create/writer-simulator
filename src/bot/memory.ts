/**
 * 识海 · 记忆引擎（机器人「观澜」· v10.65）
 *
 * 忠实实现用户手写设计稿里的机制：
 *  · 记忆 = 属性向量 { D 时间 · R 可检索 · E 情绪 · C 上下文 · I 身份相关 · S 意义强度 }
 *  · 遗忘 = 衰减 F(t) = F₀·e^(−λt)，λ 受情绪唤醒度与重复影响（唤醒越高越难忘）
 *  · 回忆反向强化：被唤醒的记忆强度回升（心理学里的「测试效应」）
 *  · 重要 + 反复想起 → 巩固进语义层（长期记忆）
 *  · 提取：过滤（评分）→ 重组（Top-K 拼装成上下文）
 *
 * 三层记忆：情景（海量·易衰减）/ 语义（三观信念·少而稳）/ 程序性（文风·几乎不衰减）
 */

import type { MemoryItem, MemoryLayer, MemorySource, RecallHit } from './types'
import { sliceScreenText } from './nlpSlice'
import type { SliceLineGeom } from './nlpSlice'

/* ------------------------------ 容量护栏 ------------------------------ */
export const CAPACITY: Record<MemoryLayer, number> = {
  episodic: 200,
  semantic: 60,
  procedural: 20,
}
/** 强度低于此值视为「已经想不起来了」，会被淘汰 */
const FADE_OUT = 0.06

let seq = 0
const newId = () => `m-${Date.now().toString(36)}-${(seq++).toString(36)}`

/* ------------------------------ 创建 ------------------------------ */

export interface CreateMemoryInput {
  content: string
  layer?: MemoryLayer
  source?: MemorySource
  confidence?: number
  importance?: number
  identity?: number
  valence?: number
  arousal?: number
  emotion?: string
  tags?: string[]
  lambda?: number
  at?: string
}

/**
 * 新建一条记忆。
 * λ 的默认值由情绪唤醒度决定：情绪越强，衰减越慢（这是"情绪让记忆更牢"的量化）。
 */
export function createMemory(input: CreateMemoryInput): MemoryItem {
  const arousal = clamp01(input.arousal ?? 0.3)
  const importance = clamp01(input.importance ?? 0.4)
  const identity = clamp01(input.identity ?? 0.3)
  // λ 基准 0.02/天（半衰期约 35 天），强情绪/高意义把它压低
  const lambda =
    input.lambda ??
    Number(Math.max(0.0015, 0.02 * (1 - arousal * 0.7) * (1 - importance * 0.4)).toFixed(5))
  const at = input.at ?? new Date().toISOString()
  return {
    id: newId(),
    layer: input.layer ?? 'episodic',
    content: input.content.trim(),
    source: input.source ?? 'self',
    confidence: clamp01(input.confidence ?? 0.7),
    createdAt: at,
    lastRecalledAt: null,
    // 重要且带情绪的，出生就比别的清楚一点
    strength: clamp01(0.35 + importance * 0.35 + arousal * 0.2),
    lambda,
    valence: clampSigned(input.valence ?? 0),
    arousal,
    emotion: input.emotion || '平静',
    importance,
    identity,
    recallCount: 0,
    tags: input.tags ?? [],
  }
}

/* ------------------------------ 衰减 / 强化 / 巩固 ------------------------------ */

const HOUR = 3600 * 1000

/** 衰减：F(t) = F₀·e^(−λΔt)，Δt 按天算 */
export function decayMemory(m: MemoryItem, nowMs = Date.now()): MemoryItem {
  const last = Date.parse(m.lastRecalledAt || m.createdAt)
  const days = Math.max(0, (nowMs - last) / (24 * HOUR))
  if (days <= 0) return m
  // 程序性记忆（文风/习惯）几乎不衰减
  if (m.layer === 'procedural') return { ...m, strength: clamp01(m.strength + 0.02) }
  return { ...m, strength: clamp01(m.strength * Math.exp(-m.lambda * days)) }
}

/** 批量衰减 + 淘汰已经淡出的（情景层才淘汰，语义层永远保留） */
export function decayAll(memories: MemoryItem[], nowMs = Date.now()): MemoryItem[] {
  const decayed = memories.map(m => decayMemory(m, nowMs))
  const alive = decayed.filter(m => m.layer !== 'episodic' || m.strength >= FADE_OUT)
  return enforceCapacity(alive)
}

/** 回忆：强度回升 + 计数 + 巩固信号（测试效应） */
export function recallMemory(m: MemoryItem, nowMs = Date.now()): MemoryItem {
  const next: MemoryItem = {
    ...m,
    lastRecalledAt: new Date(nowMs).toISOString(),
    recallCount: m.recallCount + 1,
    strength: clamp01(m.strength * 1.3 + 0.06),
  }
  return consolidate(next)
}

/** 巩固：反复想起 + 意义强度高 → 升进语义层（长期记忆） */
export function consolidate(m: MemoryItem): MemoryItem {
  if (m.layer === 'episodic' && m.recallCount >= 3 && m.importance >= 0.65) {
    return { ...m, layer: 'semantic' }
  }
  return m
}

/** 压住一条记忆：不是删除，是「被压下」（会回来，且更容易被强烈情绪唤起） */
export function suppressMemory(m: MemoryItem, on = true): MemoryItem {
  return { ...m, suppressed: on, arousal: on ? Math.min(1, m.arousal + 0.3) : m.arousal }
}

/* ------------------------------ 容量 ------------------------------ */

export function enforceCapacity(memories: MemoryItem[]): MemoryItem[] {
  const out: MemoryItem[] = []
  for (const layer of ['episodic', 'semantic', 'procedural'] as MemoryLayer[]) {
    const list = memories
      .filter(m => m.layer === layer)
      .sort((a, b) => b.strength - a.strength)
    out.push(...list.slice(0, CAPACITY[layer]))
  }
  return out
}

/* ------------------------------ 检索（过滤 → 重组）------------------------------ */

/** 中文按字 bigram 切，英文数字按词切 —— 够用且不引依赖（不上向量库） */
type SegmenterCtor = new (
  locale: string,
  opts: { granularity: 'word' },
) => { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> }

export function tokenize(text: string): string[] {
  const t = (text || '').toLowerCase()

  // v10.78：优先用运行环境内置的 **Intl.Segmenter**（ICU 中文词典切词）——
  // 零依赖、零体积，词级 token 比"双字切分"噪声小得多
  //（"夏子豪"不再产出 夏子/子豪 一串碎片，"JPM"也不再被剪成 jp/pm）。
  // 关键自洽点：检索时 query 与 content 跑的是**同一个环境里的同一个切词器**，
  // 所以两边产出一定对得上；不支持的老浏览器退回双字切分，同样自洽。
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter
  if (Seg) {
    try {
      const seg = new Seg('zh', { granularity: 'word' })
      const words: string[] = []
      for (const s of seg.segment(t)) {
        const w = s.segment.trim()
        if (!w) continue
        if (s.isWordLike || /[a-z0-9]{2,}/.test(w)) words.push(w)
      }
      return words
    } catch {
      /* 极端环境切词失败 → 落回双字切分 */
    }
  }

  // —— fallback：双字切分（老浏览器）——
  const grams: string[] = []
  const re = /[a-z0-9]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) grams.push(m[0])
  const cjk = t.replace(/[^一-龥]+/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run.length === 1) grams.push(run)
    for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2))
  }
  return grams
}

function overlap(queryGrams: string[], textGrams: Set<string>): number {
  if (!queryGrams.length) return 0
  let hit = 0
  for (const g of new Set(queryGrams)) if (textGrams.has(g)) hit++
  return hit / new Set(queryGrams).size
}

export interface RetrieveOptions {
  k?: number
  nowMs?: number
  /** 语义层记忆（三观/信念）永远参与检索，不受情景层衰减影响 */
  includeSemantic?: boolean
  minStrength?: number
}

/**
 * 识海提取：唤醒 → 打分过滤 → Top-K 重组。
 * 每条都带 `reason`（为什么被选中）—— 这是「心光选择」的可解释性来源，
 * 也是它对用户说「这让我想起…」的依据。
 */
export function retrieve(
  memories: MemoryItem[],
  query: string,
  opts: RetrieveOptions = {},
): RecallHit[] {
  const nowMs = opts.nowMs ?? Date.now()
  const k = opts.k ?? 5
  const qGrams = tokenize(query)
  const minStrength = opts.minStrength ?? 0.08

  const scored = memories
    .filter(m => (opts.includeSemantic === false ? m.layer !== 'semantic' : true))
    .filter(m => m.layer !== 'episodic' || m.strength >= minStrength)
    .map(m => {
      const fresh = decayMemory(m, nowMs)
      const textScore = overlap(qGrams, new Set(tokenize(`${fresh.content} ${fresh.tags.join(' ')}`)))
      const days = Math.max(0, (nowMs - Date.parse(fresh.createdAt)) / (24 * HOUR))
      const recency = Math.exp(-days / 30)
      const score =
        0.34 * fresh.strength +
        0.26 * Math.min(1, textScore * 2.2) +
        0.16 * fresh.importance +
        0.12 * fresh.identity +
        0.07 * recency +
        0.05 * fresh.arousal
      // 压住的记忆：平时不主动冒出来，除非情绪唤醒得很高
      const suppressedPenalty = fresh.suppressed ? 0.75 : 1
      return { memory: fresh, score: score * suppressedPenalty, reason: reasonFor(fresh, textScore, recency) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)

  return scored
}

function reasonFor(m: MemoryItem, textScore: number, recency: number): string {
  const bits: string[] = []
  if (textScore > 0.12) bits.push('和这次说的内容对得上')
  if (m.importance >= 0.65) bits.push('意义强度高')
  if (m.identity >= 0.6) bits.push('和我的身份高度相关')
  if (recency > 0.8) bits.push('最近刚发生过')
  if (m.recallCount >= 3) bits.push('我反复想起过它')
  if (m.arousal >= 0.6) bits.push(`当时情绪很${m.emotion}`)
  if (m.source === 'observed') bits.push('来自我看到的屏幕')
  if (m.source === 'user') bits.push('是你告诉我的')
  return bits.length ? bits.join('、') : '印象还够清晰'
}

/** 把命中的记忆拼成提示词里的「识海」段落（带归属，让它能引用） */
export function assembleMemories(hits: RecallHit[]): string[] {
  return hits.map(h => `· ${h.memory.content}（${h.reason}）`)
}

/* ------------------------------ 摄入闸门 ------------------------------ */

export interface LocalSummaryLike {
  topics: string[]
  entities: string[]
  mood: string
  valence: number
  chars: number
  /** OCR 文本质量 0..1（可选：老数据没有这个字段时不做质量闸） */
  quality?: number
}

export interface IngestDecision {
  keep: boolean
  reason: string
  memory?: MemoryItem
}

/** 观察摘要的文字质量下限：低于此值视为 OCR 噪声（与 screensee 的 MIN_TEXT_QUALITY 对齐） */
const MIN_OBS_QUALITY = 0.38
function isLowQuality(summary: LocalSummaryLike): boolean {
  return typeof summary.quality === 'number' && summary.quality < MIN_OBS_QUALITY
}

/**
 * 摄入闸门：观察到的屏幕文字**先过这一关**才进识海。
 * 判据（摄入是稀疏事件，不是流水账）：
 *   · 文字太短 → 不记（多是无意义的 UI 碎片）
 *   · 没有话题/实体/情绪信号 → 不记（只是界面在闪）
 *   · 同一话题短时间内重复 → 只记一次（防灌水）
 */
/* ============================================================
   v10.75 场景解读：让观察不再只会复述用户的"忙闲"
   ------------------------------------------------------------
   原来的记忆模板写死成「注意到用户在忙{话题词典里的词}……」，
   结果识海里全是同一句话；而且**其他人的发言**、**用户正在读的文章**
   都被这句话吞掉了。
   extractScene 从 OCR 文本里分辨「这是一段群聊 / 一篇长文 / 还是别的」，
   抽出说话人、标题和**要点摘记**（v10.90 起为 ≤220 字的段落级摘录，不再截成半句 ——
   用户 2026-11-09 明确要求：识海要能反映浏览时到底在浏览什么。仍不是整段原文：
   隔离硬规则仍然成立：截图与 OCR 全文只留本机 IndexedDB，上云的永远是白名单转述）。
   ============================================================ */

export interface SceneRead {
  kind: 'chat' | 'profile' | 'article' | 'misc'
  /** 独立成行的名字（微信聊天顶栏 / 资料页头像下方）—— 检索人名全靠它 */
  name: string
  /** 群聊里出现的说话人（去重，最多 3 个） */
  speakers: string[]
  /** 要点摘记：以信息量最高的一行为中心、前后各扩 4 行组稿的段落级摘录（≤220 字，v10.90） */
  gist: string
  /** 长文的标题猜测（仅 article） */
  title: string
}

const CHAT_LINE_RE = /^([^\s:：]{1,12})[:：]\s*(.{2,})$/
const UI_JUNK_RE = /(撤回|发送|输入|表情|引用|回复|转发|朋友圈|新消息|拍一拍|正在输入|\d{1,2}:\d{2}|会员专享|表格工具|表格样式|论文助手|文档工具|演示工具|图片工具|稻壳会员|屏幕上的对话里|屏幕上的群聊里|屏幕内容读到|有人说到|读到：「|我注意到|记下了：|长文《)/
/** v10.89：办公套件界面词被误判成聊天昵称（真实观察：WPS 面板列名「描述/清单」反复出现成了说话人）。
 *  这些词作为「说话人」几乎必然是界面碎片；作为聊天内容不受影响（只挡说话人/配对昵称）。 */
const OFFICE_UI_SPEAKER_RE = /^(描述|清单|只读|其他|账户|借款|单元格|工作表|开始|插入|视图|审阅|数据|v)$/
/** 资料页的字段名 —— "标签：JPM" 冒号前是字段名不是说话人，绝不能当成"人"记进来 */
const LABEL_KEY_RE = /^(标签|昵称|备注|来源|描述|地区|职位|公司|签名|微信号|邮箱|电话|共同群聊)[:：]/

export function extractScene(text: string): SceneRead {
  const lines = String(text || '')
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean)

  const speakers: string[] = []
  const msgs: string[] = []
  let colonLines = 0
  let labelLines = 0
  for (const l of lines) {
    if (UI_JUNK_RE.test(l)) continue // 时间戳/按钮行（"13:45"会被误读成 说话人"13"）
    if (LABEL_KEY_RE.test(l)) {
      labelLines++
      msgs.push(l) // 资料页的字段值（标签：JPM、Mayo Clinic…）是有用的要点素材
      continue
    }
    const m = l.match(CHAT_LINE_RE)
    if (!m) continue
    colonLines++
    // 说话人别是纯数字/时间片段/字段名/"提示""声明"这类结尾
    if (
      !/^\d+$/.test(m[1]) &&
      !/(提示|声明|注意|免责)$/.test(m[1]) &&
      !OFFICE_UI_SPEAKER_RE.test(m[1]) &&
      !speakers.includes(m[1]) &&
      speakers.length < 3
    )
      speakers.push(m[1])
    msgs.push(m[2])
  }

  // v10.76 微信式布局：**昵称独占一行**（头像下面），下一行才是消息。
  // OCR 出来的群聊长这样 —— 原来只认「名字：内容」同行格式，人名全漏了。
  // 用「同一个昵称反复出现」来压误判：文章的标题/段落不会重复，群聊里发信人会反复出现。
  const pairs: Array<{ speaker: string; msg: string }> = []
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i]
    const b = lines[i + 1]
    if (UI_JUNK_RE.test(a) || UI_JUNK_RE.test(b)) continue
    if (CHAT_LINE_RE.test(a) || LABEL_KEY_RE.test(a)) continue // 同行格式已单独处理
    if (a.length >= 1 && a.length <= 12 && !/[，。！？；：…"'」』]$/.test(a) && b.length >= 4 && b.length <= 300) {
      pairs.push({ speaker: a, msg: b })
    }
  }
  const pairCount = new Map<string, number>()
  pairs.forEach(c => pairCount.set(c.speaker, (pairCount.get(c.speaker) || 0) + 1))
  const repeatedSpeakers = [...pairCount.entries()].filter(([, n]) => n >= 2).map(([s]) => s)
  const wechatLike = pairs.length >= 3 && repeatedSpeakers.length >= 1
  if (wechatLike) {
    for (const s of repeatedSpeakers) if (!OFFICE_UI_SPEAKER_RE.test(s) && !speakers.includes(s) && speakers.length < 3) speakers.push(s)
    pairs.forEach(c => {
      if (repeatedSpeakers.includes(c.speaker)) msgs.push(c.msg)
    })
  }

  // v10.76：**名字行** —— 独立成行的 2-4 字纯中文，出现在开头几行。
  // 微信聊天顶栏 / 资料页头像下方就是这个形态。这是"这是谁"的来源。
  const name =
    lines
      .slice(0, 6)
      .find(l => /^[一-龥·]{2,4}$/.test(l) && !UI_JUNK_RE.test(l) && !LABEL_KEY_RE.test(l)) || ''

  // ============================================================
  // v10.77 微信 1:1 聊天窗口（用户实测抓出来的漏判）：
  //   顶栏 = 「人名 + 英文标签」挤在同一行（如「夏子豪 JPM.ED/Mayo Clinic.VP」），
  //   而且 1:1 的消息**没有说话人名**（只有头像）—— 上面两版都认不出这种场景，
  //   整幕掉进 article/misc，还被"同一篇长文"的去重挡住。
  // 识别：开头两行里，「2-6 个中文 + 空格 + 至少 2 个拉丁字符」的行 = 顶栏人名。
  //   （纯中文长标题、冒号行、"（3）"群人数都不会误中；只看前两行，左侧聊天列表干扰小）
  // ============================================================
  let topName = ''
  for (const t of lines.slice(0, 3)) {
    if (UI_JUNK_RE.test(t) || LABEL_KEY_RE.test(t)) continue
    // 结尾锚定：允许顶栏前面混进同高度的侧栏文字（整屏 OCR 时可能是「搜索 夏子豪 JPM.ED/…」）
    const m = t.match(/([一-龥·]{2,4})\s+([A-Za-z0-9][A-Za-z0-9./&·\s-]{1,60})$/)
    if (m && !/^(搜索|聊天|文件|通讯录)$/.test(m[1])) {
      topName = m[1]
      break
    }
  }

  // 要点：优先取**前半段**里最有信息量的行（标题/导语），免责声明这类尾巴不抢戏；
  // 有顶栏人名时，把顶栏那行从要点候选里剔掉（它是名字，不是内容）
  const pool = (msgs.length ? msgs : lines)
    .filter(l => !UI_JUNK_RE.test(l))
    .filter(l => !topName || !l.startsWith(topName))
  const scored = pool.map((l, i) => ({ l, score: Math.min(l.length, 60) * (i < pool.length / 2 ? 1.2 : 1) }))
  const salient = scored.sort((a, b) => b.score - a.score)[0]?.l || ''
  const gist = salient
    .replace(/[\s，。！？、；："'「」]+$/g, '')
    .slice(0, 220)

  // 人名与「聊天」不互斥（1:1 顶栏就有人名）；资料页只在非群聊形态时判
  const isProfile = Boolean(name && labelLines >= 1 && !wechatLike && !topName)
  const isChat = !isProfile && (Boolean(topName) || (colonLines >= 2 && speakers.length >= 1) || wechatLike)
  // 长文：行多、成段的行多 —— 读文章时屏幕就是这个形态（总字数不限，截断的长文也算）
  const longLines = lines.filter(l => l.length >= 15).length
  const isArticle = !isChat && !isProfile && !topName && lines.length >= 4 && longLines >= 3
  const title = isArticle
    ? (lines.find(l => l.length >= 6 && l.length <= 30 && !UI_JUNK_RE.test(l)) || '')
        .replace(/[\s#_]/g, '')
        .slice(0, 24)
    : ''

  const kind = isProfile ? 'profile' : isChat ? 'chat' : isArticle ? 'article' : 'misc'
  const sceneName = name || topName
  return { kind, name: kind === 'profile' || kind === 'chat' ? sceneName : '', speakers, gist, title }
}

/** v10.79：这一幕有没有敏感内容？（观察摄入闸与云端摘要库共用同一把锁） */
export function sceneHasSensitive(text: string): boolean {
  return /(密码|口令|验证码|银行卡|卡号|身份证|支付|api[_ -]?key|access[_ -]?token|私钥)/i.test(String(text || ''))
}

/**
 * v10.79 云端摘要记录：**切分 + 场景解读的产出**（白名单字段形态）。
 *
 * 用户 2026-11-06 要求把切分产出存到 Cloudflare —— 注意这**不是**推翻隔离规则：
 * 上云的仍然是「转述摘要」（类型/人名/话题/要点），屏幕原文永远只在本机 IndexedDB。
 * 存云端的价值：摘要想留多久留多久（不再受 72h 本机 TTL），跨设备也能回看。
 * 敏感闸共用 sceneHasSensitive —— 含密码/验证码的一幕连摘要都不生成。
 */
export interface ObsDigest {
  at: string
  source: string
  kind: 'chat' | 'profile' | 'article' | 'misc'
  name: string
  speakers: string[]
  topics: string[]
  entities: string[]
  gist: string
  mood: string
}

/** 浏览器 / 应用界面的固定文案：不是「观察到的场景内容」，不该上云 */
const UI_NOISE_RE =
  /(所有书签|书签栏|文件传输助手|通讯录|收藏夹|新建标签页|Workers|DevTools|Console|Inspect)/i
/** name 专用：界面标签 / 按钮名，绝不能被当成「人名」上云 */
const UI_NAME_RE =
  /(所有书签|书签栏|文件传输助手|通讯录|收藏夹|联系人|群聊|公众号|小程序|朋友圈|扫一扫|收付款|新建标签页|Workers|Console|DevTools|搜索|设置|登录|注册|历史记录|下载)/i

/**
 * 字段级 OCR 噪声判据（纯函数，刻意不 import screensee 的整屏质量分，避免耦合）。
 * 只判 extractScene 切出来的单个字段；整体偏保守：干净的中文句子、
 * 正常的中英混排一律放过，只拦明显的乱码与浏览器 UI 文案。
 */
function looksLikeNoise(s: string): boolean {
  const t = String(s || '').trim()
  if (!t) return false // 空字段（文章本就没有 name）不算噪声，交上层保留
  // 浏览器 UI 文案（限定短字段：整段 gist 里偶尔出现「通讯录」不该被误杀）
  if (t.length <= 12 && UI_NOISE_RE.test(t)) return true

  const chars = [...t]
  const total = chars.length
  // 1) 可读字符比例过低：CJK / 字母 / 数字 / 常见标点 / 空白之外都算乱码符号
  const readable = chars.filter(c =>
    /[\u4e00-\u9fa5A-Za-z0-9\s，。！？、；：·「」『』（）《》〈〉“”‘’"'(),.!?;:\-—_@#%&+=~]/.test(c),
  ).length
  if (readable / total < 0.6) return true

  // 2) CJK 多为孤立单字（连不成 2 字以上的词）→ 典型 OCR 碎片
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length
  if (cjk >= 3) {
    const inRuns = (t.match(/[\u4e00-\u9fa5]{2,}/g) || []).join('').length
    if (inRuns / cjk < 0.35) return true
  }

  // 3) 字母数字混杂的乱码形态
  if (/[A-Za-z][0-9][A-Za-z]/.test(t)) return true                            // a7b / D0a
  if (/[0-9][A-Z]{2,}/.test(t)) return true                                    // 72HC / 6STEAM
  if (/[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]{4,}/.test(t)) return true // 4+ 辅音连缀

  return false
}

/** v10.91 自观察熔断：用户开着观察逛机器人自己的界面（识海 / 作品库 / 管理后台）时，
 *  OCR 会把应用 UI 和识海卡片文字喂回来 —— 形成「记忆吃记忆」的反哺回路
 *  （真实事故：摘录里出现「记下了：长文《…》读到:…」的卡片残渣）。
 *  应用顶栏每一页都带「作家模拟器 / 管理后台 / 免费引擎」，强签名 ≥2 → 整幕不记。
 *  代价：在应用内阅读的内容也不记 —— 相比反哺污染，宁可漏记（用户观察的主要是外部内容）。 */
const SELF_APP_SIGS = [
  // v10.94b 品牌改名「观澜书房」：新名追加；旧名「作家模拟器」保留（旧缓存页面还在用），双保险
  '观澜书房', '作家模拟器', '管理后台', '免费引擎', '标准引擎', '开始观察', '停止观察',
  '私有词典', '清理未切片', '调整未切片', '让它出生', '词典引擎数据', '识海（',
]
export function isSelfAppScreen(text: string): boolean {
  let hits = 0
  for (const s of SELF_APP_SIGS) {
    if (text.includes(s)) hits++
    if (hits >= 2) return true
  }
  return false
}

export function digestScene(
  text: string,
  summary: LocalSummaryLike,
  at = new Date().toISOString(),
  lines?: SliceLineGeom[],
  domRegions?: number[],
): ObsDigest | null {
  if (isSelfAppScreen(text)) return null // v10.91：看到的是机器人自己的界面，不生成摘要
  if (sceneHasSensitive(text)) return null // 含敏感串的一幕：摘要也不生成
  if (isLowQuality(summary)) return null // 文字太乱，像 OCR 噪声：不生成云端摘要
  const scene = extractScene(text)
  // 字段级噪声闸：整屏质量分只评估原文，切出来的 name / gist 还要二次检查。
  // gist 是噪声 → 整条丢弃；name 是噪声 → 只清空 name（文章 / 匿名场景仍有价值）。
  if (looksLikeNoise(scene.gist)) return null
  // v10.82：只有真正过了 NLP 切片的一幕才上云。旧 topics 是整屏扫词典命中，
  // 与 gist 0% 重叠；这里用 slice.valid 再闸一道，并把 gist/topics/entities 换成切片产出。
  const slice = sliceScreenText(text, summary.topics, lines, domRegions)
  if (!slice.valid) return null
  // v10.94 整元收录：constrain 时整屏找不到完整度达标的整体单元 → 不产摘要
  if (slice.noWholeUnit) return null
  const name = looksLikeNoise(scene.name) || UI_NAME_RE.test(scene.name) ? '' : scene.name
  return {
    at,
    source: '',
    kind: scene.kind,
    name,
    // v10.93：主区说话人对齐 —— keySpeakers 存在时只保留场景说话人里在主区出现过的，
    // 过滤后可为空数组（宁可中性也不张冠李戴）；其余情况保持原样。
    speakers: slice.keySpeakers
      ? scene.speakers.filter(s => slice.keySpeakers!.includes(s)).slice(0, 3)
      : scene.speakers.slice(0, 3),
    topics: slice.topics.slice(0, 6),
    entities: slice.entities.slice(0, 6),
    // v10.94：gist 优先取达标整体单元（一个完整的推文/消息/段落）
    gist: slice.wholeUnit?.text ?? slice.keyText ?? slice.keyLine ?? scene.gist,
    mood: summary.mood,
  }
}

export function ingestObserved(
  memories: MemoryItem[],
  raw: string,
  summary: LocalSummaryLike,
  nowMs = Date.now(),
  lines?: SliceLineGeom[],
  domRegions?: number[],
): IngestDecision {
  const text = (raw || '').trim()
  if (text.length < 8) return { keep: false, reason: '内容太短，像界面碎片' }
  // v10.91：看到的是机器人自己的界面（识海/作品库顶栏签名）→ 整幕不记，切断「记忆吃记忆」
  if (isSelfAppScreen(text)) return { keep: false, reason: '看到的是机器人自己的界面（自观察反哺），不记' }

  // ⚠️ 敏感信息闸（v10.75，回归测试抓出来的）：屏幕上出现密码/验证码/卡号这类东西，
  // **整幕不记** —— 哪怕只是"要点转述"也不行，因为转述会把敏感串带上云。
  if (sceneHasSensitive(text)) {
    return { keep: false, reason: '这一幕可能包含密码/验证码等敏感信息，按隔离规则不记' }
  }
  // 质量闸要放在信号判定之前：backfillFromLocal 会重新 summarizeLocally + ingestObserved，
  // 光在 UI 侧挡是漏的（这是第二摄入路径，必须在这里也挡住）。
  if (isLowQuality(summary)) return { keep: false, reason: '这一幕文字太乱，像 OCR 噪声，没有采信' }

  const scene = extractScene(text)
  // v10.82：只有真正过了 NLP 切片 / 识别的一幕才进识海。旧 hasSignal 拿
  // summary.topics（整屏扫 50 词词典）当信号，几乎永不为空 → 200 条噪声记忆。
  const slice = sliceScreenText(text, summary.topics, lines, domRegions)
  if (!slice.valid) {
    return { keep: false, reason: '这一幕没有切出可采信的内容（未通过 NLP 切片），不记' }
  }
  // v10.94 整元收录：constrain 时整屏找不到完整度达标的整体单元 → 宁可漏记不错记
  if (slice.noWholeUnit) {
    return { keep: false, reason: '整屏没有完整度达标的整体单元（no-whole-unit），宁缺毋滥不记' }
  }

  // 去重键换成**场景本身**（谁在说 + 要点开头），不再用话题词典 ——
  // 原来所有屏幕内容都撞在同一个话题上，20 分钟内只记得住一句话。
  const sceneKey = `${scene.kind}:${scene.name || scene.speakers.join(',') || scene.title || slice.topics[0] || ''}:${scene.gist.slice(0, 12)}`
  const sceneTag = `场景:${sceneKey}`
  const dup = memories.find(
    m => m.source === 'observed' && m.tags.includes(sceneTag) && nowMs - Date.parse(m.createdAt) < 20 * 60 * 1000,
  )
  if (dup) {
    return {
      keep: false,
      reason: `20 分钟内已经记过这一幕了（${scene.kind === 'chat' ? '同一段对话' : scene.kind === 'article' ? '同一篇文章' : '同一屏内容'}），不重复记`,
    }
  }

  // ⚠️ 隔离硬规则（用户 2026-10-14）：进识海的只能是「摘要」，
  // 不能是屏幕原文 —— 原文只在本机 IndexedDB（screensee.ts），
  // 而记忆条目会随 AppState 上云，写进原文就等于外传。
  // v10.75：摘要从"只有情绪"升级为"要点转述"，
  // 这是用户 2026-11-06 的要求 —— 它要从其他人的发言和文章里形成认知。
  // v10.82：content 反映切片产出（keyLine + 切出的词），不再用整屏词典拼模板。
  // v10.90（用户 2026-11-09：识海要能反映浏览时到底在浏览什么）：content 升级为
  // 段落级摘录 keyText —— 以信息量最高行为中心、前后各扩 4 行合并（≤MAX_KEYTEXT_CHARS 字），
  // 解决"抓取的句子往往不完全"；keyLine（单行 ≤48 字）仍是兜底。两者均为转述白名单。
  // v10.94 整元收录：有达标整体单元时 key/cut/模板全跟着单元走
  //（speaker 存在 → chat 模板；无 speaker 的完整段落 →「读到：」模板）；
  // 无几何（wholeUnit undefined）→ 走 v10.93 原逻辑，逐字节不变。
  const wu = slice.wholeUnit
  const cutList = wu ? wu.words : (slice.regionWords ?? slice.words)
  const cut = cutList.length ? `（切出：${cutList.slice(0, 5).join('、')}）` : ''
  const key = wu ? wu.text : slice.keyText || slice.keyLine
  let content: string
  if (wu && wu.speaker) {
    content = `屏幕上的对话里，${wu.speaker}说到「${key}」${cut}。`
  } else if (wu) {
    content = `读到：「${key}」${cut}。`
  } else if (scene.kind === 'chat') {
    const many = slice.persons.length >= 2
    // v10.93：who 同区对齐 —— keySpeakers 存在且非空时优先（宁可「有人」也不张冠李戴）
    const whoSrc =
      slice.keySpeakers && slice.keySpeakers.length ? slice.keySpeakers : slice.persons
    const who = whoSrc.length ? whoSrc.slice(0, 2).join('、') : '有人'
    content = `屏幕上的${many ? '群聊' : '对话'}里，${who}说到「${key}」${cut}。`
  } else if (scene.kind === 'article') {
    content = `读到：「${key}」${cut}。`
  } else if (scene.kind === 'profile') {
    content = `读到：「${key}」${cut}。`
  } else {
    content = `屏幕内容读到「${key}」${cut}。`
  }

  // sceneTag 固定在 index 1（marker 之后、切片词之前）：无论切片词有多少，
  // 它都不会被末尾的 slice(0,8) 挤掉，20 分钟去重（m.tags.includes(sceneTag)）永远成立。
  const sliceTags = [...slice.persons, ...slice.entities, ...slice.topics]
  const memory = createMemory({
    content,
    layer: 'episodic',
    source: 'observed',
    confidence: 0.55, // OCR 可能认错，置信度给低
    importance: clamp01(0.2 + slice.score * 0.5 + (scene.kind === 'article' ? 0.1 : 0)),
    identity: clamp01(0.15 + slice.topics.length * 0.05),
    valence: summary.valence,
    arousal: Math.min(1, 0.3 + Math.abs(summary.valence) * 0.5),
    emotion: summary.mood,
    // 「切片:N词」是给 UI 的契约：tags 里带这个前缀的就是新的切片记忆。
    // 其后只放切片产出（人名/实体/话题），不再塞整屏词典命中的词。
    tags: [
      `切片:${slice.stats.keptWords}词`,
      sceneTag,
      ...sliceTags,
    ].slice(0, 8),
    at: new Date(nowMs).toISOString(),
  })
  const label =
    scene.kind === 'profile'
      ? `「${scene.name}」的资料页`
      : scene.kind === 'chat'
        ? `与「${scene.name || '联系人'}」的对话（${scene.speakers.join('、') || '对方在说'}）`
        : scene.kind === 'article'
          ? `长文${scene.title ? `《${scene.title}》` : ''}`
          : '屏幕内容'
  return { keep: true, reason: `记下了：${label}`, memory }
}

/* ------------------------------ 工具 ------------------------------ */

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(4))))
}
function clampSigned(n: number): number {
  return Math.max(-1, Math.min(1, Number(n.toFixed(3))))
}
