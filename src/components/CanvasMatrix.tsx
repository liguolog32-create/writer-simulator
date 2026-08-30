import { useApp } from '../store/AppContext'

export function CanvasMatrix() {
  const { state, dispatch, listCanvases, listDownstreamTargets, reset } = useApp()
  const canvases = listCanvases()
  const editing = state.mode === 'admin'

  return (
    <div className="canvas-matrix">
      <div className="section-head">
        <div>
          <h2 className="section-title">画布矩阵</h2>
          <p className="section-hint">{canvases.length} 块画布，可点开编辑</p>
        </div>
        {editing && (
          <button
            className="ghost-btn"
            onClick={e => {
              e.stopPropagation()
              if (confirm('重置全部画布到示例内容？')) reset()
            }}
            title="把画布清空到示例内容"
          >
            重置
          </button>
        )}
      </div>
      <ul className="canvas-list">
        {canvases.map(c => (
          <li
            key={c.id}
            className={c.id === state.selectedCanvasId ? 'canvas-item active' : 'canvas-item'}
            onClick={() => dispatch({ type: 'SELECT_CANVAS', id: c.id })}
          >
            <div className="canvas-item-head">
              <span className="canvas-dim">{c.dimension}</span>
              <span className="canvas-name">{c.title.split('·')[1]?.trim() || c.title}</span>
            </div>
            {c.downstreams.length > 0 && (
              <div className="canvas-item-down">
                级联到 → {c.downstreams.map(d => state.canvases[d]?.dimension).join('、')}
              </div>
            )}
            {editing && <DownstreamEditor fromId={c.id} />}
          </li>
        ))}
      </ul>
    </div>
  )
}

function DownstreamEditor({ fromId }: { fromId: string }) {
  const { state, dispatch, listDownstreamTargets } = useApp()
  const from = state.canvases[fromId]
  const candidates = listDownstreamTargets(fromId)
  return (
    <div className="downstream-editor" onClick={e => e.stopPropagation()}>
      <span className="downstream-label">级联</span>
      {candidates.map(target => {
        const linked = from?.downstreams.includes(target.id)
        return (
          <button
            key={target.id}
            className={linked ? 'link-btn linked' : 'link-btn'}
            onClick={() =>
              dispatch({
                type: linked ? 'REMOVE_DOWNSTREAM' : 'ADD_DOWNSTREAM',
                from: fromId,
                to: target.id,
              })
            }
          >
            {target.dimension}
          </button>
        )
      })}
    </div>
  )
}
