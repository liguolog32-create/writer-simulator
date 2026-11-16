import { Icon } from './Icon'
import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../store/AppContext'
import { ApiError } from '../lib/api'
import { creditsToCny, fetchCredits, onCreditsChanged, type CreditStatus } from '../lib/creditsClient'

/* ============================================================
   积分（付费额度）显示 —— v10.23 起
   ------------------------------------------------------------
   顶栏一颗药丸显示余额，点开看明细：
     · 当前积分余额 / 已消耗积分 / 今日消耗
     · 免费模型的今日额度（每人每天 15 次，北京时间 0 点重置）
     · 每次调用的 token 与积分流水
   管理员另外能看到「后台真实成本」等成本口径（服务端按 role 下发）。

   ⚠️「全站积分总览 + 给用户发放」已挪到「⚙ 管理后台 → 💎 积分」（v10.25）——
   一个顶栏下拉里塞两件事太挤，管理类操作应该待在管理后台里。

   「仅本机使用」模式没有云端账号 → 不渲染这颗药丸。
   ============================================================ */

export function CreditsPanel() {
  const { user, isAdmin, localOnly } = useApp()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<CreditStatus | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setData(await fetchCredits(20))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unauthorized') {
        setErr(localOnly ? '「仅本机使用」模式下没有账号，不消耗积分' : '请先登录后查看积分')
      } else {
        setErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
  }, [localOnly])

  useEffect(() => {
    void load()
  }, [load])

  // 每次 AI 调用结束都会广播 → 余额与免费额度实时刷新
  useEffect(() => onCreditsChanged(() => void load()), [load])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 未登录（仅本机模式）不显示：积分是云端账号维度的东西
  if (!user) return null

  const balance = data ? Math.round(data.balance) : null
  const freeOut = data ? data.freeLeft <= 0 : false

  return (
    <div className="credits">
      <button
        className={`credits-pill ${open ? 'open' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="付费额度（积分）：余额、消耗明细与今日免费额度"
      >
        <span className="credits-pill-ico"><Icon name="gem" /></span>
        <span className="credits-pill-txt">
          积分 <b>{balance === null ? '—' : balance.toLocaleString('zh-CN')}</b>
        </span>
      </button>

      {open && (
        <div className="credits-pop" onMouseLeave={() => setOpen(false)}>
          <header className="credits-head">
            <h3>积分 · 付费额度</h3>
            <button className="ghost-btn sm" onClick={() => void load()} disabled={loading}>
              {loading ? '刷新中…' : '刷新'}
            </button>
          </header>

          {err && <p className="credits-err">{err}</p>}

          {data && (
            <>
              <div className="credits-hero">
                <div className="credits-hero-main">
                  <span className="credits-label">当前积分余额</span>
                  <span className="credits-big">
                    {Math.round(data.balance).toLocaleString('zh-CN')}
                  </span>
                  <span className="credits-sub">
                    ≈ {creditsToCny(data.balance, data.cnyPerCredit)}
                  </span>
                </div>
                <div className="credits-hero-side">
                  <span className="credits-label">已消耗积分</span>
                  <span className="credits-mid">
                    {Math.round(data.used).toLocaleString('zh-CN')}
                  </span>
                  <span className="credits-sub">
                    累计发放 {Math.round(data.granted).toLocaleString('zh-CN')}
                  </span>
                </div>
              </div>

              {/* v10.74 全免费模式下不显示次数，直接说明当前不计费 */}
              <div className="credits-free">
                <Icon name="zap" size={14} />
                {data.freeForAll ? (
                  <>
                    <span className="credits-free-txt">
                      当前<b>全部免费</b>
                    </span>
                    <span className="credits-free-hint">
                      活动期间所有 AI 调用都不扣积分、不限次数（积分余额保留不动）
                    </span>
                  </>
                ) : (
                  <>
                    <span className="credits-free-txt">
                      今日免费次数剩余
                      <b>
                        {data.freeLeft} / {data.freeLimit}
                      </b>
                    </span>
                    <span className={`credits-free-hint ${freeOut ? 'out' : ''}`}>
                      {freeOut
                        ? `今日免费次数已用完，之后的调用按积分计费，北京时间 0 点重置`
                        : `每天前 ${data.freeLimit} 次不计费，超出后按积分计费，北京时间 0 点重置`}
                    </span>
                  </>
                )}
              </div>

              <div className="credits-stats">
                <div className="credits-stat">
                  <span className="credits-label">今日消耗</span>
                  <b>{Math.round(data.todayCredits).toLocaleString('zh-CN')} 积分</b>
                  <span className="credits-sub">{data.todayCalls} 次调用</span>
                </div>
                <div className="credits-stat">
                  <span className="credits-label">累计消耗</span>
                  <b>{Math.round(data.used).toLocaleString('zh-CN')} 积分</b>
                  <span className="credits-sub">≈ {creditsToCny(data.used, data.cnyPerCredit)}</span>
                </div>
                {/* 后台真实成本与溢价倍率是站方的成本结构，只给管理员看，不对普通用户公开 */}
                {isAdmin && (
                  <div className="credits-stat">
                    <span className="credits-label">后台真实成本</span>
                    <b>¥{(data.costCny ?? 0).toFixed(4)}</b>
                    <span className="credits-sub">付给 DeepSeek 的钱 · 仅管理员</span>
                  </div>
                )}
                {isAdmin && (
                  <div className="credits-stat">
                    <span className="credits-label">
                      按 {Math.round((data.markup ?? 1.4) * 100)}% 计价
                    </span>
                    <b>¥{(data.chargedCny ?? 0).toFixed(4)}</b>
                    <span className="credits-sub">
                      含 {Math.round(((data.markup ?? 1.4) - 1) * 100)}% 溢价 · 仅管理员
                    </span>
                  </div>
                )}
                <div className="credits-stat">
                  <span className="credits-label">累计调用</span>
                  <b>{data.calls} 次</b>
                  <span className="credits-sub">{formatTokens(data.tokens)} tokens</span>
                </div>
              </div>

              <p className="credits-note">
                {data.cnyPerCredit === 0.001
                  ? '计价方式：1 积分 = ¥0.001（1000 积分 = 1 元）。'
                  : `计价方式：1 积分 = ¥${data.cnyPerCredit}。`}
                {isAdmin && (
                  <>
                    {' '}
                    用户侧按后台真实成本的 <b>{Math.round((data.markup ?? 1.4) * 100)}%</b> 结算。
                  </>
                )}{' '}
                {data.freeForAll ? (
                  <>当前为<b>全免费活动期</b>：所有 AI 调用都不扣积分、不限次数，上面的余额保留不动。</>
                ) : (
                  <>每天前 <b>{data.freeLimit}</b> 次 AI 调用不计费，超出后按上面的口径计积分。</>
                )}
              </p>

              <section className="credits-recent">
                <h4>最近消耗</h4>
                {data.recent.length === 0 ? (
                  <p className="credits-empty">
                    还没有消耗记录。用「付费模型」生成一次就会出现。
                  </p>
                ) : (
                  <ul className="credits-list">
                    {data.recent.map((r, i) => (
                      <li key={i} className="credits-row">
                        <span className="credits-row-at">{r.at}</span>
                        <span className="credits-row-act">{actionLabel(r.action)}</span>
                        <span className="credits-row-tk">
                          {(r.tokensMiss + r.tokensHit + r.tokensOut).toLocaleString('zh-CN')} tk
                          {r.peak && (
                            <em className="credits-peak" title="高峰时段，单价 2×">
                              峰
                            </em>
                          )}
                        </span>
                        {/* 单次的真实成本是站方内部数据，只给管理员看（服务端也不下发给普通用户） */}
                        {isAdmin && (
                          <span className="credits-row-cost">¥{(r.costCny ?? 0).toFixed(4)}</span>
                        )}
                        <span className="credits-row-cr">{r.credits.toFixed(1)} 分</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {isAdmin && (
                <p className="credits-note">
                  全站积分总览与发放已挪到「⚙ 管理后台 → 💎 积分」。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const ACTION_LABEL: Record<string, string> = {
  generate: '生成整本书',
  analyze: '参考分析',
  anchorSuggest: '锚点建议',
  dissect: '原文拆解',
  imageDissect: '图片识别',
  sourceFetch: '灵感采集',
  revise: '修改',
  continue: '续写',
  writeChapter: '章节精写',
  refine: '字段改写',
  toScript: '短剧剧本',
  brainstormExtract: '脑洞提取',
  brainstormGrow: '脑洞生长',
  brainstormOutline: '脑洞大纲',
  healthCheck: '故事体检',
  direct: '方向导演',
  calibrate: '方向校准',
  styleForge: '文风炼金',
}

function actionLabel(a: string) {
  return ACTION_LABEL[a] || a || '（未知）'
}

function formatTokens(n: number) {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
