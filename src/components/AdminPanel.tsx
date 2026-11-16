import { Icon } from './Icon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookLibrary } from './BookLibrary'
import { createPortal } from 'react-dom'
import { useApp } from '../store/AppContext'
import { DIMENSIONS } from '../lib/dims'
import {
  adminAuditList,
  adminBackupList,
  adminBackupRestore,
  adminBackupRun,
  adminCorpusSave,
  adminOverview,
  adminSettingsSave,
  adminUserAssetGet,
  adminUserAssetsList,
  adminUserBookGet,
  adminUserContentOverview,
  adminTrainModel,
  adminUserDelete,
  adminUserList,
  adminUserResetPassword,
  adminUserSetRole,
  adminUserSetStatus,
  adminUserStateGet,
  platformGet,
  type AdminBackupItem,
  type AdminOverview,
  type AdminUserRow,
  type AuditRow,
  type PlatformSettings,
  type UserAssetMeta,
  type UserAssetsListResult,
  type UserBookResult,
  type UserContentOverview,
  type TrainResult,
} from '../lib/adminClient'
import { purposeLabel, type AppState, type AssetKind, type AtomicSetting, type Canvas, type SavedBook, type StoryBranch, type StorySnapshot } from '../types'
import { currentLibrary, defaultBookKeys, type BookMeta } from '../data/aiRecommendations'
// v10.25 积分的「全站总览 + 发放」从顶栏下拉挪进管理后台（管理类操作就该待在管理后台）
import { fetchAdminCredits, grantCredits } from '../lib/creditsClient'

/* ============================================================
   管理后台
   ------------------------------------------------------------
   ⚠️ 这个组件「渲染出来」不是权限，只是把人挡住了。
      真正能不能调这些接口由 Worker 的 requireAdmin 决定 ——
      角色取自 D1 的 users.role，请求体里说什么都不算数。
      所以即使有人手工构造 POST，也只会拿到 403。
   ============================================================ */

type Tab =
  | 'overview'
  | 'users'
  | 'usercontent'
  | 'credits'
  | 'platform'
  /** v10.45：书库类型（素材库盘点）—— 从全局页脚挪进来的，只在这里可见 */
  | 'library'
  | 'backup'
  | 'audit'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview', label: '总览', icon: '📊' },
  { id: 'users', label: '账号与权限', icon: '👥' },
  { id: 'usercontent', label: '用户创作', icon: '📖' },
  // v10.25：全站积分总览 + 逐人发放（原先挤在顶栏积分下拉里）
  { id: 'credits', label: '积分 / 付费额度', icon: '💎' },
  { id: 'platform', label: '平台语料 / 设置', icon: '🗂' },
  { id: 'library', label: '书库类型', icon: '📚' },
  { id: 'backup', label: '备份与还原', icon: '💾' },
  { id: 'audit', label: '审计日志', icon: '📜' },
]

/** 顶栏入口：非管理员这里直接不渲染，页面上根本看不到管理后台这个东西 */
export function AdminEntry() {
  const { isAdmin } = useApp()
  const [open, setOpen] = useState(false)
  if (!isAdmin) return null
  return (
    <>
      <button className="ghost-btn admin-entry" onClick={() => setOpen(true)} title="仅管理员可见">
        <Icon name="gear" /> 管理后台
      </button>
      {open && <AdminPanel onClose={() => setOpen(false)} />}
    </>
  )
}

/* ---------------- 通用小工具 ---------------- */

/** 每个 Tab 自己负责加载，挂载即拉取；改完数据调 run() 刷新 */
function useAsync<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const run = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setData(await loaderRef.current())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => {
    void run()
  }, [run])
  return { data, busy, error, run }
}

const fmtTime = (iso?: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}
const fmtSize = (n?: number) => {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(2)} MB`
}
const num = (n?: number) => (Number(n) || 0).toLocaleString('zh-CN')

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="adm-stat">
      <span className="adm-stat-label">{label}</span>
      <strong className="adm-stat-value">{value}</strong>
      {hint && <span className="adm-stat-hint">{hint}</span>}
    </div>
  )
}

/* ---------------- 面板主体 ---------------- */

function AdminPanel({ onClose }: { onClose: () => void }) {
  const { user } = useApp()
  const [tab, setTab] = useState<Tab>('overview')

  // portal 到 body：顶栏的 backdrop-filter 会把 fixed 遮罩困在 54px 的顶栏里（v11 回归），
  // 挂到 body 才能真正全屏居中、盖住页面内容
  return createPortal(
    <div className="adm-mask" onClick={onClose}>
      <div className="adm" onClick={e => e.stopPropagation()}>
        <header className="adm-head">
          <div>
            <h2 className="adm-title"><Icon name="gear" /> 管理后台</h2>
            <p className="adm-sub">
              当前管理员 <strong>{user?.username}</strong> · 所有写操作都会记入审计日志
            </p>
          </div>
          <button className="ghost-btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="adm-body">
          <nav className="adm-rail">
            {TABS.map(t => (
              <button
                key={t.id}
                className={`adm-rail-btn ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="adm-rail-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>

          <section className="adm-pane">
            {tab === 'overview' && <OverviewTab />}
            {tab === 'users' && <UsersTab />}
            {tab === 'usercontent' && <UserContentTab />}
            {tab === 'credits' && <CreditsTab />}
            {tab === "platform" && <PlatformTab />}
            {tab === 'library' && <BookLibrary />}
            {tab === 'backup' && <BackupTab />}
            {tab === 'audit' && <AuditTab />}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ---------------- 1. 总览 ---------------- */

function OverviewTab() {
  const { data, busy, error, run } = useAsync<AdminOverview>(() => adminOverview())
  const [train, setTrain] = useState<TrainResult | null>(null)
  const [training, setTraining] = useState(false)
  const [trainErr, setTrainErr] = useState('')

  const runTrain = async () => {
    if (!window.confirm('用全站存下的作品训练优化模型？\n会为每个有作品的用户生成写作画像，并把优秀段落写进案例库（全量重算）。')) return
    setTraining(true)
    setTrainErr('')
    try {
      const r = await adminTrainModel()
      setTrain(r)
    } catch (e) {
      setTrainErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTraining(false)
    }
  }

  if (error) return <ErrorBox error={error} onRetry={run} />
  if (!data) return <p className="adm-loading">{busy ? '读取中…' : '暂无数据'}</p>

  return (
    <div className="adm-section">
      <div className="adm-bar">
        <h3 className="adm-h3">平台总览</h3>
        <button className="ghost-btn sm" onClick={run} disabled={busy}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className="adm-stats">
        <Stat label="账号总数" value={num(data.users)} hint={`管理员 ${num(data.admins)} · 停用 ${num(data.disabled)}`} />
        <Stat label="在线会话" value={num(data.liveSessions)} hint="30 天内有效 token" />
        <Stat label="KV 业务键" value={num(data.kvKeys)} hint={`备份文件 ${num(data.backupFiles)} 个`} />
        <Stat
          label="语料覆盖层"
          value={num(data.corpusOverride)}
          hint={`其中墓碑 ${num(data.corpusTombstones)} 本 · ${fmtTime(data.corpusUpdatedAt)}`}
        />
        <Stat label="备份保留" value={`最近 ${num(data.backupKeep)} 份`} hint={data.r2Bound ? 'R2 已绑定' : 'R2 未开通，走 KV'} />
        <Stat label="审计条目" value={num(data.auditCount)} />
      </div>

      <div className="adm-card" style={{ marginTop: 10 }}>
        <div className="adm-bar">
          <div>
            <h4 className="adm-h4" style={{ margin: 0 }}>写作优化模型</h4>
            <p className="adm-dim" style={{ margin: '2px 0 0' }}>
              用全站用户存下的画布与作品蒸馏成风格画像 + 七维权重 + 案例库，供优化引擎对齐。
            </p>
          </div>
          <button className="ghost-btn sm" onClick={runTrain} disabled={training}>
            {training ? '训练中…' : '训练优化模型'}
          </button>
        </div>
        {trainErr && <p className="adm-msg bad">❌ {trainErr}</p>}
        {train && (
          <p className="adm-note" style={{ marginTop: 8 }}>
            已训练 <strong>{num(train.userCount)}</strong> 位用户 · <strong>{num(train.bookCount)}</strong> 部作品 ·{' '}
            <strong>{num(train.caseCount)}</strong> 条案例。
            风格分布：{Object.entries(train.styleTagDistribution).map(([k, v]) => `${k} ${v}`).join('、') || '无'}。
            训练时间：{fmtTime(train.trainedAt)}
          </p>
        )}
      </div>

      <h4 className="adm-h4">D1 数据表计数</h4>
      <table className="adm-table">
        <thead>
          <tr>
            <th>表</th>
            <th className="num">行数</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.d1Tables || {}).map(([t, n]) => (
            <tr key={t}>
              <td><code>{t}</code></td>
              <td className="num">{num(n)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="adm-note">
        Worker <code>v{data.version}</code> · 这些数字都不含任何稿件正文，只有计数。
      </p>
    </div>
  )
}

/* ---------------- 2. 账号与权限 ---------------- */

function UsersTab() {
  const { user } = useApp()
  const { data, busy, error, run } = useAsync(() => adminUserList())
  const [msg, setMsg] = useState('')
  const [reset, setReset] = useState<{ username: string; password: string } | null>(null)
  const [working, setWorking] = useState('')

  const guard = async (uid: string, label: string, fn: () => Promise<unknown>, okText: string) => {
    setMsg('')
    setWorking(uid)
    try {
      await fn()
      setMsg(`✅ ${label}：${okText}`)
      await run()
    } catch (e) {
      setMsg(`❌ ${label}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setWorking('')
    }
  }

  if (error) return <ErrorBox error={error} onRetry={run} />

  const rows: AdminUserRow[] = data?.items ?? []

  return (
    <div className="adm-section">
      <div className="adm-bar">
        <h3 className="adm-h3">
          账号与权限 <span className="adm-dim">共 {num(data?.total)} 个</span>
        </h3>
        <button className="ghost-btn sm" onClick={run} disabled={busy}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>

      {msg && <p className={`adm-msg ${msg.startsWith('✅') ? 'ok' : 'bad'}`}>{msg}</p>}

      {reset && (
        <div className="adm-reset-box">
          <p>
            <strong>{reset.username}</strong> 的密码已重置。这条明文只显示这一次，请立刻转达，对方登录后应立即自行修改：
          </p>
          <div className="adm-reset-pwd">
            <code>{reset.password}</code>
            <button
              className="ghost-btn sm"
              onClick={() => {
                void navigator.clipboard?.writeText(reset.password)
                setMsg('✅ 已复制到剪贴板')
              }}
            >
              复制
            </button>
            <button className="ghost-btn sm" onClick={() => setReset(null)}>
              我已记下
            </button>
          </div>
        </div>
      )}

      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>角色</th>
              <th>状态</th>
              <th className="num">作品</th>
              <th className="num">章节</th>
              <th className="num">在线</th>
              <th>最近登录</th>
              <th className="act">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(u => {
              const isSelf = u.user_id === user?.userId
              const isAdmin = u.role === 'admin'
              const disabled = u.status !== 'active'
              const busyRow = working === u.user_id
              return (
                <tr key={u.user_id} className={disabled ? 'adm-row-off' : ''}>
                  <td>
                    <div className="adm-user">
                      <strong>{u.username}</strong>
                      {isSelf && <span className="adm-tag me">你</span>}
                      {u.note && <span className="adm-dim">{u.note}</span>}
                    </div>
                    <code className="adm-uid">{u.user_id}</code>
                  </td>
                  <td>
                    <span className={`adm-tag ${isAdmin ? 'admin' : ''}`}>{isAdmin ? '管理员' : '普通用户'}</span>
                  </td>
                  <td>
                    <span className={`adm-tag ${disabled ? 'off' : 'on'}`}>{disabled ? '已停用' : '正常'}</span>
                  </td>
                  <td className="num">{num(u.projects)}</td>
                  <td className="num">{num(u.chapters)}</td>
                  <td className="num">{num(u.live_sessions)}</td>
                  <td className="adm-dim">{fmtTime(u.last_login_at)}</td>
                  <td className="act">
                    <div className="adm-actions">
                      <button
                        className="ghost-btn sm"
                        disabled={busyRow || isSelf}
                        title={isSelf ? '不能改自己的角色 —— 会把自己锁在门外' : ''}
                        onClick={() =>
                          guard(
                            u.user_id,
                            u.username,
                            () => adminUserSetRole(u.user_id, isAdmin ? 'user' : 'admin'),
                            isAdmin ? '已是普通用户' : '已提升为管理员',
                          )
                        }
                      >
                        {isAdmin ? '降为普通' : '提升管理员'}
                      </button>
                      <button
                        className="ghost-btn sm"
                        disabled={busyRow || isSelf}
                        title={isSelf ? '不能停用自己' : ''}
                        onClick={() =>
                          guard(
                            u.user_id,
                            u.username,
                            () => adminUserSetStatus(u.user_id, disabled ? 'active' : 'disabled'),
                            disabled ? '已启用' : '已停用并踢下线',
                          )
                        }
                      >
                        {disabled ? '启用' : '停用'}
                      </button>
                      <button
                        className="ghost-btn sm"
                        disabled={busyRow}
                        onClick={async () => {
                          if (!window.confirm(`重置「${u.username}」的密码？\n该账号所有已登录设备会被踢下线。`)) return
                          setMsg('')
                          setWorking(u.user_id)
                          try {
                            const r = await adminUserResetPassword(u.user_id)
                            setReset({ username: r.username, password: r.password })
                            await run()
                          } catch (e) {
                            setMsg(`❌ 重置失败：${e instanceof Error ? e.message : String(e)}`)
                          } finally {
                            setWorking('')
                          }
                        }}
                      >
                        重置密码
                      </button>
                      <button
                        className="ghost-btn sm danger"
                        disabled={busyRow || isSelf}
                        title={isSelf ? '不能删除自己' : ''}
                        onClick={async () => {
                          const ans = window.prompt(
                            `删除「${u.username}」不可撤销：\n· 该账号的云端画布、作品库、项目资产全部清除\n· 它的备份也会一并删除\n\n请输入账号名确认：`,
                            '',
                          )
                          if (ans !== u.username) {
                            if (ans !== null) setMsg('❌ 输入的账号名不匹配，已取消删除')
                            return
                          }
                          await guard(
                            u.user_id,
                            u.username,
                            () => adminUserDelete(u.user_id),
                            '账号及数据已删除',
                          )
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="adm-note">
        角色是服务端事实：改完立刻生效（对方下次打开页面时 <code>authMe</code> 会带回新角色）。
        你自己那行的按钮被禁用，是为了防止把最后一个管理员弄没、谁都进不来。
      </p>
    </div>
  )
}

/* ---------------- 3. 平台语料 / 设置 ---------------- */

type CorpusStatus = 'default' | 'overridden' | 'deleted' | 'custom'

const STATUS_LABEL: Record<CorpusStatus, string> = {
  default: '内置',
  overridden: '已改写',
  deleted: '已删除',
  custom: '自定义',
}

function PlatformTab() {
  const { reloadPlatform } = useApp()
  const { data, busy, error, run } = useAsync(() => platformGet())
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ key: string; author: string; tags: string; dims: Record<string, { feature: string; example: string }> } | null>(null)
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  const defaults = useMemo(() => new Set(defaultBookKeys()), [])
  const overlay = data?.corpus.books ?? {}

  const statusOf = (key: string): CorpusStatus => {
    const has = Object.prototype.hasOwnProperty.call(overlay, key)
    if (!has) return 'default'
    if (overlay[key] === null) return 'deleted'
    return defaults.has(key) ? 'overridden' : 'custom'
  }

  /** 列表 = 内置 ∪ 覆盖层（被删的也要列出来，否则没法撤销删除） */
  const keys = useMemo(() => {
    const all = new Set<string>([...defaults, ...Object.keys(overlay)])
    const list = [...all].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    const kw = keyword.trim().toLowerCase()
    if (!kw) return list
    return list.filter(k => k.toLowerCase().includes(kw))
  }, [defaults, overlay, keyword])

  /** 打开编辑器：草稿从「运行时合并后的内容」取，这样看到什么就编辑什么 */
  const openBook = (key: string) => {
    const eff = overlay[key]
    // 覆盖层优先；没覆盖就取合并后的出厂内容
    const meta: BookMeta | null = eff === null ? null : eff ?? currentLibrary()[key] ?? null
    const dims: Record<string, { feature: string; example: string }> = {}
    for (const d of DIMENSIONS) {
      const src = meta?.byDimension?.[d]
      dims[d] = { feature: src?.feature ?? '', example: src?.example ?? '' }
    }
    setSelected(key)
    setDraft({
      key,
      author: meta?.author ?? '',
      tags: (meta?.tags ?? []).join('、'),
      dims,
    })
    setMsg('')
  }

  const submit = async (payload: Record<string, BookMeta | null | string>, okText: string) => {
    setMsg('')
    setSaving(true)
    try {
      await adminCorpusSave(payload as Record<string, BookMeta | null>)
      setMsg(`✅ ${okText}`)
      await run()
      await reloadPlatform()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = async () => {
    if (!draft) return
    const key = draft.key.trim()
    if (!key) {
      setMsg('❌ 书名不能为空')
      return
    }
    const byDimension: Record<string, { feature: string; example: string }> = {}
    for (const d of DIMENSIONS) {
      const v = draft.dims[d]
      if (!v) continue
      if (!v.feature.trim() && !v.example.trim()) continue
      byDimension[d] = { feature: v.feature, example: v.example }
    }
    if (!Object.keys(byDimension).length) {
      setMsg('❌ 至少要填一个维度的分析')
      return
    }
    const meta: BookMeta = {
      author: draft.author.trim(),
      tags: draft.tags
        .split(/[、,，\s]+/)
        .map(s => s.trim())
        .filter(Boolean),
      byDimension,
    }
    setSelected(key)
    await submit({ [key]: meta }, `已保存《${key}》（${Object.keys(byDimension).length} 个维度）`)
  }

  if (error) return <ErrorBox error={error} onRetry={run} />
  if (!data) return <p className="adm-loading">{busy ? '读取中…' : '暂无数据'}</p>

  return (
    <div className="adm-section">
      <SettingsCard settings={data.settings} updatedAt={data.settingsUpdatedAt} onSaved={run} />

      <div className="adm-bar">
        <h3 className="adm-h3">
          平台语料 <span className="adm-dim">
            {keys.length} 本 · 出厂 {defaults.size} 本 · 覆盖 {Object.keys(overlay).length} 项
          </span>
        </h3>
        <div className="adm-bar-right">
          <input
            className="adm-input"
            placeholder="搜索书名…"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
          />
          <button className="ghost-btn sm" onClick={() => openBook('')} disabled={saving}>
            ＋ 新增
          </button>
        </div>
      </div>

      {msg && <p className={`adm-msg ${msg.startsWith('✅') ? 'ok' : 'bad'}`}>{msg}</p>}

      <div className="adm-split">
        <div className="adm-list adm-scroll">
          {keys.map(k => (
            <button
              key={k}
              className={`adm-book ${selected === k ? 'active' : ''}`}
              onClick={() => openBook(k)}
            >
              <span className="adm-book-name">{k}</span>
              <span className={`adm-tag st-${statusOf(k)}`}>{STATUS_LABEL[statusOf(k)]}</span>
            </button>
          ))}
          {!keys.length && <p className="adm-empty">没有匹配的书</p>}
        </div>

        <div className="adm-editor adm-scroll">
          {!draft ? (
            <p className="adm-empty">从左边挑一本书开始编辑，或点「＋ 新增」加一本。</p>
          ) : (
            <>
              <div className="adm-bar">
                <h4 className="adm-h4">{draft.key ? `《${draft.key}》` : '新增语料'}</h4>
                {selected ? (
                  <span className={`adm-tag st-${statusOf(selected)}`}>{STATUS_LABEL[statusOf(selected)]}</span>
                ) : (
                  <span className="adm-dim">填好书名与至少一个维度后保存</span>
                )}
              </div>

              <label className="adm-field">
                <span>书名（作为匹配键，含书名号也行）</span>
                <input
                  className="adm-input wide"
                  value={draft.key}
                  disabled={Boolean(selected)}
                  onChange={e => setDraft({ ...draft, key: e.target.value })}
                  placeholder="《书名》作者：某某"
                />
              </label>
              <label className="adm-field">
                <span>作者</span>
                <input
                  className="adm-input wide"
                  value={draft.author}
                  onChange={e => setDraft({ ...draft, author: e.target.value })}
                />
              </label>
              <label className="adm-field">
                <span>标签（用、或逗号分隔）</span>
                <input
                  className="adm-input wide"
                  value={draft.tags}
                  onChange={e => setDraft({ ...draft, tags: e.target.value })}
                  placeholder="仙侠修真、女强、升级流"
                />
              </label>

              <div className="adm-dims">
                {DIMENSIONS.map(d => (
                  <div className="adm-dim-block" key={d}>
                    <h5 className="adm-dim-title">{d}</h5>
                    <label className="adm-field">
                      <span>特征</span>
                      <textarea
                        className="adm-textarea"
                        rows={3}
                        value={draft.dims[d]?.feature ?? ''}
                        onChange={e =>
                          setDraft({
                            ...draft,
                            dims: {
                              ...draft.dims,
                              [d]: { feature: e.target.value, example: draft.dims[d]?.example ?? '' },
                            },
                          })
                        }
                      />
                    </label>
                    <label className="adm-field">
                      <span>例证</span>
                      <textarea
                        className="adm-textarea"
                        rows={3}
                        value={draft.dims[d]?.example ?? ''}
                        onChange={e =>
                          setDraft({
                            ...draft,
                            dims: {
                              ...draft.dims,
                              [d]: { feature: draft.dims[d]?.feature ?? '', example: e.target.value },
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                ))}
              </div>

              <div className="adm-editor-actions">
                <button className="primary-btn" onClick={saveDraft} disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </button>
                {selected && defaults.has(selected) && statusOf(selected) === 'default' && (
                  <span className="adm-dim">这本书还是内置原样，没有可撤销的改动</span>
                )}
                {selected && statusOf(selected) !== 'default' && (
                  <button
                    className="ghost-btn sm"
                    disabled={saving}
                    onClick={() => void submit({ [selected]: '__reset__' }, `《${selected}》已恢复默认`)}
                  >
                    恢复默认
                  </button>
                )}
                {selected && statusOf(selected) !== 'deleted' && (
                  <button
                    className="ghost-btn sm danger"
                    disabled={saving}
                    onClick={() => {
                      if (!window.confirm(`从语料里删除《${selected}》？\n它会立刻不再参与检索；内置的那本可以用「恢复默认」找回来。`)) return
                      void submit({ [selected]: null }, `《${selected}》已删除`)
                    }}
                  >
                    删除这本书
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <p className="adm-note">
        改动写在 KV 覆盖层（<code>app:platform:corpus</code>），与打包进产物的出厂语料叠加。
        好处是改坏了也不至于没内容：把覆盖层清空，站点就回到出厂语料。
      </p>
    </div>
  )
}

/** 读运行时合并后的单本内容（编辑器草稿用它，保证所见即所改） */
function SettingsCard({
  settings,
  updatedAt,
  onSaved,
}: {
  settings: PlatformSettings
  updatedAt: string | null
  onSaved: () => Promise<void>
}) {
  const { reloadPlatform } = useApp()
  const [draft, setDraft] = useState<PlatformSettings>(settings)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(settings)
  }, [settings])

  const save = async () => {
    setBusy(true)
    setMsg('')
    try {
      await adminSettingsSave(draft)
      setMsg('✅ 站点设置已保存')
      await onSaved()
      await reloadPlatform()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="adm-card">
      <div className="adm-bar">
        <h3 className="adm-h3">站点设置</h3>
        <span className="adm-dim">最后改动 {fmtTime(updatedAt)}</span>
      </div>
      <label className="adm-check">
        <input
          type="checkbox"
          checked={draft.allowRegister}
          onChange={e => setDraft({ ...draft, allowRegister: e.target.checked })}
        />
        <span>
          允许自助注册新账号
          <em>关掉之后只有你能在下面帮别人开号，已经没有账号的人进不来</em>
        </span>
      </label>
      <label className="adm-field">
        <span>首页公告（留空即不显示）</span>
        <input
          className="adm-input wide"
          maxLength={300}
          value={draft.announcement}
          onChange={e => setDraft({ ...draft, announcement: e.target.value })}
          placeholder="例如：本周维护中，语料库更新至 48 本"
        />
      </label>
      {msg && <p className={`adm-msg ${msg.startsWith('✅') ? 'ok' : 'bad'}`}>{msg}</p>}
      <div className="adm-editor-actions">
        <button className="primary-btn" onClick={save} disabled={busy}>
          {busy ? '保存中…' : '保存设置'}
        </button>
      </div>
    </div>
  )
}

/* ---------------- 4. 备份与还原 ---------------- */

function BackupTab() {
  const { data, busy, error, run } = useAsync(() => adminBackupList(80))
  const users = useAsync(() => adminUserList())
  const [msg, setMsg] = useState('')
  const [working, setWorking] = useState('')
  const [target, setTarget] = useState('')

  const doRun = async () => {
    setMsg('')
    setWorking('__run__')
    try {
      const r = await adminBackupRun(target)
      setMsg(
        r.ok
          ? `✅ 已完成备份（${r.stored}，${fmtSize(r.size)}${r.pruned ? `，裁掉旧备份 ${r.pruned} 份` : ''}）`
          : `❌ 备份失败：${r.error}`,
      )
      await run()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setWorking('')
    }
  }

  const doRestore = async (it: AdminBackupItem) => {
    const ownerText = it.uid ? `账号「${it.owner}」` : '全站'
    if (
      !window.confirm(
        `把 ${ownerText} 还原到 ${fmtTime(it.createdAt)} 的这一份？\n\n` +
          `· 该作用域下的云端数据会被这份备份整体替换\n` +
          `· 还原后该账号的登录会被清掉，必须重新登录（否则他浏览器里的旧数据会在下次同步时把还原结果盖回去）\n` +
          `· 这个操作不可撤销`,
      )
    )
      return
    setMsg('')
    setWorking(it.key)
    try {
      const r = await adminBackupRestore(it.uid, it.stamp)
      setMsg(
        `✅ 已还原 ${fmtTime(r.createdAt)} 的备份：恢复 ${r.kvRestored} 个键` +
          `${r.sessionsCleared ? `，清掉 ${r.sessionsCleared} 条登录态` : ''}`,
      )
      await run()
    } catch (e) {
      setMsg(`❌ 还原失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setWorking('')
    }
  }

  if (error) return <ErrorBox error={error} onRetry={run} />

  const items: AdminBackupItem[] = data?.items ?? []
  const restoreDisabled = (it: AdminBackupItem) => it.inline === false

  return (
    <div className="adm-section">
      <div className="adm-bar">
        <h3 className="adm-h3">
          备份与还原 <span className="adm-dim">{items.length} 份</span>
        </h3>
        <div className="adm-bar-right">
          <select className="adm-input" value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">全站（所有账号 + 平台数据）</option>
            {(users.data?.items ?? []).map(u => (
              <option key={u.user_id} value={u.user_id}>
                仅 {u.username}
              </option>
            ))}
          </select>
          <button className="ghost-btn sm" onClick={doRun} disabled={working === '__run__'}>
            {working === '__run__' ? '备份中…' : '立刻备份'}
          </button>
          <button className="ghost-btn sm" onClick={run} disabled={busy}>
            {busy ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {msg && <p className={`adm-msg ${msg.startsWith('✅') ? 'ok' : 'bad'}`}>{msg}</p>}

      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>归属</th>
              <th>类型</th>
              <th className="num">大小</th>
              <th className="act">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.key}>
                <td>{fmtTime(it.createdAt)}</td>
                <td>
                  <span className={`adm-tag ${it.uid ? '' : 'admin'}`}>{it.owner}</span>
                </td>
                <td className="adm-dim">{it.type || 'auto'}</td>
                <td className="num">{fmtSize(it.size)}</td>
                <td className="act">
                  <button
                    className="ghost-btn sm"
                    disabled={working === it.key || restoreDisabled(it)}
                    title={restoreDisabled(it) ? '这份备份只有元信息（压缩包超出 KV 内联上限），要还原需要开通 R2' : ''}
                    onClick={() => void doRestore(it)}
                  >
                    {working === it.key ? '还原中…' : restoreDisabled(it) ? '不可还原' : '还原'}
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={5} className="adm-empty">
                  还没有备份。全站备份每天由定时任务自动做一次，也可以点「立刻备份」。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="adm-note">
        每份备份只保留最近 {num(data?.keep)} 份，超出自动裁剪。
        全站备份包含平台语料覆盖层；单账号备份只包含那个账号名下的数据。
      </p>
    </div>
  )
}

/* ---------------- 5. 审计日志 ---------------- */

const ACTION_LABEL: Record<string, string> = {
  user_set_role: '改角色',
  user_set_status: '停用/启用',
  user_reset_password: '重置密码',
  user_delete: '删除账号',
  corpus_save: '改平台语料',
  settings_save: '改站点设置',
  backup_run: '手动备份',
  backup_restore: '还原备份',
}

/* ---------------- 积分 / 付费额度（v10.25）----------------
   全站每个用户的余额 / 消耗 / 真实成本，以及逐人发放。
   计价：真实成本 × 140% ÷ ¥0.001 = 积分（详见 worker 的 PRICE_CNY_PER_M）。
   ⚠️ 这一整屏都是「站方成本结构」，只有管理员能看到 —— 服务端 requireAdmin +
      creditsStatus 的 includeCost 双重把关，普通用户拿不到这些字段。 */

function CreditsTab() {
  const { data, busy, error, run } = useAsync(() => fetchAdminCredits())
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [working, setWorking] = useState('')
  const [note, setNote] = useState('')

  if (error) return <ErrorBox error={error} onRetry={run} />

  const t = data?.totals

  const doGrant = async (uid: string) => {
    const amount = Number((amounts[uid] || '').trim())
    if (!isFinite(amount) || amount === 0) {
      setNote('请填一个非 0 的积分数字（正数=发放，负数=扣回）')
      return
    }
    setWorking(uid)
    setNote('')
    try {
      const r = await grantCredits({ userId: uid, amount, mode: 'add', note: '管理后台发放' })
      setAmounts(p => ({ ...p, [uid]: '' }))
      setNote(
        `✅ ${uid} ${amount > 0 ? '发放' : '扣回'} ${Math.abs(amount)} 积分 → 该用户余额 ${Math.round(
          r.balance,
        ).toLocaleString('zh-CN')}`,
      )
      await run()
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setWorking('')
    }
  }

  return (
    <div className="adm-section">
      <div className="adm-bar">
        <h3 className="adm-h3">
          积分 / 付费额度
          <span className="adm-dim">
            真实成本 × {data ? Math.round(data.markup * 100) : 140}% ÷ ¥{data?.cnyPerCredit ?? 0.001} = 积分
          </span>
        </h3>
        <button className="ghost-btn sm" onClick={run} disabled={busy}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>

      {t && (
        <div className="adm-stats">
          <Stat label="全站真实成本" value={`¥${t.costCny.toFixed(4)}`} hint="真金白银付给 DeepSeek" />
          <Stat
            label="应计提"
            value={`¥${t.chargedCny.toFixed(4)}`}
            hint={`含 ${data ? Math.round((data.markup - 1) * 100) : 40}% 溢价`}
          />
          <Stat
            label="累计消耗积分"
            value={num(Math.round(t.used))}
            hint={`余额合计 ${num(Math.round(t.balance))}`}
          />
          <Stat label="累计调用" value={`${num(t.calls)} 次`} hint={`${num(t.tokens)} tokens`} />
        </div>
      )}

      {data?.anon && data.anon.calls > 0 && (
        <p className="adm-note">
          ⚠️ 另有 <b>{data.anon.calls}</b> 次未登录调用（真实成本 ¥{data.anon.costCny.toFixed(4)}、
          {num(data.anon.tokens)} tokens）记在 anon 名下 —— 这些不是注册账号的消耗。
        </p>
      )}
      {data?.peakNow && (
        <p className="adm-note">
          当前处于<b>高峰时段</b>（周一至周五 9:00–12:00 / 14:00–18:00 北京时间），单价按 2× 计。
        </p>
      )}

      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>余额</th>
              <th>已消耗</th>
              <th>真实成本</th>
              <th>调用</th>
              <th>发放 / 扣回积分</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map(u => (
              <tr key={u.userId}>
                <td>
                  {u.username}
                  {u.role === 'admin' && <span className="adm-tag admin">管理员</span>}
                  {u.status !== 'active' && <span className="adm-tag">已停用</span>}
                </td>
                <td>{num(Math.round(u.balance))}</td>
                <td>{num(Math.round(u.used))}</td>
                <td>
                  ¥{u.costCny.toFixed(4)}
                  <span className="adm-dim"> → ¥{u.chargedCny.toFixed(4)}</span>
                </td>
                <td>
                  {u.calls} 次
                  <span className="adm-dim"> {num(u.tokens)} tk</span>
                </td>
                <td>
                  <span className="adm-grant">
                    <input
                      className="adm-input"
                      type="number"
                      placeholder="积分"
                      value={amounts[u.userId] ?? ''}
                      onChange={e => setAmounts(p => ({ ...p, [u.userId]: e.target.value }))}
                    />
                    <button
                      className="ghost-btn sm"
                      onClick={() => void doGrant(u.userId)}
                      disabled={working === u.userId}
                    >
                      {working === u.userId ? '处理中…' : '发放'}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {!data?.items?.length && (
              <tr>
                <td colSpan={6} className="adm-empty">
                  还没有账号。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {note && <p className="adm-note">{note}</p>}
      <p className="adm-note">
        「余额 = 累计发放 − 累计消耗」，不单独存一列，避免两份数据打架。
        免费模型（Cloudflare Workers AI）不消耗积分，因此不出现在这张表里。
      </p>
    </div>
  )
}

function AuditTab() {
  const { data, busy, error, run } = useAsync(() => adminAuditList(200))
  if (error) return <ErrorBox error={error} onRetry={run} />
  const rows: AuditRow[] = data?.items ?? []
  return (
    <div className="adm-section">
      <div className="adm-bar">
        <h3 className="adm-h3">
          审计日志 <span className="adm-dim">最近 {rows.length} 条</span>
        </h3>
        <button className="ghost-btn sm" onClick={run} disabled={busy}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>
      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>操作人</th>
              <th>动作</th>
              <th>对象</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{fmtTime(r.create_at)}</td>
                <td>{r.actor_name}</td>
                <td>
                  <span className="adm-tag">{ACTION_LABEL[r.action] || r.action}</span>
                </td>
                <td>{r.target || '—'}</td>
                <td className="adm-dim">{r.detail || '—'}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="adm-empty">
                  还没有管理操作记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- 6. 用户创作浏览 ---------------- */

type ContentSubTab = 'canvases' | 'books' | 'assets'

function UserContentTab() {
  const { data: users, busy: usersBusy, error: usersError, run: runUsers } = useAsync(() => adminUserList())
  const [selectedUserId, setSelectedUserId] = useState('')
  const [subTab, setSubTab] = useState<ContentSubTab>('canvases')
  const [overview, setOverview] = useState<UserContentOverview | null>(null)
  const [state, setState] = useState<AppState | null>(null)
  const [assets, setAssets] = useState<UserAssetsListResult | null>(null)
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null)
  const [selectedAsset, setSelectedAsset] = useState<{ kind: AssetKind; id: string } | null>(null)
  const [detail, setDetail] = useState<{ book?: SavedBook; asset?: unknown } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const rows: AdminUserRow[] = users?.items ?? []
  const selectedUser = useMemo(
    () => rows.find(u => u.user_id === selectedUserId) || null,
    [rows, selectedUserId],
  )

  const loadOverview = useCallback(async (uid: string) => {
    if (!uid) return
    setBusy(true)
    setError('')
    setMsg('')
    try {
      const ov = await adminUserContentOverview(uid)
      setOverview(ov)
      const st = await adminUserStateGet(uid)
      setState(st.state)
      const ast = await adminUserAssetsList(uid)
      setAssets(ast)
      setSelectedBookId(null)
      setSelectedAsset(null)
      setDetail(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const loadBook = async (uid: string, bookId: string) => {
    setBusy(true)
    setError('')
    try {
      const r = await adminUserBookGet(uid, bookId)
      setDetail({ book: r.book })
      setSelectedBookId(bookId)
      setSelectedAsset(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const loadAsset = async (uid: string, kind: AssetKind, id: string) => {
    setBusy(true)
    setError('')
    try {
      const r = await adminUserAssetGet(uid, kind, id)
      setDetail({ asset: r.data })
      setSelectedAsset({ kind, id })
      setSelectedBookId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (usersError) return <ErrorBox error={usersError} onRetry={runUsers} />

  return (
    <div className="adm-section" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="adm-bar">
        <h3 className="adm-h3">用户创作数据</h3>
        <div className="adm-bar-right">
          <select
            className="adm-input"
            value={selectedUserId}
            disabled={usersBusy}
            onChange={e => {
              const uid = e.target.value
              setSelectedUserId(uid)
              setOverview(null)
              setState(null)
              setAssets(null)
              setDetail(null)
              void loadOverview(uid)
            }}
            style={{ minWidth: 180 }}
          >
            <option value="">{usersBusy ? '加载账号…' : '选择账号…'}</option>
            {rows.map(u => (
              <option key={u.user_id} value={u.user_id}>
                {u.username} ({u.projects} 作品 / {u.chapters} 章节)
              </option>
            ))}
          </select>
          <button className="ghost-btn sm" onClick={runUsers} disabled={usersBusy}>
            {usersBusy ? '刷新中…' : '刷新账号'}
          </button>
        </div>
      </div>

      {msg && <p className={`adm-msg ${msg.startsWith('✅') ? 'ok' : 'bad'}`}>{msg}</p>}
      {error && <p className="adm-msg bad">❌ {error}</p>}

      {overview && (
        <>
          <div className="adm-stats" style={{ marginBottom: 10 }}>
            <Stat
              label="账号"
              value={overview.username}
              hint={`${overview.role === 'admin' ? '管理员' : '普通用户'} · ${overview.status === 'active' ? '正常' : '已停用'}`}
            />
            <Stat label="画布" value={num(overview.state.canvasCount)} hint={`${num(overview.state.canvasChars)} 字符`} />
            <Stat label="作品库" value={num(overview.state.libraryCount)} hint={`${num(overview.state.libraryWords)} 字`} />
            <Stat label="精修章节" value={num(overview.state.chapterWritingWords)} hint="累计字数" />
            <Stat label="原子设定" value={num(overview.assets.atoms)} hint={`分支 ${num(overview.assets.branches)} · 快照 ${num(overview.assets.snaps)}`} />
            <Stat
              label="云端状态"
              value={fmtSize(overview.state.sizeBytes)}
              hint={overview.lastBackup ? `最近备份 ${fmtTime(overview.lastBackup.createdAt)}` : '尚无备份'}
            />
          </div>

          <div className="adm-bar" style={{ marginTop: 8 }}>
            <div className="adm-bar-right">
              {(['canvases', 'books', 'assets'] as ContentSubTab[]).map(t => (
                <button
                  key={t}
                  className={`ghost-btn sm ${subTab === t ? 'active' : ''}`}
                  onClick={() => setSubTab(t)}
                >
                  {t === 'canvases' ? '七画布' : t === 'books' ? '作品库' : '项目资产'}
                </button>
              ))}
            </div>
          </div>

          <div className="adm-split" style={{ marginTop: 8, minHeight: 0 }}>
            <div className="adm-list" style={{ width: 220, flex: 'none', overflow: 'auto' }}>
              {subTab === 'canvases' && (
                <>
                  {state?.canvases &&
                    Object.values(state.canvases).map((c: Canvas) => (
                      <button
                        key={c.id}
                        className="adm-book"
                        onClick={() => {
                          setSelectedBookId(null)
                          setSelectedAsset(null)
                          setDetail(null)
                        }}
                        title={c.title}
                      >
                        <span className="adm-book-name">{c.dimension} · {c.title}</span>
                      </button>
                    ))}
                  {!state?.canvases && <p className="adm-empty">暂无画布</p>}
                </>
              )}

              {subTab === 'books' && (
                <>
                  {(state?.library ?? []).map((b: SavedBook) => (
                    <button
                      key={b.id}
                      className={`adm-book ${selectedBookId === b.id ? 'active' : ''}`}
                      onClick={() => loadBook(selectedUserId, b.id)}
                      title={b.title}
                    >
                      <span className="adm-book-name">《{b.title}》</span>
                      <span className="adm-dim">{num(b.stats?.totalWords ?? 0)} 字 · {b.outline?.length ?? 0} 章</span>
                    </button>
                  ))}
                  {!(state?.library ?? []).length && <p className="adm-empty">暂无作品</p>}
                </>
              )}

              {subTab === 'assets' && (
                <>
                  {(['atoms', 'branches', 'snaps'] as const).map(bucket => (
                    <div key={bucket}>
                      <div className="adm-dim" style={{ padding: '8px 10px' }}>
                        {bucket === 'atoms' ? '原子设定' : bucket === 'branches' ? '剧情分支' : '版本快照'}
                      </div>
                      {(assets?.[bucket] ?? []).map((a: UserAssetMeta) => (
                        <button
                          key={a.id}
                          className={`adm-book ${selectedAsset?.id === a.id && selectedAsset?.kind === bucket.slice(0, -1) ? 'active' : ''}`}
                          onClick={() => loadAsset(selectedUserId, bucket.slice(0, -1) as AssetKind, a.id)}
                          title={a.name}
                        >
                          <span className="adm-book-name">{a.name}</span>
                          {a.dimension && <span className="adm-dim">{a.dimension}</span>}
                        </button>
                      ))}
                    </div>
                  ))}
                  {!assets?.atoms?.length && !assets?.branches?.length && !assets?.snaps?.length && (
                    <p className="adm-empty">暂无资产</p>
                  )}
                </>
              )}
            </div>

            <div className="adm-editor" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
              {subTab === 'canvases' && state?.canvases && (
                <div className="adm-dims">
                  {Object.values(state.canvases).map((c: Canvas) => (
                    <div key={c.id} className="adm-dim-block">
                      <h4 className="adm-dim-title">{c.dimension} · {c.title}</h4>
                      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0', fontSize: 12, color: 'var(--fg-2)' }}>
                        {c.content || '（空）'}
                      </pre>
                      {c.anchors?.length > 0 && (
                        <div className="adm-dim" style={{ marginTop: 6 }}>
                          锚点：{c.anchors.map(a => a.source).join('、')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {subTab === 'books' && detail?.book && (
                <div className="adm-dims">
                  <div className="adm-dim-block">
                    <h4 className="adm-dim-title">《{detail.book.title}》</h4>
                    <p className="adm-dim">{detail.book.synopsis || '无简介'}</p>
                    <p className="adm-dim">总字数 {num(detail.book.stats?.totalWords ?? 0)} · {detail.book.outline?.length ?? 0} 章 · 风格 {detail.book.stats?.styleLabel || '—'}</p>
                  </div>
                  <div className="adm-dim-block">
                    <h4 className="adm-dim-title">大纲</h4>
                    <ol style={{ fontSize: 12, color: 'var(--fg-2)', paddingLeft: 18 }}>
                      {(detail.book.outline ?? []).map(ch => (
                        <li key={ch.index}>
                          第 {ch.index} 章《{ch.title}》— {ch.summary}（{num(ch.words)} 字 · {ch.tag}）
                        </li>
                      ))}
                    </ol>
                  </div>
                  {detail.book.sampleChapter?.content && (
                    <div className="adm-dim-block">
                      <h4 className="adm-dim-title">样章：{detail.book.sampleChapter.title}</h4>
                      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0', fontSize: 12, color: 'var(--fg-2)' }}>
                        {detail.book.sampleChapter.content}
                      </pre>
                    </div>
                  )}
                  {detail.book.chapterWritings && Object.keys(detail.book.chapterWritings).length > 0 && (
                    <div className="adm-dim-block">
                      <h4 className="adm-dim-title">精修章节（{Object.keys(detail.book.chapterWritings).length} 章）</h4>
                      {Object.entries(detail.book.chapterWritings).map(([idx, w]) => (
                        <div key={idx} style={{ marginTop: 8 }}>
                          <span className="adm-dim">第 {idx} 章 · {purposeLabel((w as any).settings?.purpose)} · {num((w as any).wordCount ?? 0)} 字</span>
                          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '4px 0 0', fontSize: 12, color: 'var(--fg-2)', maxHeight: 200, overflow: 'auto' }}>
                            {(w as any).content || '（空）'}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {subTab === 'assets' && detail?.asset != null && (
                <div className="adm-dims">
                  <div className="adm-dim-block">
                    <h4 className="adm-dim-title">
                      {selectedAsset?.kind === 'atom'
                        ? '原子设定'
                        : selectedAsset?.kind === 'branch'
                          ? '剧情分支'
                          : '版本快照'}
                      ：{(detail.asset as AtomicSetting | StoryBranch | StorySnapshot).name ?? '未命名'}
                    </h4>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0', fontSize: 12, color: 'var(--fg-2)' }}>
                      {JSON.stringify(detail.asset, null, 2)}
                    </pre>
                  </div>
                </div>
              )}

              {!detail && subTab !== 'canvases' && (
                <p className="adm-empty">点击左侧条目查看详情</p>
              )}
            </div>
          </div>

          {busy && <p className="adm-loading">加载中…</p>}
        </>
      )}

      {!overview && !busy && !error && (
        <p className="adm-empty">选择一个账号以浏览其创作数据。所有读取操作都会记入审计日志。</p>
      )}
    </div>
  )
}

/* ---------------- 公共小件 ---------------- */

function ErrorBox({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="adm-error">
      <p>❌ {error}</p>
      <button className="ghost-btn sm" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}
