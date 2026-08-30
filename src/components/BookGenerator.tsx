import { useState } from 'react'
import { useApp } from '../store/AppContext'
import { generateBook, type GeneratedBook } from '../data/bookGenerator'

export function BookGenerator() {
  const { state, listCanvases } = useApp()
  const [state_, setState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [book, setBook] = useState<GeneratedBook | null>(null)
  const [open, setOpen] = useState(false)

  const handleGenerate = async () => {
    setState('loading')
    setOpen(true)
    setBook(null)
    await new Promise(r => setTimeout(r, 1200)) // 模拟 AI 合成耗时
    const result = generateBook(listCanvases())
    setBook(result)
    setState('done')
  }

  const close = () => {
    setOpen(false)
    setState('idle')
  }

  // 只读访客模式仍可生成（生成结果不写回画布）
  const filled = listCanvases().filter(c => c.content.trim().length > 0).length

  return (
    <>
      <button
        className="gen-btn"
        onClick={handleGenerate}
        disabled={state_ === 'loading'}
        title="根据 7 块画布的内容合成一本书"
      >
        {state_ === 'loading' ? '合成中…' : '📖 生成文本'}
      </button>

      {open && (
        <div className="modal-mask" onClick={close}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <header className="modal-head">
              <div>
                <h2>AI 合成结果</h2>
                <p className="modal-sub">
                  依据 {filled} 块有内容的画布 · {state.mode === 'read' ? '只读访客' : '管理后台'}
                </p>
              </div>
              <div className="modal-actions">
                <button className="ghost-btn" onClick={handleGenerate} disabled={state_ === 'loading'}>
                  {state_ === 'loading' ? '合成中…' : '重新生成'}
                </button>
                <button className="ghost-btn" onClick={close}>
                  关闭
                </button>
              </div>
            </header>

            <div className="modal-body">
              {state_ === 'loading' && <p className="gen-loading">正在读取画布 → 合并约束 → 合成正文…</p>}

              {state_ === 'done' && book && (
                <>
                  <section className="gen-block">
                    <h3 className="gen-h3">书名</h3>
                    <p className="gen-title">《{book.title}》</p>
                  </section>

                  <section className="gen-block">
                    <h3 className="gen-h3">简介</h3>
                    <p className="gen-synopsis">{book.synopsis}</p>
                  </section>

                  <section className="gen-block">
                    <h3 className="gen-h3">规格</h3>
                    <div className="gen-chips">
                      <span className="chip">{book.stats.volumes} 卷</span>
                      <span className="chip">{book.stats.chapters} 章</span>
                      <span className="chip">约 {(book.stats.totalWords / 10000).toFixed(1)} 万字</span>
                      <span className="chip chip-accent">文笔：{book.stats.styleLabel}</span>
                      {book.stats.anchorSources.length > 0 && (
                        <span className="chip chip-teal">
                          参考锚点：{book.stats.anchorSources.join('、')}
                        </span>
                      )}
                    </div>
                  </section>

                  <section className="gen-block">
                    <h3 className="gen-h3">章节大纲</h3>
                    <div className="gen-outline">
                      {book.outline.map(ch => (
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
                    <h3 className="gen-h3">{book.sampleChapter.title}</h3>
                    <div className="gen-prose">
                      {book.sampleChapter.content.split('\n\n').map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                    </div>
                    {book.sampleChapter.beat && (
                      <p className="gen-beat">情节依据：{book.sampleChapter.beat}</p>
                    )}
                  </section>

                  <p className="gen-meta">生成于 {book.generatedAt}</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
