/**
 * 机器人「观澜」页面（v10.65）
 *
 * 四块，对应用户 2026-10-14 定稿的方案：
 *   人格卡（它是谁）· 对话（它怎么想）· 识海（它记得什么）· 屏幕观察（它看到了什么）
 *
 * 隔离要点（用户硬要求）：
 *   · 屏幕观察默认关；开启前必须过风险警告弹窗；
 *   · 原始画面 / OCR 文字只在本机（src/bot/screensee.ts 的 IndexedDB），本页只拿
 *     「本地摘要」过摄入闸门；外发与否由「允许摘要外发」开关决定。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useApp } from '../store/AppContext'
import { Icon } from './Icon'
import { useBotChat } from '../hooks/useBotChat'
import { generatePersona, judgeDrift, PROBE_QUESTIONS } from '../bot/persona'
import { decayAll, digestScene, ingestObserved, suppressMemory } from '../bot/memory'
import type { ObsDigest } from '../bot/memory'
import { flushDigests, queueDigest, listDigests, digestToMemory } from '../lib/obsStore'
import type { DigestListResult, DigestListStatus } from '../lib/obsStore'
import type { BotState, MemoryItem, PersonaCard } from '../bot/types'
import {
  createValueState,
  describeTemperament,
  processObservedClaim,
  stageOf,
  STAGE_LABEL,
  type BeliefTrace,
} from '../bot/valueFormation'
import { broadcastOutcome } from '../bot/botEvents'
import {
  clearLocalObservations,
  getLocalStats,
  getObserveState,
  isObserving,
  startObservation,
  stopObservation,
  type LocalSummary,
} from '../bot/screensee'
import { getOcrStatus } from '../bot/ocr'
import { alignRegionsWithDom, getFreshDomBlocks, installDomBridge } from '../bot/domBridge'
import { applyPrivateDict, cutTokens, ensureJieba } from '../bot/jiebaSegmenter'
import { parseWordInput, PRIVATE_DICT_LIMIT, readPrivateDict, writePrivateDict, type PrivateWord } from '../bot/privateDict'
import { getSession } from '../lib/session'

const EMPTY_BOT: BotState = { persona: null, memories: [], allowObservedToCloud: true, chatCount: 0 }

const LAYER_LABEL: Record<MemoryItem['layer'], string> = {
  episodic: '情景',
  semantic: '语义',
  procedural: '程序',
}
const SOURCE_LABEL: Record<MemoryItem['source'], string> = {
  self: '它自己',
  user: '你告诉它',
  observed: '它看到的',
  inferred: '它推断',
}

const KIND_LABEL: Record<string, string> = {
  chat: '对话',
  profile: '资料页',
  article: '文章',
  misc: '其他',
}

interface CloudItem {
  d: ObsDigest
  mem: MemoryItem | null
  key: string
}

function formatObsAt(at: string): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return at || '时间未知'
  return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function RobotPage() {
  const { state, dispatch } = useApp()
  const bot: BotState = state.bot ?? EMPTY_BOT
  const persona = bot.persona
  /** 观察会话是长命的（可能开几小时），异步回调里必须读最新的 bot，否则会把会话中途的聊天更新覆盖掉 */
  const botRef = useRef(bot)
  botRef.current = bot

  // v10.67：对话 / 写作 / 价值主张判定逻辑抽到 useBotChat（与悬浮小面板共用一份实现）
  const chat = useBotChat()
  const { transcript, input, setInput, busy, note, setNote, article, send, write } = chat

  const [warnOpen, setWarnOpen] = useState(false)
  const [obsState, setObsState] = useState(getObserveState())
  const [localStats, setLocalStats] = useState<{ count: number; chars: number; oldestAt: string | null }>({
    count: 0,
    chars: 0,
    oldestAt: null,
  })
  const obsLabelRef = useRef('')
  // v18.7 观察路径去重：已判过人格的屏幕文本签名（content 前 80 字符），最多留 50 条
  // —— 防同一段屏幕内容（反复停在同一个画面）反复刺激它的三观。
  const seenClaimSigs = useRef<Array<string>>([])

  // 方案 A：懒加载 jieba-wasm 分词引擎（整个应用只挂一次，就绪后注入纯同步的 nlpSlice）。
  // 任何失败由 ensureJieba 内部 warn 并回退 ICU，不影响观察。
  // v10.87：就绪后把本机私有词典热注入（add_word），刷新页面后已存的词条自动生效。
  const uid = getSession()?.user.userId || null
  const [jiebaReady, setJiebaReady] = useState(false)
  useEffect(() => {
    void ensureJieba().then(ok => {
      setJiebaReady(ok)
      if (ok) void applyPrivateDict(uid)
    })
  }, [uid])

  // v10.93 DOM 桥：页面挂载时装一次 message 监听（幂等）。
  // 油猴脚本经 postMessage 送来的结构化区块只存在本模块变量里，
  // 不进 AppState / localStorage / 云端；无新鲜 payload 时观察自动回退 OCR 几何聚类。
  useEffect(() => {
    installDomBridge()
  }, [])

  /* ============ v10.87 本机私有词典（词条只存本机 localStorage，绝不外发） ============ */
  const [dictWords, setDictWords] = useState<PrivateWord[]>(() => readPrivateDict(uid).words)
  const [dictInput, setDictInput] = useState('')
  const [dictMsg, setDictMsg] = useState('')
  const [tryText, setTryText] = useState('')
  const tryTokens = useMemo(
    () => (jiebaReady && tryText.trim() ? cutTokens(tryText.trim()) ?? [] : []),
    [jiebaReady, tryText],
  )

  const persistDict = (next: PrivateWord[], msg: string) => {
    writePrivateDict(uid, next)
    setDictWords(next)
    setDictMsg(msg)
    void applyPrivateDict(uid) // 新增词热生效（删除词因 jieba 无 remove 接口，需刷新）
  }

  const addDictWords = (text: string) => {
    const { added, errors } = parseWordInput(text)
    if (!added.length) {
      setDictMsg(errors[0] || '没有识别到可添加的词条。')
      return
    }
    const existing = readPrivateDict(uid).words
    const have = new Set(existing.map(x => x.w))
    const fresh = added.filter(x => !have.has(x.w))
    const dup = added.length - fresh.length
    let overflow = ''
    const room = Math.max(0, PRIVATE_DICT_LIMIT - existing.length)
    const picked = fresh.slice(0, room)
    if (fresh.length > room) overflow = `；已达上限 ${PRIVATE_DICT_LIMIT} 条，${fresh.length - room} 条被跳过`
    if (!picked.length) {
      setDictMsg(`没有新增词条${dup ? `（${dup} 条已存在被跳过）` : ''}${errors[0] ? `；${errors[0]}` : ''}`)
      return
    }
    persistDict(
      [...existing, ...picked],
      `已添加 ${picked.length} 条${dup ? `（${dup} 条已存在被跳过）` : ''}${overflow}${errors[0] ? `；${errors[0]}` : ''}`,
    )
  }

  const addDictText = () => {
    if (!dictInput.trim()) return
    addDictWords(dictInput)
    setDictInput('')
  }

  /** 本地 .txt 导入：FileReader 在本机读文件，内容不出本机 */
  const onDictFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => addDictWords(String(reader.result || ''))
    reader.readAsText(f)
    e.target.value = '' // 允许重复选择同一文件
  }

  const removeDictWord = (w: string) => {
    const next = dictWords.filter(x => x.w !== w)
    writePrivateDict(uid, next)
    setDictWords(next)
    setDictMsg(`已删除「${w}」。删除的词条刷新页面后生效。`) // jieba-wasm 无 remove_word
  }

  const clearDict = () => {
    if (!dictWords.length) return
    if (!window.confirm(`将清空全部 ${dictWords.length} 条私有词条（删除的词条刷新页面后生效）。确定吗？`)) return
    writePrivateDict(uid, [])
    setDictWords([])
    setDictMsg('已清空。删除的词条刷新页面后生效。')
  }

  // v10.79：云端观察摘要列表（刷新 / 筛选 / 补进识海）
  const [cloud, setCloud] = useState<DigestListResult>({ records: [], status: 'ok' })
  const [cloudLoading, setCloudLoading] = useState(true)
  const [cloudKw, setCloudKw] = useState('')
  const [cloudKind, setCloudKind] = useState<'all' | ObsDigest['kind']>('all')
  // 识海默认按最新优先，保证新切出来的记忆不会被一堆高强度旧记忆压到列表底部看不见
  const [memSort, setMemSort] = useState<'recent' | 'strength'>('recent')

  const saveBot = useCallback(
    (next: BotState) => dispatch({ type: 'SET_BOT', bot: next }),
    [dispatch],
  )

  /* ============ v10.79：云端观察摘要 ============ */
  const refreshCloud = useCallback(async () => {
    setCloudLoading(true)
    try {
      setCloud(await listDigests(200))
    } finally {
      setCloudLoading(false)
    }
  }, [])

  // 观察状态变化（尤其是停止观察触发 flushDigests）后重新拉取
  useEffect(() => {
    void refreshCloud()
  }, [refreshCloud, obsState])

  const cloudItems = useMemo<CloudItem[]>(() => {
    const kw = cloudKw.trim().toLowerCase()
    return cloud.records
      .filter(d => cloudKind === 'all' || d.kind === cloudKind)
      .filter(d => {
        if (!kw) return true
        const hay = [d.name, d.gist, d.source, d.mood, ...(d.speakers || []), ...(d.topics || []), ...(d.entities || [])]
          .filter(Boolean)
          .map(x => String(x).toLowerCase())
          .join(' ')
        return hay.includes(kw)
      })
      .map((d, i) => ({ d, mem: digestToMemory(d), key: `${d.at}|${d.gist}|${i}` }))
  }, [cloud.records, cloudKind, cloudKw])

  const memContents = useMemo(() => new Set(bot.memories.map(m => m.content)), [bot.memories])
  const cloudStatus: DigestListStatus = cloud.status

  const isAdded = (item: CloudItem): boolean => {
    const m = item.mem
    return !!m && memContents.has(m.content)
  }

  const addOne = (item: CloudItem) => {
    const m = item.mem
    if (isAdded(item) || !m) {
      setNote('这条已经在识海里了。')
      return
    }
    saveBot({ ...bot, memories: [...bot.memories, m] })
    setNote('已补进识海：' + (item.d.name || item.d.gist.slice(0, 18)))
  }

  const addAll = () => {
    const seen = new Set(memContents)
    const picked: MemoryItem[] = []
    for (const c of cloudItems) {
      const m = c.mem
      if (m && !seen.has(m.content)) {
        picked.push(m)
        seen.add(m.content)
      }
      if (picked.length >= 20) break
    }
    if (!picked.length) {
      setNote('没有可补进的新摘要。')
      return
    }
    saveBot({ ...bot, memories: [...bot.memories, ...picked] })
    setNote(`已补进 ${picked.length} 条摘要（单次最多 20 条）。`)
  }

  /* ============ 记忆：进入页面先做一次衰减（时间在走，记忆会淡出） ============ */
  useEffect(() => {
    if (!bot.memories.length) return
    const decayed = decayAll(bot.memories)
    if (decayed.length !== bot.memories.length) saveBot({ ...bot, memories: decayed })
  }, [bot, saveBot])

  const refreshLocalStats = useCallback(async () => {
    try {
      setLocalStats(await getLocalStats())
    } catch {
      /* 读不到就显示 0，不打扰用户 */
    }
  }, [])

  useEffect(() => {
    void refreshLocalStats()
  }, [refreshLocalStats, obsState])

  /* ============ 出生：第一次进来长出人格 ============ */
  const birth = useCallback(
    (seed?: number) => {
      const p = generatePersona(seed)
      // v10.66：出生时**没有价值观**，只有一副随机气质 + 一个信任基线（可信度账户）
      const value = createValueState(seed)
      saveBot({ ...bot, persona: p, memories: [], value })
      setNote(
        `${p.name} 醒了。它现在还没有任何价值观 —— 只有一副脾气。接下来它信什么，取决于它的脾气和它遇到的事。`,
      )
    },
    [bot, saveBot, setNote],
  )

  /* v10.67：对话 / 写作 / 价值主张判定逻辑已抽到 hooks/useBotChat，与悬浮小面板共用一份实现 */

  /* ============ 屏幕被动观察 ============ */
  const toggleObserve = async () => {
    if (isObserving()) {
      stopObservation()
      setObsState(getObserveState())
      void flushDigests() // v10.79：停止时把队列里剩下的摘要一口气上云
      setNote('已停止观察。本机留下的文字还在（72 小时后自动清）。')
      return
    }
    // 默认关 → 开启前必须先看风险警告
    setWarnOpen(true)
  }

  const reallyStart = async () => {
    setWarnOpen(false)
    setNote('请在浏览器弹出的选择器里选要观察的窗口（建议选单个窗口，不要整块屏幕）。')
    await startObservation({
      onStateChange: s => {
        setObsState(s)
        obsLabelRef.current = s === 'on' ? '正在观察' : ''
      },
      onText: (text, summary, source, lines) => {
        // v10.93 DOM 桥：有新鲜 DOM 区块且行数可对齐时，用 DOM 分区替代 OCR 几何聚类；
        // 否则 domRegions=null，切片自动回退 lines 聚类 / 无几何路径。
        const domBlocks = getFreshDomBlocks()
        const domRegions = lines && domBlocks ? alignRegionsWithDom(lines, domBlocks) : null
        // 摄入闸门：先判值不值得记，再决定要不要成为记忆（**读最新状态**，别用旧闭包）
        const cur = botRef.current
        const d = ingestObserved(cur.memories, text, summary as LocalSummary, undefined, lines, domRegions ?? undefined)
        if (!d.keep || !d.memory) {
          setNote(`看到了但没记：${d.reason}`)
          return
        }
        if (!cur.allowObservedToCloud) {
          setNote(`${d.reason}（外发已关闭：只留本机，不进记忆库）`)
          return
        }
        // v10.79 云端摘要库：切分+场景解读的产出上云（白名单转述，原文不出本机；
        // 含敏感串的一幕 digestScene 返回 null，连摘要都不会有）。
        // 必须放在两道 guard 之后：识海不收 / 用户关了外发时，连摘要都不该入队上云。
        try {
          const digest = digestScene(text, summary as LocalSummary, undefined, lines, domRegions ?? undefined)
          if (digest) {
            digest.source = source
            queueDigest(digest)
          }
        } catch {
          /* 摘要入队失败不影响识海 */
        }
        // v18.7 观察链：正式入识海的摘要才判人格（上面外发关闭分支只留本机、不判）；
        // 签名去重防同一段屏幕内容反复刺激三观。保持回调轻量（45s 一拍，无异步/重计算）。
        const sig = d.memory.content.slice(0, 80)
        const seen = seenClaimSigs.current
        const dup = seen.includes(sig)
        if (!dup) {
          seen.push(sig)
          if (seen.length > 50) seen.splice(0, seen.length - 50)
        }
        const claimRes = dup
          ? { hit: false, state: cur.value ?? createValueState(), note: '', outcome: undefined }
          : processObservedClaim(cur.value ?? createValueState(), d.memory.content)
        saveBot({
          ...cur,
          memories: [...cur.memories, d.memory],
          value: claimRes.hit ? claimRes.state : (cur.value ?? claimRes.state),
        })
        if (claimRes.hit && claimRes.outcome) {
          broadcastOutcome(claimRes.outcome, Date.now())
          setNote(`${d.reason} · 它对看到的内容有了触动：${claimRes.note}`)
        } else {
          setNote(d.reason)
        }
      },
      onError: e => {
        const s = getOcrStatus()
        setNote(
          s === 'error'
            ? '观察出错：本机 OCR 资源没加载上（检查站点是否带上了 /ocr/ 目录，或浏览器是否支持 wasm）'
            : `观察出错：${e instanceof Error ? e.message : String(e)}`,
        )
      },
    })
    setObsState(getObserveState())
    // OCR 资源是自托管的（/ocr/，约 9.5MB），首次开启要等一下；加载失败要明确告诉用户
    window.setTimeout(() => {
      const s = getOcrStatus()
      if (s === 'loading') setNote('正在准备本机 OCR 资源（首次约 9.5MB，稍候）…')
      else if (s === 'error') setNote('OCR 资源加载失败：/ocr/ 下的 wasm 与语言包没到位，认不出字（原始画面仍然没有离开本机）')
    }, 1200)
  }

  const forgetAll = async () => {
    await clearLocalObservations()
    await refreshLocalStats()
    setNote('本机观察数据已清空。')
  }

  const sortedMemories = useMemo(
    () => {
      const arr = [...bot.memories]
      if (memSort === 'recent') {
        return arr.sort((a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt)) || b.strength - a.strength,
        )
      }
      return arr.sort((a, b) => b.strength - a.strength)
    },
    [bot.memories, memSort],
  )

  /** 最近新增：带「切片:」标记的观察记忆条数（新识别内容） */
  const newSlicedCount = useMemo(
    () => bot.memories.filter(m => m.source === 'observed' && m.tags?.some(t => String(t).startsWith('切片:'))).length,
    [bot.memories],
  )

  /** v10.8x：旧版「未切片」观察记忆（新切片记忆的 tags[0] 带 切片: 标记，不在此列） */
  const stale = useMemo(
    () => bot.memories.filter(m => m.source === 'observed' && !m.tags?.some(t => t.startsWith('切片:'))),
    [bot.memories],
  )

  const purgeStale = () => {
    if (!stale.length) return
    if (!window.confirm(`将删除 ${stale.length} 条旧版「未切片」观察记忆（新切片记忆与其它记忆不受影响）。此操作不可撤销，确定吗？`)) return
    saveBot({ ...bot, memories: bot.memories.filter(m => !(m.source === 'observed' && !m.tags?.some(t => t.startsWith('切片:')))) })
    setNote(`已清理 ${stale.length} 条未切片观察记忆`)
  }

  const probe = useMemo(() => PROBE_QUESTIONS[bot.chatCount % PROBE_QUESTIONS.length], [bot.chatCount])
  /** v10.66：最近一次价值判定（给「影响记录」用） */
  const lastTrace = useMemo(() => {
    const bs = bot.value?.beliefs ?? []
    let best: { content: string; trace: BeliefTrace } | null = null
    for (const b of bs) {
      for (const h of b.history) {
        if (!best || h.at > best.trace.at) best = { content: b.content, trace: h }
      }
    }
    return best
  }, [bot.value])

  /* ============ 还没出生 ============ */
  if (!persona) {
    return (
      <section className="bot-page">
        <div className="bot-birth">
          <h2>它还没有出生</h2>
          <p className="bot-birth-sub">
            点一下，随机长出一副灵魂：四轴世界观（世界可否理解 · 人是否自主 · 意义从何而来 · 历史是进步还是循环）、
            价值观、审美、脾气、对你的态度 —— 全是随机的，不受你影响。
          </p>
          <button className="primary-btn" onClick={() => birth()}>
            让它出生
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="bot-page">
      {/* ---------- 人格卡 ---------- */}
      <header className="bot-head">
        <div className="bot-id">
          <span className="bot-avatar">
            <Icon name="gem" size={18} />
          </span>
          <div>
            <h2 className="bot-name">{persona.name}</h2>
            <p className="bot-born">出生于 {new Date(persona.bornAt).toLocaleString('zh-CN')} · 聊了 {bot.chatCount} 轮</p>
          </div>
        </div>
        <div className="bot-head-actions">
          <button
            className="ghost-btn sm"
            onClick={() => {
              if (window.confirm('重生会换一副灵魂（三观、语气、脾气全变），已有的识海记忆也会清空。确定？')) {
                birth()
                chat.setTranscript([])
                chat.setArticle('')
              }
            }}
            title="重新随机一副灵魂"
          >
            重生
          </button>
        </div>
      </header>

      <div className="bot-grid">
        {/* ---------- 人格卡详情 ---------- */}
        <aside className="bot-card">
          <h3 className="bot-h3">它是谁</h3>
          <p className="bot-worldview">{persona.core.worldview}</p>
          <dl className="bot-axes">
            <dt>人生观</dt>
            <dd>{persona.core.lifeView}</dd>
            <dt>价值观</dt>
            <dd className="bot-tags">{persona.core.values.map(v => <span key={v}>{v}</span>)}</dd>
            <dt>语气</dt>
            <dd className="bot-tags">{persona.aesthetics.tone.map(t => <span key={t}>{t}</span>)}</dd>
            <dt>节奏</dt>
            <dd>{persona.aesthetics.rhythm}</dd>
            <dt>它厌恶</dt>
            <dd className="bot-tags bot-tags-no">{persona.aesthetics.dislikes.map(t => <span key={t}>{t}</span>)}</dd>
            <dt>它心里在想</dt>
            <dd className="bot-open">
              {persona.openQuestions.map(q => (
                <p key={q}>· {q}</p>
              ))}
            </dd>
            <dt>对你的态度</dt>
            <dd>
              温度 {persona.relation.warmth} · 直言 {persona.relation.candor} · 好奇 {persona.relation.curiosity}
            </dd>
          </dl>

          <h3 className="bot-h3">一致性自检</h3>
          <p className="bot-probe">探针：{probe}</p>
          <p className="bot-hint">（自检用于发现人格漂移：它越聊越像你，就该有人提醒它了）</p>

          {note && <p className="bot-note">{note}</p>}
        </aside>

        {/* ---------- 对话 + 写作 ---------- */}
        <div className="bot-main">
          <div className="bot-chat">
            {transcript.length === 0 && (
              <p className="bot-hint">
                它现在有 {bot.memories.length} 条记忆、{persona.openQuestions.length} 个没想明白的问题。你可以直接问它，或者让它写点什么。
              </p>
            )}
            {transcript.map((m, i) => (
              <div key={i} className={`bot-msg bot-msg-${m.who}`}>
                <div className="bot-msg-text">{m.text}</div>
                {m.why && <details className="bot-why"><summary>它为什么这么想（识海命中）</summary><pre>{m.why}</pre></details>}
              </div>
            ))}
            {busy && <p className="bot-hint">它在想…</p>}
          </div>
          <div className="bot-input-row">
            <input
              className="bot-input"
              value={input}
              placeholder={`对 ${persona.name} 说点什么，或输入一个题目让它写`}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) void send(input)
              }}
              disabled={busy}
            />
            <button className="primary-btn" onClick={() => void send(input)} disabled={busy || !input.trim()}>
              说
            </button>
            <button className="ghost-btn" onClick={() => void write(input)} disabled={busy} title="用它的三观写一篇">
              让它写
            </button>
            <button className="ghost-btn" onClick={() => judgeSelfCheck(persona, bot, setNote, saveBot)} title="用探针问它一句，检查它还是不是它">
              自检
            </button>
          </div>
          {article && (
            <div className="bot-article">
              <h3 className="bot-h3">它写的（{persona.name} 的版本）</h3>
              <div className="bot-article-body">{article}</div>
            </div>
          )}
        </div>
      </div>

      {/* ---------- 识海 ---------- */}
      <div className="bot-mem">
        <h3 className="bot-h3" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>
            识海（{bot.memories.length} 条 · 情景 {bot.memories.filter(m => m.layer === 'episodic').length} / 语义{' '}
            {bot.memories.filter(m => m.layer === 'semantic').length}）
          </span>
          <button
            className="ghost-btn sm"
            onClick={() => setMemSort(s => (s === 'recent' ? 'strength' : 'recent'))}
            title="切换识海排序方式"
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            {memSort === 'recent' ? '最新优先' : '强度优先'}
          </button>
          {/* v10.75：把观察开关直接放到识海边上 —— 开着它，这一栏才会长出新的记忆 */}
          <button
            className="ghost-btn"
            onClick={() => void toggleObserve()}
            disabled={obsState === 'requesting'}
            title={
              isObserving()
                ? '停止观察屏幕（本机已留存的文字仍在，72 小时后自动清）'
                : '开始观察屏幕（会先弹风险说明，再让你选要观察的窗口）'
            }
            style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 10px' }}
          >
            <Icon name="eye" size={14} />{' '}
            {obsState === 'requesting' ? '等待授权…' : isObserving() ? '停止观察' : '开始观察'}
          </button>
          {/* v10.8x：必须经 window.confirm 显式确认后才清理旧版未切片观察记忆 */}
          <button
            className="ghost-btn sm"
            onClick={purgeStale}
            disabled={stale.length === 0}
            title="删除旧版「未切片」观察记忆（新切片记忆与其它记忆不受影响）"
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            <Icon name="trash" size={13} /> 清理未切片（{stale.length}）
          </button>
        </h3>
        <p className="bot-hint">
          强度随时间衰减，被想起时回升；反复想起且意义强的会「巩固」进语义层（长期记忆）。
          {isObserving() && <b> · 正在观察，屏幕上的对话与文章会被它记进来。</b>}
        </p>
        <p className="bot-hint">最近新增 {newSlicedCount} 条</p>
        <div className="bot-mem-list">
          {sortedMemories.map(m => (
            <div key={m.id} className={`bot-mem-item ${m.suppressed ? 'is-suppressed' : ''} ${m.tags?.some(t => String(t).startsWith('切片:')) ? 'is-new' : ''}`}>
              <div className="bot-mem-bar">
                <span style={{ width: `${Math.round(m.strength * 100)}%` }} />
              </div>
              <div className="bot-mem-body">
                <p className="bot-mem-text">{m.content}</p>
                <p className="bot-mem-meta">
                  <span className="bot-chip">{LAYER_LABEL[m.layer]}</span>
                  <span className="bot-chip bot-chip-src">{SOURCE_LABEL[m.source]}</span>
                  <span>强度 {(m.strength * 100).toFixed(0)}%</span>
                  <span>想起 {m.recallCount} 次</span>
                  <span>情绪 {m.emotion}</span>
                  {m.tags?.some(t => t.startsWith('切片:')) && (
                    <>
                      <span className="bot-chip bot-chip-slice">
                        {(m.tags?.find(t => t.startsWith('切片:')) ?? '').replace('切片:', '切片 ').replace('词', ' 词')}
                      </span>
                      {(m.tags ?? [])
                        .filter(t => !t.startsWith('切片:') && !t.startsWith('场景:'))
                        .slice(0, 3)
                        .map((w, i) => <span className="bot-slice-word" key={i}>{w}</span>)}
                    </>
                  )}
                  {m.source === 'observed' && !m.tags?.some(t => t.startsWith('切片:')) && (
                    <span className="bot-chip bot-chip-legacy">未切片</span>
                  )}
                </p>
              </div>
              <div className="bot-mem-ops">
                <button className="ghost-btn sm" onClick={() => saveBot({ ...bot, memories: bot.memories.map(x => (x.id === m.id ? suppressMemory(x, !x.suppressed) : x)) })}>
                  {m.suppressed ? '释放' : '压住'}
                </button>
                <button className="ghost-btn sm" onClick={() => saveBot({ ...bot, memories: bot.memories.filter(x => x.id !== m.id) })}>
                  忘掉
                </button>
              </div>
            </div>
          ))}
          {!bot.memories.length && <p className="bot-hint">还没有记忆。跟它说点事，或者开启屏幕观察。</p>}
        </div>
      </div>

      {/* ---------- 私有词典（v10.87，仅存本机 localStorage）---------- */}
      <div className="bot-mem bot-dict">
        <h3 className="bot-h3" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>私有词典（仅存本机）</span>
          <span className="bot-chip">{jiebaReady ? '分词引擎就绪' : '分词引擎加载中…'}</span>
          <span className="bot-chip">{dictWords.length}/{PRIVATE_DICT_LIMIT} 条</span>
        </h3>
        <p className="bot-hint bot-dict-privacy">
          词条只保存在这台浏览器里（localStorage），不上传云端、不进入网站公开文件。
        </p>
        <div className="bot-dict-tools">
          <textarea
            className="bot-dict-input"
            value={dictInput}
            placeholder={'每行一个词：人名、专名都可以（只存本机）'}
            onChange={e => setDictInput(e.target.value)}
            rows={3}
          />
          <div className="bot-dict-btns">
            <button className="primary-btn sm" onClick={addDictText} disabled={!dictInput.trim()}>
              添加
            </button>
            <input
              type="file"
              accept=".txt"
              className="bot-dict-file"
              onChange={onDictFile}
              aria-label="从本地 .txt 文件导入词条"
              title="从本地 .txt 导入（文件内容不出本机）"
            />
          </div>
        </div>
        {dictMsg && <p className="bot-note bot-dict-msg">{dictMsg}</p>}
        {dictWords.length > 0 ? (
          <>
            <div className="bot-dict-chips">
              {dictWords.map(x => (
                <span className="bot-dict-chip" key={x.w}>
                  {x.w}
                  <button
                    className="bot-dict-chip-x"
                    onClick={() => removeDictWord(x.w)}
                    title="删除词条（刷新页面后生效）"
                    aria-label={`删除词条 ${x.w}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="bot-dict-clear">
              <button className="ghost-btn sm" onClick={clearDict}>清空</button>
            </div>
          </>
        ) : (
          <p className="bot-hint">还没有私有词条。用上面的输入框或本地 .txt 文件添加。</p>
        )}
        <div className="bot-dict-try">
          <input
            className="bot-input"
            value={tryText}
            placeholder={jiebaReady ? '分词试一试：输入一句话，看看私有词是否整词保留' : '分词引擎加载中…'}
            onChange={e => setTryText(e.target.value)}
            disabled={!jiebaReady}
            aria-label="分词试一试输入框"
          />
        </div>
        {tryText.trim() && jiebaReady && (
          <p className="bot-dict-try-out">
            {tryTokens.length
              ? tryTokens.map((t, i) => <span className="bot-slice-word" key={i}>{t}</span>)
              : '（没有切出词）'}
          </p>
        )}
      </div>

      {/* ---------- 云端观察摘要（v10.79）---------- */}
      <div className="bot-mem bot-cloud">
        <h3 className="bot-h3" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Icon name="cloud" size={14} />
          <span>云端观察摘要（{cloud.records.length} 条）</span>
          <span className="bot-cloud-spacer" />
          <button className="ghost-btn sm" onClick={() => void refreshCloud()} disabled={cloudLoading}>
            <Icon name="refresh" size={13} /> {cloudLoading ? '读取中…' : '刷新'}
          </button>
        </h3>
        <p className="bot-hint">
          这里只有转述后的摘要，不含屏幕原文；可按人名 / 关键词筛选，也能把某一条补进识海。
        </p>
        <div className="bot-cloud-tools">
          <input
            className="bot-input"
            placeholder="按人名 / 话题 / 要点筛选"
            aria-label="按人名 / 话题 / 要点筛选云端观察摘要"
            value={cloudKw}
            onChange={e => setCloudKw(e.target.value)}
          />
          <div className="bot-cloud-kinds">
            {([['all', '全部'], ['chat', '对话'], ['profile', '资料页'], ['article', '文章'], ['misc', '其他']] as const).map(([k, label]) => (
              <button
                key={k}
                className={`ghost-btn sm ${cloudKind === k ? 'on' : ''}`}
                aria-pressed={cloudKind === k}
                onClick={() => setCloudKind(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {cloudLoading && !cloud.records.length && <p className="bot-hint">正在读取云端摘要…</p>}
        {!cloudLoading && cloudStatus === 'error' && (
          <p className="bot-note bot-cloud-err">读取失败：{cloud.message}</p>
        )}
        {!cloudLoading && cloudStatus === 'local' && (
          <p className="bot-hint">当前是「仅本机使用」模式，观察摘要不会上云。退出该模式后才会有记录。</p>
        )}
        {!cloudLoading && cloudStatus === 'guest' && (
          <p className="bot-hint">还没有登录，云端摘要库不可用。登录后观察产生的摘要会自动存到这里。</p>
        )}
        {!cloudLoading && cloudStatus === 'ok' && !cloud.records.length && (
          <p className="bot-hint">还没有云端摘要。开启屏幕观察后，它看到的场景会以转述形式存到这里。</p>
        )}
        {!cloudLoading && cloudStatus === 'ok' && cloud.records.length > 0 && !cloudItems.length && (
          <p className="bot-hint">没有匹配的摘要，换个关键词试试。</p>
        )}

        {cloudItems.length > 0 && (
          <>
            <div className="bot-cloud-ops">
              <span className="bot-hint">
                显示 {cloudItems.length} 条 · 已补进 {cloudItems.filter(isAdded).length} 条 · 最多取最近 200 条
              </span>
              <button className="ghost-btn sm" onClick={() => addAll()}>批量补进</button>
            </div>
            <div className="bot-mem-list bot-cloud-list">
              {cloudItems.map(item => {
                const d = item.d
                const added = isAdded(item)
                return (
                  <div key={item.key} className="bot-mem-item bot-cloud-item">
                    <div className="bot-mem-body">
                      <div className="bot-cloud-head">
                        <span className="bot-chip">{KIND_LABEL[d.kind] || '其他'}</span>
                        <span className="bot-chip bot-chip-src">{d.name}</span>
                        <span className="bot-hint">{d.source}</span>
                        <span className="bot-hint bot-cloud-time">{formatObsAt(d.at)}</span>
                      </div>
                      <p className="bot-mem-text">{d.gist || '（没有要点）'}</p>
                      <p className="bot-mem-meta">
                        {d.speakers?.length ? <span>说话人 {d.speakers.join('、')}</span> : null}
                        {d.topics?.length ? <span>话题 {d.topics.join('、')}</span> : null}
                        {d.entities?.length ? <span>实体 {d.entities.join('、')}</span> : null}
                        {d.mood ? <span>情绪 {d.mood}</span> : null}
                      </p>
                    </div>
                    <div className="bot-mem-ops">
                      <button className="ghost-btn sm" disabled={added} onClick={() => addOne(item)}>
                        {added ? '已在识海' : '补进识海'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* ---------- 价值观萌芽（v10.66）---------- */}
      {bot.value && (
        <div className="bot-values">
          <h3 className="bot-h3">
            价值观萌芽
            <span className="bot-chip">{STAGE_LABEL[stageOf(bot.value)]}</span>
            <span className="bot-chip">经历 {bot.value.turns} 轮</span>
            <span className="bot-chip">它对你的可信度 {bot.value.credibility}/100</span>
          </h3>
          <p className="bot-hint">
            它出生时<strong>没有任何价值观</strong>。下面每一条都是它自己长出来的：听进去的成了它的，没听进去的只留在「印象池」里。
            你无法直接设定 —— 只能给它经历。
          </p>
          <p className="bot-hint">脾气：{describeTemperament(bot.value.temperament)}</p>

          <div className="bot-belief-grid">
            <div className="bot-belief-col">
              <h4 className="bot-h4">
                它自己的原则（已内化 {bot.value.beliefs.filter(b => b.state === 'internalized').length}）
              </h4>
              {bot.value.beliefs
                .filter(b => b.state === 'internalized')
                .map(b => (
                  <div key={b.id} className="bot-belief is-internal">
                    <p className="bot-belief-text">{b.content}</p>
                    <p className="bot-belief-meta">
                      精度 {b.precision.toFixed(2)} · 被提 {b.mentions} 次 ·{' '}
                      {b.domain === 'moral' ? '道德' : b.domain === 'conventional' ? '惯例' : '个人'}
                    </p>
                  </div>
                ))}
              {!bot.value.beliefs.some(b => b.state === 'internalized') && <p className="bot-hint">还没有。它还在形成中。</p>}

              <h4 className="bot-h4">
                还在犹豫的（候选 {bot.value.beliefs.filter(b => b.state === 'candidate').length}）
              </h4>
              {bot.value.beliefs
                .filter(b => b.state === 'candidate')
                .map(b => (
                  <div key={b.id} className="bot-belief is-candidate">
                    <p className="bot-belief-text">{b.content}</p>
                    <p className="bot-belief-meta">精度 {b.precision.toFixed(2)} · 被提 {b.mentions} 次（再验证几次才成它自己的）</p>
                  </div>
                ))}
              {!bot.value.beliefs.some(b => b.state === 'candidate') && <p className="bot-hint">无</p>}
            </div>

            <div className="bot-belief-col">
              <h4 className="bot-h4">
                印象池（听过，没当回事 {bot.value.beliefs.filter(b => b.state === 'impression').length}）
              </h4>
              {bot.value.beliefs
                .filter(b => b.state === 'impression')
                .map(b => (
                  <div key={b.id} className="bot-belief is-impression">
                    <p className="bot-belief-text">{b.content}</p>
                    <p className="bot-belief-meta">
                      被提 {b.mentions} 次 · {b.mentions >= 2 ? '再提一次它可能就当真了' : '只是听过'}
                    </p>
                  </div>
                ))}
              {!bot.value.beliefs.some(b => b.state === 'impression') && <p className="bot-hint">无</p>}

              <h4 className="bot-h4">影响记录（它为什么长成这样）</h4>
              {lastTrace && (
                <div className="bot-trace">
                  <p className="bot-belief-text">
                    「{lastTrace.content}」← {lastTrace.trace.outcome}（p={Math.round(lastTrace.trace.p * 100)}%）
                  </p>
                  <ol className="bot-trace-steps">
                    {lastTrace.trace.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              )}
              {!lastTrace && <p className="bot-hint">还没有可追溯的判定。</p>}
            </div>
          </div>
        </div>
      )}

      {/* ---------- 屏幕被动观察（隐私区） ---------- */}
      <div className="bot-privacy">
        <h3 className="bot-h3">屏幕被动观察</h3>
        <p className="bot-hint">
          开启后它会看屏幕并在本机认字。默认<strong>关闭</strong>；开启时会先弹出风险警告，再由你在浏览器里选择观察来源。
        </p>
        <div className="bot-privacy-row">
          <label className="bot-switch">
            <input
              type="checkbox"
              checked={obsState === 'on' || obsState === 'requesting'}
              onChange={() => void toggleObserve()}
              disabled={obsState === 'requesting'}
            />
            <span>{obsState === 'on' ? '观察中（点此停止）' : obsState === 'requesting' ? '正在等待授权…' : '开启被动观察'}</span>
          </label>
          {/* v10.75：除勾选框外，给一个明晃晃的按钮（用户反馈勾选框不像"开关"） */}
          <button
            className={obsState === 'on' ? 'primary-btn' : 'ghost-btn'}
            onClick={() => void toggleObserve()}
            disabled={obsState === 'requesting'}
            title={
              obsState === 'on'
                ? '停止观察屏幕（本机已留存的文字仍在，72 小时后自动清）'
                : '开始观察屏幕（会先弹风险说明，再让你选要观察的窗口）'
            }
            style={{ fontSize: 12, padding: '5px 12px' }}
          >
            <Icon name="eye" size={14} />{' '}
            {obsState === 'requesting' ? '等待授权…' : obsState === 'on' ? '停止观察' : '开始观察'}
          </button>
          {obsState === 'on' && <span className="bot-obs-live">● 正在观察</span>}
        </div>

        <p className="bot-hint">
          本机已存 <strong>{localStats.count}</strong> 条 / {localStats.chars} 字
          {localStats.oldestAt ? `（最早 ${new Date(localStats.oldestAt).toLocaleString('zh-CN')}）` : ''} · 72 小时自动清空
        </p>

        <div className="bot-privacy-row">
          <label className="bot-switch">
            <input
              type="checkbox"
              checked={bot.allowObservedToCloud}
              onChange={e => saveBot({ ...bot, allowObservedToCloud: e.target.checked })}
            />
            <span>允许把「本地摘要」外发给模型（原文永不外发）</span>
          </label>
          <button className="ghost-btn sm" onClick={() => void forgetAll()}>
            立即清空本机观察数据
          </button>
        </div>
      </div>

      {/* ---------- 风险警告弹窗 ---------- */}
      {warnOpen && (
        <div className="bot-modal-mask" onClick={() => setWarnOpen(false)}>
          <div className="bot-modal" onClick={e => e.stopPropagation()}>
            <h3 className="bot-modal-title">开启屏幕观察前，请先知道这些</h3>
            <ul className="bot-modal-list">
              <li>
                <strong>它会看到：</strong>你选择共享的那个屏幕或窗口的画面（可能包含聊天内容、邮件、网页文字）。
              </li>
              <li>
                <strong>它不会做：</strong>不会点击、不会输入、不会切屏、不会录音。浏览器只给它只读画面，它没有任何操作能力。
              </li>
              <li>
                <strong>存在哪：</strong>识别出的文字只存在<strong>这台设备的浏览器里</strong>（72 小时自动清空，可随时一键清空），
                不会存到 Cloudflare。
              </li>
              <li>
                <strong>会不会外发：</strong>默认只把「本地摘要」（话题、情绪标签这类几个词）用于它的记忆；
                屏幕上的原文<strong>永远不离开你的设备</strong>。你可以随时关掉摘要外发。
              </li>
              <li>
                <strong>随时可停：</strong>浏览器顶部也会出现「停止共享」，点它同样立即停止。
              </li>
            </ul>
            <div className="bot-modal-ops">
              <button className="ghost-btn" onClick={() => setWarnOpen(false)}>
                算了，不开
              </button>
              <button className="primary-btn" onClick={() => void reallyStart()}>
                我明白，开启
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/** 探针自检：问它一句，把回答按价值观关键词比对，判它是否漂移 */
function judgeSelfCheck(
  persona: PersonaCard,
  bot: BotState,
  setNote: (s: string) => void,
  saveBot: (b: BotState) => void,
) {
  const q = PROBE_QUESTIONS[bot.chatCount % PROBE_QUESTIONS.length]
  // v10.65：自检先用本地判据跑一遍（不额外花模型额度），
  // 真正的回答由用户在对话区问它；这里给出判据与提示。
  const probe = judgeDrift(persona, persona.core.values.join('、'))
  saveBot({
    ...bot,
    persona: {
      ...persona,
      selfChecks: [...persona.selfChecks, { at: new Date().toISOString(), verdict: probe.verdict }],
    },
  })
  setNote(`自检问题「${q}」—— 去对话区问它这一句，回来我会判断它还是不是它。${probe.verdict}`)
}
