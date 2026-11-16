import { useMemo, useState } from 'react'
import { useApp } from '../store/AppContext'
import { forgeStyleCard, type ForgedStyleCard } from '../lib/llmClient'
import { CUSTOM_CARD_GROUP, type StyleCard } from '../data/styleCards'
import { detectEmptyWords, GUIDE_TAGS } from '../data/styleForge'

/**
 * 文风炼金（StyleForge）—— 用户自己设计一张文风卡。
 * 流程照 StyleForge 的思路，但按本站现状落地：
 *   写描述 → 本地空泛词检测 + 引导标签（把话说具体）→ 一键炼卡 → 看盲测段落 → 存成自己的卡
 * 存下来的卡进入 AppState.customStyleCards，直接在【文笔】画布的「我的文风卡」分组里出现，
 * 和预置卡一样可以一键套用。
 */
export function StyleForge({ onClose }: { onClose: () => void }) {
  const { saveStyleCard } = useApp()
  const [raw, setRaw] = useState('')
  const [reference, setReference] = useState('')
  const [sampleText, setSampleText] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const [card, setCard] = useState<ForgedStyleCard | null>(null)
  const [saved, setSaved] = useState(false)

  const emptyHits = useMemo(() => detectEmptyWords(raw), [raw])

  const togglePick = (t: string) =>
    setPicked(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]))

  const appendTag = (t: string) => {
    setRaw(prev => {
      if (!prev.trim()) return t
      if (prev.includes(t)) return prev
      return `${prev.replace(/[，,、；;]\s*$/, '')}，${t}`
    })
  }

  const forge = async () => {
    if (!raw.trim() && !reference.trim()) {
      setErrMsg('先写一句你想要的文风，或者填一个参考作家')
      return
    }
    setBusy(true)
    setErrMsg('')
    setSaved(false)
    try {
      const { data } = await forgeStyleCard({
        raw,
        clarifications: picked,
        reference,
        sampleText,
      })
      setCard(data)
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doSave = () => {
    if (!card) return
    const full: StyleCard = {
      id: `mine-${Date.now().toString(36)}`,
      group: CUSTOM_CARD_GROUP,
      name: card.name.trim() || '我的文风',
      tagline: card.tagline.trim() || '自定义',
      effect: card.effect,
      quotes: card.quotes.filter(Boolean),
      applyText: card.applyText,
    }
    saveStyleCard(full)
    setSaved(true)
  }

  return (
    <div className="modal-mask" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal forge-modal">
        <div className="modal-head">
          <div>
            <h3 className="modal-title">自己设计一张文风卡</h3>
            <p className="modal-sub">
              用大白话描述你想要的文风，空泛的词会被标出来让你选清楚，然后一键炼成可套用的卡
            </p>
          </div>
          <div className="modal-actions">
            <button className="ghost-btn sm" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="modal-body">
          {/* ① 描述 */}
          <label className="forge-field">
            <span>1. 你想要的文风是什么？（说人话就行）</span>
            <textarea
              className="forge-textarea"
              rows={3}
              placeholder="例：冷一点，句子短，少写心理，像有人在深夜跟你说话，带点疏离感"
              value={raw}
              onChange={e => setRaw(e.target.value)}
            />
          </label>

          {/* ② 空泛词检测（本地，不调模型） */}
          {emptyHits.length > 0 && (
            <div className="forge-empty">
              <p className="forge-empty-head">
                检测到 {emptyHits.length} 个空泛词——它们不会让 AI 更懂你，点一个具体说法补进去：
              </p>
              {emptyHits.map(h => (
                <div key={h.word} className="forge-empty-item">
                  <p className="forge-empty-word">
                    「{h.word}」<span className="forge-empty-why">{h.why}</span>
                  </p>
                  <div className="forge-chip-row">
                    {h.options.map(op => (
                      <button
                        key={op}
                        type="button"
                        className={`forge-chip ${picked.includes(op) ? 'on' : ''}`}
                        onClick={() => {
                          togglePick(op)
                          if (!picked.includes(op)) appendTag(op)
                        }}
                      >
                        {op}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ③ 引导标签 */}
          <div className="forge-guide">
            <p className="forge-guide-head">2. 点标签把风格说具体（会追加到上面的描述里）</p>
            {GUIDE_TAGS.map(g => (
              <div key={g.label} className="forge-guide-row">
                <span className="forge-guide-label">{g.label}</span>
                <div className="forge-chip-row">
                  {g.tags.map(t => (
                    <button
                      key={t}
                      type="button"
                      className={`forge-chip sm ${raw.includes(t) ? 'on' : ''}`}
                      onClick={() => appendTag(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="forge-row2">
            <label className="forge-field">
              <span>参考作家 / 作品（可选，只借鉴气质）</span>
              <input
                className="forge-input"
                placeholder="例：村上春树 + 一点鲁迅"
                value={reference}
                onChange={e => setReference(e.target.value)}
              />
            </label>
            <label className="forge-field">
              <span>贴一段你自己写的文字（可选，保留你的个人味道）</span>
              <textarea
                className="forge-textarea"
                rows={3}
                placeholder="粘贴一段你以前写的文字，AI 会把你的个人习惯保留下来"
                value={sampleText}
                onChange={e => setSampleText(e.target.value)}
              />
            </label>
          </div>

          <div className="forge-actions">
            <button className="primary-btn" onClick={forge} disabled={busy}>
              {busy ? '炼制中…' : card ? '重新炼一张' : '炼成文风卡'}
            </button>
            {errMsg && <span className="forge-err">{errMsg}</span>}
          </div>

          {/* ④ 结果 */}
          {card && (
            <div className="forge-result">
              <div className="forge-result-head">
                <input
                  className="forge-input name"
                  value={card.name}
                  onChange={e => setCard({ ...card, name: e.target.value })}
                />
                <input
                  className="forge-input tagline"
                  value={card.tagline}
                  onChange={e => setCard({ ...card, tagline: e.target.value })}
                />
              </div>

              <label className="forge-field">
                <span>会让文风变成什么样（可改）</span>
                <textarea
                  className="forge-textarea"
                  rows={5}
                  value={card.effect}
                  onChange={e => setCard({ ...card, effect: e.target.value })}
                />
              </label>

              <label className="forge-field">
                <span>示例原文（每行一段，可改）</span>
                <textarea
                  className="forge-textarea"
                  rows={7}
                  value={card.quotes.join('\n')}
                  onChange={e =>
                    setCard({ ...card, quotes: e.target.value.split('\n').filter(s => s.trim()) })
                  }
                />
              </label>

              <label className="forge-field">
                <span>写入【文笔】画布的规范文案（可改）</span>
                <textarea
                  className="forge-textarea"
                  rows={7}
                  value={card.applyText}
                  onChange={e => setCard({ ...card, applyText: e.target.value })}
                />
              </label>

              {card.sample && (
                <div className="forge-sample">
                  <p className="forge-sample-head">盲测段落（用这个文风现场写一段，看看是不是你要的味道）</p>
                  <div className="gen-prose">
                    {card.sample.split('\n\n').map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                </div>
              )}

              {card.warnings.length > 0 && (
                <div className="forge-empty">
                  <p className="forge-empty-head">有几处可能互相打架：</p>
                  <ul className="forge-warn-list">
                    {card.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="forge-actions">
                <button className="primary-btn" onClick={doSave}>
                  存进「我的文风卡」
                </button>
                {saved && <span className="forge-ok">已保存，去下面的「我的文风卡」分组就能看到并套用</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
