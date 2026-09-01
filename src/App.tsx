import { useState } from 'react'
import { AppProvider, useApp } from './store/AppContext'
import { ModeSwitcher } from './components/ModeSwitcher'
import { CanvasMatrix } from './components/CanvasMatrix'
import { CanvasBlock } from './components/CanvasBlock'
import { BookLibrary } from './components/BookLibrary'
import { BookGenerator } from './components/BookGenerator'
import { BookShelf } from './components/BookShelf'
import { Workbench } from './components/Workbench'
import { ChapterWriter } from './components/ChapterWriter'

type View = 'canvas' | 'workbench' | 'chapter'

function AppShell() {
  const { state } = useApp()
  const [view, setView] = useState<View>('canvas')

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✍</span>
          <div>
            <h1>作家模拟器</h1>
            <p className="brand-sub">多画布并行编辑 · 原文拆解 · 修改续写</p>
          </div>
        </div>
        <div className="header-actions">
          <BookShelf />
          <BookGenerator />
          <ModeSwitcher />
        </div>
      </header>

      <nav className="viewtabs">
        <button
          className={`viewtab ${view === 'canvas' ? 'active' : ''}`}
          onClick={() => setView('canvas')}
        >
          多画布 · 合成新书
        </button>
        <button
          className={`viewtab ${view === 'workbench' ? 'active' : ''}`}
          onClick={() => setView('workbench')}
        >
          工作台 · 拆解 / 修改 / 续写
        </button>
        <button
          className={`viewtab ${view === 'chapter' ? 'active' : ''}`}
          onClick={() => setView('chapter')}
        >
          章节精修 · 逐章 AI 创作
        </button>
      </nav>

      <main className="main">
        <aside className="sidebar">
          <CanvasMatrix />
        </aside>
        <section className="workarea">
          {view === 'workbench' ? (
            <Workbench />
          ) : view === 'chapter' ? (
            <ChapterWriter />
          ) : state.selectedCanvasId ? (
            <CanvasBlock />
          ) : (
            <EmptyState />
          )}
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
      <AppShell />
    </AppProvider>
  )
}
