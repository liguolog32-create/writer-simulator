import { Icon } from './Icon'
import { Fragment, useState } from 'react'
import { useApp } from '../store/AppContext'
import { DIMENSIONS } from '../lib/dims'

/** v18.5 釉色版：卡片序号改用大写数字（壹～柒） */
const CN_NUM = ['壹', '贰', '叁', '肆', '伍', '陆', '柒']

/**
 * v18.4 · 画布流水线合并
 * 把原来「左侧栏 7 项列表 + 右侧区再列一遍 7 项」的重复结构，
 * 合并成「一条横版流水线」：7 个编号单元 + 流向箭头 + 依赖标注，
 * 末尾一个「📖 合成全书」汇聚节点，直观表达
 * 「每块画布如何影响下一块、7 块共同决定最终成稿」。
 * 点任意单元即选中该画布，下方 CanvasBlock 同步切换。
 */
export function CanvasRail() {
  const { state, dispatch, canEdit, listCanvases, listDownstreamTargets, reset, conflicts, autoSnapshot, syncNow, aiFillingCanvasIds } = useApp()

  /** v10.58：每张卡片一个「保存」按钮 —— 正在保存的画布 id / 刚保存完成的画布 id */
  const [saveBusyId, setSaveBusyId] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)

  /** v10.58：保存单块画布 = 强制版本快照（可回滚）+ 立即同步云端（未登录时内部自动跳过） */
  const saveCanvas = async (id: string, title: string) => {
    if (saveBusyId) return
    setSaveBusyId(id)
    try {
      autoSnapshot(`手动保存 · ${title}`, true)
      await syncNow()
      setSavedId(id)
      setTimeout(() => setSavedId(cur => (cur === id ? null : cur)), 2000)
    } catch {
      setSavedId(id)
      setTimeout(() => setSavedId(cur => (cur === id ? null : cur)), 2000)
    } finally {
      setSaveBusyId(null)
    }
  }

  // 严格按 DIMENSIONS 固定顺序（listCanvases 返回的是 Object.values，顺序不保证）
  const order = new Map(DIMENSIONS.map((d, i) => [d, i]))
  const canvases = listCanvases()
    .slice()
    .sort((a, b) => (order.get(a.dimension) ?? 99) - (order.get(b.dimension) ?? 99))

  const filledCount = canvases.filter(c => (c.content || '').trim()).length

  /**
   * v10.41 STEP4-02：新人一进来就面对 7 块画布会懵（还要左右滑才看全）。
   * 默认只铺开 3 块最核心的：故事世界 / 主角关系 / 主线冲突，
   * 其余折成一行「▸ 还有 4 块」。展开一次后记住选择，不再折回去。
   */
  const CORE_DIMS = ['设定', '人物', '情节']
  const [showAll, setShowAll] = useState(() => {
    try {
      return localStorage.getItem('ws-canvas-showall-v1') === '1'
    } catch {
      return false
    }
  })
  const shown = showAll ? canvases : canvases.filter(c => CORE_DIMS.includes(c.dimension))
  const hiddenCanvases = canvases.filter(c => !shown.includes(c))
  const expandAll = () => {
    setShowAll(true)
    try {
      localStorage.setItem('ws-canvas-showall-v1', '1')
    } catch {
      /* 隐私模式下写不了，无所谓 */
    }
  }

  const dimOf = (id: string) => state.canvases[id]?.dimension
  const shortName = (title: string) => title.split('·')[1]?.trim() || title

  const select = (id: string) => {
    dispatch({ type: 'SELECT_CANVAS', id })
    document.querySelector('.canvas-block')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const descOf = (c: { content?: string }) => {
    const t = (c.content || '').trim()
    if (!t) return '（待填）'
    return t.length > 52 ? t.slice(0, 52) + '…' : t
  }

  return (
    <section className="cv-rail">
      <header className="cv-rail-head">
        <div className="cv-rail-title">
          <h3>7 块画布 · 一条流水线</h3>
          {/* v18.5 釉色版：头部进度条 */}
          <span className="cv-rail-bar" aria-hidden>
            <i style={{ width: Math.round(filledCount / Math.max(1, canvases.length) * 100) + '%' }} />
          </span>
          <span className="cv-rail-count">
            {filledCount}/{canvases.length} 块已填
          </span>
        </div>
        <div className="cv-rail-meta">
          <p className="cv-rail-hint">
            点任意画布卡片开始编辑；箭头表示编排顺序。卡片下方的绿标签 = <b>修改这块时，AI 会同时参考这些关联画布</b>（它们之间是联动关系）；
            末端的 📖 表示 7 块共同决定最终成稿。
          </p>
          {canEdit && (
            <button
              className="ghost-btn sm"
              onClick={() => {
                if (confirm('重置全部画布到示例内容？')) reset()
              }}
              title="把画布清空到示例内容"
            >
              重置
            </button>
          )}
        </div>
      </header>

      <div className="cv-rail-track" role="list">
        {shown.map((c, i) => {
          const active = c.id === state.selectedCanvasId
          const content = (c.content || '').trim()
          // v4.1「研墨中」：这块画布正在被 AI 写入（瞬态，来自 AppContext）
          const isFilling = aiFillingCanvasIds.includes(c.id)
          const downs = (c.downstreams || [])
            .map(dimOf)
            .filter(Boolean) as string[]
          // v10.57：这块画布卷入了哪些冲突
          const cf = conflicts.filter(x => x.a === c.id || x.b === c.id)
          const cfReason = cf
            .map(x => {
              const otherId = x.a === c.id ? x.b : x.a
              const otherDim = state.canvases[otherId]?.dimension || otherId
              return `与「${otherDim}」：${x.reason}`
            })
            .join('；')
          // v18.5 釉色版：卡片水位（30%～92%，按内容长度）；filling 且无内容时固定 45% 视觉占位
          const fillPct = content ? Math.min(92, Math.max(30, Math.round(30 + content.length / 1500 * 62))) : 0
          const waterPct = content ? fillPct : isFilling ? 45 : 0
          return (
            <Fragment key={c.id}>
              <button
                type="button"
                role="listitem"
                className={`cv-node ${active ? 'active' : ''} ${c.locked ? 'locked' : ''} ${
                  content ? 'done' : 'todo'
                } ${isFilling ? 'filling' : ''} ${cf.length ? 'conflict' : ''}`}
                onClick={() => select(c.id)}
                title={`${c.title}　·　点此在下方编辑`}
                style={{ ['--wpct' as any]: waterPct + '%' }}
              >
                <span className="cv-node-no">{CN_NUM[order.get(c.dimension) ?? 0]}</span>
                <div className="cv-node-head">
                  <span className="cv-node-name">{shortName(c.title)}</span>
                  <span className="cv-node-dim">
                    <i className="cv-dim-dot" />
                    {c.dimension}
                  </span>
                </div>
                <p className="cv-node-desc">{descOf(c)}</p>
                {/* v18.5 釉色版：卡片字数（编辑区原有的字数显示不动） */}
                {content ? <span className="cv-node-stat">{content.length.toLocaleString()} 字</span> : null}
                <div className="cv-node-foot">
                  {c.locked && <span className="cv-node-lock" title="已锁定，AI 不会改动"><Icon name="lock" size={14} /></span>}
                  {/* v10.42 CANVAS-02：卡片上不再重复显示字数（编辑区已经有了），只标状态 */}
                  {/* v4.1：三态徽章 —— 研墨中（AI 写入中）优先于 墨满/虚位 */}
                  <span className={`cv-node-state ${isFilling ? 'filling' : content ? 'done' : 'todo'}`}>
                    {isFilling ? '研墨中' : content ? '墨满' : '虚位'}
                  </span>
                  {cf.length > 0 && (
                    <span className="cv-conflict-badge" title={cfReason}>
                      冲突
                    </span>
                  )}
                  {/* v10.58：每块画布的保存按钮（阻断冒泡，别触发卡片选中） */}
                  {canEdit && (
                    <button
                      type="button"
                      className={`cv-save-btn ${savedId === c.id ? 'saved' : ''}`}
                      disabled={saveBusyId === c.id || (saveBusyId !== null && saveBusyId !== c.id)}
                      onClick={e => {
                        e.stopPropagation()
                        void saveCanvas(c.id, c.title)
                      }}
                      title={`保存「${shortName(c.title)}」：写本地存档 + 版本快照 + 同步云端`}
                    >
                      {saveBusyId === c.id ? '保存中…' : savedId === c.id ? '✓ 已存' : '保存'}
                    </button>
                  )}
                </div>
                {!canEdit && downs.length > 0 && (
                  <div className="cv-node-down">联动 → {downs.join(' · ')}</div>
                )}
                {canEdit && (
                  <div className="cv-node-links" onClick={e => e.stopPropagation()}>
                    <span className="cv-node-links-label">联动</span>
                    {listDownstreamTargets(c.id).map(t => {
                      const linked = (c.downstreams || []).includes(t.id)
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className={`cv-link-chip ${linked ? 'linked' : ''}`}
                          onClick={() =>
                            dispatch({
                              type: linked ? 'REMOVE_DOWNSTREAM' : 'ADD_DOWNSTREAM',
                              from: c.id,
                              to: t.id,
                            })
                          }
                        >
                          {t.dimension}
                        </button>
                      )
                    })}
                  </div>
                )}
                {/* v18.5 釉色版：底部水位层与波浪；v4.1 filling 无内容时也给 45% 水位（呼吸动画） */}
                {waterPct > 0 && (
                  <>
                    <span className="cv-node-water" style={{ height: waterPct + '%' }} aria-hidden />
                    <svg className="cv-node-wave" width="115" height="7" viewBox="0 0 108 7" aria-hidden>
                      <path d="M0 5 Q 4.5 1 9 5 T 18 5 T 36 5 T 54 5 T 72 5 T 90 5 T 108 5 V 7 H 0 Z" />
                    </svg>
                  </>
                )}
              </button>

              {i < shown.length - 1 && (
                <svg className="cv-arrow-wave" width="13" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
                  <path d="M0 5 q 3.5 -4 7 0 t 7 0" />
                </svg>
              )}
            </Fragment>
          )
        })}

        <span className="cv-terminal" title="7 块画布共同决定最终成稿">
          <span className="cv-terminal-mark"><Icon name="book" /></span>
          <span className="cv-terminal-label">合成全书</span>
        </span>
      </div>

      {/* v10.41 STEP4-02：折起来的 4 块 */}
      {hiddenCanvases.length > 0 && (
        <button className="cv-fold-rest" onClick={expandAll} title="展开全部 7 块画布">
          ▸ 还有 {hiddenCanvases.length} 块：
          {hiddenCanvases.map(c => ` ${shortName(c.title)}`).join(' /')}
        </button>
      )}
    </section>
  )
}
