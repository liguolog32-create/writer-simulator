import { useMemo, useRef, useState } from 'react'
import { useApp } from '../store/AppContext'
import { writeChapter } from '../lib/llmClient'
import { PURPOSE_OPTIONS, purposeLabel, type ChapterPurpose, type ChapterWriting } from '../types'

type Settings = ChapterWriting['settings']

const DEFAULT_SETTINGS: Settings = {
  targetWords: 2000,
  style: '',
  purpose: 'main-plot',
  extraRequirements: '',
}

/** 一键精写时：按 outline tag 自动决定本章「文章目的」 */
const BATCH_TAG_PURPOSE: Record<string, ChapterPurpose> = {
  开局: 'pure-scene',
  推进: 'main-plot',
  高潮: 'reveal',
  反转: 'reveal',
  收束: 'ending',
}

export function ChapterWriter() {
  const { state, listCanvases, updateChapter } = useApp()
  const [bookId, setBookId] = useState<string>('')
  const [chapterIdx, setChapterIdx] = useState<number>(0)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [draftSettings, setDraftSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [writing, setWriting] = useState(false)
  const [info, setInfo] = useState('')
  const [output, setOutput] = useState<{ content: string; rationale: string } | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  // 一键精写全书：进度与取消控制
  const [batch, setBatch] = useState<{
    running: boolean
    current: number
    total: number
    currentTitle: string
    done: number
    errors: number
    skipped: number
    finished: boolean
  }>({ running: false, current: 0, total: 0, currentTitle: '', done: 0, errors: 0, skipped: 0, finished: false })
  const cancelRef = useRef(false)

  const book = useMemo(
    () => state.library.find(b => b.id === bookId) ?? null,
    [bookId, state.library],
  )
  const chapter = book?.outline[chapterIdx] ?? null
  const existing = book?.chapterWritings?.[chapterIdx] ?? null

  // 进入章节时把已有 settings 载入草稿（如果存在）
  const loadChapter = (idx: number) => {
    setChapterIdx(idx)
    setOutput(null)
    setInfo('')
    setSavedFlash(false)
    const w = book?.chapterWritings?.[idx]
    if (w) {
      setDraftSettings(w.settings)
      setOutput({ content: w.content, rationale: '（这是已保存的版本，可直接重写）' })
    } else {
      setDraftSettings(DEFAULT_SETTINGS)
    }
  }

  // 切换书时重置章节索引
  const pickBook = (id: string) => {
    setBookId(id)
    setChapterIdx(0)
    setOutput(null)
    setInfo('')
    setSavedFlash(false)
    const b = state.library.find(x => x.id === id)
    if (b && b.outline[0]) {
      const w0 = b.chapterWritings?.[0]
      setDraftSettings(w0?.settings ?? DEFAULT_SETTINGS)
      if (w0) setOutput({ content: w0.content, rationale: '（已保存）' })
    } else {
      setDraftSettings(DEFAULT_SETTINGS)
    }
  }

  const goRel = (delta: number) => {
    if (!book) return
    const next = chapterIdx + delta
    if (next < 0 || next >= book.outline.length) return
    loadChapter(next)
  }

  const handleWrite = async () => {
    if (!book || !chapter) return
    setWriting(true)
    setInfo('')
    setSavedFlash(false)
    try {
      const canvasesMap: Record<string, string> = {}
      listCanvases().forEach(c => { canvasesMap[c.dimension] = c.content })

      // 已写前 N-1 章（按章节索引顺序）
      const previousChapters: Array<{ title: string; content: string }> = []
      for (let i = 0; i < chapterIdx; i++) {
        const cw = book.chapterWritings?.[i + 1] // 注意：outline 是 0-based，chapterWritings key 是 1-based
        if (cw) previousChapters.push({ title: book.outline[i].title, content: cw.content })
        // 已有大纲摘要作为占位（前文没写过时告诉 AI）
        else previousChapters.push({ title: book.outline[i].title, content: `（本章尚未精写）${book.outline[i].summary}` })
      }

      const { data, searched, searchCount } = await writeChapter({
        bookTitle: book.title,
        chapterIndex: chapterIdx + 1,
        chapterTitle: chapter.title,
        chapterSummary: chapter.summary,
        settings: draftSettings,
        previousChapters,
        canvases: canvasesMap,
      })
      setOutput(data)
      setSettings(draftSettings)
      setInfo(searched ? `🌐 联网检索 ${searchCount} 次` : '（未触发联网检索）')
    } catch (e) {
      setInfo(`❌ 精写失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setWriting(false)
  }

  const handleSave = () => {
    if (!book || !output || !chapter) return
    const writing: ChapterWriting = {
      content: output.content,
      settings: draftSettings,
      generatedAt: new Date().toLocaleString('zh-CN'),
      wordCount: output.content.length,
    }
    updateChapter(book.id, chapterIdx + 1, writing)
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1800)
  }

  /** 一键精写全书：依次调用 writeChapter，purpose 按 outline tag 自动选 */
  const handleBatchWrite = async (force = false) => {
    if (!book) return
    const total = book.outline.length
    const already = Object.keys(book.chapterWritings ?? {}).length
    const todo = force ? total : total - already

    if (todo === 0) {
      window.confirm(`全部 ${total} 章都已精写。要覆盖重写吗？点击"确定"继续。`)
      if (!window.confirm('再次确认：将丢弃现有所有章节精写，从头重写。')) return
    } else {
      const minutes = Math.ceil((todo * draftSettings.targetWords) / 1500)
      if (!window.confirm(
        `将依次精写 ${todo} 章${already > 0 && !force ? `（跳过 ${already} 章已精写）` : ''}。\n` +
        `按当前设置（${draftSettings.targetWords} 字/章），预计需要 ${minutes}–${minutes * 2} 分钟。\n` +
        `可中途取消，已完成部分会保留。\n\n确定开始？`,
      )) return
    }

    cancelRef.current = false
    setBatch({
      running: true,
      current: 0,
      total,
      currentTitle: '',
      done: 0,
      errors: 0,
      skipped: 0,
      finished: false,
    })

    const canvasesMap: Record<string, string> = {}
    listCanvases().forEach(c => { canvasesMap[c.dimension] = c.content })

    for (let i = 0; i < total; i++) {
      if (cancelRef.current) break
      const ch = book.outline[i]
      const chKey = i + 1

      // 跳过已精写（非 force 模式）
      if (!force && book.chapterWritings?.[chKey]) {
        setBatch(b => ({ ...b, skipped: b.skipped + 1, current: chKey, currentTitle: ch.title + '（已跳过）' }))
        await new Promise(r => setTimeout(r, 80))
        continue
      }

      setBatch(b => ({ ...b, current: chKey, currentTitle: ch.title }))

      // 拼装前 N-1 章正文（已精写用精写内容，否则用大纲占位）
      const previousChapters: Array<{ title: string; content: string }> = []
      for (let j = 0; j < i; j++) {
        const w = book.chapterWritings?.[j + 1]
        if (w) previousChapters.push({ title: book.outline[j].title, content: w.content })
        else previousChapters.push({
          title: book.outline[j].title,
          content: `（本章尚未精写）${book.outline[j].summary}`,
        })
      }

      // 按 tag 自动选 purpose
      const chapterSettings: Settings = { ...draftSettings, purpose: BATCH_TAG_PURPOSE[ch.tag] ?? 'main-plot' }

      try {
        const { data } = await writeChapter({
          bookTitle: book.title,
          chapterIndex: chKey,
          chapterTitle: ch.title,
          chapterSummary: ch.summary,
          settings: chapterSettings,
          previousChapters,
          canvases: canvasesMap,
        })
        const writing: ChapterWriting = {
          content: data.content,
          settings: chapterSettings,
          generatedAt: new Date().toLocaleString('zh-CN'),
          wordCount: data.content.length,
        }
        updateChapter(book.id, chKey, writing)
        setBatch(b => ({ ...b, done: b.done + 1 }))
      } catch (e) {
        setBatch(b => ({ ...b, errors: b.errors + 1 }))
        console.error(`第 ${chKey} 章精写失败:`, e)
      }
    }

    setBatch(b => ({ ...b, running: false, finished: true }))
  }

  const cancelBatch = () => {
    cancelRef.current = true
  }

  if (state.library.length === 0) {
    return (
      <div className="workbench">
        <p className="gen-loading">
          资产库还没有作品。先去「多画布 · 合成新书」tab 生成一本，或在「工作台」里从已有文本拆解填画布然后生成。
        </p>
      </div>
    )
  }

  return (
    <div className="workbench">
      {/* 1. 选书 + 选章节 */}
      <section className="wb-block">
        <h3 className="wb-h3">1. 选书与章节</h3>
        <div className="wb-row">
          <select className="wb-select" value={bookId} onChange={e => pickBook(e.target.value)}>
            <option value="">— 从资产库选择 —</option>
            {state.library.map(b => (
              <option key={b.id} value={b.id}>《{b.title}》 · {b.createdAt}</option>
            ))}
          </select>
        </div>
        {book && (
          <>
            <p className="wb-desc">
              共 {book.outline.length} 章。
              {Object.keys(book.chapterWritings ?? {}).length > 0 &&
                `已精写 ${Object.keys(book.chapterWritings ?? {}).length} 章。`}
            </p>
            <div className="cw-chapter-list">
              {book.outline.map((c, i) => {
                const w = book.chapterWritings?.[i + 1]
                return (
                  <button
                    key={i}
                    className={`cw-chap-btn ${i === chapterIdx ? 'active' : ''} ${w ? 'done' : ''}`}
                    onClick={() => loadChapter(i)}
                    title={c.summary}
                  >
                    <span className="cw-chap-idx">第 {i + 1} 章</span>
                    <span className="cw-chap-title">{c.title}</span>
                    <span className={`tag tag-${c.tag}`} style={{ fontSize: 10, padding: '0 4px' }}>{c.tag}</span>
                    {w && <span className="cw-chap-mark">✓</span>}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </section>

      {book && chapter && (
        <>
          {/* 2. 4 维设置 */}
          <section className="wb-block">
            <h3 className="wb-h3">2. 本章设置（4 维）</h3>
            <div className="cw-settings">
              <label className="cw-field">
                <span className="cw-label">① 文本规模</span>
                <div className="cw-words">
                  <input
                    type="range"
                    min={500}
                    max={10000}
                    step={100}
                    value={draftSettings.targetWords}
                    onChange={e => setDraftSettings(s => ({ ...s, targetWords: Number(e.target.value) }))}
                  />
                  <input
                    type="number"
                    className="cw-num"
                    min={300}
                    max={15000}
                    value={draftSettings.targetWords}
                    onChange={e => setDraftSettings(s => ({ ...s, targetWords: Math.max(300, Number(e.target.value) || 2000) }))}
                  />
                  <span className="cw-unit">字</span>
                </div>
              </label>

              <label className="cw-field">
                <span className="cw-label">② 文笔风格</span>
                <input
                  type="text"
                  className="cw-input"
                  placeholder="留空则继承【文笔】画布设定"
                  value={draftSettings.style}
                  onChange={e => setDraftSettings(s => ({ ...s, style: e.target.value }))}
                />
              </label>

              <label className="cw-field">
                <span className="cw-label">③ 文章目的</span>
                <div className="cw-purposes">
                  {PURPOSE_OPTIONS.map(o => (
                    <button
                      key={o.value}
                      type="button"
                      className={`cw-purp ${draftSettings.purpose === o.value ? 'active' : ''}`}
                      onClick={() => setDraftSettings(s => ({ ...s, purpose: o.value as ChapterPurpose }))}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </label>

              <label className="cw-field">
                <span className="cw-label">④ 其他要求</span>
                <textarea
                  className="cw-textarea"
                  rows={3}
                  placeholder="任意补充要求：例如『增加一段女主回忆』『结尾留悬念』『多写动作少写心理』…"
                  value={draftSettings.extraRequirements}
                  onChange={e => setDraftSettings(s => ({ ...s, extraRequirements: e.target.value }))}
                />
              </label>
            </div>

            <div className="cw-actions">
              <button
                className="primary-btn"
                onClick={handleWrite}
                disabled={writing || batch.running}
              >
                {writing ? '精写中…' : existing ? '🔁 重新精写本章' : '✍️ 精写本章'}
              </button>
              {!batch.running ? (
                <button
                  className="ghost-btn cw-batch-btn"
                  onClick={() => handleBatchWrite(false)}
                  title="按 outline tag 自动选「文章目的」，逐章生成，已精写的会跳过"
                >
                  🚀 一键精写全书
                </button>
              ) : (
                <button className="ghost-btn cw-batch-btn" onClick={cancelBatch}>
                  ✖ 取消
                </button>
              )}
              <button className="ghost-btn" onClick={() => goRel(-1)} disabled={chapterIdx === 0}>
                ← 上一章
              </button>
              <button className="ghost-btn" onClick={() => goRel(1)} disabled={chapterIdx === book.outline.length - 1}>
                下一章 →
              </button>
              <button
                className="ghost-btn cw-save-btn"
                onClick={handleSave}
                disabled={!output}
                title={output ? '存入此章并刷新资产库时间' : '先生成本章才能保存'}
              >
                {savedFlash ? '✓ 已保存到本书' : '💾 存入此章'}
              </button>
            </div>
            {info && (
              <p className={info.startsWith('❌') ? 'wb-warn' : 'wb-ok'} style={{ marginTop: 12 }}>{info}</p>
            )}
            {batch.running && (
              <div className="cw-batch-progress">
                <div className="cw-batch-head">
                  <span>🚀 正在精写全书</span>
                  <span>第 {batch.current}/{batch.total} 章 · {batch.currentTitle}</span>
                </div>
                <div className="cw-batch-bar">
                  <div
                    className="cw-batch-bar-fill"
                    style={{ width: `${(batch.current / batch.total) * 100}%` }}
                  />
                </div>
                <div className="cw-batch-stats">
                  <span className="cw-batch-stat done">✓ 完成 {batch.done}</span>
                  <span className="cw-batch-stat skip">⏭ 跳过 {batch.skipped}</span>
                  {batch.errors > 0 && <span className="cw-batch-stat err">✗ 失败 {batch.errors}</span>}
                </div>
              </div>
            )}
            {batch.finished && !batch.running && (
              <p className="wb-ok" style={{ marginTop: 12 }}>
                ✅ 批量精写完成：完成 {batch.done} · 跳过 {batch.skipped} · 失败 {batch.errors}
                （失败的可单独点章节重试）
              </p>
            )}
          </section>

          {/* 3. 已写前文摘要 */}
          {chapterIdx > 0 && (
            <section className="wb-block">
              <h3 className="wb-h3">3. AI 已知的前文（{chapterIdx} 章）</h3>
              <div className="cw-prev-list">
                {book.outline.slice(0, chapterIdx).map((c, i) => {
                  const w = book.chapterWritings?.[i + 1]
                  return (
                    <div key={i} className="cw-prev-row">
                      <span className="cw-prev-idx">第 {i + 1} 章 《{c.title}》</span>
                      <span className="cw-prev-state">
                        {w ? `已精写 · ${w.wordCount} 字` : `仅大纲 · ${c.summary.slice(0, 30)}…`}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* 4. 正文 */}
          {output && (
            <section className="wb-block">
              <h3 className="wb-h3">4. 本章正文（第 {chapterIdx + 1} 章 · {output.content.length} 字）</h3>
              {output.rationale && (
                <p className="gen-beat">写作思路：{output.rationale}</p>
              )}
              <div className="gen-prose">
                {output.content.split('\n\n').map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
