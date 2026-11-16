/* ============================================================
   灵感采集面板（v10.80）
   ------------------------------------------------------------
   五个渠道（知乎 / 小红书 / 抖音 / Reddit / X）各一个独立按钮：
     ① 选渠道 → ② 抓取 → ③ 勾选条目 → ④ 组装成「带来源链接的多语言语料」
     → ⑤ 喂给原有「原文拆解」管线改编成书（每条素材的来源链接随原文可溯源）。
   放在写作页顶部、默认折叠；抓取/拆解都不挑时机，登录与否均可用。
   ============================================================ */

import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import {
  HARVEST_CHANNELS,
  CHANNEL_LABEL,
  fetchSourceHybrid,
  loadHarvestCookie,
  saveHarvestCookie,
  buildCorpus,
  langLabel,
  type ChannelConfig,
  type HarvestItem,
} from '../lib/harvest'

interface Props {
  /** 组装好的语料写入哪里（写作页的共享原文框，「散稿」tab 可见） */
  onCorpus: (corpus: string, mode: 'replace' | 'append') => void
  /** 拆解到 7 画布（用组装好的语料直接跑，不必先写回原文框） */
  onDissect: (corpus: string) => void
  /** 拆解进行中（拆解按钮置灰用） */
  dissectBusy: boolean
}

export function SourceHarvest({ onCorpus, onDissect, dissectBusy }: Props) {
  const [channel, setChannel] = useState<ChannelConfig['key']>('reddit')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(10)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ channel: string; items: HarvestItem[]; note: string } | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [cookieDraft, setCookieDraft] = useState('')
  const [cookieSaved, setCookieSaved] = useState('')

  const cfg = useMemo(() => HARVEST_CHANNELS.find(c => c.key === channel)!, [channel])

  useEffect(() => {
    setCookieDraft(loadHarvestCookie(channel))
    setCookieSaved('')
  }, [channel])

  const run = async (ch: ChannelConfig['key']) => {
    setChannel(ch)
    setBusy(true)
    setError('')
    setResult(null)
    setSelected(new Set())
    try {
      const r = await fetchSourceHybrid(ch, query.trim(), { limit, cookie: loadHarvestCookie(ch) })
      const items = (r.items || []).filter(Boolean)
      setResult({ channel: ch, items, note: r.note || '' })
      setSelected(new Set(items.map((_, i) => i).filter(i => !items[i].error)))
      if (!items.length) setError('没有抓到内容：换个关键词 / 链接再试，或看渠道说明。')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (i: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const chosenItems = useMemo(() => {
    if (!result) return []
    return result.items
      .map((it, i) => ({ it, i }))
      .filter(({ it, i }) => selected.has(i) && !it.error)
      .map(({ it }) => it)
  }, [result, selected])

  const buildAnd = (mode: 'replace' | 'append' | 'dissect') => {
    if (!chosenItems.length) return
    const corpus = buildCorpus(result!.channel, chosenItems)
    if (mode === 'dissect') onDissect(corpus)
    else onCorpus(corpus, mode)
  }

  const dirtyCookie = cookieDraft.trim() !== loadHarvestCookie(channel).trim()

  return (
    <details className="sh-panel wb-block">
      <summary className="sh-summary">
        <span className="sh-summary-title">
          <Icon name="download" size={14} /> 灵感采集 · 多渠道抓取 → 改编
        </span>
        <span className="sh-summary-hint">
          知乎 / 小红书 / 抖音 / Reddit / X —— 抓真实素材（含外文多语言）组装语料，一键拆解到 7 画布
        </span>
      </summary>

      <div className="sh-body">
        {/* 渠道按钮：每个渠道一个独立按钮 */}
        <div className="sh-channels">
          {HARVEST_CHANNELS.map(c => (
            <button
              key={c.key}
              className={`sh-channel ${channel === c.key ? 'active' : ''}`}
              onClick={() => setChannel(c.key)}
              title={c.desc}
            >
              {c.label}
              {c.needCookie === 'required' && <span className="sh-channel-badge">需Cookie</span>}
              {c.needCookie === 'optional' && <span className="sh-channel-badge soft">Cookie增强</span>}
            </button>
          ))}
        </div>

        <p className="sh-desc">
          <b>{cfg.label}</b>：{cfg.desc}
        </p>

        <div className="sh-controls">
          <input
            className="sh-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={cfg.placeholder}
            onKeyDown={e => {
              if (e.key === 'Enter' && !busy) run(channel)
            }}
          />
          <label className="sh-limit">
            条数
            <input
              type="number"
              min={1}
              max={20}
              value={limit}
              onChange={e => setLimit(Math.max(1, Math.min(20, Number(e.target.value) || 10)))}
            />
          </label>
          <button className="primary-btn sm" disabled={busy} onClick={() => run(channel)}>
            {busy ? '抓取中…' : `抓取${CHANNEL_LABEL[channel]}`}
          </button>
        </div>

        {/* Cookie 设置：按渠道存 localStorage，只随抓取请求发给对应站点 */}
        {cfg.needCookie !== 'none' && (
          <details className="sh-cookie">
            <summary>
              🔑 Cookie 设置（{cfg.needCookie === 'required' ? '本渠道必需' : '可选增强'}）
              {loadHarvestCookie(channel) && <span className="sh-cookie-ok">已保存</span>}
            </summary>
            <div className="sh-cookie-body">
              <p className="sh-cookie-hint">{cfg.cookieHint}</p>
              <textarea
                className="sh-cookie-area"
                rows={3}
                placeholder="粘贴整行 Cookie，例如：a1=xxxx; web_session=xxxx; …"
                value={cookieDraft}
                onChange={e => {
                  setCookieDraft(e.target.value)
                  setCookieSaved('')
                }}
              />
              <div className="sh-cookie-actions">
                <button
                  className="ghost-btn sm"
                  onClick={() => {
                    saveHarvestCookie(channel, cookieDraft)
                    setCookieSaved(dirtyCookie ? '已保存（仅存本机浏览器）' : '已清空')
                  }}
                >
                  保存 Cookie
                </button>
                {cookieSaved && <span className="sh-cookie-saved">{cookieSaved}</span>}
              </div>
              <p className="sh-cookie-note">
                Cookie 只存在你浏览器的 localStorage、只随抓取请求转发给对应平台；不会上传云端、不会写进作品。
              </p>
            </div>
          </details>
        )}

        {busy && (
          <p className="sh-loading">
            <span className="wb-dot" /> 正在抓取{CHANNEL_LABEL[channel]}（Reddit 翻归档库可能要几十秒）…
          </p>
        )}
        {error && <p className="sh-error">⚠️ {error}</p>}

        {/* 抓取结果：每条带来源链接，可勾选 */}
        {result && (
          <div className="sh-result">
            <p className="sh-note">{result.note}</p>
            <ul className="sh-items">
              {result.items.map((it, i) => (
                <li key={`${it.id}-${i}`} className={`sh-item ${it.error ? 'bad' : ''}`}>
                  <label className="sh-item-check">
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      disabled={Boolean(it.error)}
                      onChange={() => toggle(i)}
                    />
                  </label>
                  <div className="sh-item-main">
                    <a className="sh-item-title" href={it.url} target="_blank" rel="noopener noreferrer" title="打开来源原文">
                      {it.title || '（无标题）'}
                    </a>
                    <div className="sh-item-meta">
                      <span className="sh-lang">{langLabel(it.lang)}</span>
                      {it.author && <span>{it.author}</span>}
                      {it.metrics && <span>{it.metrics}</span>}
                      <a className="sh-item-url" href={it.url} target="_blank" rel="noopener noreferrer">
                        来源链接 ↗
                      </a>
                    </div>
                    {it.error ? (
                      <p className="sh-item-error">{it.error}</p>
                    ) : (
                      it.text && <p className="sh-item-text">{it.text.slice(0, 160)}{(it.text.length || 0) > 160 ? '…' : ''}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {/* 组装 → 改编 */}
            {chosenItems.length > 0 && (
              <div className="sh-actions">
                <span className="sh-actions-count">已选 {chosenItems.length} 条 · 共 {chosenItems.reduce((s, it) => s + (it.text?.length || 0), 0)} 字</span>
                <button className="primary-btn sm" disabled={dissectBusy} onClick={() => buildAnd('dissect')}>
                  {dissectBusy ? '拆解中…' : '组装语料并拆解到 7 画布'}
                </button>
                <button className="ghost-btn sm" onClick={() => buildAnd('replace')}>
                  写入原文框（替换）
                </button>
                <button className="ghost-btn sm" onClick={() => buildAnd('append')}>
                  追加到原文框
                </button>
              </div>
            )}
            <p className="sh-after-hint">
              拆解完成后，到「画布」页检查 7 块画布，再按原有流程生成/精写；语料里已带每条来源链接，改编可溯源。
            </p>
          </div>
        )}
      </div>
    </details>
  )
}
