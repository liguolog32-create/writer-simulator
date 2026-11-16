import { useState, type ReactNode } from 'react'
import { useApp } from '../store/AppContext'
import { ApiError } from '../lib/api'
import { Icon } from './Icon'

/**
 * 多用户入口 —— 未登录时挡住整个应用
 *
 * 设计取舍：登录失败不会把用户锁死。若 Cloudflare 不可达或用户只想本机用，
 * 可以选「仅本机使用」进入本地模式（云端功能自动隐藏，写作功能全部可用）。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, localOnly, authBusy, signIn, signUp, setLocalOnlyMode } = useApp()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState('')
  /** v10.40 隐私说明：底部只留一句人话，技术细节折叠在「详情」里（普通作者看不懂 P8KDF2/KV/D1） */
  const [showPrivacy, setShowPrivacy] = useState(false)

  if (user || localOnly) return <>{children}</>

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    const u = username.trim()
    if (!u || !password) {
      setErr('用户名和密码都要填')
      return
    }
    if (mode === 'register') {
      if (u.length < 2 || u.length > 32) {
        setErr('用户名 2–32 个字符')
        return
      }
      if (!/^[\w\u4e00-\u9fa5.@-]{2,32}$/.test(u)) {
        setErr('用户名只能用中英文、数字、下划线、点、@ 和短横线')
        return
      }
      if (password.length < 6) {
        setErr('密码至少 6 位')
        return
      }
      if (password !== confirm) {
        setErr('两次输入的密码不一致')
        return
      }
    }
    try {
      if (mode === 'login') await signIn(u, password)
      else await signUp(u, password)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'network') {
        setErr(`${e.message}\n（连不上云端时，可以先用「仅本机使用」继续写作）`)
      } else {
        setErr(e instanceof Error ? e.message : String(e))
      }
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-mark"><Icon name="inkstone" size={20} /></span>
          <div>
            <h1>观澜书房</h1>
            <p className="auth-sub">多用户云端版 · 稿子按账号隔离存放</p>
          </div>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => {
              setMode('login')
              setErr('')
            }}
          >
            登录
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => {
              setMode('register')
              setErr('')
            }}
          >
            注册新账号
          </button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <label className="auth-field">
            <span>用户名</span>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={mode === 'register' ? '2–32 个字符，支持中文' : '你的用户名'}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label className="auth-field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={mode === 'register' ? '至少 6 位' : '你的密码'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {mode === 'register' && (
            <label className="auth-field">
              <span>确认密码</span>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="再输一次"
                autoComplete="new-password"
              />
            </label>
          )}

          {err && <p className="auth-err">{err}</p>}

          <button className="auth-submit" type="submit" disabled={authBusy}>
            {authBusy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>

        <div className="auth-or">
          <span>或者</span>
        </div>

        <button
          type="button"
          className="auth-local"
          onClick={() => setLocalOnlyMode(true)}
          title="不登录，数据只存在这台电脑的浏览器里，不参与云端同步"
        >
          仅本机使用（不同步云端）
        </button>

        <p className="auth-hint auth-hint-lead">
          你的稿件只有你自己和站点管理员能看到
          <button
            type="button"
            className="auth-hint-toggle"
            onClick={() => setShowPrivacy(v => !v)}
          >
            {showPrivacy ? '收起' : '详情'}
          </button>
        </p>
        {showPrivacy && (
          <ul className="auth-hint-more">
            <li>
              <b>其他普通用户完全看不到</b>你的任何数据：稿件按账号隔离，存在你自己的 Cloudflare（KV + D1）上。
            </li>
            <li>密码采用 PBKDF2-SHA256 单向哈希存储，服务器不保存明文密码。</li>
            <li>
              <b>站点管理员可以查看账号内容</b>（只读，每次读取都会写入审计日志）。
              这是本站当前的数据政策。
            </li>
            <li>
              如果你连管理员都不想让它看到，用「仅本机使用」模式 ——
              数据只存在这台电脑的浏览器里，一个字都不会上传。
            </li>
          </ul>
        )}
      </div>
    </div>
  )
}
