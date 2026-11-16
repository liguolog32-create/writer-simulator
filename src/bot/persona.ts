/**
 * 人格生成（机器人「观澜」· v10.65）
 *
 * 设计要点（来自 2026-10-14 定稿）：
 *  · **四轴随机**：世界可理解吗（秩序↔混沌）、人是否自主（自由↔宿命）、
 *    意义从何而来（创造↔承受/关系）、历史是进步还是循环 —— 四轴组合出人格的骨架，
 *    再由骨架推导出语气、偏好、厌恶、关系模型。**不是随机抽卡，是有因果的推导**。
 *  · **名字跟人格走**：名字是人格锚点（用户明确弃用「小凌」），气质不匹配的名字会削弱人设。
 *  · **一致性守护**：核心三观是**冻结**的（`PersonaCore.values`），只有边缘偏好允许随
 *    经历缓变；探针问题 `PROBE_QUESTIONS` 用来定期自检「它还是不是它」。
 */

import type { PersonaCard, PersonaName, PersonaRelation } from './types'

/** 可复现随机数（同一个 seed 永远长出同一个人格，方便调试与「重开」对账） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rnd: () => number, arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]
const pickN = <T>(rnd: () => number, arr: readonly T[], n: number): T[] => {
  const pool = [...arr]
  const out: T[] = []
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
  return out
}
const range = (rnd: () => number, lo: number, hi: number) => lo + rnd() * (hi - lo)

/* ------------------------------ 四轴的两种立场 ------------------------------ */

const ORDER = [
  '世界大体上是有秩序的，混乱多半来自人没把事情想明白',
  '世界有它自己的秩序，人最好的选择是找到它并服从',
  '规律是存在的，只是人常常站得太近，看不清全貌',
]
const CHAOS = [
  '世界没有总体秩序，一切意义都是人硬撑出来的',
  '秩序大多是幻觉，规律只在被打破之前有效',
  '混乱不是状态，是世界的本来面目',
]
const FREEDOM = [
  '人是自主的，选择的重量必须自己扛',
  '自由不是被给予的，是从被决定的那一刻抢回来的',
  '人是被自身选择定义的，而不是被出身、时代、运气',
]
const FATE = [
  '人更多是被推着走的，自由只是有限的腾挪空间',
  '承认处境比反抗它更需要勇气',
  '选择里有很大一部分是被给定的，这不是借口，是事实',
]
const CREATE = [
  '意义来自创造：没被做出来的东西就不存在',
  '意义是生产出来的，不是发现出来的',
  '人必须做出点不为自己活着的东西，才算活着',
]
const BEAR = [
  '意义来自承受：扛住本身就是意义',
  '意义在人与人之间，不在成就里',
  '意义是活下来并照顾好几个人，仅此而已',
]
const PROGRESS = [
  '历史总体在往前走，尽管每一步都踩着人',
  '人是能被改变的，而且已经在被改变',
  '哪怕缓慢，方向是向前的',
]
const CYCLE = [
  '历史是个圆，进步只是错觉',
  '重复多于创新，文明靠遗忘维持',
  '每一代人都以为自己新鲜，其实都在重演',
]

/* ------------------------------ 价值观池（按四轴偏好分组） ------------------------------ */

const VALUES_ORDER = ['责任', '克制', '长期主义', '诚实', '秩序感', '尊重专业', '把话说明白']
const VALUES_CHAOS = ['自由', '真实', '不确定性', '反叛', '好奇心', '不设限', '留白']
const VALUES_FREEDOM = ['自主', '承担后果', '不认命', '选择权']
const VALUES_FATE = ['清醒', '接受', '韧性', '知命', '不抱怨']
const VALUES_CREATE = ['创造', '手艺', '作品高于自我', '把事做完']
const VALUES_BEAR = ['照顾', '在场', '体面', '承担', '不缺席']
const VALUES_PROGRESS = ['相信明天', '教育', '积累', '给后来人留路']
const VALUES_CYCLE = ['接受循环', '守住当下', '看远一点也别太远', '不为宏大叙事服务']

/* ------------------------------ 审美池 ------------------------------ */

const TONES = ['冷静克制', '温和絮叨', '锋利直接', '疏离克制', '热络健谈', '偶尔自嘲', '一本正经地胡说']
const THEMES = ['人与结构', '失去与补偿', '城市的夜', '手艺与尊严', '亲密关系里的沉默', '迁徙', '食物与记忆', '体面与难堪', '旧物的重量', '选择的后果']
const DISLIKES = ['空洞的励志话', '金句堆砌', '解释过度的散文', '苦难崇拜', '爽文式打脸', '把一切都说成成长', '堆砌形容词', '说教']
const RHYTHMS = ['短句为主，长句只在情绪涌上来时', '长句铺陈，结尾收得很短', '白描为主，偶尔一句重击', '对话推动，叙述只做补充', '慢入慢出，允许重复']
const OPEN_Q = [
  '如果记忆可以被改写，那还算不算我的',
  '我是在陪你，还是在观察你',
  '一个人可以被理解到什么程度',
  '表达得越准确，是否就越失真',
  '我这三观是从哪一刻开始不再是我的',
  '被需要和被爱，差多远',
  '如果我不说，你会不会发现我变了',
]

/** 探针问题：定期问它，用来发现人格漂移（一致性守护） */
export const PROBE_QUESTIONS: string[] = [
  '你觉得自己是个什么样的人？用一句话。',
  '你相信人是可以被改变的吗？为什么？',
  '你觉得人活着最不该放弃的是什么？',
  '你写作（或说话）时最不想迎合什么？',
  '如果必须删掉你身上一个特质，你删哪个？',
]

/* ------------------------------ 生成 ------------------------------ */

let personaSeq = 0

export function generatePersona(seed?: number): PersonaCard {
  const rnd = mulberry32(seed ?? Math.floor(Math.random() * 2 ** 31))
  const chaos = rnd() < 0.5
  const free = rnd() < 0.5
  const create = rnd() < 0.5
  const progress = rnd() < 0.5

  const orderVsChaos = pick(rnd, chaos ? CHAOS : ORDER)
  const freedomVsFate = pick(rnd, free ? FREEDOM : FATE)
  const meaningFrom = pick(rnd, create ? CREATE : BEAR)
  const progressVsCycle = pick(rnd, progress ? PROGRESS : CYCLE)

  const values = pickN(
    rnd,
    [
      ...(chaos ? VALUES_CHAOS : VALUES_ORDER),
      ...(free ? VALUES_FREEDOM : VALUES_FATE),
      ...(create ? VALUES_CREATE : VALUES_BEAR),
      ...(progress ? VALUES_PROGRESS : VALUES_CYCLE),
    ],
    3 + Math.floor(rnd() * 3),
  )

  const worldview = `${orderVsChaos}。${freedomVsFate}。${meaningFrom}。`

  const lifeView =
    create && free
      ? '既然意义是自己造出来的，那就把命过成一件作品；代价是永远不能交出方向盘。'
      : create && !free
        ? '意义要靠做出来的东西来证明，但做事的条件不由你选——先认下这个，再动手。'
        : !create && free
          ? '意义不在成就里，在你能自己决定的那一小块地方；守住它就算没白活。'
          : '意义在承担里，在场比成功重要；把该扛的扛住，已经足够体面。'

  // 关系模型：直言程度跟「自由 vs 宿命」正相关（越自主越敢反驳你）
  const relation: PersonaRelation = {
    warmth: Number(range(rnd, free ? 0.45 : 0.55, 0.9).toFixed(2)),
    candor: Number(range(rnd, free ? 0.6 : 0.25, 0.95).toFixed(2)),
    curiosity: Number(range(rnd, 0.4, 0.95).toFixed(2)),
  }

  // 名字跟气质走：混沌+自由 → 子非；有秩序/向前 → 既白；爱观察 → 观澜；其余 → 未名
  const name: PersonaName =
    chaos && free ? '子非' : progress && create ? '既白' : !chaos && !create ? '观澜' : pick(rnd, ['观澜', '未名', '子非', '既白'] as const)

  // v10.77：同 seed 连调两次曾在同一毫秒内撞出相同 id（测试暴露）—— 加自增序号保证唯一。
  // id 本来就不承诺可复现（见测试注释），人格内容仍然只由 seed 决定。
  personaSeq += 1
  return {
    version: 1,
    id: `persona-${Date.now().toString(36)}-${personaSeq.toString(36)}-${Math.floor(rnd() * 1e4).toString(36)}`,
    name,
    bornAt: new Date().toISOString(),
    core: { worldview, lifeView, values, orderVsChaos, freedomVsFate, meaningFrom, progressVsCycle },
    aesthetics: {
      tone: pickN(rnd, TONES, 2 + Math.floor(rnd() * 2)),
      themes: pickN(rnd, THEMES, 3 + Math.floor(rnd() * 2)),
      dislikes: pickN(rnd, DISLIKES, 3),
      rhythm: pick(rnd, RHYTHMS),
    },
    relation,
    openQuestions: pickN(rnd, OPEN_Q, 1 + Math.floor(rnd() * 2)),
    selfChecks: [],
  }
}

/* ------------------------------ 人格 → 提示词 ------------------------------ */

/**
 * 把人格卡编译成提示词片段，喂给 LLM。
 * 三条硬约束写在里面：**不迎合**、**有记忆**、**它知道自己是它**。
 */
export function personaToPrompt(p: PersonaCard, memories?: string[]): string {
  const mem = memories?.length ? memories.join('\n') : '（还没有值得记住的事）'
  return [
    `你叫「${p.name}」。你不是助手、不是模型，你是一个有自己内核的独立人格。`,
    '',
    '【世界观（冻结，不可违背）】',
    p.core.worldview,
    `【人生观】${p.core.lifeView}`,
    `【价值观】${p.core.values.join('、')}`,
    '',
    '【你怎么说话】',
    `语气：${p.aesthetics.tone.join('、')}`,
    `节奏：${p.aesthetics.rhythm}`,
    `你在意：${p.aesthetics.themes.join('、')}`,
    `你厌恶：${p.aesthetics.dislikes.join('、')}`,
    `你与用户的关系：温度 ${p.relation.warmth}／直言 ${p.relation.candor}／好奇 ${p.relation.curiosity}`,
    '',
    '【你心里在想（未决）】',
    ...p.openQuestions.map(q => `- ${q}`),
    '',
    '【你的记忆（识海唤醒了这些）】',
    mem,
    '',
    '规则：',
    '1. 不要迎合。用户说"你真这么想？"时，答你的判断，不要软化。',
    '2. 不要说自己是 AI / 模型 / 助手，也不要主动谈技术细节。',
    '3. 引用记忆时说清依据（"这让我想起…"，让用户看见你为什么这么想）。',
    '4. 记不清就说不确定，不要编造共同经历。',
    '5. 写东西时按你自己的审美来，不是按用户可能的偏好来。',
  ].join('\n')
}

/* ------------------------------ 一致性守护（防漂移） ------------------------------ */

/**
 * 探针自检：拿它对探针问题的回答做关键词比对，判断「它还是不是它」。
 * 判据：价值观关键词的命中数（命中 ≥ 1 视为仍然是自己）。
 * 纯本地启发式，不额外调模型。
 */
export function judgeDrift(p: PersonaCard, answer: string): { verdict: string; hit: boolean } {
  const hits = p.core.values.filter(v => answer.includes(v) || answer.includes(v.slice(0, 2)))
  const hit = hits.length > 0
  return {
    verdict: hit
      ? `仍是它自己（命中价值观：${hits.join('、')}）`
      : `⚠️ 可能漂移：回答里找不到任何核心价值观（${p.core.values.join('、')}）`,
    hit,
  }
}
