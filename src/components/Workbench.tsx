import { Icon } from './Icon'
import { botWrite } from '../bot/botWrite'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/AppContext'
import {
  dissectText,
  reviseText,
  continueText,
  writeChapter,
  extractNewSettings,
  type SettingSuggestion,
} from '../lib/llmClient'
import { dissectTextLocally, DIMENSIONS } from '../data/textDissect'
import { DIM_TO_CANVAS } from '../lib/dims'
import { aiFillCanvas, aiSuggestAnchors } from '../lib/canvasFill'
import { WebSearchToggle, ReferenceList, webStatusText } from './WebSearchToggle'
import { ImageDissectUpload } from './ImageDissectUpload'
import { ScriptStudio } from './ScriptStudio'
import { ChapterTextReader } from './ChapterTextReader'
import { splitChapters, planChapterImport } from '../lib/textChapters'
import { BookGenerator } from './BookGenerator'
import {
  PURPOSE_OPTIONS,
  type CanvasDimension,
  type ChapterPurpose,
  type ChapterWriting,
  type SavedBook,
} from '../types'
import { SourceHarvest } from './SourceHarvest'

type Tab = 'dissect' | 'chapters' | 'loose' | 'script'

/** 章节写作编辑器内的四个动作模式 */
type CwMode = 'generate' | 'aiEdit' | 'continue' | 'manual'

/** v10.50 清扫：状态提示里的 ❌/⚠️/✅ emoji 已删除，这里改用文案语义判断告警色，
 *  避免在「纯字符串状态提示」里残留系统 emoji，同时保留成功/警告/失败的视觉区分。 */
const isStatusError = (s: string) => s.includes('失败') || s.includes('错误')
const isStatusWarn = (s: string) =>
  !isStatusError(s) &&
  (s.includes('请') || s.includes('还没') || s.includes('没有') || s.includes('未选定') ||
    s.includes('未保存') || s.includes('至少') || s.includes('为空') || s.includes('找不到') ||
    s.includes('识别到') || s.includes('不可用'))

/** 章节框架里的单章引用 */
interface ChapterRef {
  index: number
  title: string
  summary: string
}

/** 任务完成后待用户确认的保存动作 */
interface PendingSave {
  kind: 'dissect' | 'revise' | 'continue'
  chapter?: ChapterRef | null
}

/* ===== 整书架构：起承转合（原「逐章精写」并入） ===== */
type PhaseRole = '起' | '承' | '转' | '合'
type ChapterTag = '开局' | '推进' | '高潮' | '反转' | '收束'

const TAG_TO_ROLE: Record<ChapterTag, PhaseRole> = {
  开局: '起',
  推进: '承',
  高潮: '转',
  反转: '转',
  收束: '合',
}

const ROLE_DESC: Record<PhaseRole, string> = {
  起: '交代背景、人物与世界',
  承: '推进主线与冲突累积',
  转: '关键转折 / 高潮 / 反转',
  合: '伏笔回收与结局',
}

const ROLE_LABEL: Record<ChapterTag, string> = {
  开局: '起 · 开局铺陈',
  推进: '承 · 主线推进',
  高潮: '转 · 关键高潮',
  反转: '转 · 剧情反转',
  收束: '合 · 伏笔回收',
}

type Phase = {
  actNumber: number
  startIdx: number
  endIdx: number
  tag: ChapterTag
  role: PhaseRole
  label: string
  roleDesc: string
}

/** 把连续相同 tag 的章节合并成一"幕"。每幕的角色由该 tag 决定。 */
function computeArchitecture(outline: SavedBook['outline']): Phase[] {
  if (!outline || outline.length === 0) return []
  const phases: Phase[] = []
  let start = 0
  let curTag = outline[0].tag
  for (let i = 1; i <= outline.length; i++) {
    const tag: ChapterTag | null = i < outline.length ? outline[i].tag : null
    if (tag !== curTag) {
      phases.push({
        actNumber: phases.length + 1,
        startIdx: start,
        endIdx: i - 1,
        tag: curTag,
        role: TAG_TO_ROLE[curTag],
        label: ROLE_LABEL[curTag],
        roleDesc: ROLE_DESC[TAG_TO_ROLE[curTag]],
      })
      if (tag) {
        start = i
        curTag = tag
      }
    }
  }
  return phases
}

const DEFAULT_SETTINGS: ChapterWriting['settings'] = {
  targetWords: 2000,
  style: '',
  purpose: 'main-plot',
  extraRequirements: '',
}

/** 一键精写时：按 outline tag 自动决定本章「文章目的」 */
const BATCH_TAG_PURPOSE: Record<string, ChapterPurpose> = {
  开局: 'pure-scene',
  推进: 'main-plot',
  高潮: 'reveal',
  反转: 'reveal',
  收束: 'ending',
}

export function Workbench({
  onGoCanvases,
  /** v10.27 脑洞共创完成后带过来的书 id —— 变化时自动选中那本书 */
  brainBookId,
  /** v10.41 STEP4-03：外部（右下角「写第一章」）请求切到「写章」的信号，每次自增 */
  focusChapters,
}: {
  onGoCanvases?: () => void
  brainBookId?: string | null
  focusChapters?: number
}) {
  const {
    state,
    dispatch,
    listCanvases,
    saveBook,
    updateBookOutline,
    updateChapter,
    lockedDimensions,
    autoSnapshot,
    bulkUpdateContent,
    toggleCanvasLock,
    aiAppendAnchors,
    conflicts,
    runConflictCheck,
  } = useApp()
  const [tab, setTab] = useState<Tab>('chapters')

  /** v10.46 LOOP-01①：写作时内嵌的「画布侧栏」—— 不切页也能看到当前生效的设定 */
  const [csOpen, setCsOpen] = useState(true)
  /** v10.55：侧栏每块画布可展开看全貌（原来一行省略号截断，看不全） */
  const [csExpanded, setCsExpanded] = useState<Record<string, boolean>>({})
  /** v10.55：每块画布的检索方式（true=联网 / false=本地），默认联网 */
  const [csSearch, setCsSearch] = useState<Record<string, boolean>>({})
  /** v10.55：每块画布 AI 处理中标记 */
  const [csBusy, setCsBusy] = useState<Record<string, boolean>>({})
  /** v10.55：每块画布的 AI 结果提示 */
  const [csNote, setCsNote] = useState<Record<string, string>>({})
  /** v10.46 LOOP-01②：本章「新设定」建议（AI 找出来的，用户点采纳才写进画布） */
  const [sugBusy, setSugBusy] = useState(false)
  const [sugs, setSugs] = useState<SettingSuggestion[] | null>(null)
  /** v10.46 LOOP-01③：散稿手动归章的目标 */
  const [looseTo, setLooseTo] = useState<number | ''>('')

  /** v10.41 STEP4-03：右下角「写第一章」点了之后，直接切到「写章」 */
  useEffect(() => {
    if (focusChapters && focusChapters > 0) setTab('chapters')
  }, [focusChapters])

  // 原文来源（select 全局共用；大文本框在「风格拆解 / 散稿加工」两个 tab 里出现）
  const [sourceId, setSourceId] = useState<string>('')
  const [text, setText] = useState('')

  // 拆解
  const [dissecting, setDissecting] = useState(false)
  const [dissectInfo, setDissectInfo] = useState('')
  const [dissectResult, setDissectResult] = useState<Record<string, string> | null>(null)
  const [canvasSnapshot, setCanvasSnapshot] = useState<Record<string, string> | null>(null)

  // 散稿加工（批量修改 / 整段续写，独立状态 → 切 tab 不中断）
  const [revising, setRevising] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [reviseOut, setReviseOut] = useState<{ revised: string; changes: string[]; references?: string[] } | null>(null)
  /** 联网搜索同类型范文开关（默认开）：开启时模型先检索同题材/同风格优秀文章作风格参照再改稿 */
  const [webSearch, setWebSearch] = useState(true)
  /** 散稿加工的方向意图：喂给方向导演层，让改写/续写更精准 */
  const [directionIntent, setDirectionIntent] = useState('')
  const [continueOut, setContinueOut] = useState<{ continuation: string; rationale: string } | null>(null)
  const [actionInfo, setActionInfo] = useState('')
  /** 散稿按章写入作品库的结果提示 */
  const [importInfo, setImportInfo] = useState('')

  // 章节框架
  const [chapters, setChapters] = useState<ChapterRef[]>([])
  const [activeChapter, setActiveChapter] = useState<number | null>(null)
  /** v10.27 章节增删：一次增/删几章（1-50） */
  const [chapterDelta, setChapterDelta] = useState(1)

  // 任务完成后是否弹出「是否保存」确认
  const [askSave, setAskSave] = useState(true)
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null)

  // ===== 章节写作：编辑器与四个动作模式 =====
  const [cwMode, setCwMode] = useState<CwMode>('manual')
  const [chapterText, setChapterText] = useState('')
  const [chapterBusy, setChapterBusy] = useState(false)
  const [chapterInfo, setChapterInfo] = useState('')
  const [chapterOut, setChapterOut] = useState<{ revised: string; changes: string[] } | null>(null)
  const [chapterInstr, setChapterInstr] = useState('')
  const [refName, setRefName] = useState('')
  const [refText, setRefText] = useState('')
  const [manualFlash, setManualFlash] = useState(false)
  const [aiSavedFlash, setAiSavedFlash] = useState(false)
  const refInputRef = useRef<HTMLInputElement>(null)

  // —— 生成本章（原「逐章精写」的 4 维设置 + 整书架构 + 一键精写全书）——
  const [draftSettings, setDraftSettings] = useState<ChapterWriting['settings']>(DEFAULT_SETTINGS)
  const [genWriting, setGenWriting] = useState(false)
  /** v10.72 机器人代笔：与「生成本章」是两条路，各自独立的 loading，避免状态文案互相覆盖 */
  const [botWriting, setBotWriting] = useState(false)
  /** 机器人还没出生（state.bot.persona 为空）时，代笔按钮不渲染 */
  const botPersona = state.bot?.persona ?? null
  const [genOut, setGenOut] = useState<{ content: string; rationale: string } | null>(null)
  const [genSavedFlash, setGenSavedFlash] = useState(false)
  const [batch, setBatch] = useState<{
    running: boolean
    current: number
    total: number
    currentTitle: string
    done: number
    errors: number
    skipped: number
    finished: boolean
  }>({ running: false, current: 0, total: 0, currentTitle: '', done: 0, errors: 0, skipped: 0, finished: false })
  const cancelRef = useRef(false)


  const library = state.library
  const currentBook: SavedBook | undefined = library.find(b => b.id === sourceId)
  /** v10.50：写作页不再单独设作品入口，关联书来自画布页导入（linkedBookId）或脑洞共创（brainBookId） */
  const effectiveBookId = state.linkedBookId || brainBookId || ''
  const effectiveBook: SavedBook | undefined = library.find(b => b.id === effectiveBookId)
  const running =
    dissecting || revising || continuing || chapterBusy || genWriting || batch.running
  const activeChapterRef = chapters.find(c => c.index === activeChapter) || null
  const chapterLabel = activeChapterRef
    ? `第 ${activeChapterRef.index} 章《${activeChapterRef.title}》`
    : ''
  /** 当前章在 outline 里的 0-based 位置（outline.index 为 1-based，正常情况下 pos+1 === activeChapter） */
  const activeChapterPos =
    activeChapter == null ? -1 : chapters.findIndex(c => c.index === activeChapter)
  const architecture = currentBook ? computeArchitecture(currentBook.outline) : []

  /* —— 「按章写入作品库」：算散稿里的章 → 书里第几章 ——
     散稿框是临时缓冲，不点「写入」它永远不会进 chapterWritings，章节写作就一直「待写」。 */
  const loosePieces = useMemo(() => splitChapters(text), [text])
  const looseDetected = Boolean(loosePieces[0]?.detected)
  const importPlan = useMemo(
    () => (currentBook && looseDetected ? planChapterImport(loosePieces, currentBook.outline) : []),
    [currentBook, loosePieces, looseDetected],
  )
  const writableImportCount = importPlan.filter(r => r.targetIndex != null && r.content).length

  /** 第一个「还没内容」的章节（默认写作目标） */
  const firstEmptyChapterIndex = (list: ChapterRef[], book?: SavedBook) => {
    const written = book?.chapterWritings || {}
    const first = list.find(c => !written[c.index])
    return first ? first.index : list[0]?.index ?? null
  }

  /**
   * 把一个章节的正文装进编辑区。
   * 已有正文 → 载入已有正文；还没写过 → 用大纲当草稿（保证点开一定有内容可看/可改）。
   */
  const loadChapterIntoDraft = (b: SavedBook | undefined, list: ChapterRef[], index: number) => {
    const ch = list.find(c => c.index === index)
    const w = b?.chapterWritings?.[index]
    if (w?.content) {
      setChapterText(w.content)
      setChapterInfo(
        `已载入「第 ${index} 章《${ch?.title ?? ''}》」的已有正文 · ${w.content.length} 字` +
          `${w.generatedAt ? ` · 生成于 ${w.generatedAt}` : ''}`,
      )
    } else {
      setChapterText(ch ? `【本章大纲】${ch.summary}` : '')
      setChapterInfo(
        `「第 ${index} 章《${ch?.title ?? ''}》」还没有正文，已用大纲作为草稿：` +
          `可以手动写、点「生成本章」按纲生成，或切「AI 改」按画布设定改。`,
      )
    }
    setChapterOut(null)
    setGenOut(null)
   
    setChapterInstr('')
  }

  /** 点击章节：设为写作目标 + 把关卡正文显示出来 */
  const selectChapter = (index: number) => {
    setActiveChapter(index)
    loadChapterIntoDraft(currentBook, chapters, index)
  }

  const loadFromLibrary = (id: string) => {
    setSourceId(id)
    setPendingSave(null)
    setImportInfo('')
    const b = library.find(x => x.id === id)
    if (!b) {
      setChapters([])
      setActiveChapter(null)
      setChapterText('')
      setChapterInfo('')
      return
    }    const outlineText = b.outline.map(c => `${c.index}. ${c.title}：${c.summary}`).join('\n')
    const composed = `《${b.title}》\n\n${b.synopsis}\n\n${outlineText}\n\n${b.sampleChapter.content}`
    setText(composed)
    const list: ChapterRef[] = b.outline.map(c => ({
      index: c.index,
      title: c.title,
      summary: c.summary,
    }))
    setChapters(list)
    const first = firstEmptyChapterIndex(list, b)
    setActiveChapter(first)
    if (first != null) loadChapterIntoDraft(b, list, first)
    setReviseOut(null)
    setContinueOut(null)
    setDissectResult(null)
    setDissectInfo('')
    setActionInfo('')
    const w0 = b.chapterWritings?.[first ?? -1]
    setDraftSettings(w0?.settings ?? DEFAULT_SETTINGS)
  }

  /**
   * v10.27 脑洞共创完成后带过来的书：变化时自动选中，章节框架直接就绪 ——
   * 「画布结果同步到创作台」不需要用户再去下拉框里手动挑一次。
   * v10.50：画布页「从资产库导入作品」也会设定 linkedBookId，这里一并接管加载。
   */
  useEffect(() => {
    const id = brainBookId || state.linkedBookId || ''
    if (id) loadFromLibrary(id)
    // loadFromLibrary 每次渲染都是新引用，这里只关心关联书 id 的变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brainBookId, state.linkedBookId])

  const snapshotCanvases = () => {
    const snap: Record<string, string> = {}
    listCanvases().forEach(c => {
      snap[c.dimension] = c.content
    })
    return snap
  }

  /** 把 7 个维度的分析结果写进对应画布（跳过被锁定的画布） */
  const applyToCanvases = (dims: Record<string, string>) => {
    // v10.31 这一步会一次性顶掉 7 块画布 —— 写之前先存一份版本，改坏了能退回去
    autoSnapshot('原文拆解写回画布')
    const locked = lockedDimensions()
    DIMENSIONS.forEach(d => {
      const canvasId = DIM_TO_CANVAS[d]
      const value = dims[d]
      if (canvasId && value && !locked.includes(d)) {
        dispatch({ type: 'UPDATE_CONTENT', id: canvasId, content: value })
      }
    })
  }

  /* ================= v10.55 生效设定侧栏：AI 帮我填 / 高级设置（从画布页搬来） ================= */

  type CsCanvas = { id: string; dimension: string; title: string; content: string; locked?: boolean }

  /** 侧栏「AI 帮我填/改」：空画布直接写一版，已有内容的写细一版；锁定则不动 */
  const handleCsAiFill = async (c: CsCanvas) => {
    if (c.locked) {
      setCsNote(p => ({ ...p, [c.id]: '这块画布已锁定 —— 先点「已锁定」解锁，再让 AI 填。' }))
      return
    }
    setCsBusy(p => ({ ...p, [c.id]: true }))
    setCsNote(p => ({ ...p, [c.id]: '' }))
    // 「研墨中」：侧栏 AI 填/改是独立调用 LLM 写画布（未复用 CanvasBlock），
    // c 是本函数入参、调用期间不会变，直接用它点亮流水线卡片
    dispatch({ type: 'AI_FILLING', id: c.id, on: true })
    try {
      const others: Record<string, string> = {}
      listCanvases().forEach(x => {
        if (x.id !== c.id && (x.content || '').trim()) others[x.dimension] = x.content.trim()
      })
      const outlineText = currentBook?.outline?.length
        ? currentBook.outline
            .slice(0, 20)
            .map(ch => `第${ch.index}章 ${ch.title}${ch.summary ? `：${ch.summary}` : ''}`)
            .join('\n')
        : ''
      const { refined, searched, searchCount } = await aiFillCanvas({
        dimension: c.dimension,
        current: c.content,
        bookTitle: currentBook?.title,
        bookSynopsis: currentBook?.synopsis,
        bookOutlineText: outlineText,
        otherCanvases: others,
        webSearch: csSearch[c.id] !== false,
      })
      if (!refined) {
        setCsNote(p => ({ ...p, [c.id]: 'AI 没返回内容，请重试一次。' }))
      } else {
        autoSnapshot(`AI 帮我填画布（${c.dimension}）`)
        dispatch({ type: 'UPDATE_CONTENT', id: c.id, content: refined })
        void runConflictCheck()
        setCsNote(p => ({
          ...p,
          [c.id]: `已填入「${c.dimension}」画布${searched ? `（联网检索 ${searchCount} 次）` : ''}`,
        }))
      }
    } catch (e) {
      setCsNote(p => ({ ...p, [c.id]: `生成失败：${e instanceof Error ? e.message : String(e)}` }))
    } finally {
      setCsBusy(p => ({ ...p, [c.id]: false }))
      // 「研墨中」熄灭（此入口无独立终止按钮，异常同样走进本 finally）
      dispatch({ type: 'AI_FILLING', id: c.id, on: false })
    }
  }

  /** 侧栏「AI 检索范文」：与画布页高级设置里的 AI 自动检索同一套逻辑 */
  const handleCsAiAnchor = async (c: CsCanvas) => {
    setCsBusy(p => ({ ...p, [c.id]: true }))
    setCsNote(p => ({ ...p, [c.id]: '' }))
    try {
      const topic = (c.content || '').trim() || c.title
      const { anchors, note } = await aiSuggestAnchors({
        dimension: c.dimension,
        topic,
        useSearch: csSearch[c.id] !== false,
      })
      aiAppendAnchors(c.id, anchors)
      setCsNote(p => ({ ...p, [c.id]: note }))
    } catch (e) {
      setCsNote(p => ({ ...p, [c.id]: `检索失败：${e instanceof Error ? e.message : String(e)}` }))
    } finally {
      setCsBusy(p => ({ ...p, [c.id]: false }))
    }
  }

  /* ================= 风格拆解 ================= */

  /**
   * v10.80：支持外部直接喂语料（灵感采集面板「组装并拆解」按钮用）——
   * 不必先写回原文框再点拆解，避免一次异步状态竞态。
   * overrideText 不传时保持原行为：拆解原文框里的 text。
   */
  const handleDissect = async (overrideText?: string) => {
    const source = (overrideText ?? text).trim()
    if (!source) return
    setDissecting(true)
    setDissectInfo('')
    setDissectResult(null)
    const snap = snapshotCanvases()
    let dims: Record<string, string> | null = null
    try {
      const { data, searched, searchCount } = await dissectText(source, lockedDimensions())
      dims = data
      setDissectInfo(
        `已由 优质模型生产 拆解并填充 7 个画布${searched ? `（联网检索 ${searchCount} 次）` : ''}。下方是每块画布分配到的内容。`,
      )
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('LLM 拆解失败，用本地启发式：', e)
      dims = dissectTextLocally(source)
      setDissectInfo(
        `优质模型生产 不可用（${reason.slice(0, 80)}），已用「本地启发式」填充 7 个画布。`,
      )
    }
    if (dims) {
      applyToCanvases(dims)
      setDissectResult(dims)
      setCanvasSnapshot(snap)
      if (askSave) setPendingSave({ kind: 'dissect' })
    }
    setDissecting(false)
  }

  /** 图片识别结果落画布：与文字拆解同一套写入/撤销流程 */
  const applyImageDims = (dims: Record<string, string>) => {
    const snap = snapshotCanvases()
    applyToCanvases(dims)
    setDissectResult(dims)
    setCanvasSnapshot(snap)
    setDissectInfo(
      '已识别图片内容并填充 7 个画布（下方是每块画布分配到的内容）。锁定过的画布不会被覆盖。',
    )
    if (askSave) setPendingSave({ kind: 'dissect' })
  }

  /** 撤销本次拆解写入，画布恢复原内容 */
  const undoDissect = () => {
    if (!canvasSnapshot) return
    DIMENSIONS.forEach(d => {
      const canvasId = DIM_TO_CANVAS[d]
      if (canvasId && canvasSnapshot[d] !== undefined) {
        dispatch({ type: 'UPDATE_CONTENT', id: canvasId, content: canvasSnapshot[d] })
      }
    })
    setDissectResult(null)
    setDissectInfo('↩️ 已撤销本次拆解写入，7 块画布恢复原内容。')
    setPendingSave(null)
  }

  /* ================= 散稿加工（批量修改 / 整段续写） ================= */

  const canvasesMap = () => {
    const m: Record<string, string> = {}
    listCanvases().forEach(c => {
      m[c.dimension] = c.content
    })
    return m
  }

  const handleRevise = async () => {
    if (!text.trim()) return
    setRevising(true)
    setActionInfo('')
    try {
      // 从【文笔】画布抽一句作为联网检索方向提示，帮助模型更精准地搜同类型范文
      const styleCanvas = listCanvases().find(c => c.dimension === '文笔')
      const genreHint = webSearch && styleCanvas?.content ? styleCanvas.content.slice(0, 120) : ''
      const { data, searched, searchCount } = await reviseText(
        text,
        canvasesMap(),
        undefined,
        { locked: lockedDimensions(), webSearch, genreHint, directionIntent },
      )
      setReviseOut(data)
      setActionInfo(
        webSearch
          ? searched
            ? `已联网检索同类型范文 ${searchCount} 次${data.references?.length ? `，参考：${data.references.join('、')}` : ''}`
            : '已开启联网，但本次未触发检索（模型凭知识改写）'
          : '（未开启联网，仅依据画布改写）',
      )
      if (askSave) setPendingSave({ kind: 'revise' })
    } catch (e) {
      setActionInfo(`修改失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setRevising(false)
  }

  const handleContinue = async () => {
    if (!text.trim()) return
    setContinuing(true)
    setActionInfo('')
    try {
      const { data, searched, searchCount } = await continueText(
        text,
        canvasesMap(),
        undefined,
        lockedDimensions(),
        webSearch,
        directionIntent,
      )
      setContinueOut(data)
      setActionInfo(webStatusText({ webSearch, searched, searchCount }))
      if (askSave) setPendingSave({ kind: 'continue' })
    } catch (e) {
      setActionInfo(`续写失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setContinuing(false)
  }

  /** 保存①：把散稿续写结果追加回原文 */
  const saveContinuationToText = () => {
    if (!continueOut) return
    setText(t => `${t}\n\n${continueOut.continuation}`)
    setActionInfo('已追加到原文')
    setPendingSave(null)
  }

  /** 保存②：用修改稿替换原文 */
  const saveRevisionToText = () => {
    if (!reviseOut) return
    setText(reviseOut.revised)
    setActionInfo('已用修改稿替换原文')
    setPendingSave(null)
  }

  /** 保存③：存入作品库（散稿修改 / 续写结果都能存） */
  const saveToLibrary = (content: string, title: string, beat: string) => {
    saveBook({
      id: `book-${Date.now()}`,
      title,
      synopsis: `由工作台「${title}」功能生成。`,
      outline: [],
      sampleChapter: { title, content, beat },
      stats: {
        totalWords: content.length,
        chapters: 1,
        volumes: 1,
        styleLabel: title,
        anchorSources: [],
      },
      searched: false,
      searchCount: 0,
      usedFallback: false,
      engine: 'deepseek',
      createdAt: new Date().toLocaleString('zh-CN'),
    })
    setActionInfo('已存入作品库')
    setPendingSave(null)
  }

  /**
   * 把散稿里识别出来的章节，一次性写进当前作品的章节档案。
   * 写完 chapterWritings 有值，「章节写作」的徽标立刻从「待写」变「已写」。
   */
  const handleImportChapters = () => {
    if (!currentBook) return
    const rows = importPlan.filter(r => r.targetIndex != null && r.content)
    if (!rows.length) {
      setImportInfo('没有可写入的章节。')
      return
    }
    const willOverwrite = rows.filter(r => currentBook.chapterWritings?.[r.targetIndex as number])
    if (
      willOverwrite.length &&
      !window.confirm(
        `有 ${willOverwrite.length} 章已经有正文，写入会覆盖它们：` +
          willOverwrite.map(r => `第 ${r.targetIndex} 章`).join('、') +
          '。继续吗？',
      )
    ) {
      return
    }
    rows.forEach(r => {
      updateChapter(currentBook.id, r.targetIndex as number, buildWriting(r.content))
    })
    setImportInfo(
      `已写入 ${rows.length} 章到《${currentBook.title}》` +
        `${willOverwrite.length ? `（覆盖了 ${willOverwrite.length} 章）` : ''}。` +
        '去「章节写作」看看，徽标已经变成「已写」。',
    )
  }

  /* ================= 章节写作：手动编辑 ================= */

  const jumpToNextEmpty = () => {
    const written = currentBook?.chapterWritings || {}
    const next = chapters.find(c => !written[c.index])
    if (next) selectChapter(next.index)
  }

  const buildWriting = (content: string, settings?: ChapterWriting['settings']): ChapterWriting => ({
    content,
    settings: settings ?? {
      targetWords: content.length,
      style: '',
      purpose: 'main-plot',
      extraRequirements: '',
    },
    generatedAt: new Date().toLocaleString('zh-CN'),
    wordCount: content.length,
  })

  /** 把编辑区的内容写进「第 N 章」，保存后章节框架立刻变「已写」 */
  const persistChapterText = (
    content: string,
    settings?: ChapterWriting['settings'],
    /** v10.46 LOOP-01③：不传就写当前选中章；传了就写指定章（散稿手动归章用） */
    targetIndex?: number,
  ) => {
    const idx = targetIndex ?? activeChapter
    if (!currentBook || idx == null) return false
    const trimmed = content.trim()
    if (!trimmed) return false
    updateChapter(currentBook.id, idx, buildWriting(trimmed, settings))
    return true
  }

  /* ================= v10.46 LOOP-01：画布 ↔ 写作 的闭环 ================= */

  /** ② 找出这一章里新出现的人物 / 地点 / 规则，给「加进画布」的建议 */
  const checkNewSettings = async () => {
    const src = (genOut?.content || chapterText || '').trim()
    if (!src) {
      setChapterInfo('这一章还没有正文 —— 先生成或手写一段，再来找新设定。')
      return
    }
    setSugBusy(true)
    setSugs(null)
    setChapterInfo('')
    const cvs: Record<string, string> = {}
    listCanvases().forEach(c => {
      cvs[c.dimension] = c.content
    })
    try {
      const { data } = await extractNewSettings({ text: src, canvases: cvs })
      const list = data.suggestions ?? []
      setSugs(list)
      if (!list.length) setChapterInfo('这一章没发现新设定 —— 画布上的设定已经是全的了。')
    } catch (e) {
      setChapterInfo(`检查新设定失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSugBusy(false)
    }
  }

  /** ② 采纳一条建议：追加进对应画布（维度对不上就进「设定」） */
  const adoptSuggestion = (sug: SettingSuggestion) => {
    const canvases = listCanvases()
    const target =
      canvases.find(c => c.dimension === sug.kind) ?? canvases.find(c => c.dimension === '设定')
    if (!target) {
      setChapterInfo('找不到要写进的画布')
      return
    }
    const line = `${sug.name}${sug.note ? `：${sug.note}` : ''}`
    const prev = (target.content || '').trim()
    bulkUpdateContent(
      { [target.id]: prev ? `${prev}\n${line}` : line },
      `本章新设定 → ${target.dimension}`,
    )
    setSugs(list => (list ?? []).filter(x => x.id !== sug.id))
    setChapterInfo(`已把「${sug.name}」加进【${target.dimension}】画布。`)
  }

  /** ③ 把散稿框里的整段文本手动归入指定章节 */
  const fileLooseIntoChapter = () => {
    if (!currentBook) {
      setActionInfo('先在上方「作品」里选一本书。')
      return
    }
    if (!looseTo) {
      setActionInfo('先选要写进哪一章。')
      return
    }
    if (!text.trim()) {
      setActionInfo('散稿框是空的。')
      return
    }
    const ok = persistChapterText(text, undefined, Number(looseTo))
    setActionInfo(
      ok
        ? `已把散稿写入「第 ${looseTo} 章」，切到「写章」就能看到（状态已是「已写」）。`
        : '写入失败，确认这本书有这个章节号。',
    )
  }

  /** 手动保存本章原文 */
  const handleSaveChapterManual = () => {
    if (!currentBook) {
      setChapterInfo('请先在上方「作品」里选一本书，本章正文才有地方保存。')
      return
    }
    if (activeChapter == null) {
      setChapterInfo('请先在章节框架里点一章。')
      return
    }
    if (!persistChapterText(chapterText)) {
      setChapterInfo('内容为空，未保存。')
      return
    }
    setManualFlash(true)
    setTimeout(() => setManualFlash(false), 1800)
    setChapterInfo(`已保存到「第 ${activeChapter} 章《${activeChapterRef?.title ?? ''}》」，状态已更新为「已写」。`)
  }

  /* ================= 章节写作：AI 改（可带参考文件） ================= */

  /** 读取参考文件（txt / md 等纯文本），作为 AI 修改时的参考 */
  const onPickRefFile = async (f: File | undefined | null) => {
    if (!f) return
    setRefName(f.name)
    try {
      const t = await f.text()
      setRefText(t.slice(0, 12000))
      setChapterInfo(`已附上参考文件「${f.name}」（${t.length} 字，取前 12000 字供 AI 参考）`)
    } catch (e) {
      setChapterInfo(`读取参考文件失败：${e instanceof Error ? e.message : String(e)}`)
      setRefName('')
      setRefText('')
    }
  }

  const clearRefFile = () => {
    setRefName('')
    setRefText('')
    if (refInputRef.current) refInputRef.current.value = ''
  }

  /** AI 修改本章原文（可带关键词要求 + 参考文件） */
  const handleChapterAI = async () => {
    if (activeChapter == null) {
      setChapterInfo('请先在章节框架里点一章。')
      return
    }
    const base = chapterText.trim()
    if (!base) {
      setChapterInfo('本章还没有内容。先手写 / 粘贴，或切「生成本章」按纲生成。')
      return
    }
    setChapterBusy(true)
    setChapterInfo('')
    setChapterOut(null)
    try {
      const { data, searched, searchCount } = await reviseText(
        base,
        canvasesMap(),
        activeChapterRef || undefined,
        { instruction: chapterInstr, referenceText: refText, locked: lockedDimensions() },
      )
      setChapterOut(data)
      setChapterInfo(
        `AI 已给出修改稿${searched ? `（联网检索 ${searchCount} 次）` : ''}` +
          `${refName ? ` · 已参考「${refName}」` : ''} · ${chapterLabel}。请在下方选择是否保存。`,
      )
    } catch (e) {
      setChapterInfo(`AI 修改失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setChapterBusy(false)
  }

  /** 保存①：用 AI 修改稿替换本章正文 → 章节变「已写」 */
  const saveChapterAIToChapter = () => {
    if (!chapterOut) return
    if (!persistChapterText(chapterOut.revised, {
      targetWords: chapterOut.revised.length,
      style: '',
      purpose: 'main-plot',
      extraRequirements: chapterInstr,
    })) {
      setChapterInfo('修改稿为空或未选定章节，保存失败。')
      return
    }
    setChapterText(chapterOut.revised)
    setChapterOut(null)
    setAiSavedFlash(true)
    setTimeout(() => setAiSavedFlash(false), 1800)
    setChapterInfo(
      `已用 AI 修改稿替换「第 ${activeChapter} 章《${activeChapterRef?.title ?? ''}》」正文，章节状态已变为「已写」。`,
    )
  }

  /** 保存②：把 AI 修改稿存入作品库（不覆盖本章） */
  const saveChapterAIToLibrary = () => {
    if (!chapterOut) return
    saveToLibrary(chapterOut.revised, `原文修改稿${chapterLabel ? ` · ${chapterLabel}` : ''}`, chapterOut.changes.join('；'))
  }

  /* ================= 章节写作：生成本章（原逐章精写） ================= */

  /** 拼装「前 N-1 章」上下文：已精写用正文，否则用大纲占位 */
  const buildPreviousChapters = (pos: number) => {
    if (!currentBook) return []
    const previous: Array<{ title: string; content: string }> = []
    for (let i = 0; i < pos; i++) {
      const w = currentBook.chapterWritings?.[i + 1] // chapterWritings 的 key 是 1-based
      if (w) previous.push({ title: chapters[i].title, content: w.content })
      else
        previous.push({
          title: chapters[i].title,
          content: `（本章尚未精写）${chapters[i].summary}`,
        })
    }
    return previous
  }

  const handleWriteGen = async () => {
    if (!currentBook || activeChapter == null || activeChapterPos < 0) {
      setChapterInfo('请先在上方「作品」里选一本书，并点选一章。')
      return
    }
    const ref = activeChapterRef
    if (!ref) return
    setGenWriting(true)
    setChapterInfo('')
    setGenOut(null)
    try {
      const { data, searched, searchCount } = await writeChapter({
        bookTitle: currentBook.title,
        chapterIndex: activeChapter,
        chapterTitle: ref.title,
        chapterSummary: ref.summary,
        settings: draftSettings,
        previousChapters: buildPreviousChapters(activeChapterPos),
        canvases: canvasesMap(),
        locked: lockedDimensions(),
      })
      setGenOut(data)
      setChapterInfo(
        `已生成本章${searched ? `（联网检索 ${searchCount} 次）` : ''} · ${chapterLabel}。请在下方选择是否保存。`,
      )
    } catch (e) {
      setChapterInfo(`生成本章失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setGenWriting(false)
  }

  /**
   * v10.72 机器人代笔：让它以**作者本人**身份写这一章。
   *
   * 与 handleWriteGen 的区别不是"用哪个模型"，而是"谁在写"：
   * 生成本章是把画布当规格、产出符合工程要求的正文；
   * 代笔的主语是它自己 —— 提示词第一段是它的人格卡，第二段是它自己长出来的三观，
   * 所以写出来会带它自己的性情与偏见（可能不如"标准精写"工整，但那是它）。
   * 结果同样写进 genOut，沿用下面「保存到本章」那条既有流程。
   */
  const handleBotWriteGen = async () => {
    if (!currentBook || activeChapter == null || activeChapterPos < 0) {
      setChapterInfo('请先在上方「作品」里选一本书，并点选一章。')
      return
    }
    const ref = activeChapterRef
    if (!ref || !botPersona) return
    setBotWriting(true)
    setChapterInfo('')
    setGenOut(null)
    try {
      // 画布 + 前文：它的素材。每块截断到 800 字，避免人格提示词被材料挤掉
      const cm = canvasesMap()
      const canvasBlocks = Object.entries(cm)
        .filter(([, v]) => v && String(v).trim())
        .map(([dim, v]) => `【${dim}】${v.length > 800 ? `${v.slice(0, 800)}…` : v}`)

      const prev = buildPreviousChapters(activeChapterPos)
      const context = [
        canvasBlocks.length ? `— 画布设定 —\n${canvasBlocks.join('\n\n')}` : '',
        prev.length
          ? `— 前文 —\n${prev.map((p, i) => `第 ${i + 1} 章《${p.title}》\n${p.content}`).join('\n\n')}`
          : '（本章是第一章，没有前文）',
      ]
        .filter(Boolean)
        .join('\n\n')

      const { content, why } = await botWrite({
        persona: botPersona,
        value: state.bot?.value,
        memories: state.bot?.memories,
        brief: `请写第 ${activeChapter} 章《${ref.title}》：${ref.summary}`,
        context,
        targetWords: draftSettings.targetWords || undefined,
      })

      if (!content.trim()) {
        setChapterInfo('它这次没写出东西来，再试一次？')
        return
      }
      setGenOut({ content, rationale: `由${botPersona.name}按它自己的人格代笔` })
      const firstWhy = why.split('\n').find(l => l.trim())
      setChapterInfo(
        firstWhy
          ? `${botPersona.name}写完了，它写的时候想起：${firstWhy}。请在下方选择是否保存。`
          : `${botPersona.name}写完了（这次没想起什么旧事，全按当下的想法写的）。请在下方选择是否保存。`,
      )
    } catch (e) {
      setChapterInfo(`代笔失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setBotWriting(false)
  }

  /** 保存生成本章结果 → 章节变「已写」 */
  const saveGenToChapter = () => {
    if (!genOut) return
    if (!persistChapterText(genOut.content, draftSettings)) {
      setChapterInfo('未选定章节或内容为空，保存失败。')
      return
    }
    setChapterText(genOut.content)
    setGenOut(null)
    setGenSavedFlash(true)
    setTimeout(() => setGenSavedFlash(false), 1800)
    setChapterInfo(
      `已保存到「第 ${activeChapter} 章《${activeChapterRef?.title ?? ''}》」，状态已更新为「已写」。`,
    )
  }

  /** 一键精写全书：依次调用 writeChapter，purpose 按 outline tag 自动选（原逐章精写） */
  const handleBatchWrite = async (force = false) => {
    if (!currentBook) return
    const book = currentBook
    const total = chapters.length
    const already = Object.keys(book.chapterWritings ?? {}).length
    const todo = force ? total : total - already

    if (todo === 0) {
      if (!window.confirm(`全部 ${total} 章都已精写。要覆盖重写吗？点击"确定"继续。`)) return
      if (!window.confirm('再次确认：将丢弃现有所有章节精写，从头重写。')) return
    } else {
      const minutes = Math.ceil((todo * draftSettings.targetWords) / 1500)
      if (!window.confirm(
        `将依次精写 ${todo} 章${already > 0 && !force ? `（跳过 ${already} 章已精写）` : ''}。\n` +
          `按当前设置（${draftSettings.targetWords} 字/章），预计需要 ${minutes}–${minutes * 2} 分钟。\n` +
          `可中途取消，已完成部分会保留。\n\n确定开始？`,
      )) return
    }

    cancelRef.current = false
    setBatch({
      running: true,
      current: 0,
      total,
      currentTitle: '',
      done: 0,
      errors: 0,
      skipped: 0,
      finished: false,
    })

    const canvasMap = canvasesMap()

    for (let i = 0; i < total; i++) {
      if (cancelRef.current) break
      const ch = chapters[i]
      const chKey = ch.index // chapterWritings 的 key（1-based）

      if (!force && book.chapterWritings?.[chKey]) {
        setBatch(b => ({ ...b, skipped: b.skipped + 1, current: chKey, currentTitle: ch.title + '（已跳过）' }))
        await new Promise(r => setTimeout(r, 80))
        continue
      }

      setBatch(b => ({ ...b, current: chKey, currentTitle: ch.title }))

      const previousChapters: Array<{ title: string; content: string }> = []
      for (let j = 0; j < i; j++) {
        const w = book.chapterWritings?.[chapters[j].index]
        if (w) previousChapters.push({ title: chapters[j].title, content: w.content })
        else
          previousChapters.push({
            title: chapters[j].title,
            content: `（本章尚未精写）${chapters[j].summary}`,
          })
      }

      const chapterSettings: ChapterWriting['settings'] = {
        ...draftSettings,
        purpose: BATCH_TAG_PURPOSE[(currentBook.outline[i]?.tag ?? '') as ChapterTag] ?? 'main-plot',
      }

      try {
        const { data } = await writeChapter({
          bookTitle: book.title,
          chapterIndex: chKey,
          chapterTitle: ch.title,
          chapterSummary: ch.summary,
          settings: chapterSettings,
          previousChapters,
          canvases: canvasMap,
          locked: lockedDimensions(),
        })
        updateChapter(book.id, chKey, buildWriting(data.content, chapterSettings))
        setBatch(b => ({ ...b, done: b.done + 1 }))
      } catch (e) {
        setBatch(b => ({ ...b, errors: b.errors + 1 }))
        console.error(`第 ${chKey} 章精写失败:`, e)
      }
    }

    setBatch(b => ({ ...b, running: false, finished: true }))
    // 批量结束后，如果当前编辑区还是空章草稿，就刷新成已生成的正文
    if (activeChapter != null) {
      const w = library.find(x => x.id === sourceId)?.chapterWritings?.[activeChapter]
      if (w) loadChapterIntoDraft(library.find(x => x.id === sourceId), chapters, activeChapter)
    }
  }

  const canvasTitleOf = (dim: string) =>
    listCanvases().find(c => c.dimension === dim)?.title || dim

  /** 把「本次生成实际依据的画布设定」显式摆出来 */
  const renderCanvasContext = () => {
    const list = listCanvases()
    const filled = list.filter(c => (c.content || '').trim()).length
    return (
      <details className="wb-ctx">
        <summary>
          本次将依据的画布设定 · 已填 {filled}/{list.length} 块
          <span className="wb-ctx-hint">
            （「风格拆解」的结果写在这里，会直接影响下面的生成）
          </span>
        </summary>
        <div className="wb-ctx-body">
          {list.map(c => (
            <div key={c.id} className="wb-ctx-item">
              <div className="wb-ctx-head">
                <span className="wb-ctx-name">{c.title}</span>
                <span className="wb-ctx-dim">{c.dimension}</span>
              </div>
              <p className="wb-ctx-text">{(c.content || '').trim() || '（空）'}</p>
            </div>
          ))}
        </div>
      </details>
    )
  }

  /** 原文来源块（风格拆解 / 散稿加工 两个 tab 共用同一份 text，但各自有独立的输入框 id） */
  const renderSourceBlock = (title: string, desc: string, idPrefix: string) => (
    <section className="wb-block">
      <h3 className="wb-h3">{title}</h3>
      <p className="wb-desc">{desc}</p>
      <ChapterTextReader
        text={text}
        onChange={setText}
        rows={12}
        idPrefix={idPrefix}
        placeholder="粘贴你的小说原文、样章或散稿…（在上方「作品」里选书也会自动载入；长文会自动按章拆开）"
      />
      <p className="wb-count">当前 {text.length} 字</p>
    </section>
  )

  /**
   * v10.27/10.28 章节增删 —— 以「当前选中的那一章」为基准。
   *
   *  · **添加** = 在**选中章之后**插入 N 章；一章都没选中时加在**末尾**。
   *  · **删减** = 从**选中章开始往后**删 N 章；没选中时从**末尾**删。
   *
   * 中间插/删会让后面的章节整体重新编号（第 k 章之后插入 N 章 → 后面 index 全 +N）。
   * 正文是按章节号存的（chapterWritings[index]），所以**正文必须跟着一起搬**；
   * 只改 outline 不搬正文，就会出现「第 6 章看着是第 6 章、内容却是原来第 5 章」的错位。
   * 删掉的章节，其正文一并丢弃（若其中已有正文，先 confirm）。
   */
  const applyChapterDelta = (direction: 1 | -1) => {
    if (!currentBook) {
      setChapterInfo('请先在上方「作品」里选一本书。')
      return
    }
    const n = Math.floor(Number(chapterDelta))
    if (!isFinite(n) || n < 1 || n > 50) {
      setChapterInfo('请填 1-50 之间的章节数。')
      return
    }
    const outline = currentBook.outline
    const writings = { ...(currentBook.chapterWritings ?? {}) }
    const toRefs = (o: SavedBook['outline']): ChapterRef[] =>
      o.map(c => ({ index: c.index, title: c.title, summary: c.summary }))

    if (direction === 1) {
      // —— 在选中章之后插入 N 章（没选中 → 加在末尾）——
      let insertAt = outline.length
      if (activeChapter != null) {
        const p = outline.findIndex(c => c.index === activeChapter)
        if (p >= 0) insertAt = p + 1
      }
      const added: SavedBook['outline'] = []
      for (let i = 0; i < n; i++) {
        const idx = insertAt + i + 1
        added.push({
          index: idx,
          title: `待排章节 ${idx}`,
          summary: '（新增章节：把这一章要发生的事补进摘要，或直接开始写正文）',
          tag: '推进',
          words: 10000,
        })
      }
      const head = outline.slice(0, insertAt)
      const tail = outline.slice(insertAt).map(c => ({ ...c, index: c.index + n }))
      const nextOutline = [...head, ...added, ...tail]

      // 正文重排：数组位置在 insertAt 之后的章（index > insertAt）整体 +n
      const nextWritings: SavedBook['chapterWritings'] = {}
      for (const [k, v] of Object.entries(writings)) {
        const i = Number(k)
        nextWritings[i > insertAt ? i + n : i] = v
      }

      updateBookOutline(currentBook.id, nextOutline, nextWritings)
      const nextList = toRefs(nextOutline)
      setChapters(nextList)
      // 选中新插入的第一章，方便立刻补摘要 / 写正文
      const firstNew = insertAt + 1
      setActiveChapter(firstNew)
      loadChapterIntoDraft(currentBook, nextList, firstNew)
      setChapterOut(null)
      setGenOut(null)
     
      setChapterInfo(
        activeChapter == null
          ? `已在书末尾续排 ${n} 章（新第 ${firstNew}-${insertAt + n} 章），已有章节不受影响。`
          : `已在第 ${activeChapter} 章之后插入 ${n} 章（新第 ${firstNew}-${insertAt + n} 章）。` +
              `后面 ${tail.length} 章已自动顺延编号，它们的正文也跟着搬过去了，不会错位。`,
      )
      return
    }

    // —— 从选中章开始往后删 N 章（没选中 → 从末尾删）——
    if (outline.length <= 1) {
      setChapterInfo('至少要保留 1 章。')
      return
    }
    const maxRemove = outline.length - 1
    let from = activeChapter == null ? outline.length - n + 1 : activeChapter
    if (from < 1) from = 1
    const count = Math.min(n, outline.length - from + 1, maxRemove)
    if (count < 1) {
      setChapterInfo('至少要保留 1 章。')
      return
    }
    const to = from + count - 1
    const removedIdx = outline.filter(c => c.index >= from && c.index <= to).map(c => c.index)
    const writtenHit = removedIdx.filter(i => writings[i])
    if (
      writtenHit.length &&
      !confirm(
        `要删的第 ${writtenHit.join('、')} 章已经写了正文，删掉后这些正文也会一起删除。确定要删吗？`,
      )
    ) {
      return
    }
    const nextOutline = outline
      .filter(c => c.index < from || c.index > to)
      .map(c => (c.index > to ? { ...c, index: c.index - count } : c))

    // 正文重排：被删区间丢弃，区间之后的整体 -count
    const nextWritings: SavedBook['chapterWritings'] = {}
    for (const [k, v] of Object.entries(writings)) {
      const i = Number(k)
      if (i >= from && i <= to) continue
      nextWritings[i > to ? i - count : i] = v
    }

    updateBookOutline(currentBook.id, nextOutline, nextWritings)
    const nextList = toRefs(nextOutline)
    setChapters(nextList)
    // 选中「落到原位置的那一章」（删到尾巴就选最后一章）
    const nextActive = Math.min(from, nextOutline.length)
    setActiveChapter(nextActive)
    loadChapterIntoDraft(currentBook, nextList, nextActive)
    setChapterOut(null)
    setGenOut(null)
   
    setChapterInfo(
      activeChapter == null
        ? `已从书末尾删掉 ${count} 章（第 ${removedIdx[0]}-${removedIdx[removedIdx.length - 1]} 章），前面的章节不受影响。`
        : `已从第 ${from} 章起删掉 ${count} 章（第 ${removedIdx[0]}-${removedIdx[removedIdx.length - 1]} 章）。` +
            `后面的章节已自动前移编号，正文也跟着搬过去了，不会错位。`,
    )
  }

  /** 章节框架 */
  const renderChapterFramework = () => {
    if (!chapters.length) {
      return (
        <div className="wb-chapters">
          <div className="wb-chapters-head">
            <span>章节框架</span>
          </div>
          <p className="wb-hint">
            当前未绑定章节框架。在上方「作品」里选一本带章纲的作品后，这里会列出全部章节与写作状态。
          </p>
        </div>
      )
    }
    const written = currentBook?.chapterWritings || {}
    const todo = chapters.filter(c => !written[c.index]).length
    return (
      <div className="wb-chapters">
        <div className="wb-chapters-head">
          <span>
            章节框架 · 共 {chapters.length} 章（待写 <strong>{todo}</strong> 章）
          </span>
          <div className="wb-chapter-tools">
            <button className="ghost-btn sm" onClick={jumpToNextEmpty} disabled={todo === 0}>
              跳到下一空章
            </button>
            <span
              className="wb-chapter-delta"
              title="添加=在选中章之后插入；删减=从选中章开始往后删；没选中任何章时按末尾处理"
            >
              <span className="wb-chapter-base">
                {activeChapterRef ? `基准：第 ${activeChapterRef.index} 章` : '基准：末尾'}
              </span>
              <button
                className="ghost-btn sm"
                onClick={() => applyChapterDelta(1)}
                disabled={running}
                title={
                  activeChapterRef
                    ? `在第 ${activeChapterRef.index} 章之后插入 ${chapterDelta} 章，后面章节自动顺延编号`
                    : `在书末尾续排 ${chapterDelta} 章，已有章节不受影响`
                }
              >
                ＋ 添加
              </button>
              <input
                className="wb-chapter-delta-input"
                type="number"
                min={1}
                max={50}
                value={chapterDelta}
                onChange={e => setChapterDelta(Number(e.target.value))}
              />
              <button
                className="ghost-btn sm"
                onClick={() => applyChapterDelta(-1)}
                disabled={running}
                title={
                  activeChapterRef
                    ? `从第 ${activeChapterRef.index} 章开始往后删 ${chapterDelta} 章，后面章节自动前移编号（含已写正文会先确认）`
                    : `从书末尾截掉 ${chapterDelta} 章（含已写正文会先确认）`
                }
              >
                － 删减
              </button>
            </span>
          </div>
        </div>
        <ul className="wb-chapter-list">
          {chapters.map(c => {
            const has = Boolean(written[c.index])
            return (
              <li
                key={c.index}
                className={`wb-chapter ${activeChapter === c.index ? 'active' : ''} ${
                  has ? 'done' : 'todo'
                }`}
                onClick={() => selectChapter(c.index)}
                title={c.summary}
              >
                <span className="wb-chapter-no">{c.index}</span>
                <span className="wb-chapter-title">{c.title}</span>
                <span className={`wb-chapter-badge ${has ? 'done' : 'todo'}`}>
                  {has ? '已写' : '待写'}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="wb-hint">
          先在轨道上点一章作为基准：<b>添加</b>＝在它后面插入 N 章，<b>删减</b>＝从它开始往后删 N 章；
          一章都没点时按「末尾」处理。中间插/删会自动重排后面章节的编号，
          <b>已写的正文会跟着章节一起搬</b>，不会串位；要删的章里有正文会先确认。
        </p>
        <p className="wb-hint">
          {activeChapterRef
            ? `当前写作目标：${chapterLabel}${
                written[activeChapterRef.index] ? '（已有内容）' : '（还没内容，默认优先写）'
              }　点击任意章节即可在下方看到并修改它的正文。`
            : '点上面任一章节把它设为写作目标。'}
        </p>
        {/* 生成书时给的样章是独立档案（sampleChapter），不算第 1 章正文 —— 不说清楚，
            用户会以为「书里明明有内容，怎么就全待写了」 */}
        {todo === chapters.length && currentBook?.sampleChapter?.content && (
          <p className="wb-hint">
            ℹ️ 这本书有生成时配的样章《{currentBook.sampleChapter.title}》（
            {currentBook.sampleChapter.content.length} 字），
            但它存在「样章」档案里，<b>不算</b>任何一章的正文 —— 所以下面 {chapters.length} 章都是「待写」。
            想让某章变「已写」：点那一章后「生成本章」/ 手动写并保存，
            或去「散稿加工」把已经写好的章节按章写入。
          </p>
        )}
      </div>
    )
  }

  /** 章节写作：编辑器（一套章节列表 + 一个编辑器，四种动作模式） */
  const renderChapterEditor = () => {
    if (activeChapter == null) {
      return (
        <div className="wb-chedit">
          <p className="wb-hint">
            先在上面的章节框架里点一章，这里会显示那一章的正文，可手动写 / 生成 / 改 / 续写。
          </p>
        </div>
      )
    }
    const ref = activeChapterRef
    const written = currentBook?.chapterWritings?.[activeChapter]
    const hasText = chapterText.trim().length > 0
    return (
      <div className="wb-chedit">
        {/* v10.46 LOOP-01①：画布侧栏 —— 写作时不用切页就能看到「AI 是按什么设定写的」 */}
        <div className="canvas-side">
          <button className="cs-toggle" onClick={() => setCsOpen(o => !o)}>
            当前生效设定（{listCanvases().length} 块）
            <span className="cs-arrow">{csOpen ? '▴' : '▾'}</span>
          </button>
          {csOpen && (
            <div className="cs-body">
              {listCanvases().map(c => {
                const t = (c.content || '').trim()
                const open = !!csExpanded[c.id]
                const busy = !!csBusy[c.id]
                const net = csSearch[c.id] !== false
                // v10.57：这块画布卷入了哪些冲突
                const cf = conflicts.filter(x => x.a === c.id || x.b === c.id)
                const cfReason = cf
                  .map(x => {
                    const otherId = x.a === c.id ? x.b : x.a
                    const otherDim = state.canvases[otherId]?.dimension || otherId
                    return `与「${otherDim}」：${x.reason}`
                  })
                  .join('；')
                return (
                  <div key={c.id} className={`cs-item ${open ? 'open' : ''} ${cf.length ? 'conflict' : ''}`}>
                    <div
                      className="cs-item-head"
                      onClick={() => setCsExpanded(p => ({ ...p, [c.id]: !p[c.id] }))}
                      title={open ? '收起' : '展开看全文与高级设置'}
                    >
                      <span className="cs-dim">{c.dimension}</span>
                      <span className={`cs-text ${t ? '' : 'empty'}`}>
                        {t ? (t.length > 60 ? `${t.slice(0, 60)}…` : t) : '（还没填）'}
                      </span>
                      {/* v10.56：7 块画布每块都有 AI 按钮（空=帮我填 / 有内容=帮我改） */}
                      <button
                        className="cs-ai-inline"
                        onClick={e => {
                          e.stopPropagation()
                          handleCsAiFill(c)
                        }}
                        disabled={busy}
                        title={
                          t
                            ? '让 AI 结合其他画布，把这版内容写得更具体'
                            : '按书名 / 简介 / 其他画布，让 AI 写一版这个维度的内容'
                        }
                      >
                        <Icon name="zap" size={12} /> {busy ? '生成中…' : t ? 'AI 帮我改' : 'AI 帮我填'}
                      </button>
                      {/* v10.56：把「高级设置」做成明牌 —— 点它就展开全文 + 高级设置 */}
                      <span className={`cs-adv-chip ${open ? 'on' : ''}`}>
                        <Icon name="gear" size={12} /> 高级设置 {open ? '▴' : '▾'}
                      </span>
                      {cf.length > 0 && (
                        <span className="cs-conflict-chip" title={cfReason}>
                          冲突
                        </span>
                      )}
                    </div>
                    {csNote[c.id] && <p className="cs-note">{csNote[c.id]}</p>}
                    {cf.length > 0 && <p className="cs-note cs-conflict-note">冲突：{cfReason}</p>}
                    {open && (
                      <div className="cs-full">
                        <p className="cs-full-text">
                          {t || '（还没填 —— 点上面的「AI 帮我填」让 AI 写一版，或去画布页自己写）'}
                        </p>
                        <div className="cs-actions">
                          <span className="cs-actions-label">
                            <Icon name="gear" size={12} /> 高级设置
                          </span>
                          <button className="cs-ai" onClick={() => handleCsAiFill(c)} disabled={busy}>
                            <Icon name="zap" size={13} /> {busy ? '处理中…' : t ? 'AI 帮我改' : 'AI 帮我填'}
                          </button>
                          <button
                            className={`cs-lock ${c.locked ? 'on' : ''}`}
                            onClick={() => toggleCanvasLock(c.id)}
                            title={
                              c.locked
                                ? '已锁定：AI 生成 / 改写都不会动这块，点一下解锁'
                                : '锁定这块画布：AI 生成 / 改写都不会动它'
                            }
                          >
                            <Icon name={c.locked ? 'lock' : 'unlock'} size={13} /> {c.locked ? '已锁定' : '锁定'}
                          </button>
                          <span
                            className="cs-seg"
                            title="AI 去哪找参考：联网 = 全网找同类范文；本地 = 只在你的作品库和本地知识里找"
                          >
                            <button
                              className={net ? 'on' : ''}
                              onClick={() => setCsSearch(p => ({ ...p, [c.id]: true }))}
                            >
                              <Icon name="globe" size={13} /> 联网
                            </button>
                            <button
                              className={!net ? 'on' : ''}
                              onClick={() => setCsSearch(p => ({ ...p, [c.id]: false }))}
                            >
                              <Icon name="book" size={13} /> 本地
                            </button>
                          </span>
                          <button className="cs-anchor" onClick={() => handleCsAiAnchor(c)} disabled={busy}>
                            <Icon name="compass" size={13} /> AI 检索范文
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              <p className="cs-hint">
                点每块画布或「高级设置」可展开：看全文 + 高级设置（AI 帮我填/改 · 锁定 · 联网/本地检索 · 范文检索）。
                写着写着长出新人？写完这章点下面的「本章新设定」，它就能进画布。
                {onGoCanvases && (
                  <button className="cs-goto" onClick={onGoCanvases}>
                    去画布页改 →
                  </button>
                )}
              </p>
            </div>
          )}
        </div>
        <div className="wb-chedit-head">
          <h4 className="wb-h4">
            第 {activeChapter} 章{ref ? `《${ref.title}》` : ''} · 正文
          </h4>
          <span className={`wb-chapter-badge ${written ? 'done' : 'todo'}`}>
            {written ? '已写' : '待写'}
          </span>
          <span className="wb-chedit-count">{chapterText.length} 字</span>
        </div>
        {ref?.summary && <p className="wb-chedit-summary">本章大纲：{ref.summary}</p>}

        {/* 动作模式切换 */}
        <div className="cw-mode-tabs">
          {([
            ['generate', '生成本章'],
            ['aiEdit', 'AI 改'],
            ['manual', '手动编辑'],
          ] as Array<[CwMode, string]>).map(([m, label]) => (
            <button
              key={m}
              type="button"
              className={`cw-mode-tab ${cwMode === m ? 'active' : ''}`}
              onClick={() => setCwMode(m)}
              disabled={batch.running}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 正文编辑区（四种模式都看得见、都可改） */}
        <textarea
          className="wb-chedit-textarea"
          rows={cwMode === 'generate' ? 6 : 14}
          value={chapterText}
          onChange={e => setChapterText(e.target.value)}
          placeholder="这一章的正文……可以直接在这里手动写 / 改。"
        />

        {/* v10.46 LOOP-01②：本章新设定的建议（点「加进画布」才写，不擅自改你的设定） */}
        {sugs && sugs.length > 0 && (
          <div className="sug-bar">
            <p className="sug-title">这一章里出现了 {sugs.length} 个新设定：</p>
            <ul className="sug-list">
              {sugs.map(sug => (
                <li key={sug.id} className="sug-item">
                  <span className="sug-kind">{sug.kind}</span>
                  <span className="sug-name">{sug.name}</span>
                  {sug.note && <span className="sug-note">{sug.note}</span>}
                  <span className="sug-actions">
                    <button className="ghost-btn sm" onClick={() => adoptSuggestion(sug)}>
                      ＋ 加进画布·{sug.kind}
                    </button>
                    <button
                      className="ghost-btn sm"
                      onClick={() => setSugs(list => (list ?? []).filter(x => x.id !== sug.id))}
                    >
                      忽略
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* v10.56：本章操作行 —— 按用途分组（保存 / AI 检查 / 载入 / 清空），按钮带图标 + 明白话，行下给一行说明 */}
        <div className="wb-chedit-actions">
          <button
            className="primary-btn sm"
            onClick={handleSaveChapterManual}
            disabled={!hasText || !currentBook}
            title={currentBook ? '保存后本章会标记为「已写」' : '需先在上方「作品」里选一本书'}
          >
            <Icon name="save" size={14} /> {manualFlash ? '已保存 · 已写' : '保存本章正文'}
          </button>
          <span className="wb-act-sep" aria-hidden="true" />
          <button
            className="ghost-btn sm"
            onClick={() => void checkNewSettings()}
            disabled={sugBusy || !hasText}
            title="让 AI 找这一章里的新人物 / 新地点 / 新规则，找到后可一键加进画布"
          >
            <Icon name="search" size={14} /> {sugBusy ? '检查中…' : '检查本章新设定'}
          </button>
          <button
            className="ghost-btn sm"
            onClick={() => loadChapterIntoDraft(currentBook, chapters, activeChapter)}
            disabled={!currentBook}
            title="丢弃编辑区的改动，重新从作品库取回本章正文"
          >
            <Icon name="refresh" size={14} /> 重新载入正文
          </button>
          {text.trim() && (
            <button
              className="ghost-btn sm"
              onClick={() => {
                setChapterText(text)
                setChapterOut(null)
                setGenOut(null)
                setChapterInfo('已把「风格拆解 / 散稿加工」里的文本复制到本章编辑区（尚未保存）。')
              }}
              title="把「风格拆解 / 散稿加工」里粘的散稿复制到本章编辑区"
            >
              <Icon name="download" size={14} /> 用散稿当草稿
            </button>
          )}
          {hasText && (
            <button
              className="ghost-btn sm danger"
              onClick={() => {
                setChapterText('')
                setChapterOut(null)
                setGenOut(null)
                setChapterInfo('已清空编辑区（尚未保存，点保存才会生效）。')
              }}
              title="只清空编辑区，不影响已保存的正文"
            >
              <Icon name="trash" size={14} /> 清空编辑区
            </button>
          )}
        </div>
        <p className="wb-actions-hint">
          「检查本章新设定」= 让 AI 找出这一章里的新人物 / 地点 / 规则，可一键加进画布（不会自动改设定）；
          「重新载入正文」= 丢弃编辑区改动、取回作品库里的版本。
        </p>

        {/* ===== 模式：生成本章 ===== */}
        {cwMode === 'generate' && (
          <div className="wb-chedit-mode">
            {architecture.length > 0 && (
              <details className="wb-ctx">
                <summary>整书架构 · 起承转合（共 {currentBook?.outline.length} 章 · {architecture.length} 幕）</summary>
                <div className="cw-arch-flow" style={{ marginTop: 10 }}>
                  {architecture.map((p, i) => (
                    <div key={i} className={`cw-arc-card role-${p.role}`} title={p.roleDesc}>
                      <div className="cw-arc-head">
                        <span className="cw-arc-num">第{p.actNumber}幕</span>
                        <span className="cw-arc-role">{p.role}</span>
                      </div>
                      <div className="cw-arc-label">{p.label}</div>
                      <div className="cw-arc-range">
                        第 {p.startIdx + 1}{p.endIdx > p.startIdx ? `–${p.endIdx + 1}` : ''} 章 · {p.endIdx - p.startIdx + 1} 章
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="wb-chedit-ai-head" style={{ marginTop: 10 }}>
              <span className="wb-dim-title">本章设置（4 维）</span>
            </div>
            <div className="cw-settings">
              <label className="cw-field">
                <span className="cw-label">① 文本规模</span>
                <div className="cw-words">
                  <input
                    type="range"
                    min={500}
                    max={10000}
                    step={100}
                    value={draftSettings.targetWords}
                    onChange={e => setDraftSettings(s => ({ ...s, targetWords: Number(e.target.value) }))}
                  />
                  <input
                    type="number"
                    className="cw-num"
                    min={300}
                    max={15000}
                    value={draftSettings.targetWords}
                    onChange={e => setDraftSettings(s => ({ ...s, targetWords: Math.max(300, Number(e.target.value) || 2000) }))}
                  />
                  <span className="cw-unit">字</span>
                </div>
              </label>
              <label className="cw-field">
                <span className="cw-label">② 文笔风格</span>
                <input
                  type="text"
                  className="cw-input"
                  placeholder="留空则继承【文笔】画布设定"
                  value={draftSettings.style}
                  onChange={e => setDraftSettings(s => ({ ...s, style: e.target.value }))}
                />
              </label>
              <label className="cw-field">
                <span className="cw-label">
                  ③ 文章目的
                  <em className="cw-optional">（可不选）</em>
                </span>
                <div className="cw-purposes">
                  {PURPOSE_OPTIONS.map(o => (
                    <button
                      key={o.value}
                      type="button"
                      className={`cw-purp ${draftSettings.purpose === o.value ? 'active' : ''}`}
                      // v10.32 文章目的改为非必选：再点一下已选中的就取消，不选也能生成
                      onClick={() =>
                        setDraftSettings(s => ({
                          ...s,
                          purpose:
                            s.purpose === o.value ? ('' as ChapterPurpose) : (o.value as ChapterPurpose),
                        }))
                      }
                      title={draftSettings.purpose === o.value ? '点一下取消选择' : '选中它'}
                    >
                      {o.label}
                    </button>
                  ))}
                  {draftSettings.purpose && (
                    <button
                      type="button"
                      className="ghost-btn sm"
                      onClick={() => setDraftSettings(s => ({ ...s, purpose: '' as ChapterPurpose }))}
                      title="清空文章目的"
                    >
                      清除
                    </button>
                  )}
                </div>
              </label>
              <label className="cw-field">
                <span className="cw-label">④ 其他要求</span>
                <textarea
                  className="cw-textarea"
                  rows={3}
                  placeholder="任意补充要求：例如『增加一段女主回忆』『结尾留悬念』『多写动作少写心理』…"
                  value={draftSettings.extraRequirements}
                  onChange={e => setDraftSettings(s => ({ ...s, extraRequirements: e.target.value }))}
                />
              </label>
            </div>

            <div className="cw-actions">
              <button
                className="primary-btn"
                onClick={handleWriteGen}
                disabled={genWriting || batch.running}
              >
                {genWriting ? '生成中…' : written ? '重新生成本章' : '生成本章'}
              </button>
              {botPersona && (
                <button
                  className="ghost-btn"
                  onClick={handleBotWriteGen}
                  disabled={genWriting || botWriting || batch.running}
                  title={`让${botPersona.name}按自己的人格写这一章（结果会进下方预览，你可以修改或丢弃）`}
                >
                  <Icon name="pen" size={14} />{' '}
                  {botWriting ? `${botPersona.name}正在写…` : `让${botPersona.name}代笔`}
                </button>
              )}
              {!batch.running ? (
                <button
                  className="ghost-btn cw-batch-btn"
                  onClick={() => handleBatchWrite(false)}
                  title="按章节 tag 自动选「文章目的」，逐章生成，已写的会跳过"
                >
                  一键精写全书
                </button>
              ) : (
                <button className="ghost-btn cw-batch-btn" onClick={() => { cancelRef.current = true }}>
                  取消批量
                </button>
              )}
            </div>

            {activeChapterPos > 0 && (
              <details className="wb-ctx" style={{ marginTop: 10 }}>
                <summary>AI 已知的前文（{activeChapterPos} 章）</summary>
                <div className="cw-prev-list">
                  {chapters.slice(0, activeChapterPos).map((c, i) => {
                    const w = currentBook?.chapterWritings?.[c.index]
                    return (
                      <div key={c.index} className="cw-prev-row">
                        <span className="cw-prev-idx">第 {c.index} 章 《{c.title}》</span>
                        <span className="cw-prev-state">
                          {w ? `已精写 · ${w.wordCount} 字` : `仅大纲 · ${c.summary.slice(0, 30)}…`}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </details>
            )}

            {genOut && (
              <div className="wb-chedit-out">
                <h4 className="wb-h4">
                  生成本章 · 第 {activeChapter} 章{ref ? `《${ref.title}》` : ''} · {genOut.content.length} 字
                </h4>
                {genOut.rationale && <p className="gen-beat">写作思路：{genOut.rationale}</p>}
                <div className="gen-prose">
                  {genOut.content.split('\n\n').map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
                <div className="wb-save-bar">
                  <span className="wb-save-text">
                    是否保存？保存后「第 {activeChapter} 章」将标记为「已写」。
                  </span>
                  <div className="wb-save-actions">
                    <button className="primary-btn sm" onClick={saveGenToChapter}>
                      保存到第 {activeChapter} 章（已写）
                    </button>
                    <button
                      className="ghost-btn sm"
                      onClick={() => {
                        setChapterText(genOut.content)
                        setGenOut(null)
                        setCwMode('manual')
                        setChapterInfo('生成稿已放入编辑区（尚未保存），可手动微调后点保存。')
                      }}
                    >
                      放入编辑区微调
                    </button>
                    <button className="ghost-btn sm" onClick={() => setGenOut(null)}>
                      不保存
                    </button>
                  </div>
                </div>
              </div>
            )}
            {genSavedFlash && <p className="wb-ok">已保存，本章状态更新为「已写」。</p>}
          </div>
        )}

        {/* ===== 模式：AI 改 ===== */}
        {cwMode === 'aiEdit' && (
          <div className="wb-chedit-mode">
            <div className="wb-chedit-ai">
              <div className="wb-chedit-ai-head">
                <span className="wb-dim-title">
                  <Icon name="zap" size={14} /> AI 修改本章原文
                </span>
                <span className="wb-hint">按 7 块画布的设定改写这一章；下面两步都可不填，直接点「让 AI 改写本章」也行</span>
              </div>
              <span className="wb-step-label">① 想怎么改？（可选）</span>
              <input
                className="wb-dim-input"
                value={chapterInstr}
                onChange={e => setChapterInstr(e.target.value)}
                placeholder="例如「强化悬疑感」「对话改口语」「节奏加快一倍」… 回车即执行"
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleChapterAI()
                  }
                }}
              />
              <span className="wb-step-label">② 要附参考资料吗？（可选）</span>
              <div className="wb-chedit-ref">
                <input
                  ref={refInputRef}
                  type="file"
                  accept=".txt,.md,.markdown,.text,text/*"
                  style={{ display: 'none' }}
                  onChange={e => onPickRefFile(e.target.files?.[0])}
                />
                <button className="ghost-btn sm" onClick={() => refInputRef.current?.click()}>
                  {refName ? '更换参考文件' : '附上参考文件'}
                </button>
                {refName ? (
                  <>
                    <span className="wb-chedit-refname" title={refText.slice(0, 300)}>
                      {refName}（{refText.length} 字）
                    </span>
                    <button className="ghost-btn sm" onClick={clearRefFile}>
                      移除
                    </button>
                  </>
                ) : (
                  <span className="wb-hint">txt / md 等纯文本，作风格、设定或事实参考（取前 12000 字）</span>
                )}
              </div>
              <div className="wb-ai-exec">
                <span className="wb-hint">
                  {hasText
                    ? '改完先给你看修改稿，确认后才保存到本章'
                    : '先在编辑区写入本章正文（或切「生成本章」先生成一版）后可用'}
                </span>
                <button className="primary-btn" onClick={handleChapterAI} disabled={chapterBusy || !hasText}>
                  <Icon name="zap" size={14} /> {chapterBusy ? 'AI 修改中…' : '让 AI 改写本章'}
                </button>
              </div>
            </div>

            {chapterOut && (
              <div className="wb-chedit-out">
                <h4 className="wb-h4">
                  AI 修改稿 · 第 {activeChapter} 章{ref ? `《${ref.title}》` : ''} · {chapterOut.revised.length} 字
                </h4>
                {chapterOut.changes.length > 0 && (
                  <div className="wb-changes">
                    <h4 className="wb-h4">主要改动</h4>
                    <ul>
                      {chapterOut.changes.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="gen-prose">
                  {chapterOut.revised.split('\n\n').map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
                <div className="wb-save-bar">
                  <span className="wb-save-text">
                    是否保存这份修改稿？保存后「第 {activeChapter} 章」将标记为「已写」。
                  </span>
                  <div className="wb-save-actions">
                    <button className="primary-btn sm" onClick={saveChapterAIToChapter}>
                      保存到第 {activeChapter} 章（已写）
                    </button>
                    <button
                      className="ghost-btn sm"
                      onClick={() => {
                        setChapterText(chapterOut.revised)
                        setChapterOut(null)
                        setCwMode('manual')
                        setChapterInfo('修改稿已放入编辑区（尚未保存），可继续手动微调后点保存。')
                      }}
                    >
                      放入编辑区微调
                    </button>
                    <button className="ghost-btn sm" onClick={saveChapterAIToLibrary}>
                      存入作品库
                    </button>
                    <button
                      className="ghost-btn sm"
                      onClick={() => {
                        setChapterOut(null)
                        setChapterInfo('已放弃本次修改稿。')
                      }}
                    >
                      不保存
                    </button>
                  </div>
                </div>
              </div>
            )}
            {aiSavedFlash && <p className="wb-ok">已保存，本章状态更新为「已写」。</p>}
          </div>
        )}

        {chapterInfo && (
          <p
            className={
              (isStatusError(chapterInfo) || isStatusWarn(chapterInfo)) ? 'wb-warn' : 'wb-ok'
            }
          >
            {chapterInfo}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="workbench">
      {/* v10.50：作品选择端口已挪到「画布页」（从资产库导入即载入其画布详情）。
          写作页只只读展示当前关联的作品；写章节需先在画布页导入作品，散稿加工可直接粘贴文本。 */}
      <section className="wb-block wb-book-indicator">
        <div className="wb-row">
          <span className="wb-h3" style={{ margin: 0 }}>作品</span>
          {effectiveBook ? (
            <span className="wb-book-name">《{effectiveBook.title}》</span>
          ) : (
            <span className="wb-hint">
              未关联作品 —— 写章节前请先到「画布」页从资产库导入作品；散稿加工可直接粘贴文本。
            </span>
          )}
          <BookGenerator variant="inline" />
        </div>
      </section>

      {/* v10.80 灵感采集：多渠道抓取（知乎/小红书/抖音/Reddit/X）→ 组语料 → 拆解改编。
          放在写作页顶部、默认折叠：不抓取时完全不占版面。 */}
      <SourceHarvest
        onCorpus={(corpus, mode) => {
          if (mode === 'replace') setText(corpus)
          else setText(prev => (prev.trim() ? `${prev}\n\n${corpus}` : corpus))
        }}
        onDissect={corpus => {
          void handleDissect(corpus)
        }}
        dissectBusy={dissecting}
      />

      {/* 全局运行状态 —— 切 tab 不中断任务 */}
      {running && (
        <div className="wb-running">
          <span className="wb-dot" />
          正在执行：
          {[
            dissecting && '拆解到画布',
            revising && '散稿改写',
            continuing && '散稿续写',
            chapterBusy && 'AI 修改本章',
            genWriting && '生成本章',
            batch.running && `一键精写全书（${batch.current}/${batch.total}）`,
          ]
            .filter(Boolean)
            .join('、')}
          <span className="wb-running-hint">可自由切换标签，任务不会中断</span>
        </div>
      )}

      {/* v10.40 NAV-02：子功能从纯文字 tab 改成「图标卡片」——图标在上、两字标签在下，
          比一层层嵌套的长文字 tab 好认，也省横向空间。完整说明放 title/hover */}
      <div className="wb-tabs">
        <button
          className={`wb-tab ${tab === 'chapters' ? 'active' : ''}`}
          onClick={() => setTab('chapters')}
          title="章节写作：逐章生成 / 改 / 手写，也能一键精写全书"
        >
          <span className="wb-tab-icon"><Icon name="pen" /></span>
          <span className="wb-tab-label">写章</span>
        </button>
        <button
          className={`wb-tab ${tab === 'loose' ? 'active' : ''}`}
          onClick={() => setTab('loose')}
          title="散稿加工：批量修改、整段续写、结果可存进作品库"
        >
          <span className="wb-tab-icon"><Icon name="scissors" /></span>
          <span className="wb-tab-label">散稿</span>
        </button>
        <button
          className={`wb-tab ${tab === 'script' ? 'active' : ''}`}
          onClick={() => setTab('script')}
          title="短剧剧本：把正文改写成可开拍的竖屏短剧剧本"
        >
          <span className="wb-tab-label">短剧</span>
        </button>
      </div>

      <label className="wb-asksave">
        <input
          type="checkbox"
          checked={askSave}
          onChange={e => setAskSave(e.target.checked)}
        />
        任务完成后询问是否保存结果
      </label>

      {pendingSave && (
        <div className="wb-save-bar">
          <span className="wb-save-text">任务已完成，是否保存结果？</span>
          <div className="wb-save-actions">
            {pendingSave.kind === 'revise' && reviseOut && (
              <>
                <button className="primary-btn sm" onClick={saveRevisionToText}>
                  用修改稿替换原文
                </button>
                <button
                  className="ghost-btn sm"
                  onClick={() => saveToLibrary(reviseOut.revised, '散稿修改稿', reviseOut.changes.join('；'))}
                >
                  存入作品库
                </button>
                <button className="ghost-btn sm" onClick={() => setPendingSave(null)}>
                  不保存
                </button>
              </>
            )}
            {pendingSave.kind === 'continue' && continueOut && (
              <>
                <button className="primary-btn sm" onClick={saveContinuationToText}>
                  追加到原文
                </button>
                <button
                  className="ghost-btn sm"
                  onClick={() => saveToLibrary(continueOut.continuation, '散稿续写稿', continueOut.rationale)}
                >
                  存入作品库
                </button>
                <button className="ghost-btn sm" onClick={() => setPendingSave(null)}>
                  不保存
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ===== Tab 2：章节写作（原 原文修改 + 续写 + 逐章精写 三合一） ===== */}
      <section className="wb-block" hidden={tab !== 'chapters'}>
        <p className="wb-desc">
          一本书一条流水线：点章节 → 在编辑器里「生成本章 / AI 改 / → 续写 / 手动编辑」→ 保存即标记「已写」。
          生成与修改都会读取 7 块画布的设定。
        </p>
        {renderChapterFramework()}
        {renderChapterEditor()}
      </section>

      {/* ===== Tab 3：散稿加工（无章纲的粘贴文本） ===== */}
      <section className="wb-block" hidden={tab !== 'loose'}>
        {renderSourceBlock('1. 粘贴散稿', '不针对某一章：把整段文本按 7 块画布的设定加工。适合处理粘贴进来的散稿。', 'wb-loose')}
        <p className="wb-hint">
          这一框选书时会自动载入该书的「书名 + 简介 + 大纲 + 样章」供改写参考 ——
          它只是参考文本，<b>不是</b>书的章节正文，也不会让任何一章变成「已写」。
          想把散稿算成章节，用下面第 4 节。
        </p>
        {renderCanvasContext()}
        <h3 className="wb-h3" style={{ marginTop: 14 }}>2. 按画布改写全文</h3>
        <div className="ws-row" style={{ marginBottom: 8 }}>
          <WebSearchToggle
            checked={webSearch}
            onChange={setWebSearch}
            hint="开启后，下方「改写」与「续写」都会先联网检索同类型（同题材 / 同风格）的优秀文章作为风格参照，再帮你写"
          />
        </div>
        <div className="wb-field" style={{ marginBottom: 10 }}>
          <label className="wb-label">方向意图（导演层 · 可选）</label>
          <textarea
            className="wb-textarea"
            rows={2}
            placeholder="告诉 AI 这段要往哪个方向走，例如：整体冷峻克制、收紧节奏、让主角显露锋芒。留空则只按 7 画布。"
            value={directionIntent}
            onChange={e => setDirectionIntent(e.target.value)}
          />
        </div>
        <button className="primary-btn" onClick={handleRevise} disabled={revising || !text.trim()}>
          {revising ? '修改中…' : '按画布改写全文'}
        </button>
        {reviseOut && (
          <>
            <div className="wb-save-bar" style={{ marginTop: 10 }}>
              <span className="wb-save-text">是否保存这份修改稿？</span>
              <div className="wb-save-actions">
                <button className="primary-btn sm" onClick={saveRevisionToText}>
                  用修改稿替换原文
                </button>
                <button
                  className="ghost-btn sm"
                  onClick={() => saveToLibrary(reviseOut.revised, '散稿修改稿', reviseOut.changes.join('；'))}
                >
                  存入作品库
                </button>
                <button className="ghost-btn sm" onClick={() => setReviseOut(null)}>
                  不保存
                </button>
              </div>
            </div>
            {reviseOut.changes.length > 0 && (
              <div className="wb-changes">
                <h4 className="wb-h4">主要改动</h4>
                <ul>
                  {reviseOut.changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            <ReferenceList references={reviseOut.references} />
            <div className="gen-prose">
              {reviseOut.revised.split('\n\n').map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </>
        )}

        <h3 className="wb-h3" style={{ marginTop: 18 }}>3. 按画布续写</h3>
        <p className="wb-desc">延续原文的人物与口吻往下写，结果可追加回原文。</p>
        <button className="primary-btn" onClick={handleContinue} disabled={continuing || !text.trim()}>
          {continuing ? '续写中…' : '续写散稿'}
        </button>
        {continueOut && (
          <>
            <h4 className="wb-h4" style={{ marginTop: 14 }}>
              续写结果 · {continueOut.continuation.length} 字
            </h4>
            <div className="gen-prose">
              {continueOut.continuation.split('\n\n').map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
            {continueOut.rationale && <p className="gen-beat">续写依据：{continueOut.rationale}</p>}
            <div className="wb-save-bar">
              <span className="wb-save-text">是否保存这段续写？</span>
              <div className="wb-save-actions">
                <button className="primary-btn sm" onClick={saveContinuationToText}>
                  追加到原文
                </button>
                <button
                  className="ghost-btn sm"
                  onClick={() => saveToLibrary(continueOut.continuation, '散稿续写稿', continueOut.rationale)}
                >
                  存入作品库
                </button>
                <button className="ghost-btn sm" onClick={() => setContinueOut(null)}>
                  不保存
                </button>
              </div>
            </div>
          </>
        )}
        {actionInfo && (
          <p className={(isStatusError(actionInfo) || isStatusWarn(actionInfo)) ? 'wb-warn' : 'wb-ok'}>
            {actionInfo}
          </p>
        )}

        {/* v10.46 LOOP-01③：手动归章 —— 散稿里没写章节标题时，也能指哪打哪 */}
        <div className="loose-file">
          <span className="loose-file-label">手动归入第</span>
          <select
            className="loose-file-select"
            value={looseTo}
            onChange={e => setLooseTo(e.target.value ? Number(e.target.value) : '')}
            disabled={!currentBook}
          >
            <option value="">选一章</option>
            {chapters.map(c => (
              <option key={c.index} value={c.index}>
                第 {c.index} 章 {c.title}
                {currentBook?.chapterWritings?.[c.index] ? '（已写，会覆盖）' : ''}
              </option>
            ))}
          </select>
          <button
            className="ghost-btn sm"
            onClick={fileLooseIntoChapter}
            disabled={!currentBook || !looseTo || !text.trim()}
            title="把上面散稿框里的整段文本当作这一章的正文写进去"
          >
            写入这一章
          </button>
          <span className="wb-hint">散稿框里没写章标题时用这个。</span>
        </div>

        {/* ===== 4. 按章写入作品库 =====
            散稿框只是临时缓冲，跟书的「章节档案」没有任何绑定 —— 不点这里，
            章节写作里永远是「待写」。 */}
        <h3 className="wb-h3" style={{ marginTop: 18 }}>4. 按章写入作品库</h3>
        <p className="wb-desc">
          散稿不会自动变成书的章节。上面那份文本里若带「第一章 / 第 3 节」这类标题，
          这里会把它归到当前作品的章纲上，写进去之后「章节写作」里立刻变「已写」。
        </p>
        {!currentBook ? (
          <p className="wb-hint">先在上方「作品」里选一本书，才知道要写进哪本。</p>
        ) : !looseDetected ? (
          <p className="wb-warn">
            这份散稿里没识别到章节标题，没法自动归章。两个办法：① 在原文里给每章补一行
            「第一章 章名」再回来；② 去「章节写作」点某一章，把内容粘进去点「保存本章正文」。
          </p>
        ) : (
          <>
            <div className="ci-plan">
              {importPlan.map(r => {
                const exists = r.targetIndex != null && Boolean(currentBook.chapterWritings?.[r.targetIndex])
                return (
                  <div key={r.pieceIndex} className="ci-row">
                    <span className="ci-from" title={r.pieceTitle}>{r.pieceTitle}</span>
                    <span className="ci-arrow">→</span>
                    <span className="ci-to">
                      {r.targetIndex == null
                        ? '章纲放不下了'
                        : `第 ${r.targetIndex} 章《${r.targetTitle}》`}
                    </span>
                    <span className={`ci-by ${r.by}`}>
                      {r.by === 'title' ? '标题对上了' : r.by === 'order' ? '按顺序' : '跳过'}
                    </span>
                    <span className="ci-words">{r.words} 字</span>
                    {exists && <span className="ci-over">会覆盖</span>}
                  </div>
                )
              })}
            </div>
            <div className="wb-save-actions" style={{ marginTop: 10 }}>
              <button
                className="primary-btn"
                onClick={handleImportChapters}
                disabled={writableImportCount === 0}
              >
                ⬇️ 写入这 {writableImportCount} 章
              </button>
              <span className="wb-hint">
                共 {currentBook.outline.length} 章 ·
                这本书已写 {Object.keys(currentBook.chapterWritings ?? {}).length} 章
              </span>
            </div>
            {importInfo && (
              <p className={(isStatusError(importInfo) || isStatusWarn(importInfo)) ? 'wb-warn' : 'wb-ok'}>{importInfo}</p>
            )}
          </>
        )}
      </section>

      {/* ===== Tab 4：短剧剧本（把自己写的正文改成能直接拍的 AI 短剧） ===== */}
      <section className="wb-block" hidden={tab !== 'script'}>
        <ScriptStudio text={text} onTextChange={setText} />
      </section>
    </div>
  )
}
