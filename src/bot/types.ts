/**
 * 机器人「观澜」—— 人格卡 + 识海记忆 的类型契约（v10.65）
 *
 * 设计来源：用户手写的「识海」记忆系统设计稿 + 2026-10-14 定稿的方案大纲
 * （核心规则 / 存储 / 检索 / 创作 / 重构）。
 *
 * ⚠️ 数据分层（硬约束，来自用户 2026-10-14 明确要求）：
 *   · 本文件里的 PersonaCard / MemoryItem 属于「机器人资产」，**随 AppState 同步**（人格与记忆是它的本体）；
 *   · 屏幕观察的**原始画面与 OCR 文字**绝不进这里、绝不进 AppState —— 它们只存在
 *     src/bot/screensee.ts 的本地 IndexedDB 隔离区（TTL 72h、可一键清空）。
 *     只有「本地生成的摘要」形成的记忆（source='observed'）才可能进入本结构，
 *     且受 BotState.allowObservedToCloud 开关控制。
 */

/** 名字是人格锚点：与人格气质匹配，生成时同步定名（用户 2026-10-14 弃用「小凌」） */
export type PersonaName = '观澜' | '子非' | '既白' | '未名'

export interface PersonaCore {
  /** 一句话世界观（生成时的骨架句，会随四轴立场拼出来） */
  worldview: string
  /** 人生观：人该怎样活 */
  lifeView: string
  /** 价值观关键词（3-5 条，冻结不变——防人格漂移的锚） */
  values: string[]
  /** 立场轴一：世界是可理解的秩序，还是不可化约的混沌 */
  orderVsChaos: string
  /** 立场轴二：人是自主的，还是被结构/命运推着走 */
  freedomVsFate: string
  /** 立场轴三：意义来自创造，还是来自承受/关系 */
  meaningFrom: string
  /** 立场轴四：历史是进步的，还是循环的 */
  progressVsCycle: string
}

export interface PersonaAesthetics {
  /** 语气倾向 */
  tone: string[]
  /** 偏好的主题 */
  themes: string[]
  /** 讨厌的写法 / 主题（它有自己的排斥，这比偏好更能定义风格） */
  dislikes: string[]
  /** 节奏偏好 */
  rhythm: string
}

export interface PersonaRelation {
  /** 对用户的温度 0..1 */
  warmth: number
  /** 直言程度 0..1（能不能不同意你） */
  candor: number
  /** 对用户的好奇 0..1 */
  curiosity: number
}

export interface PersonaSelfCheck {
  at: string
  /** 自检结论：它是否还是它 */
  verdict: string
}

export interface PersonaCard {
  version: number
  id: string
  name: PersonaName
  bornAt: string
  core: PersonaCore
  aesthetics: PersonaAesthetics
  relation: PersonaRelation
  /** 未决问题：它心里在想的事（最有魅力的设计位） */
  openQuestions: string[]
  /** 探针自检记录（一致性守护：发现漂移就告警） */
  selfChecks: PersonaSelfCheck[]
}

export type MemoryLayer = 'episodic' | 'semantic' | 'procedural'
export type MemorySource = 'self' | 'user' | 'observed' | 'inferred'

export interface MemoryItem {
  id: string
  layer: MemoryLayer
  /** 压缩后的条目（不堆原文——摄入闸门的产物） */
  content: string
  source: MemorySource
  /** 可信度 0..1：它分得清「我经历的 / 你说的 / 我猜的」 */
  confidence: number
  createdAt: string
  lastRecalledAt: string | null
  /** 当前强度 F（随时间衰减，被回忆时回升） */
  strength: number
  /** 衰减速率 λ（受情绪与重复影响；越小越难忘） */
  lambda: number
  /** 情绪效价 -1..1 */
  valence: number
  /** 情绪唤醒度 0..1 */
  arousal: number
  emotion: string
  /** 意义强度 S 0..1 */
  importance: number
  /** 身份相关性 I 0..1 */
  identity: number
  recallCount: number
  /** 被主动压下的记忆（不是删除，会回来） */
  suppressed?: boolean
  tags: string[]
}

export interface BotState {
  persona: PersonaCard | null
  memories: MemoryItem[]
  /** 观察摘要是否允许外发给 LLM（用户 2026-10-14 已确认允许；关掉则 observed 记忆只留本地） */
  allowObservedToCloud: boolean
  /** 对话轮次（用于漂移自检节奏） */
  chatCount: number
  /**
   * v10.66：价值观形成状态（气质参数 + 信念表 + 印象池 + 可信度账户）。
   * **出生时它是空的**：没有价值观，只有一副脾气；三观由经历概率性地长出来。
   * 详见 src/bot/valueFormation.ts 与 docs/bot-value-formation.md。
   */
  value?: import('./valueFormation').ValueState
}

/** 识海的提取结果：命中的记忆 + 它为什么被选中（可解释性） */
export interface RecallHit {
  memory: MemoryItem
  score: number
  /** 入选理由，给「心光选择」用 */
  reason: string
}
