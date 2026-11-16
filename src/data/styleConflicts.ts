/* ============================================================
   文风卡矛盾检测（本地规则，不调 LLM）
   ------------------------------------------------------------
   原理：给每张卡从 tagline / effect / applyText 里提取「风格特征」，
   两张卡的特征落在同一对矛盾轴的两端，就算互相打架。
   用途：往画布里套第二张卡时提示「它和已套用的 X 矛盾在哪儿」。
   规则是启发式的：宁可少报，不要误报——只收能从卡面文字直接认出的特征。
   ============================================================ */

import type { StyleCard } from './styleCards'

interface Trait {
  key: string
  label: string
  re: RegExp
}

const TRAITS: Trait[] = [
  { key: 'duan', label: '短句', re: /短句|短促|一句不超过|一句一个意思|句子被切|断裂|切成/ },
  { key: 'chang', label: '长句', re: /长句|从句|绕上几页|能长到一页|铺排|绵长的句子/ },
  { key: 'kezhi', label: '克制', re: /克制|零度|不动声色|冷叙述|冷眼/ },
  { key: 'chilie', label: '炽烈', re: /炽烈|炽热|浓烈|豪放|全音量|奔涌|不加节制/ },
  { key: 'leng', label: '冷调', re: /冷感|冷峻|冷调|阴冷|阴郁|偏冷|冷光|冷叙述|冷硬/ },
  { key: 're', label: '热调', re: /用词偏热|炽热|热情|滚烫|暖/ },
  { key: 'huali', label: '华丽', re: /华丽|浓墨|铺排|色彩词|繁复|对仗|辞藻|整饬/ },
  { key: 'pusu', label: '朴素', re: /朴素|素朴|白描|平实|简净|极简|冲淡|明白如话/ },
  { key: 'kouyu', label: '口语', re: /口语|京味|京片子|大白话|像日常说话/ },
  { key: 'wenyan', label: '文言/书面', re: /文言|书面语重|典雅|古典白话/ },
  { key: 'diyi', label: '第一人称', re: /第一人称/ },
  { key: 'disan', label: '第三人称/全知', re: /第三人称|全知/ },
  { key: 'kuai', label: '快节奏', re: /节奏快|快节奏|倒计时|节奏急|节奏在加速/ },
  { key: 'man', label: '慢节奏', re: /节奏慢|缓慢升压|升压极慢|慢节奏/ },
  { key: 'liubai', label: '留白多', re: /留白|不说满|空白|省略/ },
  { key: 'mianmi', label: '绵密', re: /绵密|密实|密不透风|细节密|密度极高|博物馆式的耐心/ },
  { key: 'youmo', label: '幽默', re: /幽默|诙谐|调侃|滑稽/ },
  { key: 'yinyu', label: '阴郁', re: /阴郁|阴冷|梦呓|哥特|恐怖/ },
  { key: 'shuqing', label: '抒情', re: /抒情/ },
  { key: 'bushuqing', label: '不抒情', re: /不抒情|禁止抒情/ },
]

/** 互相打架的特征轴（两端不能同用） */
const CONFLICT_AXES: Array<[string, string]> = [
  ['duan', 'chang'],
  ['kezhi', 'chilie'],
  ['leng', 're'],
  ['huali', 'pusu'],
  ['kouyu', 'wenyan'],
  ['diyi', 'disan'],
  ['kuai', 'man'],
  ['liubai', 'mianmi'],
  ['youmo', 'yinyu'],
  ['shuqing', 'bushuqing'],
]

const traitLabel = (key: string) => TRAITS.find(t => t.key === key)?.label ?? key

/** 禁忌句里的否定说法（「不要长句」「不冷硬」「拒绝长从句」），提取特征前先抹掉，否则会把「不要长句」误认成「长句」 */
const NEG_RE = /(?:不用|不写|不要|不宜|不做|不许|不得|不可|避免|拒绝|忌|禁止)[一-鿿]{0,4}/g
/** 「不抒情」是独立特征词，先抠出来防止它被否定剥离误伤，也防止残留的「抒情」误报成 shuqing */
const BUSHUQING_RE = /不抒情|禁止抒情/g
/** 「长句短句交错」这类两头都写的表述不算任何一端的特征 */
const MIXED_RE = /长短句|长句短句|短句长句/g

const traitCache = new Map<string, string[]>()

/** 提取一张卡的风格特征（结果按卡 id 缓存） */
export function cardTraits(card: StyleCard): string[] {
  const hit = traitCache.get(card.id)
  if (hit) return hit
  const raw = `${card.tagline}\n${card.effect}\n${card.applyText}`
  const cleaned = raw.replace(BUSHUQING_RE, '□').replace(NEG_RE, '□').replace(MIXED_RE, '□')
  let keys = TRAITS.filter(t =>
    t.key === 'bushuqing' ? BUSHUQING_RE.test(raw) : t.re.test(cleaned),
  ).map(t => t.key)
  // 一张卡同时写了两端（如「长句奔涌，短句如刀」）说明它两头都来，视为该轴上灵活，不参与冲突
  for (const [x, y] of CONFLICT_AXES) {
    if (keys.includes(x) && keys.includes(y)) keys = keys.filter(k => k !== x && k !== y)
  }
  traitCache.set(card.id, keys)
  return keys
}

/** 两张卡之间的矛盾点（如「短句 ↔ 长句」），没有矛盾返回空数组 */
export function conflictsBetween(a: StyleCard, b: StyleCard): string[] {
  const ta = cardTraits(a)
  const tb = new Set(cardTraits(b))
  const out: string[] = []
  for (const [x, y] of CONFLICT_AXES) {
    if (ta.includes(x) && tb.has(y)) out.push(`${traitLabel(x)} ↔ ${traitLabel(y)}`)
    else if (ta.includes(y) && tb.has(x)) out.push(`${traitLabel(y)} ↔ ${traitLabel(x)}`)
  }
  return out
}

export interface CardConflict {
  card: StyleCard
  pairs: string[]
}

/** 找出 card 与「已在画布里生效的那些卡」之间的所有矛盾 */
export function conflictsWithApplied(card: StyleCard, applied: StyleCard[]): CardConflict[] {
  return applied
    .filter(o => o.id !== card.id)
    .map(o => ({ card: o, pairs: conflictsBetween(card, o) }))
    .filter(r => r.pairs.length > 0)
}

/** 从画布正文里认出已套用了哪些卡（约定：套用时都会写入「【文风卡 · 名】」标记行） */
export function appliedCardNames(content: string): string[] {
  const out: string[] = []
  const re = /【文风卡 · (.+?)】/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content || ''))) {
    const name = (m[1] || '').trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}
