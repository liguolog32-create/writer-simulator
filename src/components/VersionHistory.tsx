import { useState } from 'react'
import { useApp } from '../store/AppContext'
import type { SnapshotCanvas, StorySnapshot } from '../types'

/* ============================================================
   画布历史版本 —— v10.31
   ------------------------------------------------------------
   背景：7 块画布是整个产品的唯一真源（所有生成都从它出发），但它此前
   没有任何自动版本保护 —— 唯一的「版本快照」要手动去「项目资产」页存，
   真被 AI 改坏的时候手上通常什么都没留。

   现在改成自动：AI 每次要覆盖画布之前，系统先自动拍一份（见 AppContext.autoSnapshot）。
   入口就放在画布页，因为它服务的就是「画布被改坏了」这件事。
   你仍然可以手动「存一个版本」——比如准备大改设定之前自己先打个点。
   ============================================================ */

const fmtTime = (iso: string) => {
  const t = Date.parse(iso)
  if (!t) return iso
  const d = new Date(t)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function VersionHistory() {
  const {
    state,
    assets,
    assetsLoading,
    reloadAssets,
    restoreSnapshot,
    deleteAsset,
    saveAsset,
  } = useApp()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  const snaps = assets.snaps
  const autoCount = snaps.filter(s => s.auto).length

  /** 这一版与「现在」不同的画布；空数组 = 和现在一样。
      存档的键是**画布 id**（APPLY_SNAPSHOT 按 id 回滚），展示时翻成维度名。 */
  const diffDims = (snap: StorySnapshot) =>
    Object.entries(snap.canvases)
      .filter(([id, v]) => (state.canvases[id]?.content ?? '') !== (v.content ?? ''))
      .map(([id]) => state.canvases[id]?.dimension ?? id)

  const saveManual = () => {
    const label = name.trim() || `手动存档 ${fmtTime(new Date().toISOString())}`
    const canvases: Record<string, SnapshotCanvas> = {}
    // 与 autoSnapshot 一致：键用画布 id，否则回滚会静默失效
    Object.values(state.canvases).forEach(c => {
      canvases[c.id] = { content: c.content, locked: Boolean(c.locked) }
    })
    if (!Object.values(canvases).some(v => (v.content || '').trim())) {
      setMsg('画布还是空的，没什么可存的')
      return
    }
    void saveAsset('snap', {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: label,
      note: '手动存档',
      canvases,
      libraryCount: state.library.length,
      createdAt: new Date().toISOString(),
    })
    setName('')
    setMsg(`✅ 已存下「${label}」`)
  }

  return (
    <div className="vh">
      <div className="vh-bar">
        {/* v10.42 EDIT-03：0 版本时不再挂一个永远显示（0）的按钮占位，
            改成一行灰色小字说明「自动存档已开启」；有版本了才变成可操作按钮 */}
        {snaps.length === 0 ? (
          <span className="vh-hint vh-idle">
            自动存档已开启 · AI 每次修改画布前都会自动留一份，改坏了可回滚
          </span>
        ) : (
          <>
            <button
              className={`ghost-btn sm vh-toggle ${open ? 'open' : ''}`}
              onClick={() => setOpen(o => !o)}
              title="每次 AI 要改画布前，系统都会自动存一份；改坏了可以退回去"
            >
              ↶ 历史版本（{snaps.length}）
            </button>
            {!open && (
              <span className="vh-hint">
                AI 每次修改前自动存档，可回滚
                {autoCount > 0 ? ` · 其中 ${autoCount} 份是自动存的` : ''}
              </span>
            )}
            {open && <span className="vh-hint">{msg}</span>}
          </>
        )}
      </div>

      {open && (
        <div className="vh-panel">
          <div className="vh-head">
            <span className="vh-title">画布历史版本</span>
            <span className="vh-sub">
              回滚是整块替换 7 块画布；锁定画布也会被一起替换
            </span>
            <button className="ghost-btn sm" onClick={() => void reloadAssets()} disabled={assetsLoading}>
              {assetsLoading ? '同步中…' : '↻ 刷新'}
            </button>
          </div>

          <div className="vh-save">
            <input
              className="vh-save-input"
              value={name}
              placeholder="准备大改之前，先存一个版本（可留空自动命名）"
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveManual()
              }}
            />
            <button className="ghost-btn sm" onClick={saveManual}>
              ＋ 存一个版本
            </button>
          </div>

          {!snaps.length && (
            <p className="vh-empty">
              还没有任何版本。等你点一次「原文拆解」「脑洞长框架」这类会改写画布的操作，这里就会自动出现存档。
            </p>
          )}

          <ul className="vh-list">
            {snaps.map(s => {
              const diff = diffDims(s)
              return (
                <li key={s.id} className="vh-item">
                  <div className="vh-item-main">
                    <span className={`vh-tag ${s.auto ? 'auto' : 'manual'}`}>
                      {s.auto ? '自动' : '手动'}
                    </span>
                    <span className="vh-name">{s.name}</span>
                    <span className="vh-time">{fmtTime(s.createdAt)}</span>
                  </div>
                  <div className="vh-item-meta">
                    {diff.length === 0 ? (
                      <span className="vh-same">与当前画布一致</span>
                    ) : (
                      <>
                        <span className="vh-dim-label">会改动：</span>
                        {diff.map(d => (
                          <span key={d} className="vh-dim">
                            {d}
                          </span>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="vh-item-actions">
                    <button
                      className="ghost-btn sm"
                      onClick={() => setMsg(restoreSnapshot(s.id))}
                      title="把 7 块画布整块换回这一版（回滚前会自动再存一份现在）"
                    >
                      ↩ 回滚到这一版
                    </button>
                    <button
                      className="ghost-btn sm danger"
                      onClick={() => {
                        void deleteAsset('snap', s.id)
                        setMsg(`已删除「${s.name}」`)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
