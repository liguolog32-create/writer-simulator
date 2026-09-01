import { useState } from 'react'
import { useApp } from '../store/AppContext'
import type { SavedBook } from '../types'

export function BookShelf() {
  const { state, removeBook, clearLibrary } = useApp()
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  // 排序：最近修改/创建的排最前（让"刚精修过"的书浮上来）
  const library = [...state.library].sort((a, b) => {
    const ta = a.updatedAt ?? a.createdAt
    const tb = b.updatedAt ?? b.createdAt
    return tb.localeCompare(ta)
  })
  const active = library.find(b => b.id === activeId) ?? null

  const displayTime = (b: SavedBook) => b.updatedAt ?? b.createdAt
  const isUpdated = (b: SavedBook) =>
    Boolean(b.updatedAt) && b.updatedAt !== b.createdAt
  const writtenCount = (b: SavedBook) =>
    Object.keys(b.chapterWritings ?? {}).length

  const closeAll = () => {
    setOpen(false)
    setActiveId(null)
    setConfirmClear(false)
  }

  return (
    <>
      <button
        className="gen-btn shelf-btn"
        onClick={() => setOpen(true)}
        title="查看历次生成的作品"
      >
        📚 作品库{library.length > 0 && ` (${library.length})`}
      </button>

      {open && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal shelf-modal" onClick={e => e.stopPropagation()}>
            <header className="modal-head">
              <div>
                <h2>我的作品库</h2>
                <p className="modal-sub">
                  共 {library.length} 本 · 存于本浏览器（localStorage），换设备不同步
                </p>
              </div>
              <div className="modal-actions">
                {library.length > 0 && (
                  confirmClear ? (
                    <>
                      <button
                        className="ghost-btn danger"
                        onClick={() => { clearLibrary(); setConfirmClear(false) }}
                      >
                        确认清空
                      </button>
                      <button className="ghost-btn" onClick={() => setConfirmClear(false)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button className="ghost-btn" onClick={() => setConfirmClear(true)}>
                      清空
                    </button>
                  )
                )}
                <button className="ghost-btn" onClick={closeAll}>关闭</button>
              </div>
            </header>

            <div className="modal-body">
              {library.length === 0 ? (
                <p className="gen-loading">
                  还没有作品。去右上角点「📖 生成文本」，AI 合成的书会自动存进这里。
                </p>
              ) : (
                <div className="shelf-grid">
                  {library.map(b => (
                    <article key={b.id} className="shelf-card">
                      <header className="shelf-card-head">
                        <h3 className="shelf-title">《{b.title}》</h3>
                        <button
                          className="shelf-del"
                          onClick={() => removeBook(b.id)}
                          title="删除这本"
                        >
                          ×
                        </button>
                      </header>
                      <p className="shelf-meta">
                        {b.stats.volumes} 卷 · {b.stats.chapters} 章 · 约{' '}
                        {(b.stats.totalWords / 10000).toFixed(1)} 万字
                      </p>
                      <p className="shelf-meta">
                        {displayTime(b)}
                        {isUpdated(b) && <span className="shelf-updated"> · 已更新</span>}
                      </p>
                      <div className="shelf-tags">
                        <span className={`chip ${b.usedFallback ? '' : 'chip-teal'}`}>
                          {b.usedFallback ? '本地兜底' : `🌐 联网 ${b.searchCount} 次`}
                        </span>
                        {writtenCount(b) > 0 ? (
                          <span className="chip chip-accent">
                            已精写 {writtenCount(b)}/{b.stats.chapters} 章
                          </span>
                        ) : (
                          <span className="chip chip-accent">{b.stats.styleLabel}</span>
                        )}
                      </div>
                      <p className="shelf-synopsis">{b.synopsis.slice(0, 80)}{b.synopsis.length > 80 ? '…' : ''}</p>
                      <button className="ghost-btn" onClick={() => setActiveId(b.id)}>
                        查看详情
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {active && (
        <div className="modal-mask" onClick={() => setActiveId(null)}>
          <div className="modal shelf-modal" onClick={e => e.stopPropagation()}>
            <header className="modal-head">
              <div>
                <h2>《{active.title}》</h2>
                <p className="modal-sub">{active.createdAt}</p>
              </div>
              <div className="modal-actions">
                <button className="ghost-btn" onClick={() => exportBook(active)}>
                  导出 Markdown
                </button>
                <button className="ghost-btn" onClick={() => setActiveId(null)}>
                  关闭
                </button>
              </div>
            </header>
            <div className="modal-body">
              <section className="gen-block">
                <h3 className="gen-h3">规格</h3>
                <div className="gen-chips">
                  <span className="chip">{active.stats.volumes} 卷</span>
                  <span className="chip">{active.stats.chapters} 章</span>
                  <span className="chip">约 {(active.stats.totalWords / 10000).toFixed(1)} 万字</span>
                  <span className="chip chip-accent">文笔：{active.stats.styleLabel}</span>
                  <span className={`chip ${active.usedFallback ? '' : 'chip-teal'}`}>
                    {active.usedFallback ? '本地兜底生成' : `🌐 联网检索 ${active.searchCount} 次`}
                  </span>
                </div>
              </section>

              <section className="gen-block">
                <h3 className="gen-h3">简介</h3>
                <p className="gen-synopsis">{active.synopsis}</p>
              </section>

              <section className="gen-block">
                <h3 className="gen-h3">章节大纲</h3>
                <div className="gen-outline">
                  {active.outline.map(ch => (
                    <div key={ch.index} className="outline-row">
                      <span className={`tag tag-${ch.tag}`}>{ch.tag}</span>
                      <span className="outline-idx">第 {ch.index} 章</span>
                      <span className="outline-title">{ch.title}</span>
                      <span className="outline-sum">{ch.summary}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="gen-block">
                <h3 className="gen-h3">{active.sampleChapter.title}</h3>
                <div className="gen-prose">
                  {active.sampleChapter.content.split('\n\n').map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
                {active.sampleChapter.beat && (
                  <p className="gen-beat">情节依据：{active.sampleChapter.beat}</p>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** 导出成 Markdown 文件下载 */
function exportBook(b: SavedBook) {
  const lines: string[] = []
  lines.push(`# ${b.title}`, '')
  lines.push(`> 生成时间：${b.createdAt}`, '')
  lines.push(
    `> 规格：${b.stats.volumes} 卷 / ${b.stats.chapters} 章 / 约 ${(b.stats.totalWords / 10000).toFixed(1)} 万字 / 文笔：${b.stats.styleLabel}`,
  )
  lines.push('')
  lines.push(
    `> 生成方式：${b.usedFallback ? '本地兜底生成器（未联网）' : `DeepSeek 联网检索 ${b.searchCount} 次`}`,
    '',
  )
  lines.push('## 简介', '', b.synopsis, '')
  lines.push('## 章节大纲', '')
  b.outline.forEach(ch => {
    lines.push(`**${ch.index}. [${ch.tag}] ${ch.title}**`, '')
    lines.push(`${ch.summary}`, '')
  })
  lines.push('## ' + b.sampleChapter.title, '')
  b.sampleChapter.content.split('\n\n').forEach(p => lines.push(p, ''))
  if (b.sampleChapter.beat) lines.push(`> 情节依据：${b.sampleChapter.beat}`, '')

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${b.title}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
