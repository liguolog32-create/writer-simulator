import { useState } from 'react'
import { useApp } from '../store/AppContext'
import { DIMENSIONS } from '../lib/dims'
import type { Canvas } from '../types'
import { Icon } from './Icon'

/* ============================================================
   PRD 功能5：画布折叠减负
   默认所有画布折叠、仅展示标题；点击展开详情，解决新手信息过载
   ============================================================ */

export function CanvasOverview() {
  const { state, dispatch } = useApp()
  const [openId, setOpenId] = useState<string | null>(null)

  const list: Canvas[] = DIMENSIONS.map(d => Object.values(state.canvases).find(c => c.dimension === d)).filter(
    Boolean,
  ) as Canvas[]

  const allCollapsed = state.collapseCanvases ?? true
  const filledCount = list.filter(c => (c.content || '').trim()).length

  const setAll = (collapse: boolean) => {
    dispatch({ type: 'SET_COLLAPSE_CANVASES', collapse })
    if (collapse) setOpenId(null)
  }

  return (
    <section className="cv-fold">
      <header className="cv-fold-head">
        <h3 className="cv-fold-title">
          画布总览
          <span className="cv-fold-count">
            {filledCount}/{list.length} 块已填
          </span>
        </h3>
        <div className="seg">
          <button
            type="button"
            className={allCollapsed ? 'seg-btn active' : 'seg-btn'}
            onClick={() => setAll(true)}
          >
            全部折叠
          </button>
          <button
            type="button"
            className={!allCollapsed ? 'seg-btn active' : 'seg-btn'}
            onClick={() => setAll(false)}
          >
            全部展开
          </button>
        </div>
      </header>

      <ul className="cv-fold-list">
        {list.map((c, i) => {
          const content = (c.content || '').trim()
          const open = !allCollapsed && openId === c.id
          return (
            <li key={c.id} className={`cv-fold-item ${open ? 'open' : ''} ${c.locked ? 'locked' : ''}`}>
              <div
                className="cv-fold-row"
                onClick={() => setOpenId(open ? null : c.id)}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter') setOpenId(open ? null : c.id)
                }}
              >
                <span className="cv-fold-no">{i + 1}</span>
                <span className="cv-fold-name">{c.title}</span>
                <span className="cv-fold-dim">{c.dimension}</span>
                {c.locked && <span className="cv-fold-lock" title="已锁定，AI 不会改动"><Icon name="lock" size={14} /></span>}
                <span className={`cv-fold-state ${content ? 'done' : 'todo'}`}>
                  {content ? `${content.length} 字` : '空白'}
                </span>
                <span className="cv-fold-arrow">{open ? '▾' : '▸'}</span>
              </div>

              {open && (
                <div className="cv-fold-body">
                  <p className="cv-fold-text">
                    {content ? (content.length > 220 ? content.slice(0, 220) + '…' : content) : '（这块画布还是空的）'}
                  </p>
                  <button
                    className="ghost-btn sm"
                    onClick={() => {
                      dispatch({ type: 'SELECT_CANVAS', id: c.id })
                      document.querySelector('.canvas-block')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                  >
                    在下方编辑这块
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <p className="wb-hint">
        只想看不想被信息淹没？保持「全部折叠」，点哪块看哪块。锁定过的画布，AI 改写时绝不会动它。
      </p>
    </section>
  )
}
