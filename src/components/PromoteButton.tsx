/* ============================================================
   发布入口（v10.18）
   ------------------------------------------------------------
   只在**测试版**（staging.writer-simulator.pages.dev）且**管理员**可见：
     🚀 发布到正式版 → 登记一条待发布请求（带 BUILD_HASH 锁定版本）
   在正式版上则退化成一个「🧪 测试版」外链，方便随时回去预览。

   为什么不直接点一下就上线：Cloudflare Pages 的 Direct Upload 项目
   不支持把 preview 部署 promote 到 production（API 恒 405），
   Worker 里也跑不了 wrangler。真正的文件上传由助手执行 ——
   按钮负责「发起 + 锁定版本」，助手负责「执行 + 回写状态」。
   ============================================================ */

import { Icon } from './Icon'
import { useCallback, useEffect, useState } from 'react'
import { BUILD_HASH, IS_STAGING } from '../config'
import {
  fetchPromoteStatus,
  requestPromote,
  resolvePromote,
  type PromoteRequest,
} from '../lib/promoteClient'
import { useApp } from '../store/AppContext'

export function PromoteButton() {
  const { isAdmin } = useApp()
  const [req, setReq] = useState<PromoteRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [loaded, setLoaded] = useState(false)

  // 管理员才需要问状态；正式版上这个组件只是个外链，不必打接口
  useEffect(() => {
    if (!isAdmin || !IS_STAGING) return
    let alive = true
    fetchPromoteStatus()
      .then(r => {
        if (alive) setReq(r.request)
      })
      .catch(() => {
        /* 查不到就当没有待发布请求，按钮仍可用 */
      })
      .finally(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [isAdmin])

  const submit = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const r = await requestPromote(BUILD_HASH, note)
      setReq(r.request)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [note])

  const cancel = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const r = await resolvePromote('cancelled', '', '由管理员在测试版撤销')
      setReq(r.request)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  if (!isAdmin) return null

  // v10.74：正式版不再显示「测试版」入口（用户要求从正式版去掉这个 tab）。
  // 测试版上的发布按钮不受影响。
  if (!IS_STAGING) return null

  const pending = req?.status === 'pending'

  return (
    <div className="promote-wrap">
      {pending ? (
        <>
          <button className="ghost-btn promote-btn is-pending" disabled title="已提交，等待助手执行部署">
            <Icon name="clock" /> 待发布 · {req?.buildHash || BUILD_HASH}
          </button>
          <button className="ghost-btn promote-btn" onClick={cancel} disabled={busy}>
            撤销
          </button>
        </>
      ) : (
        <button
          className="ghost-btn promote-btn"
          onClick={submit}
          disabled={busy || !loaded}
          title="把当前测试版的这一份产物发布到正式版"
        >
          发布到正式版
        </button>
      )}
      {error && <span className="promote-err">{error}</span>}
      {pending && !error && (
        <span
          className="promote-note"
          title={`构建 ${req?.buildHash || '-'} 已登记，通知助手执行部署即可上线`}
        >
          已登记
        </span>
      )}
    </div>
  )
}
