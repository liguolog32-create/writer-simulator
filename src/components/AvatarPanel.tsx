/**
 * 形象小面板（v10.67）—— 单击形象展开
 *
 * 只放最常用的三块：**对话** / **它刚长出的一条信念** / **本次判定落点**；
 * 底部一行入口回机器人页（= 双击形象）。对话逻辑与机器人页共用 useBotChat。
 */

import { useEffect, useRef } from 'react'
import { useApp } from '../store/AppContext'
import { useBotChat } from '../hooks/useBotChat'
import { stageOf, STAGE_LABEL } from '../bot/valueFormation'
import type { AvatarPresence } from '../bot/avatar/types'

const OUTCOME_LABEL: Record<string, string> = {
  ignored: '它没听见',
  impression: '只留了印象',
  reviewed: '它在复核',
  candidate: '收下了（候选）',
  internalized: '它信了',
  resisted: '它没被说服',
  backfire: '它反而更不信了',
}

export function AvatarPanel({ onClose, presence }: { onClose: () => void; presence: AvatarPresence }) {
  const { state } = useApp()
  const bot = state.bot
  const chat = useBotChat()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [chat.transcript.length, chat.busy])

  if (!bot?.persona) return null
  const stage = bot.value ? stageOf(bot.value) : 'heteronomous'
  const internal = (bot.value?.beliefs ?? []).filter(b => b.state === 'internalized')
  const candidate = (bot.value?.beliefs ?? []).filter(b => b.state === 'candidate')
  const latest = internal[internal.length - 1] ?? candidate[candidate.length - 1] ?? null

  return (
    <div className="avatar-panel" role="dialog" aria-label={`${bot.persona.name} 的小面板`}>
      <header className="avatar-panel-head">
        <div>
          <span className="avatar-panel-name">{bot.persona.name}</span>
          <span className="bot-chip">{STAGE_LABEL[stage]}</span>
          {bot.value && <span className="bot-chip">可信度 {bot.value.credibility}/100</span>}
        </div>
        <button className="ghost-btn sm" onClick={onClose} aria-label="收起">
          收起
        </button>
      </header>

      <p className="avatar-panel-status">{presence.status}</p>

      <div className="avatar-panel-chat" ref={listRef}>
        {chat.transcript.length === 0 && (
          <p className="bot-hint">直接跟它说话。它有自己的脾气和三观，你说的只是建议。</p>
        )}
        {chat.transcript.slice(-8).map((m, i) => (
          <div key={i} className={`bot-msg bot-msg-${m.who}`}>
            <div className="bot-msg-text">{m.text}</div>
          </div>
        ))}
        {chat.busy && <p className="bot-hint">它在想…</p>}
      </div>

      {chat.note && <p className="bot-note">{chat.note}</p>}

      {latest && (
        <div className="avatar-panel-belief">
          <span className="bot-chip">{internal.includes(latest) ? '它自己的原则' : '它还在犹豫'}</span>
          <span className="avatar-panel-belief-text">{latest.content}</span>
        </div>
      )}

      <div className="bot-input-row">
        <input
          className="bot-input"
          value={chat.input}
          placeholder={`对 ${bot.persona.name} 说点什么…`}
          onChange={e => chat.setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) void chat.send(chat.input)
          }}
          disabled={chat.busy}
        />
        <button className="primary-btn" onClick={() => void chat.send(chat.input)} disabled={chat.busy || !chat.input.trim()}>
          说
        </button>
        <button className="ghost-btn" onClick={() => void chat.write(chat.input)} disabled={chat.busy} title="用它的三观写一篇">
          让它写
        </button>
      </div>

      {chat.article && (
        <div className="avatar-panel-article">
          <p className="bot-h4">它写的</p>
          <div className="bot-article-body">{chat.article}</div>
        </div>
      )}

      <footer className="avatar-panel-foot">
        {chat.lastOutcome && <span className="bot-chip">刚才：{OUTCOME_LABEL[chat.lastOutcome.outcome] ?? chat.lastOutcome.outcome}</span>}
        <button className="ghost-btn sm" onClick={() => (window.location.hash = '#/bot')}>
          去它的房间 →
        </button>
      </footer>
    </div>
  )
}
