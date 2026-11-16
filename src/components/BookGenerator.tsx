import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../store/AppContext'
import type { LLMEngine } from '../config'
import { generateBook, type GeneratedBook } from '../data/bookGenerator'
import {
  generateBookLLMStream,
  type GeneratedBookLLM,
  type DirectionBrief,
  calibrateText,
  type CalibrateResult,
} from '../lib/llmClient'
import { Icon } from './Icon'

/**
 * 整本书生成器（读 7 块画布 → 书名/简介/大纲/样章 → 自动存入作品库）。
 *
 * v10.15：顶栏那个「📖 生成文本」入口已下线（与「📚 作品库」挤在一起，
 * 新手容易误点后干等）。生成入口收进工作区，按位置渲染成两种形态：
 *   variant="inline"  创作台「作品」行的小按钮（默认）：没书可选时当场造一本
 *   variant="cta"     多画布页顶部的横幅按钮：先把画布填好，再一键合成
 */
export function BookGenerator({
  variant = 'inline',
  /** v10.43 ENTRY-01：生成/回退完成后，给用户一个「去写作」的出口 */
  onGoWrite,
}: {
  variant?: 'inline' | 'cta'
  onGoWrite?: () => void
}) {
  const { listCanvases, saveBook } = useApp()
  /** v10.71：只保留 DeepSeek 一条通道，用户不再选引擎 */
  const [engineUsed, setEngineUsed] = useState<LLMEngine>('cloud')
  const [state_, setState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [book, setBook] = useState<GeneratedBook | null>(null)
  const [open, setOpen] = useState(false)
  const [usedFallback, setUsedFallback] = useState(false)
  const [searchInfo, setSearchInfo] = useState('')
  const [fallbackReason, setFallbackReason] = useState('')
  /** 流式阶段：idle → plan(大纲已出) → chapter(样章已出) → done */
  const [streamPhase, setStreamPhase] = useState<'idle' | 'plan' | 'chapter' | 'done'>('idle')
  /** 生成已用时（秒）：让等待有「在动」的反馈，避免看起来像卡死 */
  const [elapsed, setElapsed] = useState(0)
  /** 用户写的「方向意图」：喂给方向导演层，让生成方向更精准 */
  const [directionIntent, setDirectionIntent] = useState('')
  /** 本次生成用的「方向指令书」（导演层产出） */
  const [brief, setBrief] = useState<DirectionBrief | null>(null)
  /** 校准自检结果 */
  const [cali, setCali] = useState<CalibrateResult | null>(null)
  const [calibrating, setCalibrating] = useState(false)

  useEffect(() => {
    if (state_ !== 'loading') return
    setElapsed(0)
    const timer = setInterval(() => setElapsed(s => s + 1), 1000)
    return () => clearInterval(timer)
  }, [state_])

  /** 把本次结果存档进作品库 */
  const saveToLibrary = (
    result: GeneratedBook,
    opts: { usedFallback: boolean; searched: boolean; searchCount: number; engine: LLMEngine },
  ) => {
    saveBook({
      ...result,
      id: `book-${Date.now()}`,
      searched: opts.searched,
      searchCount: opts.searchCount,
      usedFallback: opts.usedFallback,
      engine: opts.usedFallback ? 'local' : opts.engine === 'free' ? 'free' : 'deepseek',
      createdAt: new Date().toLocaleString('zh-CN'),
    })
  }

  /**
   * v10.22：`engine` 由「🆓 免费模型 / 💳 付费模型」两颗按钮传入。
   * 只影响这一次生成，不动用户顶栏的全局引擎偏好。
   */
  const handleGenerate = async (engine: LLMEngine) => {
    setEngineUsed(engine)
    setState('loading')
    setOpen(true)
    setBook(null)
    setUsedFallback(false)
    setSearchInfo('')
    setFallbackReason('')
    setStreamPhase('idle')
    setBrief(null)
    setCali(null)

    // 把画布转成 Worker 期望的 { 维度名: 内容 } 形式
    const canvasesForLLM: Record<string, string> = {}
    listCanvases().forEach(c => {
      canvasesForLLM[c.dimension] = c.content
    })

    try {
      await generateBookLLMStream(
        canvasesForLLM,
        {
        onPlan: (b: GeneratedBookLLM) => {
          setStreamPhase('plan')
          // 规划先到：先把书名/简介/大纲/规格渲染出来（样章还是空的）
          setBook({ ...b, generatedAt: '' } as GeneratedBook)
        },
        onChapter: (b: GeneratedBookLLM) => {
          setStreamPhase('chapter')
          // 样章后到：保留已出的大纲，补上样章正文
          setBook(prev => ({ ...(prev ?? ({} as GeneratedBook)), sampleChapter: b.sampleChapter } as GeneratedBook))
        },
        onDone: (full: GeneratedBookLLM, searched: boolean, searchCount: number) => {
          setStreamPhase('done')
          setBrief(full.directionBrief ?? null)
          setSearchInfo(
            searched ? `已联网检索 ${searchCount} 次` : '（本次未触发联网检索，模型依据画布与已有知识创作）',
          )
          const produced: GeneratedBook = {
            ...full,
            generatedAt: new Date().toLocaleString('zh-CN'),
          }
          setBook(produced)
          saveToLibrary(produced, { usedFallback: false, searched, searchCount, engine })
          setState('done')
        },
        onError: (msg: string) => {
          // 流式失败 → 兜底用本地确定性生成（demo 不会挂）
          console.warn('流式生成失败，回退到本地生成器：', msg)
          setUsedFallback(true)
          setFallbackReason(msg || '未知错误')
          const produced = generateBook(listCanvases())
          setBook(produced)
          saveToLibrary(produced, { usedFallback: true, searched: false, searchCount: 0, engine })
          setState('done')
        },
      },
        undefined,
        directionIntent,
        engine,
      )
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('流式生成抛出异常，回退到本地生成器：', e)
      setUsedFallback(true)
      setFallbackReason(reason || '未知错误')
      const produced = generateBook(listCanvases())
      setBook(produced)
      saveToLibrary(produced, { usedFallback: true, searched: false, searchCount: 0, engine })
      setState('done')
    }
  }

  const handleCalibrate = async () => {
    if (!brief || !book?.sampleChapter?.content) return
    setCalibrating(true)
    try {
      const r = await calibrateText(brief, book.sampleChapter.content)
      setCali(r)
    } catch (e) {
      console.warn('校准失败', e)
    } finally {
      setCalibrating(false)
    }
  }

  const adoptFix = () => {
    if (!cali?.fixedText || !book) return
    setBook(prev =>
      prev ? { ...prev, sampleChapter: { ...prev.sampleChapter, content: cali.fixedText } } : prev,
    )
    setCali(null)
  }

  const close = () => {
    setOpen(false)
    setState('idle')
  }

  // 只读访客模式仍可生成（生成结果不写回画布）
  const filled = listCanvases().filter(c => c.content.trim().length > 0).length

  return (
    <>
      {variant === 'cta' ? (
        /* v10.71：取消免费模型 —— 只剩站方 DeepSeek 一条通道。
           每日前 20 次不计费，超出后按积分计费（服务端判定，前端不参与）。 */
        <div className="gen-btns gen-btns-cta">
          <button
            className="primary-btn gen-cta-btn"
            onClick={() => handleGenerate('cloud')}
            disabled={state_ === 'loading'}
            title="用站方 DeepSeek 生成整本书：每天前 20 次不计费，超出后按积分计费"
          >
            {state_ === 'loading' ? (
              'AI 创作中…'
            ) : (
              <>
                <Icon name="zap" size={14} /> 生成整本书
              </>
            )}
          </button>
        </div>
      ) : (
        /* v10.71：模型选择器已取消（只有 DeepSeek 一条通道），只留生成按钮。 */
        <div className="gen-inline-row">
          <button
            className="ghost-btn gen-inline-btn"
            onClick={() => handleGenerate('cloud')}
            disabled={state_ === 'loading'}
            title="按 7 块画布生成一整本书（每天前 20 次不计费，成品自动存进作品库）"
          >
            {state_ === 'loading' ? 'AI 创作中…' : (<><Icon name="zap" size={14} /> 生成整本书</>)}
          </button>
        </div>
      )}

      {/* portal 到 body：顶栏 backdrop-filter 会把 fixed 遮罩困在顶栏内（v11 回归） */}
      {open &&
        createPortal(
          <div className="modal-mask" onClick={close}>
            <div className="modal" onClick={e => e.stopPropagation()}>
            <header className="modal-head">
              <div>
                <h2>AI 合成结果</h2>
                <p className="modal-sub">
                  依据 {filled} 块有内容的画布 · 本次用
                  <span className="gen-engine-chip is-cloud">
                    <Icon name="cloud" size={14} /> DeepSeek
                  </span>
                </p>
              </div>
              <div className="modal-actions">
                <button
                  className="ghost-btn"
                  onClick={() => handleGenerate('cloud')}
                  disabled={state_ === 'loading'}
                  title="用同一通道（DeepSeek）重新生成"
                >
                  {state_ === 'loading' ? 'AI 创作中…' : '重新生成'}
                </button>
                <button className="ghost-btn" onClick={close}>
                  关闭
                </button>
                {/* v10.43 ENTRY-01：生成完了，下一步就是去写 —— 别让用户自己找入口 */}
                {onGoWrite && (
                  <button
                    className="primary-btn"
                    onClick={() => {
                      close()
                      onGoWrite()
                    }}
                    title="关掉结果，直接去「写作」开始写第 1 章"
                  >
                    去写作 →
                  </button>
                )}
              </div>
            </header>

            <div className="modal-body">
              <div className="gen-direction">
                <label className="gen-direction-label">方向意图（可选 · 让 AI 更精准地朝你要的方向写）</label>
                <textarea
                  className="gen-direction-input"
                  value={directionIntent}
                  onChange={e => setDirectionIntent(e.target.value)}
                  placeholder="例如：整体冷峻克制、第一章就制造悬念并收紧节奏、主角要在绝境中显露锋芒"
                  rows={2}
                />
                <p className="gen-direction-hint">留空则仅按 7 块画布创作；写了会作为硬约束让方向更精准。</p>
              </div>

              {state_ === 'loading' && (
                <div className="gen-stream">
                  <div className="gen-phase">
                    <span className={`gen-dot ${streamPhase === 'idle' ? 'pulse' : 'on'}`} />
                    <span>
                      {streamPhase === 'idle' && '正在读取 7 块画布 → 规划大纲…'}
                      {streamPhase === 'plan' && '✓ 大纲已出 · 正在撰写样章…'}
                      {streamPhase === 'chapter' && '✓ 样章已出 · 正在汇总…'}
                      <span className="gen-elapsed">已用时 {elapsed}s（一般 15-30 秒）</span>
                    </span>
                  </div>
                  {book && (
                    <div className="gen-live">
                      {book.title && <p className="gen-title">《{book.title}》</p>}
                      {book.synopsis && <p className="gen-synopsis">{book.synopsis}</p>}
                      {book.outline?.length > 0 && (
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
                      )}
                      {book.sampleChapter?.content && (
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
                      )}
                    </div>
                  )}
                </div>
              )}

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
                      DeepSeek 调用失败，本次使用本地兜底生成器（模板确定性，结果不联网）。可稍后重试。
                      {fallbackReason && (
                        <span className="gen-fallback-reason">原因：{fallbackReason}</span>
                      )}
                    </p>
                  )}
                  {searchInfo && <p className="gen-searchinfo">{searchInfo}</p>}
                  <p className="gen-meta">生成于 {book.generatedAt}</p>
                </>
              )}

              {brief && (
                <section className="gen-block">
                  <h3 className="gen-h3">方向指令书（AI 据此创作）</h3>
                  <div className="brief-card">
                    {brief.styleLock && <p><b>风格锁：</b>{brief.styleLock}</p>}
                    {brief.tone && <p><b>语气：</b>{brief.tone}</p>}
                    {brief.rhythmIntent && <p><b>节奏：</b>{brief.rhythmIntent}</p>}
                    {brief.hardRules && brief.hardRules.length > 0 && (
                      <p><b>硬约束：</b>{brief.hardRules.join('；')}</p>
                    )}
                    {brief.forbidden && brief.forbidden.length > 0 && (
                      <p><b>禁止：</b>{brief.forbidden.join('；')}</p>
                    )}
                  </div>
                </section>
              )}

              {brief && book?.sampleChapter?.content && (
                <section className="gen-block">
                  <h3 className="gen-h3">方向校准（防漂移）</h3>
                  <button className="ghost-btn" onClick={handleCalibrate} disabled={calibrating}>
                    {calibrating ? '校准中…' : '校准样章方向'}
                  </button>
                  {cali && (
                    <div className="cali-report">
                      <span className={`cali-score ${cali.score >= 80 ? 'good' : cali.score >= 60 ? 'mid' : 'bad'}`}>
                        方向一致度 {cali.score}/100
                      </span>
                      {cali.deviations.length > 0 ? (
                        <ul className="cali-dev">
                          {cali.deviations.map((d, i) => (
                            <li key={i}>{d}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="cali-ok">✓ 未发现方向偏离</p>
                      )}
                      {cali.fixedText && cali.fixedText !== book.sampleChapter.content && (
                        <button className="ghost-btn ghost-accent" onClick={adoptFix}>
                          采纳修正稿
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/**
 * 多画布页顶部的生成入口横幅（替代原先顶栏的「📖 生成文本」）。
 * 顺带把「几块画布已填」摆出来 —— 空画布太多时先提示，再让用户决定要不要生成。
 */
export function BookGenerateBanner({ onGoWrite }: { onGoWrite?: () => void } = {}) {
  const { listCanvases } = useApp()
  const canvases = listCanvases()
  const filled = canvases.filter(c => (c.content || '').trim().length > 0).length
  const total = canvases.length || 7
  const ready = filled === total

  return (
    <section className="gen-cta">
      <div className="gen-cta-text">
        <h3 className="gen-cta-title">把画布合成一整本书</h3>
        <p className="gen-cta-sub">
          已填 <b>{filled}</b>/{total} 块画布 · 自动起书名、写简介、排全书大纲并出样章，成品自动存进「作品库」
        </p>
        {!ready && (
          <p className="gen-cta-warn">
            还有 {total - filled} 块画布是空的 —— 也可以直接生成，AI 会自己补，只是方向没那么准。
          </p>
        )}
      </div>
      <BookGenerator variant="cta" onGoWrite={onGoWrite} />
    </section>
  )
}
