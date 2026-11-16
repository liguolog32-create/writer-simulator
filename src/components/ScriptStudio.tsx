import { useEffect, useState } from 'react'
import { useApp } from '../store/AppContext'
import {
  toScriptLLM,
  scriptLineToText,
  scriptSceneHead,
  type ScriptResult,
  type ScriptEpisode,
  type ScriptScene,
} from '../lib/llmClient'
import { DIMENSIONS } from '../data/textDissect'
import { ChapterTextReader } from './ChapterTextReader'
import type { TextChapter } from '../lib/textChapters'
import type { SavedBook } from '../types'

const PLATFORMS = ['通用', '抖音', '快手', '红果短剧', '微信短剧', '番茄短剧']
const EP_OPTIONS = [1, 2, 3, 4, 6, 8, 12]
const SEC_OPTIONS = [60, 90, 120, 180]
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/** 1 → 一、12 → 十二 */
export function cnNum(n: number): string {
  return CN_NUM[n] ?? String(n)
}

/** 模型常把「第1集」写进标题里，UI 已经单独显示集号，这里去掉避免重复 */
function cleanEpTitle(t: string): string {
  return (t || '').replace(/^\s*第\s*[\d一二三四五六七八九十]+\s*集\s*[·:：\-\s]*/, '').trim() || '（未命名）'
}

/** 单场戏按行业标准格式渲染成纯文本 */
function sceneToText(sc: ScriptScene): string[] {
  const out: string[] = []
  out.push(scriptSceneHead(sc))
  if (sc.cast.length) out.push(`人物：${sc.cast.join('、')}`)
  for (const l of sc.lines) out.push(scriptLineToText(l))
  const cam = [sc.camera, sc.transition].filter(Boolean).join('　')
  if (cam) out.push(`〔镜头〕${cam}`)
  return out
}

/** 单集渲染成纯文本 */
function episodeToText(ep: ScriptEpisode): string[] {
  const out: string[] = [`第${cnNum(ep.index)}集` + (ep.title ? `　${cleanEpTitle(ep.title)}` : '')]
  if (ep.hook) out.push(`〔本集钩子〕${ep.hook}`)
  for (const sc of ep.scenes) {
    out.push('')
    out.push(...sceneToText(sc))
  }
  if (ep.cliffhanger) {
    out.push('')
    out.push(`〔本集结尾悬念〕${ep.cliffhanger}`)
  }
  return out
}

/** 把结构化剧本拼成符合短剧交付格式的 Markdown */
export function scriptToMarkdown(s: ScriptResult): string {
  const lines: string[] = []
  lines.push(`# ${s.title}`)
  if (s.genre) lines.push(`类型：${s.genre}`)
  if (s.tags.length) lines.push(`标签：${s.tags.join(' + ')}`)
  if (s.castLine) lines.push(`人设：${s.castLine}`)
  if (s.logline) lines.push(`卖点：${s.logline}`)
  lines.push('')
  if (s.platformTip) {
    lines.push(`平台提示：${s.platformTip}`)
    lines.push('')
  }
  if (s.characters.length) {
    lines.push('## 人物')
    for (const c of s.characters) {
      lines.push(`- **${c.name}**（${c.identity}）${c.subtitle ? `　首次出场字幕：${c.subtitle}` : ''}`)
      lines.push(`  - 说话方式：${c.voice}`)
      lines.push(`  - 外形/服化：${c.look}`)
    }
    lines.push('')
  }
  for (const ep of s.episodes) {
    lines.push(`## 第${cnNum(ep.index)}集　${cleanEpTitle(ep.title)}（约 ${ep.durationSec} 秒）`)
    lines.push('')
    if (ep.hook) lines.push(`> 本集钩子：${ep.hook}`)
    for (const sc of ep.scenes) {
      lines.push('')
      lines.push(...sceneToText(sc))
    }
    if (ep.cliffhanger) {
      lines.push('')
      lines.push(`> 本集结尾悬念：${ep.cliffhanger}`)
    }
    lines.push('')
  }
  if (s.prompts.length) {
    lines.push('## AI 出片提示词')
    for (const p of s.prompts) lines.push(`- **${p.scene}**：${p.prompt}`)
    lines.push('')
  }
  if (s.notes.length) {
    lines.push('## 改编说明')
    for (const n of s.notes) lines.push(`- ${n}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 渲染剧本正文里的一行（△动作 / 台词 / VO / OS / 字幕） */
function ScriptLineView({ l }: { l: ScriptScene['lines'][number] }) {
  if (l.kind === 'beat') return <p className="sl-beat">△{l.text}</p>
  if (l.kind === 'sub') {
    const t = l.text.startsWith('【') || l.text.startsWith('△') ? l.text : `【${l.text}】`
    return <p className="sl-sub">{t}</p>
  }
  if (l.kind === 'vo')
    return (
      <p className="sl-line">
        <span className="sl-spk">{l.speaker}VO</span>
        <span className="sl-colon">：</span>
        {l.text}
      </p>
    )
  if (l.kind === 'os')
    return (
      <p className="sl-line sl-os">
        <span className="sl-spk sl-spk-os">{l.speaker}OS</span>
        <span className="sl-colon">：</span>
        {l.text}
      </p>
    )
  return (
    <p className="sl-line">
      <span className="sl-spk">{l.speaker}</span>
      <span className="sl-colon">：</span>
      {l.emotion && <span className="sl-emo">（{l.emotion}）</span>}
      {l.text}
    </p>
  )
}

/**
 * 短剧剧本：把自己写的正文改写成能直接拍的 AI 短剧剧本。
 * 挂在「创作台」第 4 个 tab（与散稿加工共用同一份原文框）。
 */
export function ScriptStudio({
  text,
  onTextChange,
}: {
  text: string
  onTextChange: (v: string) => void
}) {
  const { state, saveBook } = useApp()
  const [episodes, setEpisodes] = useState(3)
  const [secPerEp, setSecPerEp] = useState(90)
  const [platform, setPlatform] = useState('通用')
  const [styleNote, setStyleNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [result, setResult] = useState<ScriptResult | null>(null)
  /** 结果区当前查看的集：'all' 或集号。生成后默认落在第 1 集 */
  const [activeEp, setActiveEp] = useState<number | 'all'>('all')
  /** 章节阅读器里当前停在哪一章（切「全文」时为 null） */
  const [scopedChapter, setScopedChapter] = useState<TextChapter | null>(null)
  /** 只把当前这一章送去改编 */
  const [onlyChapter, setOnlyChapter] = useState(false)

  const canvases = Object.fromEntries(
    Object.values(state.canvases).map(c => [c.dimension, c.content]),
  ) as Record<string, string>
  const hasCanvas = DIMENSIONS.some(d => (canvases[d] || '').trim())

  /** 实际送去改编的正文 */
  const sourceText = onlyChapter && scopedChapter ? scopedChapter.content : text

  // 切换集数下拉时，若已生成的结果集数不匹配，提示需要重新生成
  const epMismatch = !!result && result.settings.episodes !== episodes

  // 结果换了一份就重置到第 1 集
  useEffect(() => {
    if (result) setActiveEp(result.episodes[0]?.index ?? 'all')
  }, [result])

  const run = async () => {
    const body = sourceText.trim()
    if (!body) {
      setMsg('先贴一段要改编的正文')
      return
    }
    setBusy(true)
    setMsg('')
    try {
      const { data } = await toScriptLLM({
        text: body,
        canvases,
        episodes,
        secPerEp,
        platform,
        styleNote,
      })
      setResult(data)
      setMsg(`✅ 已生成 ${data.episodes.length} 集剧本`)
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const copyMd = async () => {
    if (!result) return
    const md = scriptToMarkdown(result)
    try {
      await navigator.clipboard.writeText(md)
      setMsg('剧本已复制到剪贴板')
    } catch {
      setMsg('复制失败，请手动选中复制')
    }
  }

  const downloadMd = () => {
    if (!result) return
    const md = scriptToMarkdown(result)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${result.title || '短剧剧本'}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const saveToLibrary = () => {
    if (!result) return
    const md = scriptToMarkdown(result)
    const words = md.replace(/\s/g, '').length
    const book: SavedBook = {
      id: `script-${Date.now().toString(36)}`,
      title: `${result.title}（短剧剧本）`,
      synopsis: result.logline || 'AI 短剧剧本',
      outline: result.episodes.map((ep, i) => ({
        index: ep.index || i + 1,
        title: ep.title,
        summary: [ep.hook, ep.cliffhanger].filter(Boolean).join(' / '),
        tag: i === 0 ? '开局' : i === result.episodes.length - 1 ? '收束' : i % 3 === 0 ? '反转' : '推进',
        words: Math.round(words / Math.max(1, result.episodes.length)),
      })),
      sampleChapter: {
        title: `第${cnNum(result.episodes[0]?.index || 1)}集 · ${result.episodes[0]?.title || ''}`,
        content: md,
        beat: result.episodes[0]?.hook || '',
      },
      stats: {
        totalWords: words,
        chapters: result.episodes.length,
        volumes: 1,
        styleLabel: `${result.settings.platform} · ${result.settings.episodes}集 × ${result.settings.secPerEp}秒`,
        anchorSources: [],
      },
      searched: false,
      searchCount: 0,
      usedFallback: false,
      engine: 'deepseek',
      createdAt: new Date().toLocaleString('zh-CN'),
    }
    saveBook(book)
    setMsg('已存入作品库（可在「章节写作」里继续精修）')
  }

  const shown: ScriptEpisode[] =
    !result ? [] : activeEp === 'all' ? result.episodes : result.episodes.filter(e => e.index === activeEp)

  return (
    <div className="script-studio">
      <p className="wb-desc">
        把你写好的正文改写成**符合短剧行业交付格式、可直接开拍**的竖屏 AI 短剧剧本：按「集-场」编号，
        每场标题 + 人物表，正文用 △动作 / 台词 / 括号表演提示 / VO画外音 / OS内心独白 / 【字幕】六种行写。
        会顺带读取 7 块画布的设定。
      </p>

      <div className="script-settings">
        <label className="script-field">
          <span>集数</span>
          <select value={episodes} onChange={e => setEpisodes(Number(e.target.value))}>
            {EP_OPTIONS.map(n => (
              <option key={n} value={n}>
                {n} 集
              </option>
            ))}
          </select>
        </label>
        <label className="script-field">
          <span>单集时长</span>
          <select value={secPerEp} onChange={e => setSecPerEp(Number(e.target.value))}>
            {SEC_OPTIONS.map(n => (
              <option key={n} value={n}>
                {n} 秒
              </option>
            ))}
          </select>
        </label>
        <label className="script-field">
          <span>平台</span>
          <select value={platform} onChange={e => setPlatform(e.target.value)}>
            {PLATFORMS.map(p => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="script-field grow">
          <span>补充要求（可选）</span>
          <input
            placeholder="例：女主台词要更狠；不要旁白；保留结尾反转"
            value={styleNote}
            onChange={e => setStyleNote(e.target.value)}
          />
        </label>
      </div>

      <label className="script-label">要改编的正文</label>
      <ChapterTextReader
        text={text}
        onChange={onTextChange}
        rows={14}
        idPrefix="script"
        placeholder="粘贴你的小说正文、某一章或一段散稿…（在上方「作品」里选书会自动载入；长文会自动按章拆开）"
        onActiveChapterChange={setScopedChapter}
        footer={ch =>
          ch ? (
            <label className="ct-scope">
              <input
                type="checkbox"
                checked={onlyChapter}
                onChange={e => setOnlyChapter(e.target.checked)}
              />
              只改编当前这一章（{ch.title} · {ch.words} 字）
            </label>
          ) : null
        }
      />
      <p className="script-scope-hint">
        将改编：
        {onlyChapter && scopedChapter
          ? `${scopedChapter.title}（${scopedChapter.words} 字）`
          : `全部正文（${text.replace(/\s/g, '').length} 字）`}
      </p>

      <div className="script-actions">
        <button className="primary-btn" onClick={run} disabled={busy || !sourceText.trim()}>
          {busy ? '改编中…（约需 30-60 秒）' : '改编成短剧剧本'}
        </button>
        {result && (
          <>
            <button className="ghost-btn" onClick={copyMd}>
              复制剧本
            </button>
            <button className="ghost-btn" onClick={downloadMd}>
              ⬇️ 下载 .md
            </button>
            <button className="ghost-btn" onClick={saveToLibrary}>
              存入作品库
            </button>
            <button className="ghost-btn" onClick={() => setResult(null)}>
              清空结果
            </button>
          </>
        )}
      </div>
      {msg && <p className={msg.startsWith('❌') ? 'wb-warn' : 'wb-ok'}>{msg}</p>}

      {result && (
        <div className="script-result">
          <h3 className="script-title">
            {result.title}
            <span className="script-badge">
              {result.settings.episodes} 集 × {result.settings.secPerEp} 秒 · {result.settings.platform}
            </span>
          </h3>

          <div className="script-credits">
            {result.genre && (
              <p className="sb-line">
                <span className="sb-key">类型</span>
                {result.genre}
              </p>
            )}
            {result.tags.length > 0 && (
              <p className="sb-line">
                <span className="sb-key">标签</span>
                {result.tags.join(' + ')}
              </p>
            )}
            {result.castLine && (
              <p className="sb-line">
                <span className="sb-key">人设</span>
                {result.castLine}
              </p>
            )}
            {result.logline && (
              <p className="sb-line">
                <span className="sb-key">卖点</span>
                {result.logline}
              </p>
            )}
          </div>
          {result.platformTip && <p className="script-tip">{result.platformTip}</p>}

          {epMismatch && (
            <p className="wb-warn">
              当前剧本是 {result.settings.episodes} 集，你把集数改成了 {episodes} 集 ——
              点上面的「改编成短剧剧本」重新生成才会按新集数重排。
            </p>
          )}

          {result.characters.length > 0 && (
            <section className="script-sec">
              <h4 className="wb-h4">人物</h4>
              <div className="script-cast">
                {result.characters.map((c, i) => (
                  <div key={i} className="script-cast-card">
                    <p className="cast-name">{c.name}</p>
                    <p className="cast-line">身份：{c.identity}</p>
                    <p className="cast-line">说话：{c.voice}</p>
                    <p className="cast-line">外形：{c.look}</p>
                    {c.subtitle && <p className="cast-line">首场字幕：{c.subtitle}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── 集数切换：点哪一集就看哪一集的剧本 ── */}
          <div className="ep-tabs">
            <span className="ep-tabs-label">集数</span>
            {result.episodes.map(ep => (
              <button
                key={ep.index}
                type="button"
                className={`ep-tab ${activeEp === ep.index ? 'on' : ''}`}
                onClick={() => setActiveEp(ep.index)}
                title={ep.hook || ''}
              >
                第{cnNum(ep.index)}集
              </button>
            ))}
            <button
              type="button"
              className={`ep-tab all ${activeEp === 'all' ? 'on' : ''}`}
              onClick={() => setActiveEp('all')}
            >
              全部（{result.episodes.length}）
            </button>
          </div>

          {shown.map(ep => (
            <section key={ep.index} className="script-ep">
              <h4 className="script-ep-title">
                第{cnNum(ep.index)}集　{cleanEpTitle(ep.title)}
                <span className="script-ep-sec">{ep.durationSec}s</span>
              </h4>
              {ep.hook && <p className="script-hook">本集钩子：{ep.hook}</p>}
              {ep.scenes.map((sc, si) => (
                <div key={si} className="sc-block">
                  <p className="sc-head">{scriptSceneHead(sc)}</p>
                  {sc.cast.length > 0 && <p className="sc-castline">人物：{sc.cast.join('、')}</p>}
                  {sc.lines.map((l, li) => (
                    <ScriptLineView key={li} l={l} />
                  ))}
                  {(sc.camera || sc.transition) && (
                    <p className="sc-cam">
                      {sc.camera}
                      {sc.transition ? `　转场：${sc.transition}` : ''}
                    </p>
                  )}
                </div>
              ))}
              {ep.cliffhanger && <p className="script-cliff">本集结尾悬念：{ep.cliffhanger}</p>}
            </section>
          ))}

          {result.prompts.length > 0 && (
            <section className="script-sec">
              <h4 className="wb-h4">AI 出片提示词（可直接喂给生视频 / 生图模型）</h4>
              <ul className="script-prompts">
                {result.prompts.map((p, i) => (
                  <li key={i}>
                    <span className="prompt-scene">{p.scene}</span>
                    <p className="prompt-text">{p.prompt}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.notes.length > 0 && (
            <section className="script-sec">
              <h4 className="wb-h4">改编说明（删了什么 / 为什么这么改）</h4>
              <ul className="script-notes">
                {result.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
