import { useApp } from '../store/AppContext'

/* ============================================================
   脑洞完成后的「成果导览」浮层 —— v10.41 STEP4-01
   ------------------------------------------------------------
   从友好的选择题界面suddenly扔进 7 块画布，是整个流程断层最大的一步。
   所以第一次进来先给一张导览卡：告诉他 AI 填好了什么、接下来能做什么。
   只在**首次**弹一次（localStorage 标记），之后不再打扰。

   术语翻译成人话：设定→故事世界、人物→主角关系、情节→主线冲突…
   ============================================================ */

/** 维度 → 用户能懂的说法 */
const FRIENDLY: Record<string, string> = {
  设定: '故事世界',
  人物: '主角关系',
  文笔: '文笔风格',
  结构: '章节结构',
  篇幅: '字数分配',
  情节: '主线冲突',
  节奏: '节奏曲线',
}

export function BrainTour({
  open,
  onClose,
  onStartWriting,
}: {
  open: boolean
  onClose: () => void
  onStartWriting: () => void
}) {
  const { listCanvases } = useApp()
  if (!open) return null

  const canvases = listCanvases()
  const filled = canvases.filter(c => (c.content || '').trim())

  return (
    <div className="tour-mask" onClick={onClose}>
      <div className="tour-card" onClick={e => e.stopPropagation()}>
        <button className="tour-x" onClick={onClose} title="关闭">
          ✕
        </button>

        <h3 className="tour-title">你的小说架子已经搭好了！</h3>
        <p className="tour-sub">
          AI 帮你填好了这 {canvases.length} 块（<b>{filled.length}</b> 块有内容）：
        </p>

        <ul className="tour-list">
          {canvases.map(c => {
            const on = Boolean((c.content || '').trim())
            return (
              <li key={c.id} className={on ? 'ok' : 'todo'}>
                <span className="tour-mark">{on ? '✓' : '○'}</span>
                <span>{FRIENDLY[c.dimension] ?? c.dimension}</span>
                {!on && <em className="tour-todo">待补充</em>}
              </li>
            )
          })}
        </ul>

        <p className="tour-sub">接下来你可以：</p>
        <ol className="tour-steps">
          <li>点任意一块，看看 AI 写了什么</li>
          <li>不满意的地方直接改</li>
          <li>右下角「写第一章」开始正式写</li>
        </ol>

        <div className="tour-actions">
          <button className="primary-btn" onClick={onStartWriting}>
            开始写作 →
          </button>
          <button className="ghost-btn" onClick={onClose}>
            我先看看画布
          </button>
        </div>
      </div>
    </div>
  )
}

/** 是否该弹导览（首次进入工作台时弹一次） */
export function shouldShowBrainTour() {
  try {
    if (localStorage.getItem('ws-brain-tour-v1')) return false
    localStorage.setItem('ws-brain-tour-v1', '1')
    return true
  } catch {
    return false
  }
}
