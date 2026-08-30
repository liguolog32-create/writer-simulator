import type { Canvas, CanvasDimension } from '../types'

export interface ChapterOutline {
  index: number
  title: string
  summary: string
  tag: '开局' | '推进' | '高潮' | '反转' | '收束'
  words: number
}

export interface GeneratedBook {
  title: string
  synopsis: string
  outline: ChapterOutline[]
  sampleChapter: { title: string; content: string; beat: string }
  stats: {
    totalWords: number
    chapters: number
    volumes: number
    styleLabel: string
    anchorSources: string[]
  }
  generatedAt: string
}

/* ---------------- 基础工具 ---------------- */

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function cnToInt(s: string): number | null {
  if (!s) return null
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (s.length === 1) return CN_NUM[s] ?? null
  if (s === '十') return 10
  if (s.length === 2 && s[0] === '十') return 10 + (CN_NUM[s[1]] ?? 0)
  if (s.length === 2 && s[1] === '十') return (CN_NUM[s[0]] ?? 0) * 10
  if (s.length === 3 && s[1] === '十') return (CN_NUM[s[0]] ?? 0) * 10 + (CN_NUM[s[2]] ?? 0)
  return null
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function makeRng(seed: number) {
  let s = seed || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

type Rng = () => number
const pick = <T,>(arr: T[], rng: Rng): T => arr[Math.floor(rng() * arr.length) % arr.length]

function contentOf(canvases: Canvas[], dim: CanvasDimension): string {
  return canvases.find(c => c.dimension === dim)?.content ?? ''
}

/* ---------------- 画布信息抽取 ---------------- */

/** 世界名词：先按常见题材词库匹配，不足则用短语兜底 */
const WORLD_KEYWORDS = [
  '祖器', '灵气', '神族', '王朝', '修行', '凡人', '江湖', '朝堂', '宗门', '秘境',
  '妖兽', '剑客', '符箓', '阵法', '丹药', '兵器', '仙人', '魔道', '佛门', '鬼域',
  '皇帝', '将军', '书院', '商会', '家族', '血脉', '传承', '禁地', '遗迹', '城池',
  '山海', '异兽', '时空', '机甲', '星际', '病毒', '异能', '系统', '副本', '公会',
]

function extractWorldNouns(text: string): string[] {
  const hits = WORLD_KEYWORDS.filter(k => text.includes(k))
  if (hits.length >= 2) return hits.slice(0, 6)
  // 兜底：切分短语取前几个
  const parts = text
    .split(/[，。；、\n·「」《》（）()：:！!？?]/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && t.length <= 5)
  return [...new Set([...hits, ...parts])].slice(0, 6)
}

function extractProtagonist(text: string): string {
  const patterns = [
    /([\u4e00-\u9fa5]{2,4})[，,]\s*\d+\s*岁/,
    /主角[：:\s]*([\u4e00-\u9fa5]{2,4})/,
    /^([\u4e00-\u9fa5]{2,4})[，,]/m,
    /([\u4e00-\u9fa5]{2,4})[，,][^，。]{0,12}岁/,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) return m[1]
  }
  return '主角'
}

interface Relation {
  role: string
  name: string
  status: string
}

function extractRelations(text: string): Relation[] {
  const out: Relation[] = []
  // 括号状态改为可选，否则「- 对手 萧皇后」这类无括号的关系会被漏掉
  const re = /[-•*]?\s*([\u4e00-\u9fa5]{1,3})[\s:：]+([\u4e00-\u9fa5]{2,4})(?:[（(]([^）)]+)[）)])?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({ role: m[1], name: m[2], status: m[3] ?? '' })
  }
  return out
}

interface StyleProfile {
  shortSentences: boolean
  restrained: boolean
  objectMetaphor: boolean
  environmentLed: boolean
  dialogueHeavy: boolean
  ornate: boolean
  label: string
}

function extractStyle(text: string): StyleProfile {
  const has = (...ks: string[]) => ks.some(k => text.includes(k))
  const p: StyleProfile = {
    shortSentences: has('短句', '句短', '简洁', '利落'),
    restrained: has('冷峻', '克制', '冷静', '不动声色', '不直说'),
    objectMetaphor: has('比喻', '器物', '古物', '意象'),
    environmentLed: has('环境', '景物', '白描', '画面'),
    dialogueHeavy: has('对话', '对白', '口语'),
    ornate: has('华丽', '辞藻', '藻饰', '繁复', '浓墨'),
    label: '',
  }
  const labels: string[] = []
  if (p.shortSentences) labels.push('短句')
  if (p.restrained) labels.push('克制')
  if (p.objectMetaphor) labels.push('器物意象')
  if (p.environmentLed) labels.push('环境白描')
  if (p.dialogueHeavy) labels.push('对话驱动')
  if (p.ornate) labels.push('繁复辞藻')
  p.label = labels.length ? labels.join(' · ') : '未指定（默认平实）'
  return p
}

interface StructureInfo {
  volumes: number
  perVolume: number
  chapters: number
  totalWords: number
  wordsPerChapter: number
}

function extractStructure(structureText: string, lengthText: string): StructureInfo {
  const volM = structureText.match(/([\d一二三四五六七八九十]+)\s*卷/)
  const perM = structureText.match(/每卷\s*([\d一二三四五六七八九十]+)\s*章/)
  const totalM = lengthText.match(/总计?\s*([\d.]+)\s*万字?/) ?? structureText.match(/([\d.]+)\s*万字/)
  const perChapM = lengthText.match(/单章\s*([\d.]+)\s*万字?/)

  const volumes = volM ? cnToInt(volM[1]) ?? 3 : 3
  const perVolume = perM ? cnToInt(perM[1]) ?? 6 : 6
  const totalWords = totalM ? Math.round(parseFloat(totalM[1]) * 10000) : 180000
  const wordsPerChapter = perChapM ? Math.round(parseFloat(perChapM[1]) * 10000) : 10000

  let chapters = volumes * perVolume
  if (!volM || !perM) {
    const byLength = Math.round(totalWords / wordsPerChapter)
    if (byLength > 0) chapters = byLength
  }
  chapters = Math.max(3, Math.min(chapters, 60))
  return { volumes: Math.max(1, volumes), perVolume: Math.max(1, perVolume), chapters, totalWords, wordsPerChapter }
}

function extractRhythm(text: string): { climaxEvery: number; reversalPerVolume: boolean } {
  const m = text.match(/每\s*([\d一二三四五六七八九十]+)\s*章[^，。]{0,4}高潮/)
  const climaxEvery = m ? cnToInt(m[1]) ?? 3 : 3
  const reversalPerVolume = /每卷[^，。]{0,4}反转/.test(text) || /反转/.test(text)
  return { climaxEvery: Math.max(2, climaxEvery), reversalPerVolume }
}

function extractPlotBeats(text: string): string[] {
  const parts = text
    .split(/[，。；\n]/)
    .map(t => t.trim())
    .filter(t => t.length >= 4)
  return parts.slice(0, 6)
}

/* ---------------- 正文生成（受文笔风格驱动） ---------------- */

function buildProse(
  rng: Rng,
  name: string,
  nouns: string[],
  relations: Relation[],
  style: StyleProfile,
): string {
  const noun = nouns.length ? nouns[0] : '此物'
  const noun2 = nouns.length > 1 ? nouns[1] : noun
  const place = pick(['青瓦', '旧巷', '渡口', '城楼', '荒庙', '石阶', '长街'], rng)
  const ally = relations.find(r => /友|兄|妹|妻|夫/.test(r.role))?.name ?? '故人'
  const foe = relations.find(r => /对手|敌|仇/.test(r.role))?.name ?? '那人'
  const weather = pick(['雨', '雪', '风', '雾'], rng)

  const paras: string[] = []

  // 第一段：开场
  if (style.environmentLed) {
    paras.push(
      pick(
        [
          `${weather}落在${place}上。${name}站在檐下，看那道从匣中透出来的光。`,
          `${place}尽头亮着一盏灯。${name}走过去，${weather}把影子拉得很长。`,
          `天还没亮。${name}推开窗，${weather}气涌进来，带着铁锈的味道。`,
        ],
        rng,
      ),
    )
  } else {
    paras.push(
      pick(
        [
          `${name}是第三天到的${place}。${noun}就在他怀里，还是凉的。`,
          `${name}没有立刻动手。他先看了一圈，然后才把${noun}取出来。`,
          `事情起于一个消息：${noun}现世。${name}听完，只说了两个字——我去。`,
        ],
        rng,
      ),
    )
  }

  // 第二段：器物 / 细节
  if (style.objectMetaphor) {
    paras.push(
      pick(
        [
          `那${noun}像一枚旧铜钱，边缘磨得发亮。谁能想到，三千年前的东西，会落在一个教书先生手里。`,
          `${name}把${noun}放在桌上。烛火一跳，它的影子在墙上晃，像另一个人。`,
          `他数过，一共十二枚。这是第${pick(['三', '四', '五'], rng)}枚，也是最难收的一枚。`,
        ],
        rng,
      ),
    )
  } else {
    paras.push(
      pick(
        [
          `${noun}的来历，${name}查了六年。线索断过七次，每次都在快要接上时断掉。`,
          `他把${noun}收进袖中。这东西不该存在，可它偏偏在。`,
        ],
        rng,
      ),
    )
  }

  // 第三段：对话（对话驱动时加重）
  if (style.dialogueHeavy) {
    paras.push(
      pick(
        [
          `「你还是找到了。」${foe}在身后说。\n「不是我找到的，」${name}说，「是它自己出来的。」`,
          `「值得吗？」${ally}问。\n${name}没答。有些问题，答了就是认了。`,
          `「${noun2}在皇城。」${ally}压低声音，「你不能一个人去。」\n「我知道，」${name}说，「所以我没打算一个人去。」`,
        ],
        rng,
      ),
    )
  } else {
    paras.push(
      pick(
        [
          `${foe}在身后出声时，${name}没有回头。${weather}声很大，大到能盖住很多东西。`,
          `${ally}说过一句话，他一直记着：真正在动的那只手，从来不在明面上。`,
        ],
        rng,
      ),
    )
  }

  // 第四段：收束
  if (style.shortSentences) {
    paras.push(
      pick(
        [
          `他收好${noun}。起身。推门。\n${weather}还在下。路还长。`,
          `${name}把灯吹了。\n黑暗里，只有${noun}还在发亮。\n他看着它，看了很久。`,
          `明天还要赶路。他把${noun}贴身收好，躺下。\n有风。有${weather}。没有梦。`,
        ],
        rng,
      ),
    )
  } else if (style.ornate) {
    paras.push(
      `那一夜${weather}声不绝，${place}上的灯次第灭去。${name}独坐至天明，指腹摩挲着${noun}上冰冷的刻纹，仿佛摩挲着一段尚未写完的旧事——而旧事之后，尚有长路，尚有${noun2}，尚有一个他尚未谋面的结局。`,
    )
  } else {
    paras.push(
      pick(
        [
          `${weather}停的时候，${name}已经走出很远。${noun}贴着他胸口，温度终于和他一样了。`,
          `他把${noun}收好，转身走进${weather}里。后面是${place}，前面是${noun2}和一场还没开始的局。`,
        ],
        rng,
      ),
    )
  }

  // 情节依据不再塞进正文，改为独立字段返回，避免破坏叙事
  return paras.join('\n\n')
}

/* ---------------- 大纲生成 ---------------- */

function buildOutline(
  rng: Rng,
  info: StructureInfo,
  rhythm: { climaxEvery: number; reversalPerVolume: boolean },
  nouns: string[],
  relations: Relation[],
  beats: string[],
): ChapterOutline[] {
  const noun = nouns.length ? nouns[0] : '此物'
  const noun2 = nouns.length > 1 ? nouns[1] : noun
  const foe = relations.find(r => /对手|敌|仇/.test(r.role))?.name ?? '对手'
  // 反转优先指向「师」——情节里通常师门才是幕后黑手
  const mentor =
    relations.find(r => /师/.test(r.role))?.name ??
    relations.find(r => /父|母/.test(r.role))?.name ??
    '师长'

  // 按 tag 取标题模板，用章序轮转避免相邻重复
  const TITLE_BANK: Record<ChapterOutline['tag'], string[]> = {
    开局: ['{n1}现世', '风起{n2}', '开局：{n1}', '{n1}初现'],
    推进: ['{n1}之踪', '{n2}的线索', '{n1}余波', '再寻{n2}', '{n2}未明', '{n1}在手'],
    高潮: ['{n1}之争', '{n2}之围', '高点：{n1}', '{n1}现于市', '兵临{n2}'],
    反转: ['{mentor}的真面', '{n1}背后的手', '反转：{foe}', '谁在执子', '{mentor}的另一面'],
    收束: ['终局', '{n1}归位', '最后一场', '{n2}落定'],
  }

  const out: ChapterOutline[] = []
  for (let i = 1; i <= info.chapters; i++) {
    const volEnd = i % info.perVolume === 0
    const isLast = i === info.chapters
    const isClimax = !isLast && !volEnd && i % rhythm.climaxEvery === 0

    let tag: ChapterOutline['tag']
    if (i === 1) tag = '开局'
    else if (isLast) tag = '收束'
    else if (volEnd && rhythm.reversalPerVolume) tag = '反转'
    else if (isClimax) tag = '高潮'
    else tag = '推进'

    const beatText = beats.length ? beats[(i - 1) % beats.length] : '主线推进'

    const bank = TITLE_BANK[tag]
    const raw = bank[(i - 1) % bank.length]
    const title = raw
      .replace(/\{n1\}/g, noun)
      .replace(/\{n2\}/g, noun2)
      .replace(/\{mentor\}/g, mentor)
      .replace(/\{foe\}/g, foe)

    let summary = ''
    switch (tag) {
      case '开局':
        summary = `铺陈世界与${noun}的由来，主角登场，首个目标浮现。`
        break
      case '高潮':
        summary = `本段张力最高点：${beatText}，冲突正面爆发。`
        break
      case '反转':
        summary = `卷末反转：既有认知被推翻，${mentor}与${foe}的关系重排。`
        break
      case '收束':
        summary = `所有线索收拢，${noun}落定，结局揭晓。`
        break
      default:
        summary = `${beatText}；推进主线并向下一个高点蓄力。`
    }

    out.push({
      index: i,
      title,
      summary,
      tag,
      words: info.wordsPerChapter,
    })
  }
  return out
}

/* ---------------- 主入口 ---------------- */

export function generateBook(canvases: Canvas[]): GeneratedBook {
  const blob = canvases.map(c => c.content + c.anchors.map(a => a.features).join()).join('|')
  const rng = makeRng(hashString(blob))

  const settingText = contentOf(canvases, '设定')
  const characterText = contentOf(canvases, '人物')
  const styleText = contentOf(canvases, '文笔')
  const structureText = contentOf(canvases, '结构')
  const lengthText = contentOf(canvases, '篇幅')
  const plotText = contentOf(canvases, '情节')
  const rhythmText = contentOf(canvases, '节奏')

  const nouns = extractWorldNouns(settingText)
  const hero = extractProtagonist(characterText)
  const relations = extractRelations(characterText)
  const style = extractStyle(styleText)
  const info = extractStructure(structureText, lengthText)
  const rhythm = extractRhythm(rhythmText)
  const beats = extractPlotBeats(plotText)

  // 参考锚点：并入风格与来源
  const anchorSources = canvases
    .flatMap(c => c.anchors.map(a => a.source))
    .filter(Boolean)
  const anchorFeatures = canvases.flatMap(c => c.anchors.map(a => `${c.dimension}：${a.features}`))

  const title = pick(
    [
      `${nouns[0] ?? '长夜'}·${hero}`,
      `十二${nouns[0] ?? '器'}`,
      `${hero}与${nouns[0] ?? '旧事'}`,
      `${nouns[0] ?? '残章'}行`,
    ],
    rng,
  )

  const stripEnd = (s: string) => s.replace(/[。.\s、，,]+$/, '')
  const settingLine = stripEnd(settingText.split(/[。\n]/)[0] || '在一个尚未写完的世界里')
  const charLine = stripEnd(
    characterText.split(/[。\n]/)[0]?.replace(/^[^，,]*[，,]/, '') || '一个带着目的上路的人',
  )
  const plotLine = stripEnd(plotText || '主线待补')

  const synopsis = [`${settingLine}。`, `${hero}——${charLine}。`, `${plotLine}。`].join('')

  const outline = buildOutline(rng, info, rhythm, nouns, relations, beats)

  const sampleChapter = {
    title: `第一章 · ${outline[0]?.title ?? '开局'}`,
    content: buildProse(rng, hero, nouns, relations, style),
    beat: beats[0] ?? '',
  }

  return {
    title,
    synopsis,
    outline,
    sampleChapter,
    stats: {
      totalWords: info.totalWords,
      chapters: info.chapters,
      volumes: info.volumes,
      styleLabel: style.label + (anchorFeatures.length ? `（叠加 ${anchorFeatures.length} 条锚点特征）` : ''),
      anchorSources: [...new Set(anchorSources)],
    },
    generatedAt: new Date().toLocaleString('zh-CN'),
  }
}
