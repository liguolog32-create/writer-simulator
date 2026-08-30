import { useState } from 'react'
import { useApp } from '../store/AppContext'
import { generateBook, type GeneratedBook } from '../data/bookGenerator'
import { generateBookLLM } from '../lib/llmClient'

export function BookGenerator() {
  const { state, listCanvases, saveBook } = useApp()
  const [state_, setState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [book, setBook] = useState<GeneratedBook | null>(null)
  const [open, setOpen] = useState(false)
  const [usedFallback, setUsedFallback] = useState(false)
  const [searchInfo, setSearchInfo] = useState('')
  const [fallbackReason, setFallbackReason] = useState('')

  /** 把本次结果存档进作品库 */
  const saveToLibrary = (
    result: GeneratedBook,
    opts: { usedFallback: boolean; searched: boolean; searchCount: number },
  ) => {
    saveBook({
      ...result,
      id: `book-${Date.now()}`,
      searched: opts.searched,
      searchCount: opts.searchCount,
      usedFallback: opts.usedFallback,
      engine: opts.usedFallback ? 'local' : 'deepseek',
      createdAt: new Date().toLocaleString('zh-CN'),
    })
  }

  const handleGenerate = async () => {
    setState('loading')
    setOpen(true)
    setBook(null)
    setUsedFallback(false)
    setSearchInfo('')
    setFallbackReason('')

    // 把画布转成 Worker 期望的 { 维度名: 内容 } 形式
    const canvasesForLLM: Record<string, string> = {}
    listCanvases().forEach(c => { canvasesForLLM[c.dimension] = c.content })

    try {
      const { data: llm, searched, searchCount } = await generateBookLLM(canvasesForLLM)
      setSearchInfo(
        searched ? `🌐 已联网检索 ${searchCount} 次` : '（本次未触发联网检索，模型依据画布与已有知识创作）',
      )
      const produced: GeneratedBook = {
        ...llm,
        generatedAt: new Date().toLocaleString('zh-CN'),
      }
      setBook(produced)
      saveToLibrary(produced, { usedFallback: false, searched, searchCount })
    } catch (e) {
      // LLM 失败 → 兜底用本地确定性生成（demo 不会挂），但把具体原因也显示出来
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('LLM 生成失败，回退到本地生成器：', e)
      setUsedFallback(true)
      setFallbackReason(reason || '未知错误')
      const produced = generateBook(listCanvases())
      setBook(produced)
      // 兜底产物也存档，但标记为未联网，用户回看时知道这份不靠谱
      saveToLibrary(produced, { usedFallback: true, searched: false, searchCount: 0 })
    }
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
        {state_ === 'loading' ? 'AI 创作中…' : '📖 生成文本'}
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
                  {state_ === 'loading' ? 'AI 创作中…' : '重新生成'}
                </button>
                <button className="ghost-btn" onClick={close}>
                  关闭
                </button>
              </div>
            </header>

            <div className="modal-body">
              {state_ === 'loading' && <p className="gen-loading">正在读取 7 块画布 → DeepSeek 联网检索 + 创作 → 渲染结果（联网搜索模式下最长约 2 分钟）…</p>}

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
                      {searchInfo && <span className="chip chip-teal">{searchInfo}</span>}
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

                  {usedFallback && (
                    <p className="gen-fallback">
                      ⚠️ DeepSeek 调用失败，本次使用本地兜底生成器（模板确定性，结果不联网）。
                      {fallbackReason && (
                        <span className="gen-fallback-reason">原因：{fallbackReason}</span>
                      )}
                    </p>
                  )}
                  {searchInfo && <p className="gen-searchinfo">{searchInfo}</p>}
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
