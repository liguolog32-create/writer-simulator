import { useApp } from '../store/AppContext'

export function ModeSwitcher() {
  const { state, dispatch } = useApp()
  return (
    <div className="mode-switcher" role="tablist" aria-label="访问模式">
      <button
        role="tab"
        aria-selected={state.mode === 'read'}
        className={state.mode === 'read' ? 'tab active' : 'tab'}
        onClick={() => dispatch({ type: 'SET_MODE', mode: 'read' })}
      >
        只读访客
      </button>
      <button
        role="tab"
        aria-selected={state.mode === 'admin'}
        className={state.mode === 'admin' ? 'tab active' : 'tab'}
        onClick={() => dispatch({ type: 'SET_MODE', mode: 'admin' })}
      >
        管理后台
      </button>
    </div>
  )
}
