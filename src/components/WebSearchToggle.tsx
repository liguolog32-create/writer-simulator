/* ============================================================
   联网搜索开关 · 全站共用组件
   ------------------------------------------------------------
   散稿加工 / 章节精修 / 故事体检 / 脑洞共创 四处都用它，
   保证「同一个开关、同一句文案、同一个长相」，避免各处临时手写样式不一致。
   同时提供参考资料展示块与状态文案助手。
   ============================================================ */

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  /** 可选：覆盖按钮文案（默认「联网搜同类型范文」） */
  label?: string
  /** 可选：覆盖 title 提示 */
  hint?: string
  disabled?: boolean
}

const DEFAULT_HINT =
  '开启后，AI 会先联网检索同类型（同题材 / 同风格）的优秀文章作为风格参照，再帮你写；关闭则只依据你的画布与已有内容'

/** 统一的联网开关（开关样式，带状态色） */
export function WebSearchToggle({ checked, onChange, label, hint, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      className={`ws-toggle ${checked ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      title={hint || DEFAULT_HINT}
      aria-pressed={checked}
    >
      <span className="ws-track" aria-hidden="true">
        <span className="ws-knob" />
      </span>
      <span className="ws-text">{label || '联网搜同类型范文'}</span>
    </button>
  )
}

/** 统一的「本次联网参考了哪些同类型范文」展示块；无参考则不渲染 */
export function ReferenceList({ references }: { references?: string[] }) {
  if (!references || references.length === 0) return null
  return (
    <div className="ws-refs">
      <div className="ws-refs-head">本次联网参考的同类型范文</div>
      <ul>
        {references.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 统一的联网状态文案，避免各处拼出来的说法不一样。
 * 未开联网 → 空字符串（调用方自行决定是否展示）。
 */
export function webStatusText(args: {
  webSearch: boolean
  searched?: boolean
  searchCount?: number
}): string {
  const { webSearch, searched, searchCount } = args
  if (!webSearch) return ''
  if (searched) return `已联网检索同类型范文 ${searchCount ?? 0} 次`
  return '已开启联网，但本次未触发检索（模型凭已有知识写作）'
}
