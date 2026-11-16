import { Icon } from './Icon'
import { useState } from 'react'
import { useApp } from '../store/AppContext'
import { healthCheck, refineField, type HealthResult, type HealthIssue } from '../lib/llmClient'
import { DIM_TO_CANVAS } from '../lib/dims'
import type { CanvasDimension } from '../types'
import { WebSearchToggle, webStatusText } from './WebSearchToggle'

/* ============================================================
   PRD 功能2：故事体检校验器（侧边悬浮可折叠面板）
   AI 扫 7 画布 → 大白话诊断 → 问题 + 2-3 个优化选择题 → 点选即修复
   ============================================================ */

export function HealthPanel() {
  const { state, listCanvases, dispatch } = useApp()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [result, setResult] = useState<HealthResult | null>(null)
  const [info, setInfo] = useState('')
  const [fixed, setFixed] = useState<Record<string, string>>({})
  /** 联网搜同类型范文开关（默认关：一键修复求快；开则先检索同题材/同风格优秀范文作风格参照） */
  const [webSearch, setWebSearch] = useState(false)

  const canvasesMap = () => {
    const m: Record<string, string> = {}
    listCanvases().forEach(c => {
      m[c.dimension] = c.content
    })
    return m
  }

  const run = async () => {
    setBusy(true)
    setInfo('')
    try {
      const { data } = await healthCheck(canvasesMap())
      setResult(data)
      setFixed({})
      if (!data.issues.length) setInfo('✅ 没发现明显问题，可以放心往下写。')
    } catch (e) {
      setInfo(`❌ 体检失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setBusy(false)
  }

  /** 用户点选某个选项 → 让 AI 按这个方向改写对应画布 */
  const applyFix = async (issue: HealthIssue, optionLabel: string) => {
    const opt = issue.options.find(o => o.label === optionLabel)
    const dim = issue.dimension as CanvasDimension
    const canvasId = DIM_TO_CANVAS[dim]
    if (!opt || !canvasId) {
      setInfo('⚠️ 这条问题没有指明要改哪块画布，请手动处理。')
      return
    }
    if (state.canvases[canvasId]?.locked) {
      setInfo(`【${dim}】画布已锁定，AI 不会改动它。要修先解锁。`)
      return
    }
    const key = `${issue.id}:${optionLabel}`
    setFixing(key)
    setInfo('')
    try {
      const { data, searched, searchCount } = await refineField({
        dimension: dim,
        current: state.canvases[canvasId]?.content || '',
        instruction: `${opt.fix}\n\n（要解决的问题：${issue.problem}）`,
        context: `用户是写作新手，请用大白话，不要出现写作专业术语。`,
        webSearch,
      })
      if (data.refined) {
        dispatch({ type: 'UPDATE_CONTENT', id: canvasId, content: data.refined })
        setFixed(f => ({ ...f, [issue.id]: optionLabel }))
        const status = webStatusText({ webSearch, searched, searchCount })
        const refTip = data.references?.length ? `（参考：${data.references.join('、')}）` : ''
        setInfo(`✅ 已按「${optionLabel}」修好【${dim}】画布。${status}${refTip}`)
      } else {
        setInfo('⚠️ AI 没返回内容，换个选项再试。')
      }
    } catch (e) {
      setInfo(`❌ 修复失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setFixing(null)
  }

  const scoreClass = (s: number) => (s >= 80 ? 'good' : s >= 60 ? 'mid' : 'bad')

  return (
    <div className={`health ${open ? 'open' : ''}`}>
      <button className="health-tab" onClick={() => setOpen(o => !o)} title="故事体检">
        <span className="health-tab-icon"><Icon name="compass" /></span>
        <span className="health-tab-text">故事体检</span>
        <span className="health-tab-arrow">{open ? '›' : '‹'}</span>
      </button>

      {open && (
        <div className="health-body">
          <header className="health-head">
            <h3><Icon name="compass" /> 故事体检</h3>
            <button className="ghost-btn sm" onClick={() => setOpen(false)}>
              ✖
            </button>
          </header>

          <p className="wb-hint">
            AI 会把你 7 块画布通读一遍，用大白话告诉你哪里最容易让读者跑掉，并给你几个「怎么办」的选项，点一下就修。
          </p>

          <div className="ws-row" style={{ marginBottom: 6 }}>
            <button className="primary-btn sm health-run" onClick={run} disabled={busy}>
              {busy ? '正在体检…' : result ? '再体检一次' : '开始体检'}
            </button>
            <WebSearchToggle
              checked={webSearch}
              onChange={setWebSearch}
              hint="开启后，点击「怎么办」选项修复画布时，AI 会先联网检索同类型（同题材 / 同风格）的优秀范文作为风格参照，再帮你改写"
            />
          </div>

          {result && (
            <>
              <div className="health-score">
                <span className={`health-score-num ${scoreClass(result.score)}`}>{result.score}</span>
                <span className="health-score-label">整体完成度</span>
              </div>
              {result.summary && <p className="health-summary">{result.summary}</p>}

              <ul className="health-issues">
                {result.issues.map(it => (
                  <li key={it.id} className={`health-issue ${fixed[it.id] ? 'fixed' : ''}`}>
                    <div className="health-issue-head">
                      <span className="health-issue-dim">{it.dimension || '整体'}</span>
                      <span className="health-issue-problem">{it.problem}</span>
                    </div>
                    {it.why && <p className="health-issue-why">{it.why}</p>}
                    <div className="health-issue-options">
                      {it.options.map(o => {
                        const key = `${it.id}:${o.label}`
                        return (
                          <button
                            key={o.label}
                            className={`health-option ${fixed[it.id] === o.label ? 'active' : ''}`}
                            onClick={() => applyFix(it, o.label)}
                            disabled={fixing !== null}
                            title={o.fix}
                          >
                            {fixing === key ? '修复中…' : o.label}
                          </button>
                        )
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {info && (
            <p className={info.startsWith('❌') || info.startsWith('⚠️') || info.startsWith('🔒') ? 'wb-warn' : 'wb-ok'}>
              {info}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
