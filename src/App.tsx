import {useEffect, useState, useMemo } from 'react'
import { AppProvider, useApp } from './store/AppContext'
import { Icon } from './components/Icon'
import { AdminEntry } from './components/AdminPanel'
import { CanvasBlock } from './components/CanvasBlock'
import { WorldviewPanel } from './components/WorldviewPanel'
import { BrainTour, shouldShowBrainTour } from './components/BrainTour'
import { LibraryPage } from './components/LibraryPage'
import { RobotPage } from './components/RobotPage'
import { AvatarLayer } from './components/AvatarLayer'
import { CanvasRail } from './components/CanvasRail'
import { BookLibrary } from './components/BookLibrary'
import { BookGenerateBanner } from './components/BookGenerator'
import { BookShelf } from './components/BookShelf'
import { Workbench } from './components/Workbench'
import { HomeScreen } from './components/HomeScreen'
import { LiteraryAudit } from './components/LiteraryAudit'
import { BrainFlow } from './components/BrainFlow'
import { HealthPanel } from './components/HealthPanel'
import { CloudBadge } from './components/CloudBadge'
import { EngineToggle } from './components/EngineToggle'
import { CreditsPanel } from './components/CreditsPanel'
import { PromoteButton } from './components/PromoteButton'
import { AuthGate } from './components/AuthGate'
import type { EntryMode } from './types'
import { IS_STAGING } from './config'

/** PRD 2.2 产品页面路由：/ 首页分流页、/novel-brain 脑洞共创页、/ 原有工作台（高级模式） */
type View = 'home' | 'brain' | 'pro' | 'library' | 'bot' | 'audit'

const HASH: Record<View, string> = {
  home: '#/',
  brain: '#/novel-brain',
  pro: '#/workspace',
  library: '#/library',
  // v10.65：机器人「观澜」独立页面（人格 + 识海 + 屏幕被动观察）
  bot: '#/bot',
  // 文学审读：五步评判流程 + R1/R2/R3 诊断 + 报告生成
  audit: '#/literary-audit',
}

function viewFromHash(): View {
  const h = window.location.hash
  if (h.startsWith('#/novel-brain')) return 'brain'
  if (h.startsWith('#/workspace')) return 'pro'
  // v10.42 LIB-01：作品库从弹窗改成独立页面，可直接用 URL 打开
  if (h.startsWith('#/library')) return 'library'
  if (h.startsWith('#/bot')) return 'bot'
  if (h.startsWith('#/literary-audit')) return 'audit'
  return 'home'
}

/** 右上角账号区：显示当前账号，可改密码 / 退出登录 */
function AccountMenu() {
  const { user, localOnly, signOut, setLocalOnlyMode, changePassword } = useApp()
  const [open, setOpen] = useState(false)
  const [pwdOpen, setPwdOpen] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // v10.40 TOPNAV-02：本机模式改成一个**状态指示**（不可点的圆点 + 文字），
  // 真正的登录入口是它旁边那个小小的「登录同步 →」。
  // 之前它长得像个按钮，用户分不清「这是状态还是入口」。
  if (!user && localOnly) {
    return (
      <div className="acct acct-status">
        <span className="acct-dot local" />
        <span className="acct-status-text">本机模式</span>
        <button
          className="acct-login-link"
          onClick={() => setLocalOnlyMode(false)}
          title="登录后可跨设备同步、自动备份"
        >
          登录同步 →
        </button>
      </div>
    )
  }

  if (!user && !localOnly) return null
  const label = user ? user.username : '本机模式'

  const resetPwdForm = () => {
    setOldPwd('')
    setNewPwd('')
    setConfirmPwd('')
    setNote('')
  }

  const submitPwd = async (e: React.FormEvent) => {
    e.preventDefault()
    setNote('')
    if (newPwd.length < 6) {
      setNote('新密码至少 6 位')
      return
    }
    if (newPwd !== confirmPwd) {
      setNote('两次输入的新密码不一致')
      return
    }
    if (newPwd === oldPwd) {
      setNote('新密码不能和原密码一样')
      return
    }
    setBusy(true)
    try {
      await changePassword(oldPwd, newPwd)
      setNote('已修改。其他设备上的登录已失效，这台不受影响。')
      setOldPwd('')
      setNewPwd('')
      setConfirmPwd('')
    } catch (err) {
      setNote(`❌ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="acct">
      <button className="ghost-btn acct-btn" onClick={() => setOpen(o => !o)} title="账号">
        <span className={`acct-dot ${user ? 'online' : 'local'}`} />
        {label}
      </button>
      {open && (
        <div className="acct-pop" onMouseLeave={() => setOpen(false)}>
          <p className="acct-line">
            {user ? `已登录：${user.username}` : '仅本机使用（未登录）'}
          </p>

          {user ? (
            <>
              {!pwdOpen ? (
                <button
                  className="ghost-btn"
                  onClick={() => {
                    setPwdOpen(true)
                    resetPwdForm()
                  }}
                >
                  修改密码
                </button>
              ) : (
                <form className="acct-pwd" onSubmit={submitPwd}>
                  <label className="auth-field">
                    <span>原密码</span>
                    <input
                      type="password"
                      value={oldPwd}
                      onChange={e => setOldPwd(e.target.value)}
                      autoComplete="current-password"
                      autoFocus
                    />
                  </label>
                  <label className="auth-field">
                    <span>新密码（至少 6 位）</span>
                    <input
                      type="password"
                      value={newPwd}
                      onChange={e => setNewPwd(e.target.value)}
                      autoComplete="new-password"
                    />
                  </label>
                  <label className="auth-field">
                    <span>确认新密码</span>
                    <input
                      type="password"
                      value={confirmPwd}
                      onChange={e => setConfirmPwd(e.target.value)}
                      autoComplete="new-password"
                    />
                  </label>
                  {note && (
                    <p className={`acct-note ${note.startsWith('已修改') ? 'ok' : 'bad'}`}>{note}</p>
                  )}
                  <div className="acct-pwd-actions">
                    <button className="primary-btn" type="submit" disabled={busy}>
                      {busy ? '提交中…' : '确认修改'}
                    </button>
                    <button
                      className="ghost-btn"
                      type="button"
                      onClick={() => {
                        setPwdOpen(false)
                        resetPwdForm()
                      }}
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}
              <button
                className="ghost-btn"
                onClick={() => {
                  setOpen(false)
                  setPwdOpen(false)
                  void signOut()
                }}
              >
                退出登录
              </button>
            </>
          ) : (
            <button
              className="ghost-btn"
              onClick={() => {
                setOpen(false)
                setLocalOnlyMode(false)
              }}
            >
              去登录（开启云同步）
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AppShell() {
  const { state, setLastMode, localOnly, setLocalOnlyMode, importBook, unlinkBook } = useApp()
  /**
   * v10.40 GLOBAL-01：本机模式只在**第一次**弹一次说明（toast，6 秒自动消失）。
   * 之前每页页脚都挂一行「数据只存在这台电脑…」，看三遍就成了视觉噪音。
   * 之后想知道同步状态，看顶栏的状态圆点即可。
   */
  const [localNotice, setLocalNotice] = useState('')

  /**
   * v10.42 GLOBAL-03：本机模式下**累计写满 1000 字**才提示一次登录备份。
   * 一上来就催登录会把人赶走；等用户真写了、有沉没成本了再提，才有人愿意登。
   */
  const [loginNudge, setLoginNudge] = useState(false)
  const totalWords = useMemo(() => {
    const lib = state.library ?? []
    return lib.reduce((sum, b) => {
      const cw = b.chapterWritings ?? {}
      const written = Object.values(cw).reduce(
        (acc, w) => acc + (Number(w.wordCount) || (w.content || '').length || 0),
        0,
      )
      return sum + (Number(b.stats?.totalWords) || 0) + written
    }, 0)
  }, [state.library])

  useEffect(() => {
    if (!localOnly || loginNudge || totalWords < 1000) return
    try {
      if (localStorage.getItem('ws-login-nudge-v1')) return
      localStorage.setItem('ws-login-nudge-v1', '1')
    } catch {
      return
    }
    setLoginNudge(true)
  }, [localOnly, totalWords, loginNudge])
  useEffect(() => {
    if (!localOnly) return
    try {
      if (localStorage.getItem('ws-local-notice-v1')) return
      localStorage.setItem('ws-local-notice-v1', '1')
    } catch {
      return
    }
    setLocalNotice('当前是本机模式，数据只存在这台浏览器。需要跨设备同步，点右上角「登录同步」。')
    const t = window.setTimeout(() => setLocalNotice(''), 7000)
    return () => window.clearTimeout(t)
  }, [localOnly])
  const [view, setView] = useState<View>(() => {
    // 「始终默认上次打开模式」勾选时，直接进上次的模式，跳过分流页
    if (state.rememberMode && state.lastMode) return state.lastMode === 'brain' ? 'brain' : 'pro'
    return viewFromHash()
  })
  /** v10.42 LIB-01：从作品库点进来要打开的那本书 */
  const [openBookId, setOpenBookId] = useState<string | null>(null)

  /** v10.41 STEP4-01/03：成果导览浮层 + 「写第一章」的跳转信号 */
  const [tourOpen, setTourOpen] = useState(false)
  const [writeNonce, setWriteNonce] = useState(0)

  const goWriteChapter = () => {
    setTourOpen(false)
    setCanvasTab('workbench')
    setWriteNonce(n => n + 1)
  }

  const [canvasTab, setCanvasTab] = useState<'canvas' | 'workbench' | 'worldview'>('canvas')
  /** v10.27 脑洞共创完成后带过来的书 id：创作台据此自动选中它 */
  const [brainBookId, setBrainBookId] = useState<string | null>(null)

  // 地址栏 hash 同步（可分享链接、可书签）
  useEffect(() => {
    const want = HASH[view]
    if (window.location.hash !== want) window.history.replaceState(null, '', want)
  }, [view])

  // 浏览器前进/后退
  useEffect(() => {
    const onHash = () => setView(viewFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const enter = (mode: EntryMode, next: View) => {
    setLastMode(mode)
    setView(next)
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          {/* v18.5 釉色版：brand-mark 换朱砂章「观」字 */}
          <span className="brand-mark"><span className="brand-seal-char">观</span></span>
          <div>
            <h1>
              观澜书房 <span className="brand-en">GUANLAN STUDY</span>
            </h1>
            <p className="brand-sub">
              {view === 'brain'
                ? '脑洞快速造框架 · 零结构思维也能写'
                : view === 'audit'
                  ? '六步评判流程 · R0 叙事 / R1 因果 / R2 读者 / R3 表达 · 生成审读报告'
                  : '多画布并行编辑 · 原文拆解 · 修改续写'}
            </p>
          </div>
        </div>
        <div className="header-actions">
          {view !== 'home' && (
            <button className="ghost-btn" onClick={() => setView('home')} title="回到首页 / 模式选择">
              <Icon name="home" /> 首页
            </button>
          )}
          <BookShelf />
          {/* v10.65：机器人「观澜」——独立人格 + 识海记忆 + 屏幕被动观察 */}
          <button
            className={`ghost-btn ${view === 'bot' ? 'on' : ''}`}
            onClick={() => setView('bot')}
            title="机器人：它有自己的人格和三观，替你写东西"
          >
            <Icon name="gem" /> 机器人
          </button>
          {/* 文学审读：把评判流程模板做成可操作页面，入口常驻顶栏 */}
          <button
            className={`ghost-btn ${view === 'audit' ? 'on' : ''}`}
            onClick={() => setView('audit')}
            title="文学审读：按版本契约 → R0 叙事构成 → R1 因果 → R2 读者 → R3 表达 → 综合判定"
          >
            <Icon name="book" /> 文学审读
          </button>
          {/* v10.15 已下线顶栏的「📖 生成文本」：
              它和「📚 作品库」并排挤在右上角，新手分不清谁是谁，还容易误点后干等。
              生成入口挪进工作区 ——「多画布页」顶部有横幅按钮，
              「创作台 · 作品」那一行也有一个，两处都是需要它的时候才看得见。 */}
          {/* 这里原来是「只读访客 / 管理后台」两个 Tab —— 纯前端开关，
              谁都能点一下给自己开管理权限。v10 已删除：
              管理入口只对服务端判定为 admin 的账号渲染。 */}
          <AdminEntry />
          <AccountMenu />
          {/* v10.17 引擎切换：免费（Cloudflare，不花钱）/ 云端 DeepSeek（质量优先）。
              只在这里挂一个入口，不做全局提示条 —— 引擎是设一次就不动的选择，
              常驻提醒反而会一直占着视线。 */}
          <EngineToggle />
          {/* v10.23 积分（付费额度）：显示余额与消耗；用「仅本机使用」时没有账号，不渲染。 */}
          <CreditsPanel />
          {/* v10.18 发布入口：测试版上给管理员一个「发布到正式版」，
              正式版上退化成「去测试版」外链。非管理员完全不渲染。 */}
          <PromoteButton />
        </div>
      </header>

      {/* 所有视图保持挂载、只切换可见性：切走会卸载组件，正在跑的任务与结果都会丢 */}
      <div className="view-host" hidden={view !== 'home'}>
        {/* v10.48 HOME-01：三个入口 —— 前两个归「书籍创作」，新增「世界观创作」直达世界观页 */}
        <HomeScreen
          onPick={m => {
            if (m === 'worldview') setCanvasTab('worldview')
            enter(m, m === 'brain' ? 'brain' : 'pro')
          }}
          onOpenAudit={() => setView('audit')}
        />
      </div>

      <div className="view-host" hidden={view !== 'library'}>
        <LibraryPage
          onOpenBook={id => {
            setOpenBookId(id)
            setCanvasTab('workbench')
            setView('pro')
          }}
        />
      </div>

      {/* v10.65：机器人页（人格卡 + 识海 + 屏幕被动观察）。同样保持挂载，只切可见性 */}
      <div className="view-host" hidden={view !== 'bot'}>
        <RobotPage />
      </div>

      {/* 文学审读页：五步评判流程 + R1/R2/R3 检查清单 + 报告生成 */}
      <div className="view-host" hidden={view !== 'audit'}>
        <LiteraryAudit />
      </div>

      <div className="view-host" hidden={view !== 'brain'}>
        <BrainFlow
          active={view === 'brain'}
          onEnterPro={id => {
            // v10.27 脑洞完成 → 进创作台并自动选中刚生成的那本书（画布结果同步到创作台）
            setBrainBookId(id ?? null)
            setCanvasTab('workbench')
            // v10.41 STEP4-01：第一次进工作台先给一张成果导览，别直接扔 7 块画布
            setTourOpen(shouldShowBrainTour())
            setLastMode('pro')
            setView('pro')
          }}
        />
      </div>

      <div className="pro-host" hidden={view !== 'pro'}>
        {/* v10.47 FLOW-01：顶部「画布/写作/世界观」tab 已拆 —— 页面顶部只显示当前环节的标识；
            画布 ↔ 写作 靠右缘「→ 写作」前进键 / 左缘「← 画布」退回键推进；
            世界观不再占 tab，入口挪到「画布页 → 工具行 🌍 世界观」 */}
        <div className="section-head">
          <span className="section-name">
            {canvasTab === 'canvas' ? '画布' : canvasTab === 'workbench' ? '写作' : '世界观'}
          </span>
        </div>

        <main className="main">
          <section className="workarea">
            <div hidden={canvasTab !== 'workbench'}>
              <p className="tab-sub">拆解旧稿、写章节、加工散稿、写短剧剧本</p>
              <Workbench
                onGoCanvases={() => setCanvasTab('canvas')}
                brainBookId={brainBookId || openBookId}
                focusChapters={writeNonce}
              />
            </div>
            <div hidden={canvasTab !== 'worldview'}>
              <p className="tab-sub">搭建故事世界的底层设定，管理系列合集</p>
              <WorldviewPanel onGoCanvases={() => setCanvasTab('canvas')} />
            </div>
            <div className="canvas-page" hidden={canvasTab !== 'canvas'}>
              <p className="tab-sub">7 块画布搭好小说骨架，一键合成整本书</p>
              {/* v10.49 UI-01：「历史版本」面板已整个下架（用户判定为测试痕迹）。
                  画布自动快照仍在 AppContext.autoSnapshot 里默默存档，数据没丢，
                  以后要做回滚可以再从「管理后台」给个入口。 */}
              <div className="canvas-tools-row">
                <HealthPanel />
                {/* v10.50：作品导入端口从「写作页」挪到「画布页」—— 选中即载入该书创作时的 7 块画布；
                    同时显示本书是否挂靠已有世界观（世界观入口改由首页「世界观创作」承担，不再占画布页工具） */}
                <label className="canvas-import" title="从资产库导入作品：载入它创作时的 7 块画布详情">
                  <span className="ico"><Icon name="book" size={15} /></span>
                  <select
                    className="wb-select"
                    value={state.linkedBookId ?? ''}
                    onChange={e => {
                      const id = e.target.value
                      if (id) importBook(id)
                    }}
                  >
                    <option value="">从资产库导入作品（载入画布详情）</option>
                    {state.library.map(b => (
                      <option key={b.id} value={b.id}>
                        《{b.title}》
                      </option>
                    ))}
                  </select>
                </label>
                {state.linkedBookId &&
                  (() => {
                    const linkedBook = state.library.find(b => b.id === state.linkedBookId) || null
                    const linkedWorldview = state.worldviews.find(w =>
                      (w.bookIds ?? []).includes(state.linkedBookId as string),
                    )
                    return (
                      <>
                        <span
                          className={`wv-link ${linkedWorldview ? 'on' : 'off'}`}
                          title="本书是否挂靠已有世界观"
                        >
                          {linkedWorldview
                            ? `已挂靠世界观《${linkedWorldview.name}》`
                            : '未挂靠世界观'}
                        </span>
                        {linkedBook && (
                          <button
                            className="ghost-btn sm"
                            onClick={unlinkBook}
                            title="取消与作品的关联（保留当前画布内容）"
                          >
                            取消关联
                          </button>
                        )}
                      </>
                    )
                  })()}
              </div>
              <CanvasRail />
              {state.selectedCanvasId ? <CanvasBlock /> : <EmptyState />}

              {/* v10.43 ENTRY-01：把「生成整本书」和「我自己写」合成一个入口放在底部 ——
                  原来顶部一个大按钮、右下角一个悬浮按钮，用户不知道该点哪个。
                  现在两个选项并列，选完都去「写作」。 */}
              <div className="next-step">
                <p className="next-step-title">7 块画布填完后，接下来怎么写？</p>
                <div className="next-step-cards">
                  <div className="next-step-card ai">
                    <span className="nsc-icon"><Icon name="zap" size={18} /></span>
                    <span className="nsc-name">AI 生成整本书</span>
                    <span className="nsc-desc">自动出书名 + 简介 + 全书大纲 + 第 1 章样章</span>
                    <BookGenerateBanner onGoWrite={goWriteChapter} />
                  </div>
                  <button className="next-step-card mine" onClick={goWriteChapter}>
                    <span className="nsc-icon"><Icon name="pen" size={18} /></span>
                    <span className="nsc-name">我自己写</span>
                    <span className="nsc-desc">从第 1 章开始逐章写，AI 只做辅助</span>
                    <span className="nsc-cta">从第 1 章开始写 →</span>
                  </button>
                </div>
                <p className="next-step-hint">两个选一个就行，点完都会跳到「写作」。</p>
              </div>
            </div>
          </section>
        </main>
        {/* v10.45：「书库类型」已从全局页脚移除 —— 它是内部素材盘点，
            现在只在「管理后台 → 平台语料 / 设置」里出现，普通用户看不到
            v10.48 HIDE-PROD：底部 Cloudflare 同步条只在测试版显示，正式版整个页脚不渲染 */}
        {IS_STAGING && (
          <footer className="footer">
            <CloudBadge />
          </footer>
        )}
      </div>

      {/* v10.41 STEP4-03：右下角固定主行动 —— 用户走完流程后真正想做的事就是「开始写」
          v10.47 FLOW-01：只在「写作」环节显示 —— 画布页的前进由右缘大键「→ 写作」接管，
          避免画布页同时出现两个「去写作」入口（ENTRY-01 的教训：入口多了用户反而不知道点哪个） */}
      {view === 'pro' && canvasTab === 'workbench' && (
        <button
          className="fab-write"
          onClick={goWriteChapter}
          title="继续写 —— 跳到「写作 · 写章」，接着上次写到的那一章写"
        >
          <span className="fab-write-icon"><Icon name="pen" size={16} /></span>
          <span className="fab-write-text">继续写 →</span>
        </button>
      )}

      {/* v10.47 FLOW-01：环节推进大键 —— 画布 → 写作（右缘）／ 写作·世界观 → 画布（左缘） */}
      {view === 'pro' && canvasTab === 'canvas' && (
        <button
          className="flow-fwd"
          onClick={() => setCanvasTab('workbench')}
          title="画布搭好了？进入写作环节"
        >
          <span className="flow-arrow">→</span>
          <span className="flow-label">写作</span>
        </button>
      )}
      {view === 'pro' && canvasTab !== 'canvas' && (
        <button
          className="flow-back"
          onClick={() => setCanvasTab('canvas')}
          title="退回画布环节"
        >
          <span className="flow-arrow">←</span>
          <span className="flow-label">画布</span>
        </button>
      )}

      {/* v10.42 GLOBAL-03：写满 1000 字才提示登录备份（只提示一次） */}
      {loginNudge && (
        <div className="login-nudge">
          <p className="login-nudge-text">
            已经写了 <b>{totalWords.toLocaleString('zh-CN')}</b> 字了？登录账号可以自动备份，换设备也能接着写。
          </p>
          <div className="login-nudge-actions">
            <button
              className="primary-btn sm"
              onClick={() => {
                setLoginNudge(false)
                setLocalOnlyMode(false)
              }}
            >
              登录，备份我的作品
            </button>
            <button className="ghost-btn sm" onClick={() => setLoginNudge(false)}>
              不用了，就放本地
            </button>
          </div>
        </div>
      )}

      {/* v10.41 STEP4-01：脑洞完成后的成果导览（只在首次弹一次） */}
      <BrainTour
        open={tourOpen}
        onClose={() => setTourOpen(false)}
        onStartWriting={goWriteChapter}
      />

      {/* v10.67：机器人「观澜」的常驻可移动形象 ——
          挂在 shell 内、与页面视图并列，所以切页面它不消失。
          没有出生（state.bot.persona 为空）时不渲染。 */}
      <AvatarLayer />

      {/* v10.40 GLOBAL-01：本机模式首次说明（只弹一次，7 秒后自动消失） */}
      {localNotice && (
        <div className="local-toast" role="status">
          <span>{localNotice}</span>
          <button className="local-toast-x" onClick={() => setLocalNotice('')} title="知道了">
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="empty">
      <p className="empty-title">点上方任意画布卡片开始</p>
      <p className="empty-hint">画布之间可手动连线，改一处会触发级联</p>
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <AuthGate>
        <AppShell />
      </AuthGate>
    </AppProvider>
  )
}
