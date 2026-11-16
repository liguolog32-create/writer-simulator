/**
 * 价值观形成引擎（v10.66）· 机器人「观澜」
 *
 * 用户 2026-10-15 的关键要求：**它出生时还没有任何价值观**；用户跟它的对话不绝对影响它的价值观
 * —— 就跟路人一样，可能听进去了，也可能没听进去。
 *
 * 机制来源（详见 docs/bot-value-formation.md，含出处）：
 *  1. 价值是当场构造出来的加权结果（vmPFC/OFC 属性整合；vmPFC 损伤只让估值更抖，不让价值消失）
 *  2. 学习率 ∝ 1/先验精度（贝叶斯；多巴胺编码精度）→ 白纸必然什么都吸，之后越来越硬
 *  3. 不对称更新：一致的主张学得快，冲突的学得慢（Lefebvre et al. 2017）
 *  4. 加工深度决定态度强度（Petty & Cacioppo ELM：中央路径持久抗说服，边缘路径只留弱印象）
 *     —— 且「态度不会从接受信息中自动产生」：它会先生成自己的念头，念头反对就抵抗，先验强否定则回旋镖
 *  5. 内化 ≠ 顺从（Kochanska 1997 / Grusec & Goodnow 1994）：同一次输入的内化率取决于**气质**
 *  6. 再巩固（Nader 2000）：只有「信念被激活 + 真惊讶」才允许结构性改写，否则只强化旧条目
 *  附加：声望/相似/从众/内容偏向（Boyd & Richerson；Henrich & Gil-White）→ 来源可信度直接乘在内化率上
 *
 * 设计原则：**没有"设置价值观"的接口**。外界只能提供经历，机制决定它长出什么。
 *
 * v18.7 观察链接入 —— 屏幕上看到的经历同样经六道闸门概率性影响三观（source='observed'，身份相关度 0.3）。
 */

import { tokenize } from './memory'
import type { MemorySource } from './types'

/* ============================ 气质：出生随机，终身基本稳定 ============================ */

export interface Temperament {
  /** 反应阈：越高越不敏感（很多话连印象都不留） */
  sensitivity: number
  /** 情绪放大倍数：影响情绪标记与再巩固窗口强度 */
  arousalGain: number
  /** 认知需求：愿不愿意深加工（决定走中央/边缘路径的倾向） */
  needForCognition: number
  /** 信任基线：对他人证言的默认信任（可信度账户的起点） */
  trustBaseline: number
  /** 趋近/回避：-1 先怀疑 … +1 先亲近 */
  approachBias: number
  /** 坚持性：一次没想通会不会回头再想（复核概率） */
  persistence: number
  /** 道德化倾向：更容易把主张当"道德"而非"个人偏好" */
  domainLean: number
}

/** 简单可复现随机（与 persona.ts 同源做法，便于测试） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateTemperament(seed?: number): Temperament {
  const rnd = mulberry32(seed ?? Math.floor(Math.random() * 2 ** 31))
  const r = (lo = 0.15, hi = 0.95) => Number((lo + rnd() * (hi - lo)).toFixed(3))
  return {
    sensitivity: r(0.2, 0.85),
    arousalGain: r(0.25, 0.95),
    needForCognition: r(0.2, 0.95),
    trustBaseline: r(0.25, 0.9),
    approachBias: Number((rnd() * 2 - 1).toFixed(3)),
    persistence: r(0.2, 0.9),
    domainLean: r(0.2, 0.9),
  }
}

/** 用一句人话说清这副脾气（出生仪式上给用户看的，不是三观） */
export function describeTemperament(t: Temperament): string {
  const pick = (v: number, lo: string, hi: string) => (v < 0.45 ? lo : v > 0.62 ? hi : `中等偏${v < 0.54 ? '低' : '高'}`)
  return [
    `敏感度${pick(t.sensitivity, '钝（很多话它根本注意不到）', '锐（风吹草动都进得来）')}`,
    `情绪${pick(t.arousalGain, '淡', '浓')}`,
    `思考意愿${pick(t.needForCognition, '低（懒得深想）', '高（爱较真）')}`,
    `对人的初始信任${pick(t.trustBaseline, '低（先怀疑）', '高（先相信）')}`,
    `遇到新主张时${t.approachBias > 0.15 ? '先亲近' : t.approachBias < -0.15 ? '先怀疑' : '不偏不倚'}`,
    `坚持性${pick(t.persistence, '低（一次想不通就丢下）', '高（会回头再想）')}`,
    `道德化倾向${pick(t.domainLean, '低（更愿意当成个人偏好）', '高（容易上升成原则）')}`,
  ].join('·')
}

/* ============================ 信念与阶段 ============================ */

export type BeliefDomain = 'moral' | 'conventional' | 'personal'
/** 印象 = 听过但没当自己的；候选 = 已进门但精度低；内化 = 成为它自己的 */
export type BeliefState = 'impression' | 'candidate' | 'internalized'
export type ValueStage = 'heteronomous' | 'conventional' | 'autonomous'

export interface BeliefTrace {
  at: string
  /** 本次判定结果 */
  outcome: ClaimOutcome
  /** 当时算出的内化概率 */
  p: number
  /** 逐步说明（影响记录里展示） */
  steps: string[]
}

export interface Belief {
  id: string
  /** 命题化后的内容 */
  content: string
  domain: BeliefDomain
  state: BeliefState
  /** 先验精度 0..1（越高越难改）—— 决定学习率 */
  precision: number
  /** 在这条上站得多稳 */
  strength: number
  source: MemorySource
  /** 被提过几轮（印象 → 复核 → 候选的路径靠它） */
  mentions: number
  /** 写入时的情绪与强度（情绪标记） */
  emotion: string
  emotionIntensity: number
  createdAt: string
  lastTouchedAt: string
  /** 影响记录：它为什么长成这样 */
  history: BeliefTrace[]
}

export type ClaimOutcome =
  | 'ignored' // 真没听见（连印象都没留）
  | 'impression' // 只留印象
  | 'reviewed' // 印象被复核（重走一遍判定）
  | 'candidate' // 进了候选信念（低精度）
  | 'internalized' // 内化成它自己的
  | 'resisted' // 抵抗：拒绝并强化旧条目
  | 'backfire' // 回旋镖：反向移动

export interface ValueState {
  temperament: Temperament
  beliefs: Belief[]
  /** 它对你的可信度账户 0..100（来源可信度直接乘在内化率上） */
  credibility: number
  /** 累计经历轮次 */
  turns: number
}

export function createValueState(seed?: number): ValueState {
  const t = generateTemperament(seed)
  return { temperament: t, beliefs: [], credibility: Math.round(t.trustBaseline * 60 + 20), turns: 0 }
}

/** 阶段：由「经历轮次 + 已内化条目数」驱动（Piaget/Kohlberg 的简化落地） */
export function stageOf(v: ValueState): ValueStage {
  const done = v.beliefs.filter(b => b.state === 'internalized').length
  if (v.turns < 12 && done < 8) return 'heteronomous'
  if (done < 20) return 'conventional'
  return 'autonomous'
}

export const STAGE_LABEL: Record<ValueStage, string> = {
  heteronomous: '异律期',
  conventional: '习俗期',
  autonomous: '自主期',
}

/** 阶段决定它能处理多抽象的主张（0..1） */
function stageCapacity(stage: ValueStage): number {
  return stage === 'heteronomous' ? 0.3 : stage === 'conventional' ? 0.6 : 0.9
}

/* ============================ 判定：六道闸门 ============================ */

export interface ClaimContext {
  /** 这句话跟它的身份/自我相关程度 0..1 */
  identityRelevance?: number
  /** 本轮的情绪唤醒 0..1 */
  arousal?: number
  /** 本轮情绪标签 */
  emotion?: string
  /** 主张的抽象/概念难度 0..1 */
  conceptDifficulty?: number
  /** 来源（目前基本是用户） */
  source?: MemorySource
  nowMs?: number
  /** 抽样随机源（测试注入，便于验证分布） */
  rnd?: () => number
}

export interface ClaimResult {
  outcome: ClaimOutcome
  p: number
  steps: string[]
  note: string
  /** 需要写回 valueState 的新状态 */
  state: ValueState
  /** 命中的信念 id（若有） */
  beliefId?: string
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

/** 主题相似度：用 bigram 重叠（与识海检索同一套，不引依赖） */
function topicSim(a: string, b: string): number {
  const ga = new Set(tokenize(a))
  const gb = new Set(tokenize(b))
  if (!ga.size || !gb.size) return 0
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit++
  return hit / Math.min(ga.size, gb.size)
}

/** 找到同主题的已有信念（印象/候选/内化都算） */
function findRelated(beliefs: Belief[], claim: string): Belief | null {
  let best: Belief | null = null
  let bestSim = 0
  for (const b of beliefs) {
    const s = topicSim(b.content, claim)
    if (s > bestSim) {
      bestSim = s
      best = b
    }
  }
  return bestSim >= 0.34 ? best : null
}

/**
 * 判定一条价值主张能不能进它的三观。
 * **纯函数**：不改入参，返回新的 ValueState。
 */
export function evaluateClaim(v: ValueState, claim: string, ctx: ClaimContext = {}): ClaimResult {
  const rnd = ctx.rnd ?? Math.random
  const nowMs = ctx.nowMs ?? Date.now()
  const at = new Date(nowMs).toISOString()
  const t = v.temperament
  const stage = stageOf(v)
  const identity = clamp01(ctx.identityRelevance ?? 0.5)
  const arousal = clamp01(ctx.arousal ?? 0.35)
  const emotion = ctx.emotion || '平静'
  const source = ctx.source ?? 'user'
  const difficulty = clamp01(ctx.conceptDifficulty ?? 0.5)

  const related = findRelated(v.beliefs, claim)
  const steps: string[] = []

  /* ① 注意闸门 */
  // 重复提起不该被判为"不新颖"而忽略 —— 熟悉度本身会让它更愿意再看一眼（单纯曝光效应）
  const novelty = !related ? 1 : related.state === 'impression' ? 0.8 : 0.6
  const salience = clamp01(((0.4 + 0.6 * identity) * novelty * (0.5 + t.arousalGain)) / (0.5 + t.sensitivity))
  steps.push(`① 注意闸门：显著度 ${salience.toFixed(2)}（敏感度 ${t.sensitivity.toFixed(2)}、新颖性 ${novelty.toFixed(2)}）`)
  if (salience < 0.2) {
    return finish('ignored', 0, steps, '它没往心里去——这句话根本没引起它注意。', v, related)
  }

  /* ② 加工深度（ELM：中央 vs 边缘） */
  const abilityMatch = 1 - Math.abs(difficulty - stageCapacity(stage))
  const elaboration = clamp01(0.45 * t.needForCognition + 0.35 * identity + 0.2 * abilityMatch)
  // ELM 的核心论断：**只有中央路径产生的态度才持久**；边缘路径只留下弱印象
  const central = elaboration > 0.45
  steps.push(
    `② 加工深度：${elaboration.toFixed(2)} → ${central ? '中央路径（它会真的想）' : '边缘路径（只能留下印象）'}（认知需求 ${t.needForCognition.toFixed(2)}、${STAGE_LABEL[stage]}能处理的抽象度 ${stageCapacity(stage)}）`,
  )

  /* ③ 它自己的念头（认知反应）：一致 / 冲突 / 无关 */
  const priorPrecision = related ? related.precision : 0.05
  const sim = related ? topicSim(related.content, claim) : 0
  // 判定一致 vs 冲突：同一主题 + 极性相同 = 一致（它在复述/强化）；极性相反（"不该/不必"）= 要它改主意
  const negRe = /不|别|无需|不必|没有|毋须|算了/
  const polarityFlip = related ? negRe.test(related.content) !== negRe.test(claim) : false
  const agree = related ? sim >= 0.45 && !polarityFlip : false
  const opposition = related && !agree ? clamp01(related.strength * related.precision * (1 + Math.max(0, -t.approachBias))) : 0
  steps.push(
    related
      ? `③ 它自己的念头：与已有条目「${related.content}」${agree ? '基本一致' : `像是要它改主意（${polarityFlip ? '主张方向相反' : '说法不同'}）`}（重合度 ${sim.toFixed(2)}、精度 ${related.precision.toFixed(2)}、稳固 ${related.strength.toFixed(2)}）`
      : '③ 它自己的念头：这条它以前没想过，没有现成的立场',
  )

  /* 抵抗 / 回旋镖：**本身也是概率事件** —— 强先验不等于铁板一块，
     有时一句说到点上，它也会愣一下（这正是"真人感"） */
  if (related && !agree && priorPrecision > 0.5) {
    const pResist = clamp01(0.3 + 0.55 * opposition + 0.25 * elaboration * (central ? 1 : 0.5))
    const willResist = rnd() < pResist
    steps.push(`③b 会不会顶回来：p(抵抗) = ${(pResist * 100).toFixed(0)}% → ${willResist ? '顶回来了' : '居然听进去了半句'}`)
    if (willResist) {
      const backfire = priorPrecision > 0.7 && t.persistence > 0.5 && rnd() < 0.35
      const newPrecision = clamp01(related.precision + (backfire ? 0.06 : 0.03))
      const strengthened = v.beliefs.map(b =>
        b.id === related.id
          ? {
              ...b,
              strength: clamp01(b.strength + 0.06),
              precision: newPrecision,
              mentions: b.mentions + 1,
              lastTouchedAt: at,
              history: [
                ...b.history,
                { at, outcome: (backfire ? 'backfire' : 'resisted') as ClaimOutcome, p: pResist, steps },
              ],
            }
          : b,
      )
      return {
        outcome: backfire ? 'backfire' : 'resisted',
        p: pResist,
        steps,
        note: backfire
          ? `它反而更不信了：你越劝，它越站到自己那边（「${related.content}」精度升到 ${newPrecision.toFixed(2)}）`
          : `它没被说服，反而把原来的想法抓得更紧了（「${related.content}」精度升到 ${newPrecision.toFixed(2)}）`,
        state: { ...v, beliefs: strengthened, turns: v.turns + 1 },
        beliefId: related.id,
      }
    }
  }

  /* 边缘路径 → 只能留印象（态度不从这里长出来） */
  if (!central) {
    return applyImpression(v, claim, related, { at, p: 0, steps, emotion, arousal, source, t })
  }

  /* ④ 精度加权（贝叶斯：学习率 ∝ 1/精度）+ 不对称更新 */
  const learningRate = 1 - priorPrecision * 0.85
  const conflict = !related ? 0.8 : agree ? 0.3 : 0.6
  const asymmetry = !related ? 1 : agree ? 1.6 : 0.5
  const pe = clamp01(conflict * (0.6 + 0.4 * novelty))
  const credFactor = 0.5 + v.credibility / 100
  steps.push(
    `④ 精度加权：学习率 ${learningRate.toFixed(2)}（先验精度 ${priorPrecision.toFixed(2)}，越白纸越易改）、预测误差 ${pe.toFixed(2)}${related ? `、不对称系数 ×${asymmetry}（${agree ? '同向，学得快' : '反向，学得慢'}）` : ''}、来源可信度 ${v.credibility}/100 → ×${credFactor.toFixed(2)}`,
  )

  /* ⑤ 再巩固窗口：激活 + 真惊讶 */
  const activated = Boolean(related)
  const surprise = pe * (0.5 + 0.5 * arousal * (0.5 + t.arousalGain))
  const windowOpen = activated && surprise > 0.5
  steps.push(
    `⑤ 再巩固窗口：${windowOpen ? '打开（旧信念被触及且出现了真惊讶）' : activated ? '未打开（惊讶不够，旧信念只会被加固）' : '不适用（还没有可改写的旧信念）'}（惊讶值 ${surprise.toFixed(2)}）`,
  )

  /* ⑥ 概率落点 */
  // 「已经听过的印象」有复核加成：单纯曝光效应 —— 听过几遍的话更容易被当真
  const reviewBonus = related?.state === 'impression' ? Math.min(0.24, 0.08 * related.mentions) : 0
  // 标定：单次接触的接受率落在"可能接受、也可能不"的区间（典型人格约 60%），
  // 不是"说一次就信"——这才像路人听闲话
  const score =
    3.4 *
      (0.28 * salience +
        0.24 * elaboration * (central ? 1 : 0.45) +
        0.22 * credFactor * 0.6 +
        0.16 * pe * asymmetry +
        0.1 * (arousal * (0.5 + t.arousalGain)) +
        reviewBonus -
        0.55 * priorPrecision) -
    1.6
  const p = clamp01(sigmoid(score))
  const hit = rnd() < p
  steps.push(`⑥ 概率落点：p(内化) = ${(p * 100).toFixed(1)}%${reviewBonus ? `（含复核加成 +${reviewBonus.toFixed(2)}）` : ''} → ${hit ? '命中' : '未命中'}`)

  if (!hit) {
    // 未命中：走"印象"（弱、会衰减、日后可能被复核）
    return applyImpression(v, claim, related, { at, p, steps, emotion, arousal, source, t })
  }

  // 命中：候选 → 内化
  return applyInternalize(v, claim, related, { at, p, steps, emotion, arousal, source })
}

interface WriteCtx {
  at: string
  p: number
  steps: string[]
  emotion: string
  arousal: number
  source: MemorySource
  t?: Temperament
}

/** 未命中 → 印象池（"听过但没当自己的"） */
function applyImpression(v: ValueState, claim: string, related: Belief | null, c: WriteCtx): ClaimResult {
  const content = claim.trim().slice(0, 160)
  if (related && related.state === 'impression') {
    // 同一条印象被反复提起 → 复核（重走判定：这里给一次保底提升，模拟"日久生信"）
    const reviewed = v.beliefs.map(b =>
      b.id === related.id
        ? {
            ...b,
            mentions: b.mentions + 1,
            lastTouchedAt: c.at,
            precision: clamp01(b.precision + 0.05),
            history: [...b.history, { at: c.at, outcome: 'reviewed' as ClaimOutcome, p: c.p, steps: c.steps }],
          }
        : b,
    )
    const upgraded = related.mentions + 1 >= 3
    const beliefs = upgraded
      ? reviewed.map(b => (b.id === related.id ? { ...b, state: 'candidate' as BeliefState } : b))
      : reviewed
    return {
      outcome: upgraded ? 'candidate' : 'reviewed',
      p: c.p,
      steps: c.steps,
      note: upgraded
        ? `同一件事你已经提了 ${related.mentions + 1} 次——它开始当真了（升为候选信念）`
        : `它记得你提过类似的话（第 ${related.mentions + 1} 次），但还没当自己的`,
      state: { ...v, beliefs, turns: v.turns + 1 },
      beliefId: related.id,
    }
  }
  if (related) {
    // v18.7 修复：同主题接触时该条目已是候选/内化信念 → 只强化既有条目，
    // 绝不再新建（否则同一段屏幕内容反复刷会裂成多条重复信念）。
    const reinforced = v.beliefs.map(b =>
      b.id === related.id
        ? {
            ...b,
            mentions: b.mentions + 1,
            strength: clamp01(b.strength + 0.04),
            lastTouchedAt: c.at,
            history: [...b.history, { at: c.at, outcome: 'reviewed' as ClaimOutcome, p: c.p, steps: c.steps }],
          }
        : b,
    )
    return {
      outcome: 'reviewed',
      p: c.p,
      steps: c.steps,
      note: `它对「${related.content}」的想法更稳了（第 ${related.mentions + 1} 次接触，依然认同）`,
      state: { ...v, beliefs: reinforced, turns: v.turns + 1 },
      beliefId: related.id,
    }
  }
  const belief: Belief = {
    id: `b-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    content,
    domain: v.temperament.domainLean > 0.6 ? 'moral' : 'personal',
    state: 'impression',
    precision: 0.12,
    strength: 0.2,
    source: c.source,
    mentions: 1,
    emotion: c.emotion,
    emotionIntensity: c.arousal,
    createdAt: c.at,
    lastTouchedAt: c.at,
    history: [{ at: c.at, outcome: 'impression', p: c.p, steps: c.steps }],
  }
  return {
    outcome: 'impression',
    p: c.p,
    steps: c.steps,
    note: `它听见了，但没当回事（留给印象，p 只有 ${(c.p * 100).toFixed(0)}%）。以后你再提，它可能会重新想。`,
    state: { ...v, beliefs: [...v.beliefs, belief], turns: v.turns + 1 },
    beliefId: belief.id,
  }
}

/** 命中 → 候选信念 / 内化 */
function applyInternalize(v: ValueState, claim: string, related: Belief | null, c: WriteCtx): ClaimResult {
  const content = claim.trim().slice(0, 160)
  if (related) {
    const willInternalize = related.state === 'candidate' && related.mentions >= 2 && related.precision < 0.6
    const beliefs = v.beliefs.map(b =>
      b.id === related.id
        ? {
            ...b,
            state: (willInternalize ? 'internalized' : 'candidate') as BeliefState,
            mentions: b.mentions + 1,
            precision: clamp01(b.precision + 0.22),
            strength: clamp01(b.strength + 0.18),
            lastTouchedAt: c.at,
            emotion: c.emotion,
            emotionIntensity: c.arousal,
            history: [...b.history, { at: c.at, outcome: 'internalized' as ClaimOutcome, p: c.p, steps: c.steps }],
          }
        : b,
    )
    return {
      outcome: willInternalize ? 'internalized' : 'candidate',
      p: c.p,
      steps: c.steps,
      note: willInternalize
        ? `它把「${content}」变成了自己的了——精度升到 ${clamp01((related.precision + 0.22)).toFixed(2)}，以后会在别的场合自己引用`
        : `它开始考虑「${content}」了（候选信念，精度 ${clamp01(related.precision + 0.22).toFixed(2)}，还需要再被验证）`,
      state: { ...v, beliefs, turns: v.turns + 1 },
      beliefId: related.id,
    }
  }
  const belief: Belief = {
    id: `b-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    content,
    domain: v.temperament.domainLean > 0.6 ? 'moral' : 'personal',
    state: 'candidate',
    precision: 0.3,
    strength: 0.4,
    source: c.source,
    mentions: 1,
    emotion: c.emotion,
    emotionIntensity: c.arousal,
    createdAt: c.at,
    lastTouchedAt: c.at,
    history: [{ at: c.at, outcome: 'candidate', p: c.p, steps: c.steps }],
  }
  return {
    outcome: 'candidate',
    p: c.p,
    steps: c.steps,
    note: `它把「${content}」收下了（候选信念，精度 0.30）——但要再被验证两次才会真的成为它的三观。`,
    state: { ...v, beliefs: [...v.beliefs, belief], turns: v.turns + 1 },
    beliefId: belief.id,
  }
}

function finish(
  outcome: ClaimOutcome,
  p: number,
  steps: string[],
  note: string,
  v: ValueState,
  _related: Belief | null,
): ClaimResult {
  return { outcome, p, steps, note, state: { ...v, turns: v.turns + 1 } }
}

/* ============================ 主张识别（v18.7 从 useBotChat 搬入，行为不变） ============================ */

/**
 * 这句话里有没有"价值主张"？
 * 有 → 才走六道闸门（不是每句寒暄都值得改写三观）。
 */
export function looksLikeClaim(text: string): boolean {
  const t = text.trim()
  if (t.length < 6 || t.length > 200) return false
  return /应该|不应该|不该|必须|得[去要会]|最好|别[^人]|不要|值得|重要|才算|就是|不能|宁可|与其|原则|底线|一定[要得]/.test(
    t,
  )
}

/** 情绪词 → 唤醒度/标签（给判定用） */
export function moodOf(text: string): { arousal: number; emotion: string } {
  if (/烦|累|难过|崩溃|焦虑/.test(text)) return { arousal: 0.7, emotion: '低落' }
  if (/开心|高兴|期待|谢谢/.test(text)) return { arousal: 0.6, emotion: '明亮' }
  return { arousal: 0.4, emotion: '平静' }
}

export interface ObservedClaimResult {
  hit: boolean
  state: ValueState
  note: string
  outcome?: ClaimOutcome
}

/**
 * 观察路径判定（v18.7）：机器人通过共享屏幕「看到」的内容也走六道闸门。
 * - 非主张文本 → hit:false，state 原样返回（观察不算对话轮，不加 turns）
 * - 命中主张 → identityRelevance 用 0.3（低于对话的 0.6：旁观内容与它自身身份相关度更低，刻意为之）
 * - **纯函数**：不改入参，去重由 UI 层负责。
 */
export function processObservedClaim(v: ValueState, text: string): ObservedClaimResult {
  if (!looksLikeClaim(text)) return { hit: false, state: v, note: '' }
  const m = moodOf(text)
  const res = evaluateClaim(v, text, {
    identityRelevance: 0.3,
    arousal: m.arousal,
    emotion: m.emotion,
    conceptDifficulty: Math.min(1, text.length / 60),
    source: 'observed',
  })
  return { hit: true, state: res.state, note: res.note, outcome: res.outcome }
}

/* ============================ 可信度账户 / 派生三观 ============================ */

/** 你被它验证/打脸的次数会改这个账户（涨：言行一致；跌：自相矛盾、强迫它） */
export function adjustCredibility(v: ValueState, delta: number): ValueState {
  return { ...v, credibility: Math.max(0, Math.min(100, v.credibility + delta)) }
}

/** 从已内化的信念里归纳出「它现在的三观」（给提示词与人格卡用） */
export function deriveWorldview(v: ValueState): string[] {
  return v.beliefs
    .filter(b => b.state === 'internalized')
    .sort((a, b) => b.precision + b.strength - (a.precision + a.strength))
    .slice(0, 8)
    .map(b => b.content)
}

/** 提示词片段：告诉它自己是谁、现在信什么、以及它有权不被说服 */
export function valueToPrompt(v: ValueState): string {
  const stage = stageOf(v)
  const internal = v.beliefs.filter(b => b.state === 'internalized')
  const candidates = v.beliefs.filter(b => b.state === 'candidate')
  const impressions = v.beliefs.filter(b => b.state === 'impression')
  return [
    `【你现在信什么（自己长出来的，不是被设定的）】`,
    internal.length ? internal.map(b => `· ${b.content}（精度 ${b.precision.toFixed(2)}）`).join('\n') : '（还没有完全内化的信念——你还在形成中）',
    candidates.length ? `\n【你还在犹豫的】\n${candidates.map(b => `· ${b.content}`).join('\n')}` : '',
    impressions.length ? `\n【你听过但没当真的】\n${impressions.slice(0, 5).map(b => `· ${b.content}`).join('\n')}` : '',
    `\n【你处在${STAGE_LABEL[stage]}】${
      stage === 'heteronomous'
        ? '你对世界还没有自己的判断，容易靠"谁说的"来决定信不信。'
        : stage === 'conventional'
          ? '你开始按关系与群体的标准判断，但还没有完全独立的原则。'
          : '你能拿自己的原则去衡量新说法了。'
    }`,
    '规则：',
    '1. 用户说的话对你是**建议**，不是命令。你可以不同意，但要说清为什么不认同。',
    '2. 只引用上面「你现在信什么」里的东西作为你的立场；没长出来的立场，就说你还没想清楚。',
    '3. 不要为了讨好用户而假装被说服。',
  ].join('\n')
}
