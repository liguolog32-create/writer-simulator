/* ============================================================
   写作引擎切换（v10.17）
   ------------------------------------------------------------
   为什么做成「顶栏一个药丸 + 点开面板」而不是平铺两个按钮：
   引擎是个「设一次、很久不动」的选择，平铺在顶栏会长期占位、
   还会和「作品库 / 管理 / 账号」抢视觉焦点。药丸只显示当前状态，
   要改的时候点开就是。
   ============================================================ */

import { Icon } from './Icon'
import { useEffect, useRef, useState } from 'react'
import { FREE_ENGINE_MODELS, type FreeEngineModelKey, type LLMEngine } from '../config'
import { setEnginePref, useEnginePref } from '../lib/engine'
import { fetchEngineStatus, type EngineStatus } from '../lib/llmClient'

export function EngineToggle() {
  const pref = useEnginePref()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [statusErr, setStatusErr] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  // 打开面板时问一次服务端两条通道通不通（不消耗额度），用来把不可用的选项置灰
  useEffect(() => {
    if (!open) return
    let alive = true
    setStatusErr('')
    fetchEngineStatus()
      .then(s => {
        if (alive) setStatus(s)
      })
      .catch(e => {
        if (alive) setStatusErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [open])

  // 点面板外面 / 按 Esc 关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (engine: LLMEngine) => setEnginePref({ engine })
  const pickModel = (freeModel: FreeEngineModelKey) => setEnginePref({ freeModel })

  const cloudBlocked = status ? !status.cloud : false
  const freeBlocked = status ? !status.free : false

  return (
    <div className="eng-box" ref={boxRef}>
      <button
        type="button"
        className={`eng-pill ${pref.engine === 'free' ? 'is-free' : 'is-cloud'} ${open ? 'open' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="选择用哪个引擎写作：免费（不花钱）或云端 优质模型生产（质量优先）"
        aria-expanded={open}
      >
        <span className="eng-pill-ico"><Icon name={pref.engine === 'free' ? 'zap' : 'cloud'} /></span>
        <span className="eng-pill-txt">{pref.engine === 'free' ? '免费引擎' : '云端 优质模型生产'}</span>
        <span className="eng-pill-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="eng-panel" role="dialog" aria-label="写作引擎设置">
          <div className="eng-panel-head">
            <strong>写作引擎</strong>
            <span className="eng-panel-sub">只对这台设备生效</span>
          </div>

          <button
            type="button"
            className={`eng-opt ${pref.engine === 'free' ? 'active' : ''} ${freeBlocked ? 'blocked' : ''}`}
            onClick={() => !freeBlocked && pick('free')}
            disabled={freeBlocked}
          >
            <span className="eng-opt-title">
              <Icon name="zap" /> 免费引擎 · Cloudflare
              {pref.engine === 'free' && <em className="eng-badge">当前</em>}
            </span>
            <span className="eng-opt-desc">
              不消耗你的 优质模型生产 余额。跑在 Cloudflare 的边缘 GPU 上，
              每天赠送 1 万神经元（约合 27 万输出 token，够写几十章）。
            </span>
            <span className="eng-opt-warn">
              不支持联网检索同类型范文；读图能力有限；质量略低于 优质模型生产
            </span>
            {freeBlocked && <span className="eng-opt-blocked">服务端未挂载 Workers AI 绑定，暂不可用</span>}
          </button>

          {/* 免费引擎的模型选择：选免费引擎时才展开，减少无关选项的干扰 */}
          {pref.engine === 'free' && (
            <div className="eng-sub">
              <div className="eng-sub-head">免费模型</div>
              {FREE_ENGINE_MODELS.map(m => (
                <button
                  type="button"
                  key={m.key}
                  className={`eng-model ${pref.freeModel === m.key ? 'active' : ''}`}
                  onClick={() => pickModel(m.key)}
                >
                  <span className="eng-model-label">{m.label}</span>
                  <span className="eng-model-hint">{m.hint}</span>
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            className={`eng-opt ${pref.engine === 'cloud' ? 'active' : ''} ${cloudBlocked ? 'blocked' : ''}`}
            onClick={() => !cloudBlocked && pick('cloud')}
            disabled={cloudBlocked}
          >
            <span className="eng-opt-title">
              云端 优质模型生产
              {pref.engine === 'cloud' && <em className="eng-badge">当前</em>}
            </span>
            <span className="eng-opt-desc">
              质量最高，支持联网检索同类型范文、支持读图解析思维导图。会消耗 优质模型生产 API 余额。
            </span>
            {cloudBlocked && <span className="eng-opt-blocked">服务端未配置 优质模型生产 密钥，暂不可用</span>}
          </button>

          <div className="eng-foot">
            {statusErr ? (
              <span className="eng-foot-err">状态未知：{statusErr.slice(0, 80)}</span>
            ) : status ? (
              <span>
                通道状态：免费 {status.free ? '可用' : '不可用'} · 云端{' '}
                {status.cloud ? '可用' : '不可用'}
              </span>
            ) : (
              <span>正在检查通道状态…</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
