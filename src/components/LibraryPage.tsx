import { useMemo, useState } from 'react'
import { useApp } from '../store/AppContext'

/* ============================================================
   作品库 · 独立页面（#/library）—— v10.42 LIB-01 / LIB-02
   ------------------------------------------------------------
   原来作品库是右上角点出来的**弹窗**：关掉就没了、不能直接用 URL 访问、
   也没法在里面搜索 / 排序 / 批量看。现在改成独立路由页：
     顶部：搜索框 + 排序（最近编辑 / 书名 / 字数）+ 计数
     主体：作品卡片网格（书名 / 字数 / 章节 / 最近编辑 / 状态）
     点卡片 → 进工作台并自动选中那本书

   空状态（LIB-02）不再用文字描述「去哪里点哪个按钮」，
   直接给两个行动按钮：从一个脑洞开始 / 粘贴我的旧稿。
   ============================================================ */

type SortKey = 'updated' | 'title' | 'words'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: '最近编辑' },
  { key: 'title', label: '书名' },
  { key: 'words', label: '字数' },
]

const fmtTime = (s?: string) => {
  if (!s) return '—'
  const d = new Date(s.replace(/\//g, '-'))
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 这本书写到哪了 */
function progressOf(book: { outline?: unknown[]; chapterWritings?: Record<string, unknown> }) {
  const total = book.outline?.length ?? 0
  const done = Object.keys(book.chapterWritings ?? {}).length
  if (total && done >= total) return { label: '已完成', done, total }
  return { label: '写作中', done, total }
}

export function LibraryPage({ onOpenBook }: { onOpenBook: (bookId: string) => void }) {
  const { state, removeBook, restoreBook, purgeBook } = useApp()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('updated')
  /** v10.43 DEL-01：回收站展开状态 */
  const [trashOpen, setTrashOpen] = useState(false)

  const trashed = state.trash ?? []
  /** 距离自动清除还剩几天（保留 30 天） */
  const daysLeft = (iso: string) => {
    const gone = new Date(iso).getTime()
    if (Number.isNaN(gone)) return 30
    return Math.max(0, 30 - Math.floor((Date.now() - gone) / 86400000))
  }

  const books = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const list = (state.library ?? []).filter(b => {
      if (!kw) return true
      return (
        (b.title || '').toLowerCase().includes(kw) ||
        (b.synopsis || '').toLowerCase().includes(kw) ||
        (b.outline ?? []).some(c => (c.title || '').toLowerCase().includes(kw))
      )
    })
    const arr = [...list]
    arr.sort((a, b) => {
      if (sort === 'title') return (a.title || '').localeCompare(b.title || '', 'zh-CN')
      if (sort === 'words') return (Number(b.stats?.totalWords) || 0) - (Number(a.stats?.totalWords) || 0)
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    })
    return arr
  }, [state.library, q, sort])

  return (
    <div className="lib-page">
      <header className="lib-head">
        <div className="lib-head-left">
          <h2 className="lib-title">作品库</h2>
          <span className="lib-count">共 {state.library?.length ?? 0} 本</span>
        </div>
        <div className="lib-head-right">
          <input
            className="lib-search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索书名 / 简介 / 章节标题"
          />
          <div className="seg lib-sort" role="group" aria-label="排序方式">
            {SORTS.map(s => (
              <button
                key={s.key}
                type="button"
                className={`seg-btn ${sort === s.key ? 'active' : ''}`}
                onClick={() => setSort(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {/* v10.43 DEL-01：回收站入口（有删过的书才出现） */}
          {trashed.length > 0 && (
            <button
              className={`ghost-btn sm lib-trash-btn ${trashOpen ? 'on' : ''}`}
              onClick={() => setTrashOpen(v => !v)}
              title="你删掉的作品会在这里保留 30 天，随时能恢复"
            >
              回收站（{trashed.length}）
            </button>
          )}
        </div>
      </header>

      {/* v10.43 DEL-01：回收站 —— 删错了有后悔药；被管理员删的能看到原因 */}
      {trashOpen && trashed.length > 0 && (
        <div className="lib-trash">
          <p className="lib-trash-hint">
            这些是你删掉的作品，<b>保留 30 天</b>，到期自动清除。恢复后会回到上面的列表。
          </p>
          <ul className="lib-trash-list">
            {trashed.map(b => {
              const adminDeleted = b.deletedBy === 'admin'
              return (
                <li key={b.id} className={`lib-trash-item ${adminDeleted ? 'admin' : ''}`}>
                  <span className="lib-trash-name">《{b.title || '未命名'}》</span>
                  <span className="lib-trash-meta">
                    {(Number(b.stats?.totalWords) || 0).toLocaleString('zh-CN')} 字
                  </span>
                  {adminDeleted ? (
                    <span className="lib-trash-note">
                      已被管理员删除{b.deleteReason ? `：${b.deleteReason}` : ''}（不可恢复，可联系管理员）
                    </span>
                  ) : (
                    <>
                      <span className="lib-trash-note">{daysLeft(b.deletedAt)} 天后自动清除</span>
                      <button className="ghost-btn sm" onClick={() => restoreBook(b.id)}>
                        ↩ 恢复
                      </button>
                      <button
                        className="ghost-btn sm danger"
                        onClick={() => {
                          if (
                            window.confirm(
                              `《${b.title}》将被彻底删除，无法恢复。确定吗？`,
                            )
                          ) {
                            purgeBook(b.id)
                          }
                        }}
                      >
                        彻底删除
                      </button>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {books.length === 0 ? (
        <div className="lib-empty">
          {/* LIB-02：给按钮，不要让用户自己去猜「去哪里点哪个」 */}
          <p className="lib-empty-title">
            {q.trim() ? '没有匹配的作品' : '还没有作品。想怎么开始？'}
          </p>
          {!q.trim() && (
            <div className="lib-empty-actions">
              <button
                className="primary-btn"
                onClick={() => {
                  window.location.hash = '#/novel-brain'
                }}
              >
                从一个脑洞开始
              </button>
              <button
                className="ghost-btn"
                onClick={() => {
                  window.location.hash = '#/workspace'
                }}
                title="进创作台的「拆解」，把旧稿 / 大纲粘进去，AI 按 7 个维度拆好"
              >
                粘贴我的旧稿
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="lib-grid">
          {books.map(b => {
            const prog = progressOf(b)
            return (
              <div key={b.id} className="lib-card-wrap">
                <button className="lib-card" onClick={() => onOpenBook(b.id)}>
                  <span className="lib-card-title">{b.title || '未命名'}</span>
                  <span className="lib-card-synopsis">{b.synopsis || '（还没写简介）'}</span>
                  <span className="lib-card-meta">
                    <span>{(Number(b.stats?.totalWords) || 0).toLocaleString('zh-CN')} 字</span>
                    <span>
                      {prog.done}/{prog.total} 章
                    </span>
                    <span className={`lib-card-state ${prog.label === '已完成' ? 'done' : ''}`}>
                      {prog.label}
                    </span>
                  </span>
                  <span className="lib-card-time">最近编辑：{fmtTime(b.createdAt)}</span>
                </button>
                {/* v10.43 DEL-01：删除入口 —— 原来只有已停用的弹窗里能删，用户根本删不到。
                    现在是软删除：进回收站留 30 天，删错了能恢复。 */}
                <button
                  className="lib-card-del"
                  title="删除这本（会先放进回收站，30 天内可恢复）"
                  onClick={e => {
                    e.stopPropagation()
                    if (
                      window.confirm(
                        `删除《${b.title || '未命名'}》？\n\n会先放进回收站保留 30 天，随时可以恢复。`,
                      )
                    ) {
                      removeBook(b.id)
                    }
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
