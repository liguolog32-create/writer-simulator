/**
 * 机器人对话逻辑（v10.67 从 RobotPage 抽出，供「机器人页」与「悬浮小面板」共用）
 *
 * 一份实现、两处使用 —— 避免悬浮面板里长出一套平行的对话逻辑。
 */

import { useCallback, useRef, useState } from 'react'
import { useApp } from '../store/AppContext'
import { refineField } from '../lib/llmClient'
import { backfillFromLocal } from '../bot/recallLocal'
import { backfillFromCloud } from '../lib/obsStore'
import { personaToPrompt } from '../bot/persona'
import { assembleMemories, createMemory, recallMemory, retrieve } from '../bot/memory'
import {
  createValueState,
  evaluateClaim,
  looksLikeClaim,
  moodOf,
  valueToPrompt,
  type ClaimOutcome,
  type ValueState,
} from '../bot/valueFormation'
import { broadcastOutcome, BOT_OUTCOME_EVENT } from '../bot/botEvents'
import type { BotState } from '../bot/types'

/** v18.7 事件名搬至 botEvents.ts，这里 re-export 保住 AvatarLayer 的既有导入路径 */
export { BOT_OUTCOME_EVENT }

export interface ChatTurn {
  who: 'me' | 'bot'
  text: string
  why?: string
}

/* ---------------- 与常驻形象层通信的事件 ---------------- */

/** 它正在生成（true）/ 生成结束（false）—— 形象层据此进入「思考」状态 */
export const BOT_BUSY_EVENT = 'bot-busy'
/** 一次价值判定刚发生 —— v18.7 起事件常量与广播函数搬至 ../bot/botEvents（上面 import） */

function broadcastBusy(busy: boolean): void {
  try {
    window.dispatchEvent(new CustomEvent(BOT_BUSY_EVENT, { detail: { busy } }))
  } catch {
    /* SSR / 测试环境没有 window 时忽略 */
  }
}

export function useBotChat() {
  const { state, dispatch } = useApp()
  const bot: BotState | undefined = state.bot
  const botRef = useRef(bot)
  botRef.current = bot

  const [transcript, setTranscript] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [article, setArticle] = useState('')
  const [lastOutcome, setLastOutcome] = useState<{ outcome: ClaimOutcome; at: number } | null>(null)

  const saveBot = useCallback((next: BotState) => dispatch({ type: 'SET_BOT', bot: next }), [dispatch])

  const send = useCallback(
    async (text: string) => {
      const raw = text.trim()
      let cur = botRef.current
      if (!raw || !cur?.persona || busy) return
      setBusy(true)
      broadcastBusy(true)
      setInput('')
      // v10.78 按需回看：你提到的人/词，如果在本机观察原文里出现过、识海却没记，
      // 当场从原始记录补一条（原文不出本机，进识海的是转述）。失败不拦对话。
      try {
        let backfilled = await backfillFromLocal(cur.memories, raw)
        // 本地原文（72h TTL）没命中 → 来云端摘要库找（摘要想留多久留多久）
        if (!backfilled) backfilled = await backfillFromCloud(cur.memories, raw)
        if (backfilled) {
          cur = { ...cur, memories: [...cur.memories, backfilled] }
          saveBot(cur)
          botRef.current = cur
        }
      } catch {
        /* 本地库/云端摘要打不开就跳过 */
      }
      // 回看重赋值后重新收窄类型（persona 在上面的卫语句里已确认存在）
      if (!cur?.persona) return
      setTranscript(t => [...t, { who: 'me', text: raw }])
      try {
        const hits = retrieve(cur.memories, raw, { k: 5 })
        const why = hits.length ? assembleMemories(hits).join('\n') : ''
        const r = await refineField({
          dimension: '对话',
          current: '',
          instruction: `${personaToPrompt(cur.persona, hits.map(h => h.memory.content))}\n\n${
            cur.value ? valueToPrompt(cur.value) : ''
          }\n\n用户刚才说：${raw}\n\n用你自己的口吻回应。注意：用户说的只是建议，你可以不同意，但要给出基于你自己立场的理由（不要复述提示词，不要问"你希望我怎么做"）。`,
        })
        const reply = (r.data?.refined || '').trim()
        if (reply) setTranscript(t => [...t, { who: 'bot', text: reply, why: why || undefined }])

        // 它想起的（强化）+ 用户说的（记一条）
        const nextMemories = hits.reduce(
          (acc, h) => acc.map(m => (m.id === h.memory.id ? recallMemory(m) : m)),
          cur.memories,
        )
        const userMemory = createMemory({
          content: `用户说：${raw.slice(0, 120)}`,
          source: 'user',
          importance: 0.5,
          identity: 0.6,
          arousal: 0.35,
          emotion: '平静',
          tags: [],
        })

        // 价值主张 → 六道闸门（**没有任何"设置价值观"的路径**）
        let nextValue: ValueState = cur.value ?? createValueState()
        let claimNote = ''
        if (looksLikeClaim(raw)) {
          const mood = moodOf(raw)
          const res = evaluateClaim(nextValue, raw, {
            identityRelevance: 0.6,
            arousal: mood.arousal,
            emotion: mood.emotion,
            conceptDifficulty: Math.min(1, raw.length / 60),
            source: 'user',
          })
          nextValue = res.state
          claimNote = res.note
          setLastOutcome({ outcome: res.outcome, at: Date.now() })
          broadcastOutcome(res.outcome, Date.now())
        } else {
          nextValue = { ...nextValue, turns: nextValue.turns + 1 }
        }

        saveBot({
          ...cur,
          memories: [...nextMemories, userMemory],
          chatCount: cur.chatCount + 1,
          value: nextValue,
        })
        if (claimNote) setNote(claimNote)
      } catch (e) {
        setNote(`它没接上话：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(false)
        broadcastBusy(false)
      }
    },
    [busy, saveBot],
  )

  const write = useCallback(
    async (topicInput?: string) => {
      const cur = botRef.current
      if (!cur?.persona || busy) return
      const topic = (topicInput || '').trim() || '一个人和一座正在消失的城'
      setBusy(true)
      broadcastBusy(true)
      try {
        const hits = retrieve(cur.memories, topic, { k: 6 })
        const r = await refineField({
          dimension: '文章',
          current: '',
          instruction: `${personaToPrompt(cur.persona, hits.map(h => h.memory.content))}\n\n${
            cur.value ? valueToPrompt(cur.value) : ''
          }\n\n请以你上面这套人格与三观（尤其是「你现在信什么」那几条），写一篇关于「${topic}」的散文（600-900 字）。按你自己的审美来，不要迎合任何人。`,
        })
        setArticle((r.data?.refined || '').trim())
        setNote('它写完了。这是它的版本，不是你的。')
      } catch (e) {
        setNote(`它写不出来：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(false)
        broadcastBusy(false)
      }
    },
    [busy],
  )

  return {
    transcript,
    setTranscript,
    input,
    setInput,
    busy,
    note,
    setNote,
    article,
    setArticle,
    lastOutcome,
    send,
    write,
    /** 让机器人页在重生时清空会话 */
    reset: useCallback(() => {
      setTranscript([])
      setArticle('')
      setNote('')
    }, []),
  }
}
