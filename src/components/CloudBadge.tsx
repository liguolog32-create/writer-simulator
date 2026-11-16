import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../store/AppContext'
import type { BackupItem } from '../lib/cloudSync'

/**
 * 云同步状态条（页脚）—— PRD《Cloudflare自动化部署版本》
 * 业务数据以 Cloudflare KV 为准，浏览器存储仅作离线缓存。
 * R2 未开通时备份走 KV 多版本：保留最近若干份，可逐份还原。
 */
export function CloudBadge() {
  const {
    cloudStatus,
    cloudSavedAt,
    cloudEnabled,
    setCloudEnabled,
    syncNow,
    backupNow,
    listBackups,
    restoreBackup,
    user,
    localOnly,
  } = useApp()
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [items, setItems] = useState<BackupItem[]>([])
  const [keep, setKeep] = useState(0)
  const [loadingList, setLoadingList] = useState(false)
  const [restoring, setRestoring] = useState('')

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const fmtSize = (n: number) => {
    if (!n) return '0 B'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  const refresh = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await listBackups(40)
      setItems(res.items)
      setKeep(res.keep)
    } catch (e) {
      setMsg(`读取备份列表失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingList(false)
    }
  }, [listBackups])

  // 打开面板时拉一次列表
  useEffect(() => {
    if (showHistory && user && !localOnly) void refresh()
  }, [showHistory, refresh, user, localOnly])

  // 「仅本机使用」模式：**不再每页重复挂一行提示条**（v10.40 GLOBAL-01）。
  // 那行字在首页/画布/写作/世界观都出现，看三遍就变成视觉噪音。
  // 现在：数据状态看顶栏的状态圆点，登录入口是它旁边的「登录同步 →」；
  // 首次进入本机模式时由 App 弹一次 toast 说明（只弹一次）。
  if (localOnly || !user) {
    return null
  }

  const label =
    cloudStatus === 'syncing'
      ? '同步中…'
      : cloudStatus === 'synced'
        ? `已同步到 Cloudflare（${user.username}）`
        : cloudStatus === 'offline'
          ? '离线（本地缓存已保留）'
          : cloudStatus === 'guarded'
            ? '已保护：本次回写会清空云端作品库，已拦下'
            : cloudStatus === 'disabled'
              ? '云同步已关闭'
              : '待同步'

  const doBackup = async () => {
    setBusy(true)
    const text = await backupNow()
    setMsg(text)
    setBusy(false)
    if (showHistory) void refresh()
  }

  const doRestore = async (item: BackupItem) => {
    const when = fmtTime(item.createdAt)
    const ok = window.confirm(
      `确定要还原到 ${when} 的这份备份吗？\n\n` +
        `会用它覆盖当前的画布、作品库与项目资产。\n` +
        `还原前建议先点「立即备份」，把现在的状态也留一份。`,
    )
    if (!ok) return
    setRestoring(item.stamp)
    const text = await restoreBackup(item.stamp)
    setMsg(text)
    setRestoring('')
    void refresh()
  }

  return (
    <div className="cloud-badge">
      {showHistory && (
        <div className="bk-panel">
          <div className="bk-head">
            <span className="bk-title">备份历史</span>
            <span className="bk-sub">保留最近 {keep} 份 · 可逐份还原</span>
            <button className="ghost-btn sm" onClick={() => void refresh()} disabled={loadingList}>
              {loadingList ? '读取中…' : '↻ 刷新'}
            </button>
            <button className="ghost-btn sm" onClick={() => setShowHistory(false)}>
              收起
            </button>
          </div>
          {!items.length && !loadingList && (
            <p className="bk-empty">
              还没有备份。点「立即备份」手动存一份；系统也会每天自动备份一次。
            </p>
          )}
          <div className="bk-list">
            {items.map(item => (
              <div key={item.key} className="bk-item">
                <span className="bk-time">{fmtTime(item.createdAt)}</span>
                <span className="bk-chip">{item.type === 'auto' ? '自动' : item.type === 'manual' ? '手动' : '定点快照'}</span>
                <span className="bk-size">{fmtSize(item.size)}</span>
                <span className={`bk-chip ${item.hasData ? '' : 'bk-chip-warn'}`}>
                  {item.hasData ? '可还原' : '仅元信息'}
                </span>
                <button
                  className="ghost-btn sm"
                  onClick={() => void doRestore(item)}
                  disabled={!item.hasData || Boolean(restoring)}
                  title={item.hasData ? '用这份备份覆盖当前数据' : item.note || '这份备份没有存下数据体'}
                >
                  {restoring === item.stamp ? '还原中…' : '⏪ 还原'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <span
        className="cloud-group-label"
        title="同步 = 把当前数据推到 Cloudflare；备份 = 留一个可随时还原的时间点"
      >
        数据同步
      </span>
      <span className={`cloud-dot cloud-${cloudStatus}`} />
      <span className="cloud-label">{label}</span>
      {cloudSavedAt && <span className="cloud-time">· {fmtTime(cloudSavedAt)}</span>}
      {msg && <span className="cloud-msg">{msg}</span>}
      <button
        className="ghost-btn sm"
        onClick={() => void syncNow()}
        disabled={!cloudEnabled}
        title="把当前数据立刻推到云端"
      >
        同步到云端
      </button>
      <button
        className="ghost-btn sm"
        onClick={doBackup}
        disabled={busy}
        title="把现在的数据存成一个可还原的时间点"
      >
        {busy ? '备份中…' : '备份当前数据'}
      </button>
      <button
        className={`ghost-btn sm ${showHistory ? 'on' : ''}`}
        onClick={() => setShowHistory(v => !v)}
        title="查看历史备份，可逐份还原"
      >
        备份历史
      </button>
      <label className="cloud-toggle" title="关掉后不再自动同步 / 自动备份（仍可手动点左边按钮）">
        <input
          type="checkbox"
          checked={cloudEnabled}
          onChange={e => setCloudEnabled(e.target.checked)}
        />
        自动同步
      </label>
    </div>
  )
}
