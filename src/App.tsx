import { AppProvider, useApp } from './store/AppContext'
import { ModeSwitcher } from './components/ModeSwitcher'
import { CanvasMatrix } from './components/CanvasMatrix'
import { CanvasBlock } from './components/CanvasBlock'
import { BookLibrary } from './components/BookLibrary'
import { BookGenerator } from './components/BookGenerator'

function Workbench() {
  const { state } = useApp()
  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✍</span>
          <div>
            <h1>作家模拟器</h1>
            <p className="brand-sub">多画布并行编辑 · 一个链接两种入口</p>
          </div>
        </div>
        <div className="header-actions">
          <BookGenerator />
          <ModeSwitcher />
        </div>
      </header>
      <main className="main">
        <aside className="sidebar">
          <CanvasMatrix />
        </aside>
        <section className="workarea">
          {state.selectedCanvasId ? <CanvasBlock /> : <EmptyState />}
        </section>
      </main>
      <footer className="footer">
        <BookLibrary />
      </footer>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="empty">
      <p className="empty-title">在左侧挑一块画布开始</p>
      <p className="empty-hint">画布之间可手动连线，改一处会触发级联</p>
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Workbench />
    </AppProvider>
  )
}
