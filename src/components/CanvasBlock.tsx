import { useState } from 'react'
import { useApp } from '../store/AppContext'
import type { ReferenceAnchor } from '../types'
import {
  findBookInLibrary,
  findBookByContent,
  bookToAnchor,
  bookLibrary,
  dimensionFallback,
  dimensionBooks,
} from '../data/aiRecommendations'
import { analyzeBook } from '../lib/llmClient'

// 画布头部 ✨ AI 自动检索：按维度推 2 本书
export function CanvasBlock() {
  const { state, dispatch, selectedCanvas, updateAnchor, removeAnchor, aiAppendAnchors } = useApp()
  const [aiState, setAiState] = useState<'idle' | 'loading' | 'done'>('idle')
  if (!selectedCanvas) return null
  const editing = state.mode === 'admin'

  const handleAIFill = () => {
    if (!selectedCanvas) return
    setAiState('loading')
    setTimeout(() => {
      const keys = dimensionBooks[selectedCanvas.dimension] || []
      const anchors: ReferenceAnchor[] = keys
        .map(k => {
          const meta = bookLibrary[k]
          if (!meta) return null
          return bookToAnchor(k, meta, selectedCanvas.dimension)
        })
        .filter(Boolean) as ReferenceAnchor[]
      aiAppendAnchors(selectedCanvas.id, anchors)
      setAiState('done')
      setTimeout(() => setAiState('idle'), 1800)
    }, 1200)
  }

  return (
    <div className="canvas-block">
      <header className="canvas-block-head">
        <h2>{selectedCanvas.title}</h2>
        <span className="canvas-dim-pill">{selectedCanvas.dimension}</span>
        {editing && (
          <div className="canvas-actions">
            <button
              className="ai-btn"
              onClick={handleAIFill}
              disabled={aiState !== 'idle'}
              title="按本画布维度推荐 2 本书作参考"
            >
              {aiState === 'loading' && '读取语料库…'}
              {aiState === 'done' && '✓ 已添加推荐'}
              {aiState === 'idle' && '✨ AI 自动检索'}
            </button>
          </div>
        )}
      </header>

      <section className="content-section">
        <h3 className="sub-title">画布内容</h3>
        {editing ? (
          <textarea
            className="content-textarea"
            value={selectedCanvas.content}
            onChange={e =>
              dispatch({ type: 'UPDATE_CONTENT', id: selectedCanvas.id, content: e.target.value })
            }
            placeholder="在这块画布上记录这个维度的内容…"
          />
        ) : (
          <div className="content-readonly">
            {selectedCanvas.content || <em>（空白）</em>}
          </div>
        )}
      </section>

      <section className="anchor-section">
        <h3 className="sub-title">
          参考锚点 <span className="count-pill">{selectedCanvas.anchors.length}</span>
        </h3>
        {selectedCanvas.anchors.length === 0 ? (
          <p className="anchor-empty">
            还没有锚点。{editing ? '在下方添加一条参考范文。' : '管理模式下可添加。'}
          </p>
        ) : (
          <ul className="anchor-list">
            {selectedCanvas.anchors.map(a => (
              <AnchorCard
                key={a.id}
                canvasId={selectedCanvas.id}
                anchor={a}
                editing={editing}
                onUpdate={updateAnchor}
                onRemove={removeAnchor}
              />
            ))}
          </ul>
        )}
        {editing && <AnchorAdder canvasId={selectedCanvas.id} />}
      </section>
    </div>
  )
}

function AnchorCard({
  canvasId,
  anchor,
  editing,
  onUpdate,
  onRemove,
}: {
  canvasId: string
  anchor: ReferenceAnchor
  editing: boolean
  onUpdate: (canvasId: string, a: ReferenceAnchor) => void
  onRemove: (canvasId: string, id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className="anchor-card">
      <header className="anchor-head" onClick={() => setOpen(o => !o)}>
        <span className="anchor-source">{anchor.source || '（未命名参考）'}</span>
        <span className="anchor-toggle">{open ? '收起' : '展开'}</span>
      </header>
      {open && (
        <div className="anchor-body">
          {editing ? (
            <>
              <label className="field">
                <span>参考来源</span>
                <input
                  value={anchor.source}
                  onChange={e => onUpdate(canvasId, { ...anchor, source: e.target.value })}
                />
              </label>
              <label className="field">
                <span>特征描述</span>
                <textarea
                  rows={3}
                  value={anchor.features}
                  onChange={e => onUpdate(canvasId, { ...anchor, features: e.target.value })}
                />
              </label>
              <label className="field">
                <span>原文例证</span>
                <textarea
                  rows={4}
                  value={anchor.examples}
                  onChange={e => onUpdate(canvasId, { ...anchor, examples: e.target.value })}
                />
              </label>
              <button className="danger-btn" onClick={() => onRemove(canvasId, anchor.id)}>
                删除此锚点
              </button>
            </>
          ) : (
            <>
              <p>
                <strong>特征：</strong>
                {anchor.features || '—'}
              </p>
              <p>
                <strong>例证：</strong>
                {anchor.examples || '—'}
              </p>
            </>
          )}
        </div>
      )}
    </li>
  )
}

// 新增锚点：按 source 框输入查书库
function AnchorAdder({ canvasId }: { canvasId: string }) {
  const { addAnchor, selectedCanvas } = useApp()
  const [source, setSource] = useState('')
  const [features, setFeatures] = useState('')
  const [examples, setExamples] = useState('')
  const [fillState, setFillState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [notFound, setNotFound] = useState('')
  const [searchInfo, setSearchInfo] = useState('')
  const reset = () => {
    setSource('')
    setFeatures('')
    setExamples('')
    setNotFound('')
    setSearchInfo('')
  }

  const handleAIFill = async () => {
    if (!selectedCanvas) return
    setFillState('loading')
    setNotFound('')
    setSearchInfo('')
    const userSource = source.trim()
    // 清空旧结果（避免上次成功的填充残留误导用户）
    setFeatures('')
    setExamples('')
    let result: { source: string; features: string; examples: string } | null = null

    if (userSource) {
      // 优先级 1：用户输入的书名 → 在本地库中查
      const hit = findBookInLibrary(userSource)
      if (hit) {
        const a = bookToAnchor(hit.key, hit.meta, selectedCanvas.dimension)
        result = { source: a.source, features: a.features, examples: a.examples }
      } else {
        // 优先级 2：本地没有 → 调 DeepSeek 联网分析（真 web_search）
        try {
          const { data: llm, searched, searchCount } = await analyzeBook(
            userSource,
            selectedCanvas.dimension,
          )
          result = {
            source: llm.source || userSource,
            features: llm.features || '',
            examples: llm.examples || '',
          }
          setSearchInfo(
            searched ? `🌐 已联网检索 ${searchCount} 次` : '⚠️ 未触发联网检索（模型凭已有知识回答，请留意准确性）',
          )
        } catch (e) {
          setNotFound(`${userSource}（LLM 分析失败：${e instanceof Error ? e.message : String(e)}）`)
          setFillState('idle')
          return
        }
      }
    } else {
      // 优先级 3：source 空 → 按画布 content 关键词在书库里查
      const hit = findBookByContent(selectedCanvas.content)
      if (hit) {
        const a = bookToAnchor(hit.key, hit.meta, selectedCanvas.dimension)
        result = { source: a.source, features: a.features, examples: a.examples }
      } else {
        // 优先级 4：库也匹配不上 → 用该维度的通用分析角度（不挂书名）
        const fb = dimensionFallback[selectedCanvas.dimension]
        if (fb) {
          result = {
            source: '（未指定书名 · 通用分析角度）',
            features: fb.feature,
            examples: fb.example,
          }
        }
      }
    }

    if (result) {
      setSource(result.source)
      setFeatures(result.features)
      setExamples(result.examples)
      setFillState('done')
      setTimeout(() => setFillState('idle'), 1600)
    } else {
      setFillState('idle')
    }
  }

  return (
    <details className="anchor-adder">
      <summary>+ 新增参考锚点</summary>
      <div className="anchor-body">
        <label className="field">
          <span>参考来源</span>
          <input
            value={source}
            onChange={e => {
              setSource(e.target.value)
              if (notFound) setNotFound('')
            }}
            placeholder="书名 / 范文标题（先填这里，AI 按书名查）"
          />
        </label>
        <label className="field">
          <span>特征描述</span>
          <textarea
            rows={3}
            value={features}
            onChange={e => setFeatures(e.target.value)}
            placeholder="AI 解析出的本画布维度特征"
          />
        </label>
        <label className="field">
          <span>原文例证</span>
          <textarea
            rows={4}
            value={examples}
            onChange={e => setExamples(e.target.value)}
            placeholder="能支撑上述特征的原文片段"
          />
        </label>
        {notFound && (
          <p className="not-found">
            {notFound}
          </p>
        )}
        {searchInfo && <p className="search-info">{searchInfo}</p>}
        <div className="row">
          <button
            className="ai-mini-btn"
            onClick={handleAIFill}
            disabled={fillState !== 'idle'}
            title="按已填的来源查书库，匹配上自动填三栏"
          >
            {fillState === 'loading' && (source.trim() ? 'AI 联网分析中…' : 'AI 匹配中…')}
            {fillState === 'done' && '✓ 已填三栏'}
            {fillState === 'idle' && '✨ AI 填充'}
          </button>
          <button
            className="primary-btn"
            disabled={!source.trim() && !features.trim()}
            onClick={() => {
              addAnchor(canvasId, source.trim(), features.trim(), examples.trim())
              reset()
            }}
          >
            添加锚点
          </button>
        </div>
      </div>
    </details>
  )
}
