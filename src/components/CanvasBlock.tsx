import { useMemo, useRef, useState } from 'react'
import { useApp } from '../store/AppContext'
import { DIMENSIONS } from '../lib/dims'

/** v18.5 釉色版：序号章用大写数字（与 CanvasRail 同一套） */
const CN_NUM = ['壹', '贰', '叁', '肆', '伍', '陆', '柒']
import type { ReferenceAnchor } from '../types'
import type { AnalyzeResult } from '../lib/llmClient'
import {
  findBookInLibrary,
  findBookByContent,
  bookToAnchor,
  lookupBook,
  dimensionBooks,
} from '../data/aiRecommendations'
import { analyzeBook, suggestAnchor } from '../lib/llmClient'
import { aiFillCanvas } from '../lib/canvasFill'
import { botWrite } from '../bot/botWrite'
import { StyleForge } from './StyleForge'
import { appliedCardNames, conflictsWithApplied } from '../data/styleConflicts'
import {
  STYLE_CARDS,
  STYLE_CARD_GROUPS,
  type StyleCard,
  type StyleCardGroup,
} from '../data/styleCards'
import { Icon } from './Icon'

// 画布头部 ✨ AI 自动检索：按选择的「联网/本地」模式检索本画布维度参考
export function CanvasBlock() {
  const {
    state,
    dispatch,
    selectedCanvas,
    canEdit,
    updateAnchor,
    removeAnchor,
    aiAppendAnchors,
    toggleCanvasLock,
    removeStyleCard,
    autoSnapshot,
    syncNow,
    conflicts,
    scheduleConflictCheck,
    runConflictCheck,
  } = useApp()
  const [aiState, setAiState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [aiNote, setAiNote] = useState('')
  /** v10.58：画布手动保存（存版本快照 + 立即同步云端） */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  /** v10.55：空画布的「AI 帮我填」—— 生成整块画布正文（与高级设置里的范文检索不同） */
  const [contentAi, setContentAi] = useState<'idle' | 'loading'>('idle')
  const [contentNote, setContentNote] = useState('')
  /** v10.73：机器人代笔画布 —— 与「AI 帮我填」并列的另一条入口（它按自己的人格写） */
  const [botFilling, setBotFilling] = useState(false)
  /** 机器人还没出生时，代笔按钮不渲染 */
  const botPersona = state.bot?.persona ?? null
  /** v10.59：进行中的 AI 填写/改写的中止控制器（点「终止生成」用） */
  const contentAbortRef = useRef<AbortController | null>(null)
  /** v10.59：参考画布选择（画布 id → 是否作为 AI 上下文）；未设置时默认「有内容就参考」 */
  const [refSel, setRefSel] = useState<Record<string, boolean>>({})
  // 修改3：联网 / 本地 检索模式（画布级，常驻可见，不再藏在折叠面板里）
  /** v10.42 EDIT-01：高级设置是否展开（记住选择，进阶用户展开一次就不用再点） */
  const [showAdv, setShowAdv] = useState(() => {
    try {
      return localStorage.getItem('ws-canvas-adv-v1') === '1'
    } catch {
      return false
    }
  })
  const [useSearch, setUseSearch] = useState(true)
  /** 文风卡：当前展开查看的那张 */
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [styleNote, setStyleNote] = useState('')
  /** 文风炼金弹窗（自己设计一张文风卡） */
  const [forgeOpen, setForgeOpen] = useState(false)
  /** 用户自己炼的卡，最新的排最前 */
  const customCards = state.customStyleCards ?? []
  /** 全量卡（自定义 + 预置），用于从画布正文反查已套用的卡 */
  const allCards = useMemo(() => [...customCards, ...STYLE_CARDS], [customCards])
  /** 画布里已套用的卡：按「【文风卡 · 名】」标记反查 */
  const appliedCards = useMemo(() => {
    const names = appliedCardNames(selectedCanvas?.content || '')
    return allCards.filter(c => names.includes(c.name))
  }, [selectedCanvas, allCards])
  if (!selectedCanvas) return null
  const editing = canEdit
  // PRD 功能1：画布锁定 —— 锁定后内容只读，AI 绝不改动
  const locked = Boolean(selectedCanvas.locked)
  /** v10.56：这块画布是否已有内容（空=AI 帮我填 / 有=AI 帮我改） */
  const hasContent = Boolean((selectedCanvas.content || '').trim())
  /** v10.57：当前画布卷入了哪些冲突（a/b 为画布 id） */
  const cfForThis = conflicts.filter(c => c.a === selectedCanvas.id || c.b === selectedCanvas.id)

  /**
   * v10.59 参考画布选择：用户可勾选让 AI 生成时参考哪几块画布。
   * v10.59b：列全 7 块（含当前画布自身，可作为重写基础）；默认（没动过开关的画布）= 有内容就参考。
   * 只要用户显式动过任何一个开关，就进入「严格参考」模式：AI 必须以勾选的画布为依据重写。
   */
  const refPickable = Object.values(state.canvases)
  const refOn = (id: string) => refSel[id] ?? Boolean((state.canvases[id]?.content || '').trim())
  const toggleRef = (id: string) => setRefSel(prev => ({ ...prev, [id]: !refOn(id) }))
  const strictRefs = Object.keys(refSel).length > 0

  /** v10.59：终止进行中的 AI 生成（fetch 中断，画布内容不会被打回来的半成品覆盖） */
  const stopAIFillContent = () => contentAbortRef.current?.abort()

  /**
   * v10.58「保存」：显式保存当前画布 ——
   * ① 强制存一份版本快照（force=true 跳过一分钟合并，可在「备份历史」回滚）；
   * ② 立即推一次云端（未登录/仅本机时 syncNow 内部自动跳过）。
   * 平时击键已自动写本地，这里是给用户一个「我存好了」的确定按钮。
   */
  const handleSave = async () => {
    if (!selectedCanvas || saveState === 'saving') return
    setSaveState('saving')
    try {
      autoSnapshot(`手动保存 · ${selectedCanvas.title || selectedCanvas.dimension}`, true)
      await syncNow()
      setSaveState('saved')
    } catch {
      // syncNow 内部已吞错（云端失败置 offline），本地快照一定已落，按成功处理
      setSaveState('saved')
    } finally {
      setTimeout(() => setSaveState('idle'), 2000)
    }
  }

  const handleAIFill = async () => {
    if (!selectedCanvas) return
    setAiState('loading')
    setAiNote('')
    // 以画布内容优先作为检索/分析主题（用户在内容框里输入的才是检索意图）
    const topic = selectedCanvas.content.trim() || selectedCanvas.title
    try {
      if (useSearch) {
        // 联网：调用 优质模型生产生产（web_search）分析本画布维度
        const { data: llm, searched, searchCount } = await analyzeBook(
          topic,
          selectedCanvas.dimension,
          true,
        )
        const anchor: ReferenceAnchor = {
          id: crypto.randomUUID(),
          source: llm.source || topic,
          features: llm.features || '',
          examples: llm.examples || '',
        }
        aiAppendAnchors(selectedCanvas.id, [anchor])
        setAiNote(searched ? `已联网检索 ${searchCount} 次` : '未触发联网检索（模型凭已有知识回答）')
      } else {
        // 本地：优先本地书库推荐；书库无匹配再调 LLM 本地知识兜底
        const keys = dimensionBooks[selectedCanvas.dimension] || []
        const anchors: ReferenceAnchor[] = keys
          .map(k => {
            const meta = lookupBook(k)
            if (!meta) return null
            return bookToAnchor(k, meta, selectedCanvas.dimension)
          })
          .filter(Boolean) as ReferenceAnchor[]
        if (anchors.length) {
          aiAppendAnchors(selectedCanvas.id, anchors)
          setAiNote(`本地书库推荐 ${anchors.length} 本`)
        } else {
          const { data: llm } = await analyzeBook(topic, selectedCanvas.dimension, false)
          const anchor: ReferenceAnchor = {
            id: crypto.randomUUID(),
            source: llm.source || topic,
            features: llm.features || '',
            examples: llm.examples || '',
          }
          aiAppendAnchors(selectedCanvas.id, [anchor])
          setAiNote('本地知识（书库无匹配）')
        }
      }
      setAiState('done')
      setTimeout(() => setAiState('idle'), 1800)
    } catch (e) {
      setAiNote(`分析失败：${e instanceof Error ? e.message : String(e)}`)
      setAiState('idle')
    }
  }

  /**
   * v10.55「AI 帮我填这块画布」：空画布时出现 —— 用书名/简介/章纲 + 其他画布作上下文，
   * 让 AI 直接产出这一维度的正文（服务端 refine 对空内容就是「按修改要求写出来」）。
   * 与高级设置里的「AI 自动检索」（只追加范文参考锚点）不是一回事，故单独一个入口。
   */
  const handleAIFillContent = async () => {
    if (!selectedCanvas || locked) return
    if (contentAi === 'loading') return
    // 防生成中用户切换画布：进场先锁定本块画布的 id，全程用它发「研墨中」信号
    const canvasId = selectedCanvas.id
    setContentAi('loading')
    // 「研墨中」：流水线上这张卡片开始呼吸（CanvasRail 据此渲染）
    dispatch({ type: 'AI_FILLING', id: canvasId, on: true })
    setContentNote('')
    // v10.59：挂一个中止控制器，「终止生成」按钮随时掐断
    const ac = new AbortController()
    contentAbortRef.current = ac
    try {
      // v10.59：只把勾选中的画布作为参考（v10.59b：含当前画布自身，共 7 块可选）
      const others: Record<string, string> = {}
      Object.values(state.canvases).forEach(x => {
        if ((x.content || '').trim() && refOn(x.id)) others[x.dimension] = x.content.trim()
      })
      const book = state.library.find(b => b.id === state.linkedBookId)
      const outlineText = book?.outline?.length
        ? book.outline
            .slice(0, 20)
            .map(ch => `第${ch.index}章 ${ch.title}${ch.summary ? `：${ch.summary}` : ''}`)
            .join('\n')
        : ''
      const { refined, searched, searchCount } = await aiFillCanvas({
        dimension: selectedCanvas.dimension,
        current: selectedCanvas.content,
        bookTitle: book?.title,
        bookSynopsis: book?.synopsis,
        bookOutlineText: outlineText,
        otherCanvases: others,
        webSearch: useSearch,
        signal: ac.signal,
        strictRefs,
      })
      if (!refined) {
        setContentNote('AI 没返回内容，请重试一次。')
      } else {
        autoSnapshot(`AI 帮我填画布（${selectedCanvas.dimension}）`)
        dispatch({ type: 'UPDATE_CONTENT', id: selectedCanvas.id, content: refined })
        void runConflictCheck()
        const refNames = Object.keys(others)
        setContentNote(
          `已填入「${selectedCanvas.dimension}」画布${searched ? `（联网检索 ${searchCount} 次）` : ''}${
            refNames.length ? `；参考了：${refNames.join('、')}` : '（未参考其他画布）'
          }`,
        )
      }
    } catch (e) {
      if (ac.signal.aborted) {
        // 用户主动终止 —— 不算错误，画布内容保持原样
        setContentNote('已终止生成，画布内容未改动。')
      } else {
        setContentNote(`生成失败：${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      if (contentAbortRef.current === ac) contentAbortRef.current = null
      setContentAi('idle')
      // 「研墨中」熄灭：成功 / 失败 / 用户终止（abort 会 reject 走进本 finally）统一收口
      dispatch({ type: 'AI_FILLING', id: canvasId, on: false })
    }
  }

  /**
   * v10.73「让它帮我填这块画布」：同一个位置、同一份上下文，但**写的人不是工具，是它自己**。
   *
   * 和 handleAIFillContent 的差别只在提示词的主语（人格卡 + 它自己的三观在前，
   * 任务在后）——所以填出来的设定会带它自己的偏好，甚至会和你想的不一样。
   * 落库方式完全一致：先存快照，再 UPDATE_CONTENT，最后跑一次矛盾检测。
   */
  const handleBotFillContent = async () => {
    if (!selectedCanvas || locked || !botPersona || botFilling) return
    // 防代笔中用户切换画布：锁定本块画布 id，全程用它发「研墨中」信号
    const canvasId = selectedCanvas.id
    setBotFilling(true)
    // 「研墨中」：机器人代笔同样点亮流水线卡片
    dispatch({ type: 'AI_FILLING', id: canvasId, on: true })
    setContentNote('')
    try {
      const others: Record<string, string> = {}
      Object.values(state.canvases).forEach(x => {
        if ((x.content || '').trim() && refOn(x.id)) others[x.dimension] = x.content.trim()
      })
      const book = state.library.find(b => b.id === state.linkedBookId)
      const outlineText = book?.outline?.length
        ? book.outline
            .slice(0, 20)
            .map(ch => `第${ch.index}章 ${ch.title}${ch.summary ? `：${ch.summary}` : ''}`)
            .join('\n')
        : ''
      const current = (selectedCanvas.content || '').trim()
      const context = [
        book ? `— 作品 —\n《${book.title}》${book.synopsis ? `\n${book.synopsis}` : ''}` : '',
        outlineText ? `— 章纲 —\n${outlineText}` : '',
        Object.keys(others).length
          ? `— 其它画布 —\n${Object.entries(others)
              .map(([d, v]) => `【${d}】${v.length > 800 ? `${v.slice(0, 800)}…` : v}`)
              .join('\n\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')

      const { content, why } = await botWrite({
        persona: botPersona,
        value: state.bot?.value,
        memories: state.bot?.memories,
        brief: current
          ? `请改写并补全「${selectedCanvas.dimension}」这块画布：下面是现有内容，保留其中有价值的设定，其余按你的判断重写。\n\n${current.length > 1200 ? `${current.slice(0, 1200)}…` : current}`
          : `请从零写出「${selectedCanvas.dimension}」这块画布的具体内容（不要写"这里应该写…"这类说明，直接给设定本身）。`,
        context,
        targetWords: 600,
      })

      if (!content.trim()) {
        setContentNote(`${botPersona.name}这次没写出东西来，再试一次？`)
        return
      }
      autoSnapshot(`让${botPersona.name}代笔画布（${selectedCanvas.dimension}）`)
      dispatch({ type: 'UPDATE_CONTENT', id: selectedCanvas.id, content })
      void runConflictCheck()
      const firstWhy = why.split('\n').find(l => l.trim())
      setContentNote(
        `${botPersona.name}写完了「${selectedCanvas.dimension}」${
          firstWhy ? `；它写的时候想起：${firstWhy}` : '（这次没想起旧事，全按当下的想法写的）'
        }`,
      )
    } catch (e) {
      setContentNote(`代笔失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBotFilling(false)
      // 「研墨中」熄灭（botWrite 无独立终止路径，异常同样走进本 finally）
      dispatch({ type: 'AI_FILLING', id: canvasId, on: false })
    }
  }

  /** 套用文风卡：把卡的文案写进【文笔】画布（replace=替换 / append=追加） */
  const applyStyleCard = (card: StyleCard, mode: 'replace' | 'append') => {
    if (!selectedCanvas || locked) return
    // v10.31 replace 会直接顶掉【文笔】画布原有内容 —— 动手前先存一份版本
    if (mode === 'replace') autoSnapshot('套用文风卡（替换文笔画布）')
    // 统一打标记行（预置卡自带；自定义卡可能没有），后续矛盾检测靠它认卡
    const text = card.applyText.trimStart().startsWith('【文风卡')
      ? card.applyText
      : `【文风卡 · ${card.name}】\n${card.applyText}`
    const cur = (selectedCanvas.content || '').trim()
    const next = mode === 'replace' || !cur ? text : `${cur}\n\n${text}`
    dispatch({ type: 'UPDATE_CONTENT', id: selectedCanvas.id, content: next })
    void scheduleConflictCheck()
    // 矛盾检测：replace 会清掉旧卡，只需在 append 时提醒
    const conflicts = mode === 'append' ? conflictsWithApplied(card, appliedCards) : []
    if (conflicts.length > 0) {
      setStyleNote(
        `已追加「${card.name}」，但它和 ${conflicts
          .map(c => `「${c.card.name}」`)
          .join('、')}可能矛盾：${conflicts.flatMap(c => c.pairs).join('；')}。建议二选一，或改掉冲突项。`,
      )
    } else {
      setStyleNote(
        `已${mode === 'replace' ? '套用' : '追加'}文风卡「${card.name}」，之后生成 / 润色 / 精修都会按这个文风走。`,
      )
    }
    setTimeout(() => setStyleNote(''), 6000)
  }

  return (
    <div className={`canvas-block ${locked ? 'is-locked' : ''} ${cfForThis.length ? 'conflict' : ''}`}>
      <header className="canvas-block-head">
        {/* v18.5 釉色版：序号章「壹 / 柒」 */}
        <span className="cb-seal-index">
          {CN_NUM[Math.max(0, DIMENSIONS.indexOf(selectedCanvas.dimension))]} / {CN_NUM[DIMENSIONS.length - 1]}
        </span>
        <h2>{selectedCanvas.title}</h2>
        <span className="canvas-dim-pill">{selectedCanvas.dimension}</span>
        {editing && (
          <button
            type="button"
            className={`canvas-save-btn ${saveState === 'saved' ? 'saved' : ''}`}
            onClick={() => void handleSave()}
            disabled={saveState === 'saving'}
            title="保存这块画布：立即写本地存档 + 存一份可回滚的版本快照 + 同步云端"
          >
            {saveState === 'saving' && (<><Icon name="refresh" size={14} /> 保存中…</>)}
            {saveState === 'saved' && (<><Icon name="save" size={14} /> 已保存</>)}
            {saveState === 'idle' && (<><Icon name="save" size={14} /> 保存</>)}
          </button>
        )}
        {editing && (
          <div className="canvas-adv-wrap">
            {/* v10.42 EDIT-01：这排按钮（锁定 / 检索方式 / AI 自动检索）是进阶功能，
                新手第一次进来完全不知道它们是干什么的 → 默认折起来，展开后每个都带一句人话说明 */}
            <button
              type="button"
              className={`canvas-adv-toggle ${showAdv ? 'on' : ''}`}
              onClick={() => {
                const next = !showAdv
                setShowAdv(next)
                try {
                  localStorage.setItem('ws-canvas-adv-v1', next ? '1' : '0')
                } catch {
                  /* 隐私模式写不了，无所谓 */
                }
              }}
              title="锁定 / 检索方式 / AI 自动检索 —— 给进阶用法准备的，平时不用管"
            >
              <Icon name="gear" size={14} /> 高级设置 {showAdv ? '▴' : '▾'}
            </button>

            {showAdv && (
              <div className="canvas-actions">
                {/* PRD 功能1：画布锁定 */}
                <button
                  type="button"
                  className={`lock-btn ${locked ? 'active' : ''}`}
                  onClick={() => toggleCanvasLock(selectedCanvas.id)}
                  title={
                    locked
                      ? '已锁定：AI 改写 / 重新生成 / 拆解 / 续写都不会改动这块画布，点一下解锁'
                      : '锁定这块画布：AI 改写 / 重新生成 / 拆解 / 续写都不会动它'
                  }
                >
                  {locked ? (
                    <>
                      <Icon name="lock" size={14} /> 已锁定
                    </>
                  ) : (
                    <>
                      <Icon name="unlock" size={14} /> 锁定
                    </>
                  )}
                </button>
                {/* 修改3：联网 / 本地 检索模式切换（常驻可见） */}
                <div className="seg canvas-search-seg" title="选择 AI 检索方式">
                  <button
                    type="button"
                    className={useSearch ? 'seg-btn active' : 'seg-btn'}
                    onClick={() => setUseSearch(true)}
                  >
                    <Icon name="globe" size={14} /> 联网检索
                  </button>
                  <button
                    type="button"
                    className={!useSearch ? 'seg-btn active' : 'seg-btn'}
                    onClick={() => setUseSearch(false)}
                  >
                    <Icon name="book" size={14} /> 本地检索
                  </button>
                </div>
                <button
                  className="ai-btn"
                  onClick={handleAIFill}
                  disabled={aiState !== 'idle'}
                  title={useSearch ? '联网调用 优质模型生产 分析本画布维度' : '从本地书库/本地知识推荐参考'}
                >
                  {aiState === 'loading' && '检索中…'}
                  {aiState === 'done' && '✓ 已添加'}
                  {aiState === 'idle' && (<><Icon name="zap" size={14} /> AI 自动检索</>)}
                </button>
              </div>
            )}

            {showAdv && (
              <p className="canvas-adv-hints">
                <span><Icon name="lock" size={14} /> 锁定 = AI 自动填充时不会覆盖这块</span>
                <span><Icon name="globe" size={14} /> 联网检索 = 写这块时联网找参考资料</span>
                <span><Icon name="book" size={14} /> 本地检索 = 只在你的作品和世界观里找</span>
                <span><Icon name="zap" size={14} /> 点一下 = 立刻按当前设置填一版参考</span>
              </p>
            )}
          </div>
        )}
      </header>

      {locked && (
        <p className="canvas-locked-note">
          <Icon name="lock" size={14} /> 这块画布已锁定 —— AI 改写、重新生成、拆解、续写都不会修改它。要改内容先点上面的「已锁定」解锁。
        </p>
      )}

      {cfForThis.length > 0 && (
        <div className="cb-conflict-banner">
          <span className="cb-conflict-title">
            检测到 {cfForThis.length} 处画布冲突
          </span>
          <ul className="cb-conflict-list">
            {cfForThis.map((c, i) => {
              const otherId = c.a === selectedCanvas.id ? c.b : c.a
              const otherDim = state.canvases[otherId]?.dimension || otherId
              return (
                <li key={i}>
                  与「{otherDim}」冲突：{c.reason}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {editing && aiNote && <p className="ai-note">{aiNote}</p>}

      {/* v10.50：画布内容（左）与范文参考（右）并排 —— 范文参考不再堆在内容下方 */}
      <div className="cb-cols">
        <div className="cb-main">
          <section className="content-section">
        <h3 className="sub-title">画布内容</h3>
        {editing ? (
          locked ? (
            <div className="content-readonly locked">{selectedCanvas.content || <em>（空白）</em>}</div>
          ) : (
            <textarea
              className="content-textarea"
              value={selectedCanvas.content}
              onChange={e =>
                dispatch({ type: 'UPDATE_CONTENT', id: selectedCanvas.id, content: e.target.value })
              }
              onBlur={() => scheduleConflictCheck()}
              placeholder="在这块画布上记录这个维度的内容…（空着的话，可点下方「AI 帮我填」）"
            />
          )
        ) : (
          <div className="content-readonly">
            {selectedCanvas.content || <em>（空白）</em>}
          </div>
        )}

        {/* v10.56：每块画布都有 AI 入口（空=帮我填 / 有内容=帮我改）—— 直接生成/重写正文，不是范文检索 */}
        {editing && !locked && (
          <div className="ai-fill-row">
            <button
              className={`ai-fill-btn ${hasContent ? 'sub' : ''}`}
              onClick={handleAIFillContent}
              disabled={contentAi !== 'idle'}
            >
              <Icon name="zap" size={14} />{' '}
              {contentAi === 'loading'
                ? 'AI 正在写…'
                : hasContent
                  ? `AI 帮我改「${selectedCanvas.dimension}」画布`
                  : `AI 帮我填「${selectedCanvas.dimension}」画布`}
            </button>
            {/* v10.73：同一条入口的「人格版」—— 谁写这块画布，由它自己决定 */}
            {botPersona && (
              <button
                className="ghost-btn"
                onClick={handleBotFillContent}
                disabled={contentAi !== 'idle' || botFilling || locked}
                title={`让${botPersona.name}按自己的人格写这块画布（会先存快照，写坏了可回滚）`}
              >
                <Icon name="pen" size={14} />{' '}
                {botFilling ? `${botPersona.name}正在写…` : `让${botPersona.name}帮我填`}
              </button>
            )}
            {/* v10.59：生成中随时可终止 —— fetch 直接掐断，画布内容不会被半成品覆盖 */}
            {contentAi === 'loading' && (
              <button
                type="button"
                className="ai-stop-btn"
                onClick={stopAIFillContent}
                title="终止这次 AI 生成，画布内容保持原样不动"
              >
                <Icon name="scissors" size={14} /> 终止生成
              </button>
            )}
            <span className="ai-fill-hint">
              {hasContent
                ? '按书名 / 其他画布再写细一版（会覆盖当前内容，写前自动存快照）'
                : '按书名 / 简介 / 其他画布生成一版内容，写完可直接改'}
            </span>
          </div>
        )}
        {/* v10.59：参考画布选择 —— 勾选谁，AI 生成这块时就以谁为依据重写（v10.59b：7 块全列出，含本画布） */}
        {editing && !locked && refPickable.length > 0 && (
          <div className="ai-ref-row">
            <span className="ai-ref-label">参考画布：</span>
            {refPickable.map(x => (
              <button
                key={x.id}
                type="button"
                className={`ai-ref-chip ${refOn(x.id) ? 'on' : ''} ${x.id === selectedCanvas.id ? 'self' : ''}`}
                onClick={() => toggleRef(x.id)}
                title={
                  x.id === selectedCanvas.id
                    ? refOn(x.id)
                      ? '本画布也作为重写基础，点一下取消'
                      : '点一下把本画布作为重写基础'
                    : refOn(x.id)
                      ? '已选为参考依据，点一下取消'
                      : '未参考，点一下选为依据'
                }
              >
                {x.dimension}
              </button>
            ))}
            <span className="ai-ref-hint">
              勾选后点 AI 生成，会<b>以勾选的画布为依据重新生成</b>本块内容（默认：有内容的都参考）
            </span>
          </div>
        )}
        {editing && contentNote && <p className="ai-note">{contentNote}</p>}

        {/* 文风卡：只在【文笔】画布出现，点了立刻把文风写进画布 */}
        {selectedCanvas.dimension === '文笔' && (
          <StyleCardBar
            openId={openCardId}
            onToggle={id => setOpenCardId(prev => (prev === id ? null : id))}
            onApply={applyStyleCard}
            editable={editing && !locked}
            customCards={customCards}
            onRemoveCustom={id => {
              removeStyleCard(id)
              setStyleNote('已删除这张自定义文风卡')
              setTimeout(() => setStyleNote(''), 2500)
            }}
            onOpenForge={() => setForgeOpen(true)}
            appliedCards={appliedCards}
          />
        )}
        {styleNote && <p className="ai-note">{styleNote}</p>}
          </section>
        </div>
        <aside className="cb-anchors">
          <section className="anchor-section">
        <h3 className="sub-title">
          范文参考 <span className="count-pill">{selectedCanvas.anchors.length}</span>
        </h3>
        {selectedCanvas.anchors.length === 0 ? (
          <>
            <p className="anchor-empty">
              想让 AI 照着你喜欢的文风写？贴一段范文进来。{editing ? '在下方「+ 新增范文参考」里贴。' : '管理模式下可添加。'}
            </p>
            {/* v18.5 釉色版：竖排引文 */}
            <div className="cb-quote-wrap">
              <div className="cb-quote-vert">观千剑而后识器</div>
              <div className="cb-quote-src">—— 文心雕龙 · 知音</div>
            </div>
          </>
        ) : (
          <ul className="anchor-list">
            {selectedCanvas.anchors.map(a => (
              <AnchorCard
                key={a.id}
                canvasId={selectedCanvas.id}
                anchor={a}
                editing={editing}
                onUpdate={updateAnchor}
                onRemove={removeAnchor}
              />
            ))}
          </ul>
        )}
        {editing && <AnchorAdder key={selectedCanvas.id} canvasId={selectedCanvas.id} useSearch={useSearch} />}
          </section>
        </aside>
      </div>

      {/* 文风炼金：自己设计一张文风卡（结果存进 AppState.customStyleCards，跟着云同步） */}
      {forgeOpen && <StyleForge onClose={() => setForgeOpen(false)} />}
    </div>
  )
}

function AnchorCard({
  canvasId,
  anchor,
  editing,
  onUpdate,
  onRemove,
}: {
  canvasId: string
  anchor: ReferenceAnchor
  editing: boolean
  onUpdate: (canvasId: string, a: ReferenceAnchor) => void
  onRemove: (canvasId: string, id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className="anchor-card">
      <header className="anchor-head" onClick={() => setOpen(o => !o)}>
        <span className="anchor-source">{anchor.source || '（未命名参考）'}</span>
        <span className="anchor-toggle">{open ? '收起' : '展开'}</span>
      </header>
      {open && (
        <div className="anchor-body">
          {editing ? (
            <>
              <label className="field">
                <span>参考来源</span>
                <input
                  value={anchor.source}
                  onChange={e => onUpdate(canvasId, { ...anchor, source: e.target.value })}
                />
              </label>
              <label className="field">
                <span>特征描述</span>
                <textarea
                  rows={3}
                  value={anchor.features}
                  onChange={e => onUpdate(canvasId, { ...anchor, features: e.target.value })}
                />
              </label>
              <label className="field">
                <span>原文例证</span>
                <textarea
                  rows={4}
                  value={anchor.examples}
                  onChange={e => onUpdate(canvasId, { ...anchor, examples: e.target.value })}
                />
              </label>
              <button className="danger-btn" onClick={() => onRemove(canvasId, anchor.id)}>
                删除此锚点
              </button>
            </>
          ) : (
            <>
              <p>
                <strong>特征：</strong>
                {anchor.features || '—'}
              </p>
              <p>
                <strong>例证：</strong>
                {anchor.examples || '—'}
              </p>
            </>
          )}
        </div>
      )}
    </li>
  )
}

// 新增锚点：按 source 框输入查书库；命中本地库直接填，未命中调 AI（支持联网/本地 + 重新生成去重）
// useSearch 由画布级开关统一控制，避免两处不一致
function AnchorAdder({ canvasId, useSearch }: { canvasId: string; useSearch: boolean }) {
  const { state, addAnchor, selectedCanvas } = useApp()
  const [source, setSource] = useState('')
  const [features, setFeatures] = useState('')
  const [examples, setExamples] = useState('')
  const [fillState, setFillState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [notFound, setNotFound] = useState('')
  const [searchInfo, setSearchInfo] = useState('')
  // 修改4：已生成的历史结果，用于「重新生成」时去重（内容不重复）
  const [prevResults, setPrevResults] = useState<AnalyzeResult[]>([])
  const [hasLLMResult, setHasLLMResult] = useState(false)
  /** 当前结果是不是「按自己画布直出」来的 —— 决定「🔄 重新生成」该走哪条链路 */
  const [suggestMode, setSuggestMode] = useState(false)
  /** v10.60：批量添加成功提示（面板不收起，方便连续加多本） */
  const [addedNote, setAddedNote] = useState('')

  const reset = () => {
    setSource('')
    setFeatures('')
    setExamples('')
    setNotFound('')
    setSearchInfo('')
    setPrevResults([])
    setHasLLMResult(false)
  }

  // 真正调用 LLM（联网/本地由 useSearch 决定）。isRegenerate=true 时把历史结果传入去重
  const callLLM = async (isRegenerate: boolean) => {
    if (!selectedCanvas) return
    const userSource =
      source.trim() || selectedCanvas.content.trim().slice(0, 30) || selectedCanvas.title
    setFillState('loading')
    setNotFound('')
    setSearchInfo('')
    setFeatures('')
    setExamples('')
    setSuggestMode(false)
    try {
      const { data: llm, searched, searchCount } = await analyzeBook(
        userSource,
        selectedCanvas.dimension,
        useSearch,
        isRegenerate ? prevResults : [],
      )
      const result: AnalyzeResult = {
        source: llm.source || userSource,
        features: llm.features || '',
        examples: llm.examples || '',
      }
      setSource(result.source)
      setFeatures(result.features)
      setExamples(result.examples)
      setPrevResults(p => [...p, result])
      setHasLLMResult(true)
      setFillState('done')
      setSearchInfo(
        useSearch
          ? searched
            ? `已联网检索 ${searchCount} 次`
            : '未触发联网检索（模型凭已有知识回答，请留意准确性）'
          : '本地知识模式（未联网）',
      )
      setTimeout(() => setFillState('idle'), 1600)
    } catch (e) {
      setNotFound(`${userSource}（LLM 分析失败：${e instanceof Error ? e.message : String(e)}）`)
      setFillState('idle')
    }
  }

  /**
   * v10.19 修 bug：书库都匹配不上时，不再回填写死的「提示：…」方法论。
   * v10.20 再修：AI 必须**点名推荐 1 部署名作品**（「作品名（作者）」写在【参考来源】），
   * features / examples 都围绕那部作品 + 用户自己的画布来写 ——
   * 用户要的是「这次参考的是哪本书」，而不是「本作推演」这种自造标签。
   */
  const callSuggest = async (isRegenerate: boolean) => {
    if (!selectedCanvas) return
    setFillState('loading')
    setNotFound('')
    setSearchInfo('')
    setFeatures('')
    setExamples('')
    setSuggestMode(true)
    // 其他画布作为上下文（只带非空的），让模型知道人物名/设定名
    const canvasContext: Record<string, string> = {}
    for (const c of Object.values(state.canvases)) {
      const t = (c.content || '').trim()
      if (t) canvasContext[c.dimension] = t
    }
    try {
      const { data: llm, searched, searchCount } = await suggestAnchor({
        dimension: selectedCanvas.dimension,
        content: (selectedCanvas.content || '').trim(),
        title: selectedCanvas.title,
        canvases: canvasContext,
        useSearch,
        previousResults: isRegenerate ? prevResults : [],
      })
      const features = (llm.features || '').trim()
      const examples = (llm.examples || '').trim()
      if (!features && !examples) {
        setNotFound('AI 这次没返回内容，请重试一次，或在顶栏把引擎切到「云端 优质模型生产」。')
        setFillState('idle')
        return
      }
      const result: AnalyzeResult = {
        // 服务端已保证 source 是「参考作品名（作者）」；真拿不到就如实写明未确认
        source: (llm.source || '（未确认参考作品）').trim(),
        features,
        examples,
      }
      setSource(result.source)
      setFeatures(result.features)
      setExamples(result.examples)
      setPrevResults(p => [...p, result])
      setHasLLMResult(true)
      setFillState('done')
      setSearchInfo(
        useSearch
          ? searched
            ? `已联网检索 ${searchCount} 次，并按你的画布内容推荐了上面这部署名作品`
            : '已按你的画布内容推荐了上面的参考作品（未触发联网，用的是模型已有知识）'
          : '已按你的画布内容推荐了上面的参考作品（本地知识模式）',
      )
      setTimeout(() => setFillState('idle'), 1800)
    } catch (e) {
      setNotFound(
        `AI 生成具体内容失败：${e instanceof Error ? e.message : String(e)}。可重试，或在顶栏把引擎切到「云端 优质模型生产」。`,
      )
      setFillState('idle')
    }
  }

  const handleAIFill = async () => {
    if (!selectedCanvas) return
    setFillState('loading')
    setNotFound('')
    setSearchInfo('')
    const userSource = source.trim()
    // 清空旧结果（避免上次成功的填充残留误导用户）
    setFeatures('')
    setExamples('')

    if (userSource) {
      // 优先级 1：用户输入的书名 → 在本地库中查
      const hit = findBookInLibrary(userSource)
      if (hit) {
        const a = bookToAnchor(hit.key, hit.meta, selectedCanvas.dimension)
        setSource(a.source)
        setFeatures(a.features)
        setExamples(a.examples)
        setPrevResults([])
        setHasLLMResult(false)
        setFillState('done')
        setTimeout(() => setFillState('idle'), 1600)
        return
      }
      // 优先级 2：本地没有 → 调 AI（联网/本地由开关决定），重置历史去重
      setPrevResults([])
      setHasLLMResult(false)
      await callLLM(false)
      return
    }

    // 优先级 3：source 空 → 按画布 content 关键词在书库里查
    const hit = findBookByContent(selectedCanvas.content)
    if (hit) {
      const a = bookToAnchor(hit.key, hit.meta, selectedCanvas.dimension)
      setSource(a.source)
      setFeatures(a.features)
      setExamples(a.examples)
      setPrevResults([])
      setHasLLMResult(false)
      setFillState('done')
      setTimeout(() => setFillState('idle'), 1600)
      return
    }
    // 优先级 4：库也匹配不上 → 交给 AI，基于用户自己的画布内容直出**具体**参考
    // （v10.19 修 bug：此处原来回填写死的「提示：…」方法论，用户反馈「只给提示词、不给具体内容」）
    setPrevResults([])
    setHasLLMResult(false)
    await callSuggest(false)
  }

  return (
    <details className="anchor-adder">
      <summary>+ 新增范文参考</summary>
      <div className="anchor-body">
        <label className="field">
          <span>参考来源</span>
          <input
            value={source}
            onChange={e => {
              setSource(e.target.value)
              if (notFound) setNotFound('')
              // 用户手动改来源即视为新查询，重置去重历史与重新生成入口
              setHasLLMResult(false)
              setPrevResults([])
            }}
            placeholder="书名 / 范文标题，可一次贴多本（换行或逗号分隔）"
          />
        </label>
        <label className="field">
          <span>特征描述</span>
          <textarea
            rows={3}
            value={features}
            onChange={e => setFeatures(e.target.value)}
            placeholder="AI 解析出的本画布维度特征"
          />
        </label>
        <label className="field">
          <span>原文例证</span>
          <textarea
            rows={4}
            value={examples}
            onChange={e => setExamples(e.target.value)}
            placeholder="能支撑上述特征的原文片段"
          />
        </label>
        {notFound && <p className="not-found">{notFound}</p>}
        {searchInfo && <p className="search-info">{searchInfo}</p>}
        <div className="row">
          <button
            className="ai-mini-btn"
            onClick={handleAIFill}
            disabled={fillState !== 'idle'}
            title="按已填的来源查书库，命中则自动填三栏，未命中则调用 AI"
          >
            {fillState === 'loading' && (source.trim() ? 'AI 分析中…' : 'AI 匹配中…')}
            {fillState === 'done' && '✓ 已填三栏'}
            {fillState === 'idle' && (<><Icon name="zap" size={14} /> AI 填充</>)}
          </button>
          {hasLLMResult && (
            <button
              className="ai-mini-btn ghost"
              onClick={() => (suggestMode ? callSuggest(true) : callLLM(true))}
              disabled={fillState !== 'idle'}
              title="基于已生成内容重新生产一份不重复的结果"
            >
              {fillState === 'loading' ? '重新生成中…' : (<><Icon name="refresh" size={14} /> 重新生成</>)}
            </button>
          )}
          <button
            className="primary-btn"
            disabled={!source.trim() && !features.trim()}
            onClick={() => {
              // v10.60 批量添加：参考来源按换行 / 空格 / 逗号 / 顿号 / 分号拆成多个书名，一键入库多本。
              // （浏览器会把贴进 input 的换行转成空格，所以空格也算分隔符）
              const feats = features.trim()
              const exs = examples.trim()
              const names = source
                .split(/[\s,，、;；]+/)
                .map(s => s.trim())
                .filter(Boolean)
              const addedNames: string[] = []
              for (const name of names) {
                const hit = findBookInLibrary(name)
                const a = hit
                  ? bookToAnchor(hit.key, hit.meta, selectedCanvas!.dimension)
                  : { source: name, features: feats, examples: exs }
                addAnchor(canvasId, a.source, a.features, a.examples)
                addedNames.push(a.source)
              }
              // 旧行为兜底：没填书名但填了特征 → 直接加一条无名锚点
              if (!names.length) {
                addAnchor(canvasId, '', feats, exs)
                addedNames.push('（未命名参考）')
              }
              setAddedNote(`✓ 已添加 ${addedNames.length} 本范文参考：${addedNames.join('、')}。可继续粘贴下一批。`)
              setTimeout(() => setAddedNote(''), 8000)
              setSource('')
              setFeatures('')
              setExamples('')
              setNotFound('')
              setSearchInfo('')
              setPrevResults([])
              setHasLLMResult(false)
            }}
          >
            添加锚点
          </button>
        </div>
        {addedNote && <p className="search-info">{addedNote}</p>}
        {prevResults.length > 1 && (
          <p className="dedup-hint">
            已累计生成 {prevResults.length} 份不重复内容，可继续点「重新生成」
          </p>
        )}
      </div>
    </details>
  )
}

/**
 * 文风卡条：预置文风模板。展开能看到「这张卡会让文风变成什么样」+ 原文例句，
 * 可一键套用（替换画布）或追加到【文笔】画布。
 */
function StyleCardBar({
  openId,
  onToggle,
  onApply,
  editable,
  customCards,
  onRemoveCustom,
  onOpenForge,
  appliedCards,
}: {
  openId: string | null
  onToggle: (id: string) => void
  onApply: (card: StyleCard, mode: 'replace' | 'append') => void
  editable: boolean
  /** 用户自己炼的卡（AppState.customStyleCards） */
  customCards: StyleCard[]
  onRemoveCustom: (id: string) => void
  onOpenForge: () => void
  /** 当前画布里已套用的卡（用来做矛盾提示） */
  appliedCards: StyleCard[]
}) {
  const [group, setGroup] = useState<StyleCardGroup | '全部'>('全部')
  const [query, setQuery] = useState('')
  /** 面板整体折叠：记住上次的状态，默认收起，避免 112 张卡把画布顶到看不见 */
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('ws:style-cards-open') !== '0'
    } catch {
      return true
    }
  })
  /** 不搜索时分页展示，避免一次渲染上百张 */
  const [limit, setLimit] = useState(20)

  const all = useMemo(() => [...customCards, ...STYLE_CARDS], [customCards])
  const countOf = (g: StyleCardGroup | '全部') =>
    g === '全部' ? all.length : all.filter(c => c.group === g).length

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const matched = useMemo(() => {
    const base = group === '全部' ? all : all.filter(c => c.group === group)
    if (!searching) return base
    return base.filter(c =>
      [c.name, c.tagline, c.effect, c.group, ...c.quotes]
        .join('\n')
        .toLowerCase()
        .includes(q),
    )
  }, [all, group, searching, q])

  const visible = searching ? matched : matched.slice(0, limit)
  const hiddenCount = matched.length - visible.length

  const toggleOpen = () => {
    setOpen(prev => {
      const next = !prev
      try {
        localStorage.setItem('ws:style-cards-open', next ? '1' : '0')
      } catch {
        /* 隐私模式下存不进就存不进 */
      }
      return next
    })
  }

  return (
    <div className={`style-cards ${open ? 'panel-open' : 'panel-folded'}`}>
      <div className="style-cards-head">
        <button type="button" className="sc-fold-btn" onClick={toggleOpen}>
          <span className="sc-fold-arrow">{open ? '▾' : '▸'}</span>
          <h4 className="sc-title">文风卡</h4>
          <span className="sc-group-count">{all.length}</span>
        </button>
        {open ? (
          <span className="sc-sub">可搜索 · 点开看效果 · 一键套用</span>
        ) : (
          <span className="sc-sub">点击展开全部文风卡</span>
        )}
        <button type="button" className="ghost-btn sm sc-forge-btn" onClick={onOpenForge}>
          ＋ 自己设计一张
        </button>
      </div>

      {open && (
        <>
          <div className="sc-toolbar">
            <input
              className="sc-search"
              type="search"
              placeholder="搜卡名 / 标签 / 效果 / 例句…（例：短句、疏离、村上）"
              value={query}
              onChange={e => {
                setQuery(e.target.value)
                setLimit(20)
              }}
            />
            {query && (
              <button type="button" className="ghost-btn sm" onClick={() => setQuery('')}>
                清空
              </button>
            )}
          </div>

          <div className="sc-group-row">
            {(['全部', ...STYLE_CARD_GROUPS] as const).map(g => (
              <button
                key={g}
                type="button"
                className={`sc-group-chip ${group === g ? 'on' : ''}`}
                onClick={() => {
                  setGroup(g as StyleCardGroup | '全部')
                  setLimit(20)
                }}
              >
                {g}
                <span className="sc-group-count">{countOf(g as StyleCardGroup | '全部')}</span>
              </button>
            ))}
          </div>

          {group === '我的文风卡' && customCards.length === 0 && !searching && (
            <p className="sc-empty-mine">
              还没有自己设计的卡。点右上角「＋ 自己设计一张」，用一句大白话就能炼出一张专属文风卡。
            </p>
          )}

          {searching && matched.length === 0 && (
            <p className="sc-empty-mine">没有匹配「{query}」的卡。换个词试试，或点「清空」。</p>
          )}

          <div className="style-card-row">
            {visible.map(c => {
              const expanded = openId === c.id
              const mine = c.group === '我的文风卡'
              // 与画布里已套用的卡之间的矛盾（本地规则，只提示不拦截）
              const conflicts = conflictsWithApplied(c, appliedCards)
              return (
                <div
                  key={c.id}
                  className={`style-card ${expanded ? 'open' : ''} ${mine ? 'mine' : ''}`}
                >
                  <button type="button" className="sc-head" onClick={() => onToggle(c.id)}>
                    <span className="sc-name">{c.name}</span>
                    <span className="sc-tagline">{c.tagline}</span>
                    <span className="sc-toggle">{expanded ? '收起' : '展开'}</span>
                  </button>
                  {expanded && (
                    <div className="sc-body">
                      {conflicts.length > 0 && (
                        <div className="sc-conflict">
                          <p className="sc-conflict-head">与画布里已套用的卡可能矛盾：</p>
                          {conflicts.map(({ card: o, pairs }) => (
                            <p key={o.id} className="sc-conflict-line">
                              「{o.name}」：{pairs.join('；')}
                            </p>
                          ))}
                          <p className="sc-conflict-note">仍可套用，建议二选一或改掉冲突项。</p>
                        </div>
                      )}
                      <p className="sc-effect">{c.effect}</p>
                      <ul className="sc-quotes">
                        {c.quotes.map((qq, i) => (
                          <li key={i}>「{qq}」</li>
                        ))}
                      </ul>
                      {editable ? (
                        <div className="sc-actions">
                          <button className="primary-btn sm" onClick={() => onApply(c, 'replace')}>
                            套用（替换画布）
                          </button>
                          <button className="ghost-btn sm" onClick={() => onApply(c, 'append')}>
                            追加到画布
                          </button>
                          {mine && (
                            <button
                              className="ghost-btn sm danger"
                              onClick={() => onRemoveCustom(c.id)}
                              title="删除这张自定义卡"
                            >
                              删除
                            </button>
                          )}
                        </div>
                      ) : (
                        <p className="sc-readonly">（当前不可编辑：只读模式或该画布已锁定）</p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {hiddenCount > 0 && (
            <button
              type="button"
              className="ghost-btn sm sc-more-btn"
              onClick={() => setLimit(prev => prev + 30)}
            >
              显示更多（还有 {hiddenCount} 张）
            </button>
          )}
        </>
      )}
    </div>
  )
}
