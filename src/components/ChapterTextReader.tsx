import { useEffect, useMemo, useRef, useState } from 'react'
import { replaceChapter, splitChapters, type TextChapter } from '../lib/textChapters'

/**
 * 长正文阅读器：把一整份原文按章节拆开看/改，避免几千字挤在一个框里读。
 *
 * - 能识别「第一章 / 第 3 节 / Chapter 2 / ## 标题 / 卷一」等标题
 * - 识别不到标题时按段落自动分块
 * - 文本很短（< 900 字）时不显示章节条，退化成普通文本框
 * - 在某一章里编辑只把该章写回全文，其余部分原样不动
 * - 想看整篇时切「全文」
 *
 * 受控组件：`text` / `onChange` 对应整份原文。
 */
export function ChapterTextReader({
  text,
  onChange,
  placeholder,
  rows = 14,
  idPrefix = 'ct',
  onActiveChapterChange,
  footer,
}: {
  text: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  /** 用于生成唯一 input id，同一页面可能有多个阅读器 */
  idPrefix?: string
  /** 当前正在看哪一章（切「全文」时回调 null） */
  onActiveChapterChange?: (ch: TextChapter | null) => void
  /** 正文框下方的附加内容，参数是当前章 */
  footer?: (ch: TextChapter | null) => React.ReactNode
}) {
  const chapters = useMemo(() => splitChapters(text), [text])
  const [activeIdx, setActiveIdx] = useState(0)
  const [viewAll, setViewAll] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const locked = chapters.length <= 1
  const idx = Math.min(activeIdx, Math.max(0, chapters.length - 1))
  const cur: TextChapter | null = chapters.length ? chapters[idx] : null
  const active: TextChapter | null = locked || viewAll ? null : cur

  // 章节数变化（换书 / 载入新文 / AI 改写全文）时把下标拉回合法范围
  useEffect(() => {
    if (activeIdx > chapters.length - 1) setActiveIdx(Math.max(0, chapters.length - 1))
  }, [chapters.length, activeIdx])

  useEffect(() => {
    onActiveChapterChange?.(active)
    // active 由 chapters / viewAll 派生，这里只需要跟随它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.index, active?.start, active?.end, viewAll, locked])

  const value = locked || viewAll ? text : cur?.content ?? ''
  const totalWords = chapters.reduce((a, c) => a + c.words, 0)

  const handleEdit = (v: string) => {
    if (locked || viewAll || !cur) onChange(v)
    else onChange(replaceChapter(text, cur, v))
  }

  const pickChapter = (i: number) => {
    setViewAll(false)
    setActiveIdx(i)
    // 切章后把光标放到开头，避免停在上一章的位置
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) {
        ta.scrollTop = 0
        ta.selectionStart = 0
        ta.selectionEnd = 0
      }
    })
  }

  return (
    <div className="ct-reader">
      {!locked && (
        <div className="ct-bar">
          <span className="ct-count">
            共 <b>{chapters.length}</b> {chapters[0]?.detected ? '章' : '段'} · {totalWords} 字
          </span>
          <div className="ct-chapters">
            {chapters.map(c => (
              <button
                key={c.index}
                type="button"
                className={`ct-chip ${!viewAll && idx === c.index ? 'on' : ''}`}
                onClick={() => pickChapter(c.index)}
                title={`${c.title}（${c.words} 字）`}
              >
                <span className="ct-chip-no">{c.index + 1}</span>
                <span className="ct-chip-name">{c.title}</span>
              </button>
            ))}
            <button
              type="button"
              className={`ct-chip all ${viewAll ? 'on' : ''}`}
              onClick={() => setViewAll(v => !v)}
              title="看 / 改整篇原文"
            >
              全文
            </button>
          </div>
        </div>
      )}

      {/* 没识别到标题时说明白：这些「片段」是按字数切的，不是书的章节 —— 否则很容易以为
          自己「写好了两章」，回头在章节写作里看到全是「待写」就懵了 */}
      {!locked && !chapters[0]?.detected && (
        <p className="ct-warn">
          这段文本里没识别到「第一章 / 第 3 节」这类标题，下面这些是按段落自动切的
          <b>片段</b>，不是书的章节，也不会自动变成「已写」。
        </p>
      )}

      {!locked && !viewAll && cur && (
        <div className="ct-now">
          <span className="ct-now-title">{cur.title}</span>
          <span className="ct-now-words">{cur.words} 字</span>
          <span className="ct-now-tip">只显示这一章 · 点右侧「全文」看整篇</span>
          <span className="ct-now-nav">
            <button
              type="button"
              className="ghost-btn sm"
              disabled={idx === 0}
              onClick={() => pickChapter(idx - 1)}
            >
              ← 上一章
            </button>
            <button
              type="button"
              className="ghost-btn sm"
              disabled={idx >= chapters.length - 1}
              onClick={() => pickChapter(idx + 1)}
            >
              下一章 →
            </button>
          </span>
        </div>
      )}

      <textarea
        ref={taRef}
        id={`${idPrefix}-textarea`}
        className="wb-textarea ct-textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={e => handleEdit(e.target.value)}
      />

      {footer?.(active)}
    </div>
  )
}
