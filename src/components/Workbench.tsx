import { useState } from 'react'
import { useApp } from '../store/AppContext'
import { dissectText, reviseText, continueText } from '../lib/llmClient'
import { dissectTextLocally, DIMENSIONS } from '../data/textDissect'
import type { CanvasDimension } from '../types'

/** 维度 → 画布 id 的映射（与 seed.ts 的画布 id 对应） */
const DIM_TO_CANVAS: Record<CanvasDimension, string> = {
  设定: 'setting',
  人物: 'character',
  文笔: 'style',
  结构: 'structure',
  篇幅: 'length',
  情节: 'plot',
  节奏: 'rhythm',
}

type Tab = 'dissect' | 'revise' | 'continue'

export function Workbench() {
  const { state, dispatch, listCanvases, saveBook } = useApp()
  const [tab, setTab] = useState<Tab>('dissect')

  // 原文来源
  const [sourceId, setSourceId] = useState<string>('')
  const [text, setText] = useState('')

  // 拆解
  const [dissecting, setDissecting] = useState(false)
  const [dissectInfo, setDissectInfo] = useState('')

  // 修改 / 续写
  const [acting, setActing] = useState(false)
  const [reviseOut, setReviseOut] = useState<{ revised: string; changes: string[] } | null>(null)
  const [continueOut, setContinueOut] = useState<{ continuation: string; rationale: string } | null>(null)
  const [actionInfo, setActionInfo] = useState('')

  const library = state.library

  /** 从资产库选一本，把它的正文（样章+大纲摘要）取出来当原文 */
  const loadFromLibrary = (id: string) => {
    setSourceId(id)
    const b = library.find(x => x.id === id)
    if (!b) return
    const outlineText = b.outline.map(c => `${c.index}. ${c.title}：${c.summary}`).join('\n')
    const composed = `《${b.title}》\n\n${b.synopsis}\n\n${outlineText}\n\n${b.sampleChapter.content}`
    setText(composed)
    setReviseOut(null)
    setContinueOut(null)
    setDissectInfo('')
  }

  /** 把 7 个维度的分析结果写进对应画布 */
  const applyToCanvases = (dims: Record<string, string>) => {
    DIMENSIONS.forEach(d => {
      const canvasId = DIM_TO_CANVAS[d]
      const value = dims[d]
      if (canvasId && value) {
        dispatch({ type: 'UPDATE_CONTENT', id: canvasId, content: value })
      }
    })
  }

  const handleDissect = async () => {
    if (!text.trim()) return
    setDissecting(true)
    setDissectInfo('')
    try {
      const { data, searched, searchCount } = await dissectText(text)
      applyToCanvases(data)
      setDissectInfo(
        `✅ 已由 DeepSeek 拆解并填充 7 个画布${searched ? `（联网检索 ${searchCount} 次）` : ''}。切到「多画布」tab 可查看/微调。`,
      )
    } catch (e) {
      // LLM 不可用 → 本地启发式兜底，保证功能不挂
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('LLM 拆解失败，用本地启发式：', e)
      const local = dissectTextLocally(text)
      applyToCanvases(local)
      setDissectInfo(
        `⚠️ DeepSeek 不可用（${reason.slice(0, 80)}），已用「本地启发式」填充 7 个画布。质量较粗糙，更新 Cloudflare Worker 到 v4.0 后可获得 LLM 级拆解。`,
      )
    }
    setDissecting(false)
  }

  const canvasesMap = () => {
    const m: Record<string, string> = {}
    listCanvases().forEach(c => { m[c.dimension] = c.content })
    return m
  }

  const handleRevise = async () => {
    if (!text.trim()) return
    setActing(true)
    setActionInfo('')
    try {
      const { data, searched, searchCount } = await reviseText(text, canvasesMap())
      setReviseOut(data)
      setActionInfo(searched ? `🌐 联网检索 ${searchCount} 次` : '（未触发联网检索）')
    } catch (e) {
      setActionInfo(`❌ 修改失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setActing(false)
  }

  const handleContinue = async () => {
    if (!text.trim()) return
    setActing(true)
    setActionInfo('')
    try {
      const { data, searched, searchCount } = await continueText(text, canvasesMap())
      setContinueOut(data)
      setActionInfo(searched ? `🌐 联网检索 ${searchCount} 次` : '（未触发联网检索）')
    } catch (e) {
      setActionInfo(`❌ 续写失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setActing(false)
  }

  /** 把续写结果也存进作品库，形成闭环 */
  const saveContinuation = () => {
    if (!continueOut) return
    saveBook({
      id: `book-${Date.now()}`,
      title: '续写稿',
      synopsis: '由工作台「续写」功能生成。',
      outline: [],
      sampleChapter: {
        title: '续写正文',
        content: continueOut.continuation,
        beat: continueOut.rationale,
      },
      stats: {
        totalWords: continueOut.continuation.length,
        chapters: 1,
        volumes: 1,
        styleLabel: '续写',
        anchorSources: [],
      },
      searched: false,
      searchCount: 0,
      usedFallback: false,
      engine: 'deepseek',
      createdAt: new Date().toLocaleString('zh-CN'),
    })
    setActionInfo('✅ 已存入作品库')
  }

  return (
    <div className="workbench">
      {/* 原文来源 */}
      <section className="wb-block">
        <h3 className="wb-h3">1. 选择原文</h3>
        <div className="wb-row">
          <select
            className="wb-select"
            value={sourceId}
            onChange={e => loadFromLibrary(e.target.value)}
          >
            <option value="">— 从资产库选择 —</option>
            {library.map(b => (
              <option key={b.id} value={b.id}>
                《{b.title}》 · {b.createdAt}
              </option>
            ))}
          </select>
          <span className="wb-hint">或直接在下面粘贴你自己的文本</span>
        </div>
        <textarea
          className="wb-textarea"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="粘贴你的小说原文…"
          rows={8}
        />
        <p className="wb-count">当前 {text.length} 字</p>
      </section>

      {/* 三个功能 tab */}
      <div className="wb-tabs">
        <button
          className={`wb-tab ${tab === 'dissect' ? 'active' : ''}`}
          onClick={() => setTab('dissect')}
        >
          拆解到画布
        </button>
        <button
          className={`wb-tab ${tab === 'revise' ? 'active' : ''}`}
          onClick={() => setTab('revise')}
        >
          原文修改
        </button>
        <button
          className={`wb-tab ${tab === 'continue' ? 'active' : ''}`}
          onClick={() => setTab('continue')}
        >
          续写
        </button>
      </div>

      {tab === 'dissect' && (
        <section className="wb-block">
          <h3 className="wb-h3">2. 拆解并填充画布</h3>
          <p className="wb-desc">
            AI 会按 设定/人物/文笔/结构/篇幅/情节/节奏 七个维度分析原文，
            结果直接写入对应画布（画布原有功能全部保留）。
          </p>
          <button className="primary-btn" onClick={handleDissect} disabled={dissecting || !text.trim()}>
            {dissecting ? '拆解中…' : '🔍 分析并填充 7 个画布'}
          </button>
          {dissectInfo && (
            <p className={dissectInfo.startsWith('✅') ? 'wb-ok' : 'wb-warn'}>{dissectInfo}</p>
          )}
        </section>
      )}

      {tab === 'revise' && (
        <section className="wb-block">
          <h3 className="wb-h3">2. 按画布设定修改原文</h3>
          <p className="wb-desc">依据 7 个画布的设定（尤其【文笔】）改写原文，保留核心情节与人物。</p>
          <button className="primary-btn" onClick={handleRevise} disabled={acting || !text.trim()}>
            {acting ? '修改中…' : '✍️ 修改原文'}
          </button>
          {actionInfo && (
            <p className={actionInfo.startsWith('❌') ? 'wb-warn' : 'wb-ok'}>{actionInfo}</p>
          )}
          {reviseOut && (
            <>
              {reviseOut.changes.length > 0 && (
                <div className="wb-changes">
                  <h4 className="wb-h4">主要改动</h4>
                  <ul>
                    {reviseOut.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="gen-prose">
                {reviseOut.revised.split('\n\n').map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'continue' && (
        <section className="wb-block">
          <h3 className="wb-h3">2. 按画布设定续写</h3>
          <p className="wb-desc">延续原文人物与口吻，依据【情节】【节奏】画布往下写。</p>
          <button className="primary-btn" onClick={handleContinue} disabled={acting || !text.trim()}>
            {acting ? '续写中…' : '➡️ 续写正文'}
          </button>
          {actionInfo && (
            <p className={actionInfo.startsWith('❌') ? 'wb-warn' : 'wb-ok'}>{actionInfo}</p>
          )}
          {continueOut && (
            <>
              <div className="gen-prose">
                {continueOut.continuation.split('\n\n').map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
              {continueOut.rationale && (
                <p className="gen-beat">续写依据：{continueOut.rationale}</p>
              )}
              <button className="ghost-btn" onClick={saveContinuation}>
                存入作品库
              </button>
            </>
          )}
        </section>
      )}
    </div>
  )
}
