import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store/AppContext'
import {
  brainstormExtract,
  brainstormGrow,
  brainstormOutline,
  type BookScale,
  type BrainExtractResult,
  type BrainGrowResult,
} from '../lib/llmClient'
import { patchToCanvasIds } from '../lib/dims'
import { setEnginePref } from '../lib/engine'
import { WebSearchToggle, ReferenceList } from './WebSearchToggle'
import { ImageDissectUpload } from './ImageDissectUpload'

/* ============================================================
   PRD 三、3.2 脑洞共创 0 结构生成流程
   步骤1 灵感极简输入 → 步骤2 选择题式核心确认 →
   步骤3 分层自动生长 → 步骤4 一键导入高级工作台
   ============================================================ */

type Step = 1 | 2 | 3 | 4

/** 卡片点选输入：题材 + 情绪 + 核心冲突（无打字创作） */
const CARD_GROUPS: { key: string; label: string; options: string[] }[] = [
  {
    key: 'genre',
    label: '题材',
    options: ['都市言情', '古装宫斗', '玄幻仙侠', '悬疑推理', '科幻未来', '校园青春', '年代家族', '爽文逆袭'],
  },
  {
    key: 'mood',
    label: '情绪',
    options: ['甜爽治愈', '虐心催泪', '紧张刺激', '轻松搞笑', '黑暗压抑', '温暖热血'],
  },
  {
    key: 'conflict',
    label: '核心冲突',
    options: ['身份秘密', '爱而不得', '复仇雪恨', '权力争夺', '生存危机', '误会重重'],
  },
]

const LAYER_META = [
  { layer: 1, title: '一句话故事', hint: '先有一个能说出口的故事' },
  { layer: 2, title: '故事骨架', hint: '开端 → 升级 → 危机 → 转折 → 结局' },
  { layer: 3, title: '人物与关系', hint: '谁想要什么、谁挡着谁' },
  { layer: 4, title: '文笔 · 节奏 · 篇幅', hint: '这个故事读起来是什么味道' },
]

/**
 * v10.29 篇幅体量 —— 决定「自动长框架 → 章节清单」这一跳生成多少章。
 * 这里只是展示文案；真正的结构约束在 worker 的 SCALE_SPEC 里（章数上下限、每章字数、输出上限）。
 * 注：7 画布里的「篇幅」是 AI 写的描述性文字，这里的体量是硬参数，两者互补、不冲突。
 */
/** v10.41 STEP1-01：等待期间每 3 秒换一句，给用户「它在干活」的心理锚点 */
const WAIT_HINTS = [
  '正在拆解核心设定…',
  '正在识别主角和冲突…',
  '正在匹配故事类型…',
  '正在整理可选走向…',
]

const SCALES: { id: BookScale; label: string; meta: string; desc: string }[] = [
  {
    id: 'short',
    label: '短篇小说',
    meta: '6–12 章 · 约 2–3 万字',
    desc: '单线推进，一个核心冲突讲透，不铺支线',
  },
  {
    id: 'medium',
    label: '中篇小说',
    meta: '18–30 章 · 约 5–9 万字',
    desc: '主副线并行，主角有成长弧，中段一次大转折',
  },
  {
    id: 'long',
    label: '长篇小说',
    meta: '50–120 章 · 约 15–36 万字',
    desc: '多幕结构，容得下多条支线与长线伏笔',
  },
  {
    id: 'custom',
    label: '自定义字数',
    meta: '2–40 万字 · 章数自动分',
    desc: '自己填全书总字数，章数与每章字数按它反算',
  },
]

/** 自定义总字数的可填范围（字） */
const CUSTOM_MIN = 20000
const CUSTOM_MAX = 400000

/**
 * v10.30 自定义体量 → 章数 / 每章字数的估算。
 * ⚠️ 这**只是给用户看的预估**；真正下发给模型的约束在 worker 的 brainstormOutline 分支里
 * （同一套算法，改一处请同步另一处）。
 */
function estimateCustom(totalWords: number) {
  const total = Math.max(CUSTOM_MIN, Math.min(CUSTOM_MAX, Math.floor(totalWords || 0)))
  const per = total <= 50000 ? 2500 : total <= 120000 ? 2800 : 3000
  const chapters = Math.max(4, Math.min(120, Math.round(total / per)))
  const words = Math.max(1500, Math.min(6000, Math.round(total / chapters / 100) * 100))
  return { total, chapters, words }
}

const ANSWER_LABEL: Record<string, string> = {
  protagonist: '主角人设',
  conflict: '核心矛盾',
  theme: '故事主题',
  ending: '结局走向',
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function BrainFlow({
  onEnterPro,
  active,
}: {
  /** bookId：这次脑洞生成的书（若导出了章节清单）。创作台会自动选中它，实现「画布结果同步到创作台」 */
  onEnterPro: (bookId?: string) => void
  /** 当前是否正处于脑洞页（App 用 hidden 保持挂载，用来在离开后自动复位） */
  active: boolean
}) {
  const { listCanvases, bulkUpdateContent, saveBook } = useApp()

  const [step, setStep] = useState<Step>(1)
  const [info, setInfo] = useState('')
  /** v10.27 这次脑洞导出的书 id（进入创作台时自动选中它） */
  const [createdBookId, setCreatedBookId] = useState<string | null>(null)
  /**
   * v10.29 篇幅体量：决定章节清单的规模。
   * 必须在「确认生成」之前选定 —— 章纲就是按它生成的，选完再想要么重新生成、要么去创作台增删章节。
   */
  const [scale, setScale] = useState<BookScale>('medium')
  /** 自定义体量：全书总字数（以「万字」为单位输入，存的是字） */
  const [customWan, setCustomWan] = useState(12)

  // —— 步骤1：灵感输入 ——
  const [raw, setRaw] = useState('')
  const [cards, setCards] = useState<Record<string, string>>({})
  const [listening, setListening] = useState(false)
  const [extracting, setExtracting] = useState(false)
  /**
   * v10.41 STEP1-01：等待态要「有进度、可取消、有预估」。
   * 免费引擎实测可能等 30 秒以上，之前只有一颗变灰的按钮，用户以为卡死了。
   */
  const [waitSec, setWaitSec] = useState(0)
  const [hintIdx, setHintIdx] = useState(0)
  /** 用户点了「取消」→ 结果回来就丢掉（fetch 本身没带 signal，这里做「逻辑取消」） */
  const cancelRef2 = useRef(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null)

  // —— 步骤2：选择题确认 ——
  const [extract, setExtract] = useState<BrainExtractResult | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  /**
   * v10.41 STEP2-01：理解确认卡的状态机
   * pending=等你确认 / ok=已确认（选择题才可点）/ editing=正在改 AI 的理解
   */
  const [understood, setUnderstood] = useState<'pending' | 'ok' | 'editing'>('pending')
  const [readbackDraft, setReadbackDraft] = useState('')
  /** 用户改过的「理解」优先于原始脑洞喂给分层生长 */
  const [premise, setPremise] = useState('')

  // —— 步骤3：分层生长 ——
  const [layers, setLayers] = useState<BrainGrowResult[]>([])
  const [runningLayer, setRunningLayer] = useState(0)
  const [progress, setProgress] = useState(0)
  /** v10.41 STEP3-03：单层失败信息（层号 → 报错），失败层不阻塞其他层 */
  const [layerErr, setLayerErr] = useState<Record<number, string>>({})
  const [chosenVariant, setChosenVariant] = useState('')
  /** 联网搜同类型作品开关（默认关）：开启时分层生长 + 章节清单都会先检索同类型优秀作品作参考 */
  const [webSearch, setWebSearch] = useState(false)
  /** 各层/清单联网参考到的同类型作品，汇总展示 */
  const [references, setReferences] = useState<string[]>([])

  // —— 步骤4：导入 ——
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState(false)
  const [bookTitle, setBookTitle] = useState('')
  const [chapterCount, setChapterCount] = useState(0)

  /** 整个流程一键清空，回到步骤1（生成完一次后必须复位，否则会重复导入出内容一样的书） */
  const resetFlow = () => {
    setStep(1)
    setInfo('')
    setRaw('')
    setCards({})
    setExtract(null)
    setAnswers({})
    setUnderstood('pending')
    setReadbackDraft('')
    setPremise('')
    setLayers([])
    setRunningLayer(0)
    setProgress(0)
    setChosenVariant('')
    setImporting(false)
    setImported(false)
    setBookTitle('')
    setChapterCount(0)
  }

  // 离开脑洞页时，如果这次流程已经走完（书已入库），自动清空回到初始状态
  useEffect(() => {
    if (!active && imported) resetFlow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, imported])

  const cardText = Object.entries(cards)
    .map(([k, v]) => `${CARD_GROUPS.find(g => g.key === k)?.label ?? k}：${v}`)
    .join('；')

  /** 把 AI 回传的「维度 → 内容」补丁写进对应画布（store 会自动跳过被锁定的画布） */
  const applyPatch = (patch: Record<string, string>) => {
    const idPatch = patchToCanvasIds(patch)
    // v10.31 带上原因：写回前会自动存一份画布版本，改坏了能退回去
    if (Object.keys(idPatch).length) bulkUpdateContent(idPatch, '脑洞长框架写回画布')
  }

  /**
   * 图片识别结果：写进 7 个画布，并顺手把「设定+情节+人物」合成一句填进脑洞输入框
   *（这样即使没打字，「下一步」也能继续往下走）。
   */
  const applyImageDims = (dims: Record<string, string>) => {
    applyPatch(dims)
    const summary = [dims['设定'], dims['情节'], dims['人物']].filter(Boolean).join(' ')
    if (summary && !raw.trim()) setRaw(summary.slice(0, 300))
    setInfo('✅ 已识别图片内容并分配到 7 个画布，可以继续点「下一步」。')
  }

  /**
   * v10.41 STEP1-02：三组标签都选完 → 自动拼成一句人话填进脑洞输入框。
   * 只在输入框为空、或内容还是上一次自动拼的那句时才覆盖，不抢用户手打的字。
   */
  const autoSentenceRef = useRef('')
  const composeFromCards = (next: Record<string, string>) => {
    if (!CARD_GROUPS.every(g => (next[g.key] || '').trim())) return null
    return `一个${next.mood}的${next.genre}故事，核心是${next.conflict}`
  }

  /* ---------- 步骤1 → 步骤2 ---------- */
  const handleExtract = async () => {
    if (!raw.trim() && !cardText) {
      setInfo('⚠️ 先写一句脑洞，或者点几张卡片也行。')
      return
    }
    setExtracting(true)
    setInfo('')
    cancelRef2.current = false
    setWaitSec(0)
    setHintIdx(0)
    try {
      const { data } = await brainstormExtract({ raw, cards })
      // 期间用户点了「取消」→ 结果丢掉，不往下走
      if (cancelRef2.current) return
      setExtract(data)
      // 确认卡回到待确认态，并把 AI 读出来的话放进草稿
      setUnderstood('pending')
      setReadbackDraft(data.readback || '')
      setPremise('')
      // 每组默认选中第一个选项 —— 用户全程不动手也能一路「下一步」
      const preset: Record<string, string> = {}
      data.questions.forEach(q => {
        if (q.options[0]) preset[q.key] = q.options[0].label
      })
      setAnswers(preset)
      setStep(2)
    } catch (e) {
      if (cancelRef2.current) return
      setInfo(`❌ 没读懂这段脑洞：${msg(e)}`)
    } finally {
      setExtracting(false)
    }
  }

  /** 取消等待：回到输入态，脑洞内容保留 */
  const cancelExtract = () => {
    cancelRef2.current = true
    setExtracting(false)
    setWaitSec(0)
    setInfo('已取消这次读取，脑洞内容还在，可以直接再点一次。')
  }

  /** 等太久 → 一键切到付费引擎（DeepSeek），比免费通道稳 */
  const switchToPaid = () => {
    setEnginePref({ engine: 'cloud' })
    setInfo('已切到付费引擎（优质模型生产）。再点一次「下一步」，这次会快很多。')
    cancelExtract()
  }

  /* 等待计时 + 轮播提示（纯前端定时器，不需要真的流式输出） */
  useEffect(() => {
    if (!extracting) return
    const t = window.setInterval(() => {
      setWaitSec(s => s + 1)
      setHintIdx(i => i + 1)
    }, 1000)
    return () => window.clearInterval(t)
  }, [extracting])

  /* ---------- 语音输入 ---------- */
  const toggleVoice = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const W = window as any
    const SR = W.SpeechRecognition || W.webkitSpeechRecognition
    if (!SR) {
      setInfo('⚠️ 当前浏览器不支持语音输入（建议用 Chrome / Edge），改用文字或卡片即可。')
      return
    }
    if (listening) {
      recRef.current?.stop()
      setListening(false)
      return
    }
    const rec = new SR()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript
      setRaw(prev => prev + text)
    }
    rec.onerror = () => {
      setListening(false)
      setInfo('⚠️ 语音识别出错，可直接打字或点卡片。')
    }
    rec.onend = () => setListening(false)
    rec.start()
    recRef.current = rec
    setListening(true)
    setInfo('正在听…说完点「停止」')
  }

  /* ---------- 步骤2 → 步骤3：分层生长 ---------- */
  const mergedAnswers = () => {
    const m: Record<string, string> = { ...answers }
    if (extract) {
      if (!m.protagonist && extract.elements.protagonist) m.protagonist = extract.elements.protagonist
      if (!m.conflict && extract.elements.conflict) m.conflict = extract.elements.conflict
      if (!m.ending && extract.elements.ending) m.ending = extract.elements.ending
      // 核心欲望并进主角人设，避免信息丢失
      if (extract.elements.desire && !String(m.protagonist).includes(extract.elements.desire)) {
        m.protagonist = `${m.protagonist}；核心欲望：${extract.elements.desire}`
      }
    }
    return m
  }

  /**
   * v10.41 STEP3-01/03：分层生长的循环抽出来，支持「从第 N 层继续」。
   * 单层失败不再卡死整条流程 —— 记下这一层的错误、把控制权交回用户，
   * 用户可以「重试这一层」或「跳过这层继续下一层」。
   */
  const growFrom = async (start: number) => {
    setInfo('')
    const acc: BrainGrowResult[] = layers.slice(0, start - 1).filter(Boolean)
    for (let n = start; n <= 4; n++) {
      setRunningLayer(n)
      setLayerErr(prev => {
        const next = { ...prev }
        delete next[n]
        return next
      })
      try {
        const { data } = await brainstormGrow({
          raw: premise || raw,
          answers: mergedAnswers(),
          previousLayers: acc.map(l => l.display.join('；')),
          layer: n,
          webSearch,
        })
        acc.push(data)
        if (data.references?.length) setReferences(r => [...r, ...(data.references as string[])])
        setLayers([...acc])
        applyPatch(data.canvasPatch)
        if (n === 1 && data.variants.length) setChosenVariant(data.variants[0])
        setProgress(p => Math.max(p, n))
      } catch (e) {
        setLayerErr(prev => ({ ...prev, [n]: msg(e) }))
        setRunningLayer(0)
        return false
      }
    }
    setRunningLayer(0)
    return true
  }

  const runAllLayers = async () => {
    setStep(3)
    setInfo('')
    setLayers([])
    setProgress(0)
    setLayerErr({})
    setChosenVariant('')
    if (await growFrom(1)) {
      setInfo('✅ 四层都搭好了，7 块画布已经自动填好。')
    }
  }
  /** 单层重试（第 1 层失败或用户换了梗概版本时用） */
  const rerunLayer = async (n: number, variant?: string) => {
    setRunningLayer(n)
    // v10.41 STEP3-03：重试时先清掉这一层的失败标记
    setLayerErr(prev => {
      const next = { ...prev }
      delete next[n]
      return next
    })
    setInfo('')
    const acc = layers.slice(0, n - 1).filter(Boolean)
    try {
      const { data } = await brainstormGrow({
        raw: premise || raw,
        answers: mergedAnswers(),
        chosenVariant: variant ?? (n === 1 ? '' : chosenVariant),
        previousLayers: acc.map(l => l.display.join('；')),
        layer: n,
        webSearch,
      })
      const next = [...layers]
      next[n - 1] = data
      if (data.references?.length) setReferences(r => [...r, ...(data.references as string[])])
      setLayers(next)
      applyPatch(data.canvasPatch)
      if (n === 1 && data.variants.length && !variant) setChosenVariant(data.variants[0])
      setProgress(p => Math.max(p, n))
      setInfo(
        n === 1
          ? `✅ 已按新版本重写第一层，画布同步更新。`
          : `✅ 第 ${n} 层已重新生成。`,
      )
    } catch (e) {
      setInfo(`❌ 第 ${n} 层生成失败：${msg(e)}`)
    }
    setRunningLayer(0)
  }

  const pickVariant = async (v: string) => {
    if (v === chosenVariant || runningLayer) return
    setChosenVariant(v)
    await rerunLayer(1, v)
  }

  /* ---------- 步骤3 → 步骤4：生成章节清单并导入（一本书只导一次） ---------- */
  const handleImport = async () => {
    if (imported || importing) return
    // v10.30 选了自定义体量但字数越界：直接拦下来，别让它带着一个被夹到边界的值去生成
    if (scale === 'custom' && (customWan * 10000 < CUSTOM_MIN || customWan * 10000 > CUSTOM_MAX)) {
      setInfo('❌ 自定义字数请填 2–40 万字之间（点「确认生成」前先改好）')
      return
    }
    setImporting(true)
    setInfo('')
    try {
      const canvases: Record<string, string> = {}
      listCanvases().forEach(c => {
        canvases[c.dimension] = c.content
      })
      // 再把最终补丁写一次，确保画布与展示一致（锁定画布会被跳过）
      layers.filter(Boolean).forEach(l => applyPatch(l.canvasPatch))

      const { data } = await brainstormOutline(
        canvases,
        webSearch,
        scale,
        scale === 'custom' ? Math.round(customWan * 10000) : undefined,
      )
      if (data.references?.length) setReferences(r => [...r, ...(data.references as string[])])
      // v10.27 记下这本书的 id：进入创作台时自动选中它（画布结果 → 创作台 同步）
      const bookId = `book-${Date.now()}`
      saveBook({
        id: bookId,
        title: data.title,
        synopsis: data.synopsis,
        outline: data.outline,
        sampleChapter: {
          title: data.outline[0]?.title || '第一章',
          content: '',
          beat: '脑洞共创模式只搭框架不写正文 —— 到「创作台 · 章节写作」按章节一键生成正文',
        },
        stats: data.stats,
        searched: false,
        searchCount: 0,
        usedFallback: false,
        engine: 'deepseek',
        createdAt: new Date().toLocaleString('zh-CN'),
      })
      setCreatedBookId(bookId)
      setBookTitle(data.title)
      setChapterCount(data.outline.length)
      setImported(true)
      setStep(4)
      setInfo('')
    } catch (e) {
      setInfo(`❌ 章节清单生成失败：${msg(e)}　可以点「跳过，直接进入工作台」。`)
    }
    setImporting(false)
  }

  /** STEP2-02：选了几组 / 还差几组（不强制选满，只做提示，AI 会用默认值补） */
  const answeredAll = Boolean(extract) && extract!.questions.every(q => (answers[q.key] || '').trim())
  const leftCount = extract ? extract.questions.filter(q => !(answers[q.key] || '').trim()).length : 0

  return (
    <div className="brain">
      {/* 步骤条 */}
      <ol className="brain-steps">
        {[
          { n: 1, label: '写下脑洞' },
          { n: 2, label: '选择题确认' },
          { n: 3, label: '自动长框架' },
          { n: 4, label: '进入工作台' },
        ].map(s => {
          const state = step === s.n ? 'active' : step > s.n ? 'done' : 'todo'
          return (
            <li key={s.n} className={`brain-step ${state}`}>
              <span className="brain-step-dot">{step > s.n ? '✓' : s.n}</span>
              <span className="brain-step-label">{s.label}</span>
            </li>
          )
        })}
      </ol>

      {/* ================= 步骤 1：灵感极简输入 ================= */}
      <section className="wb-block" hidden={step !== 1}>
        <h2 className="brain-h2">你的脑洞是什么样？</h2>
        <p className="wb-desc">
          怎么想的就怎么写，一句话、一个人设、一个名场面都行。不想打字就点下面的卡片。
        </p>

        <textarea
          className="brain-textarea"
          rows={6}
          value={raw}
          onChange={e => setRaw(e.target.value)}
          placeholder="例：一个能看见别人死亡倒计时的法医，发现自己头顶的数字只剩三天。"
        />
        <div className="brain-input-actions">
          <button className={`ghost-btn sm ${listening ? 'danger' : ''}`} onClick={toggleVoice}>
            {listening ? '停止收音' : '语音输入'}
          </button>
          <span className="wb-hint">{raw.length} / 建议至少 10 字</span>
        </div>

        <ImageDissectUpload
          onResult={applyImageDims}
          hint="已经在纸上画过思维导图 / 大纲？直接上传，AI 识别后分配到 7 个画布"
        />

        <details className="brain-cards" open={!raw.trim()}>
          <summary>
            不想打字？点几个标签，自动拼出一句话
            {cardText && <span className="brain-cards-picked">已选：{cardText}</span>}
          </summary>
          <div className="brain-cards-body">
            {CARD_GROUPS.map(g => (
              <div key={g.key} className="brain-card-group">
                <span className="brain-card-label">
                  {g.label}
                  <em className="brain-card-need">（选 1 个）</em>
                </span>
                <div className="brain-chips">
                  {g.options.map(o => (
                    <button
                      key={o}
                      type="button"
                      className={`brain-chip ${cards[g.key] === o ? 'active' : ''}`}
                      onClick={() => {
                        const next = { ...cards, [g.key]: cards[g.key] === o ? '' : o }
                        setCards(next)
                        // STEP1-02：三组都选完 → 自动拼一句填进输入框（填过的不覆盖用户手改）
                        const sentence = composeFromCards(next)
                        if (sentence && (!raw.trim() || raw === autoSentenceRef.current)) {
                          autoSentenceRef.current = sentence
                          setRaw(sentence)
                        }
                      }}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>

        {info && <p className={info.startsWith('❌') || info.startsWith('⚠️') ? 'wb-warn' : 'wb-ok'}>{info}</p>}

        {/* v10.41 STEP1-01：读取等待态 —— 进度条 + 轮播提示 + 取消 + 超时兜底 */}
        {extracting ? (
          <div className="brain-wait">
            <div className="brain-wait-row">
              <span className="brain-wait-spin">⏳</span>
              <span className="brain-wait-text">{WAIT_HINTS[hintIdx % WAIT_HINTS.length]}</span>
              <button className="ghost-btn sm" onClick={cancelExtract}>
                取消
              </button>
            </div>
            <div className="brain-wait-bar">
              <span />
            </div>
            <div className="brain-wait-meta">
              <span>AI 正在读你的脑洞…</span>
              <span className="brain-wait-eta">
                {waitSec < 25 ? '约 15 秒' : `比预期慢，再等等`}（已等 {waitSec}s）
              </span>
            </div>
            {waitSec >= 25 && (
              <div className="brain-wait-slow">
                <span>AI 读得有点慢，免费引擎当前排队中。</span>
                <span className="brain-wait-slow-btns">
                  <button className="ghost-btn sm" onClick={() => setWaitSec(25)}>
                    再等等
                  </button>
                  <button className="ghost-btn sm" onClick={switchToPaid}>
                    切换到付费引擎（更快）
                  </button>
                </span>
              </div>
            )}
          </div>
        ) : (
          <button
            className="primary-btn brain-cta"
            onClick={handleExtract}
            disabled={!raw.trim() && !cardText}
          >
            下一步：让 AI 读懂我的脑洞 →
          </button>
        )}
      </section>

      {/* ================= 步骤 2：选择题式核心确认 ================= */}
      <section className="wb-block" hidden={step !== 2}>
        <h2 className="brain-h2">先确认几件事（都是选择题，不用打字）</h2>

        {/* v10.41 STEP2-01：先确认「AI 读对了吗」，确认后才展开选择题。
            想改就地点「改」，不用滚到页面最底部找「← 改脑洞」。 */}
        {extract && (
          <div className={`brain-confirm ${understood === 'ok' ? 'ok' : ''}`}>
            <p className="brain-confirm-title">
              {understood === 'ok' ? '✓ 已确认 AI 的理解' : 'AI 是这样理解你的脑洞的：'}
            </p>
            {understood === 'editing' ? (
              <>
                <textarea
                  className="brain-confirm-input"
                  rows={3}
                  value={readbackDraft}
                  onChange={e => setReadbackDraft(e.target.value)}
                />
                <div className="brain-confirm-actions">
                  <button
                    className="primary-btn sm"
                    onClick={() => {
                      setPremise(readbackDraft.trim())
                      setUnderstood('ok')
                    }}
                  >
                    确认修改
                  </button>
                  <button
                    className="ghost-btn sm"
                    onClick={() => {
                      setReadbackDraft(extract.readback || '')
                      setUnderstood('pending')
                    }}
                  >
                    还原
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="brain-confirm-text">「{readbackDraft || extract.readback}」</p>
                <div className="brain-confirm-actions">
                  <button
                    className={`ghost-btn sm ${understood === 'ok' ? 'on' : ''}`}
                    onClick={() => setUnderstood('ok')}
                  >
                    {understood === 'ok' ? '✓ 已确认' : '对 ✓'}
                  </button>
                  <button className="ghost-btn sm" onClick={() => setUnderstood('editing')}>
                    改
                  </button>
                </div>
              </>
            )}
            {understood !== 'ok' && (
              <p className="wb-hint">确认之后，下面的选择题才会展开。</p>
            )}
          </div>
        )}

        <div className={understood === 'ok' ? '' : 'brain-locked'}>
          {extract?.elements && (
            <div className="brain-elements">
              {[
                ['主角', extract.elements.protagonist],
                ['最想要的', extract.elements.desire],
                ['最大阻力', extract.elements.conflict],
                ['走向', extract.elements.ending],
              ].map(([k, v]) => (
                <div key={k} className="brain-element">
                  <span className="brain-element-k">{k}</span>
                  <span className="brain-element-v">{v || '—'}</span>
                </div>
              ))}
            </div>
          )}

          {/* v10.41 STEP2-02：每组带序号 + 完成标记，底部按钮文案随完成度变化 */}
          {extract?.questions.map((q, qi) => (
            <div key={q.key} className="brain-question">
              <div className="brain-q-head">
                <span className="brain-q-num">
                  {['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'][qi] ?? `(${qi + 1})`}
                </span>
                <span className="brain-q-label">{ANSWER_LABEL[q.key] ?? q.label}</span>
                <span className="brain-q-text">{q.question}</span>
                <span className={`brain-q-mark ${answers[q.key] ? 'done' : ''}`}>
                  {answers[q.key] ? '✓' : '○'}
                </span>
              </div>
              <div className="brain-options">
                {q.options.map(o => (
                  <button
                    key={o.label}
                    type="button"
                    className={`brain-option ${answers[q.key] === o.label ? 'active' : ''}`}
                    onClick={() =>
                      // v10.41 STEP2-02：再点一下已选中的就取消 —— 否则「还差 N 组」永远到不了
                      setAnswers(a => ({
                        ...a,
                        [q.key]: a[q.key] === o.label ? '' : o.label,
                      }))
                    }
                    title={answers[q.key] === o.label ? '再点一下取消选择' : '选中它'}
                  >
                    <span className="brain-option-label">{o.label}</span>
                    {o.detail && <span className="brain-option-detail">{o.detail}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {info && <p className="wb-warn">{info}</p>}

        <div className="brain-nav">
          <button className="ghost-btn" onClick={() => { setStep(1); setInfo('') }}>
            ← 改脑洞
          </button>
          <button
            className={`primary-btn ${understood === 'ok' && answeredAll ? '' : 'weak'}`}
            onClick={runAllLayers}
            disabled={understood !== 'ok'}
            title={understood !== 'ok' ? '先确认上面 AI 的理解' : '没选满也能开始，AI 会用默认值补'}
          >
            {understood !== 'ok'
              ? '先确认上面的理解 ↑'
              : answeredAll
                ? '就这些，开始搭框架 →'
                : `还差 ${leftCount} 组，也可以直接开始 →`}
          </button>
        </div>
      </section>
      {/* ================= 步骤 3：分层自动生长 ================= */}
      <section className="wb-block" hidden={step !== 3}>
        <h2 className="brain-h2">AI 正在一层一层把故事长出来</h2>
        <p className="wb-desc">
          每长出一层，对应的画布就自动填好了。你什么都不用做，等它长完就行。
        </p>

        <div className="ws-row" style={{ marginBottom: 10 }}>
          <WebSearchToggle
            checked={webSearch}
            onChange={setWebSearch}
            disabled={runningLayer !== 0}
            hint="开启后，四层生长与最后生成章节清单时，AI 都会先联网检索同类型（同题材 / 同风格）的优秀作品作参考，让选项和章节划分更扎实；默认关闭，纯凭你的脑洞生长"
          />
        </div>

        <div className="brain-progress">
          {LAYER_META.map(m => {
            const hasData = Boolean(layers[m.layer - 1])
            const failed = Boolean(layerErr[m.layer])
            const done = hasData && !failed
            const running = runningLayer === m.layer
            const waiting = !hasData && !running && !failed
            return (
              <div
                key={m.layer}
                className={`brain-layer ${done ? 'done' : ''} ${running ? 'running' : ''} ${failed ? 'failed' : ''}`}
              >
                <div className="brain-layer-head">
                  <span className="brain-layer-no">{done ? '✓' : failed ? '⚠' : m.layer}</span>
                  <span className="brain-layer-title">{m.title}</span>
                  <span className="brain-layer-hint">{m.hint}</span>
                  {running && <span className="brain-layer-spin">生成中…</span>}
                  {/* v10.41 STEP3-01：每层可单独重写，不用全部重来 */}
                  {done && runningLayer === 0 && (
                    <button
                      className="ghost-btn sm"
                      onClick={() => void rerunLayer(m.layer)}
                      title="只重新生成这一层，其他层不动"
                    >
                      ↻ 重写
                    </button>
                  )}
                </div>

                {running && (
                  <div className="brain-layer-bar">
                    <span />
                  </div>
                )}

                {/* 第一层：3 版一句话梗概，可切换 */}
                {m.layer === 1 && (layers[0]?.variants?.length ?? 0) > 0 && (
                  <div className="brain-variants">
                    {layers[0].variants.map((v, i) => (
                      <button
                        key={i}
                        type="button"
                        className={`brain-variant ${chosenVariant === v ? 'active' : ''}`}
                        onClick={() => pickVariant(v)}
                        disabled={runningLayer !== 0}
                      >
                        <span className="brain-variant-no">版本 {i + 1}</span>
                        <span className="brain-variant-text">{v}</span>
                      </button>
                    ))}
                    <p className="wb-hint">点其中一个版本就会用它重写第一层，画布跟着更新。</p>
                  </div>
                )}

                {hasData && (layers[m.layer - 1]?.display?.length ?? 0) > 0 && (
                  <ul className="brain-layer-body">
                    {layers[m.layer - 1].display.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                )}

                {hasData && Object.keys(layers[m.layer - 1].canvasPatch).length > 0 && (
                  <p className="brain-layer-patch">
                    已写入画布：
                    {Object.keys(layers[m.layer - 1].canvasPatch).map(d => (
                      <span key={d} className="brain-patch-tag">
                        {d}
                      </span>
                    ))}
                  </p>
                )}

                {/* v10.41 STEP3-03：单层失败 —— 局部重试或跳过，不阻塞其他层 */}
                {failed && (
                  <div className="brain-layer-fail">
                    <p className="brain-layer-fail-title">{m.title} 生成失败</p>
                    <p className="brain-layer-fail-msg">{layerErr[m.layer]}</p>
                    <div className="brain-layer-fail-btns">
                      <button className="ghost-btn sm" onClick={() => void rerunLayer(m.layer)}>
                        重试这一层
                      </button>
                      <button
                        className="ghost-btn sm"
                        onClick={() => {
                          setLayerErr(prev => {
                            const next = { ...prev }
                            delete next[m.layer]
                            return next
                          })
                          void growFrom(m.layer + 1)
                        }}
                      >
                        跳过这层，继续下一层
                      </button>
                    </div>
                  </div>
                )}

                {waiting && <p className="brain-layer-wait">等待中…</p>}

                {waiting && progress === m.layer - 1 && runningLayer === 0 && (
                  <button className="ghost-btn sm" onClick={() => void rerunLayer(m.layer)}>
                    ▶️ 生成这一层
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {info && <p className={info.startsWith('❌') ? 'wb-warn' : 'wb-ok'}>{info}</p>}

        <ReferenceList references={references} />

        {progress >= 4 && !imported && runningLayer === 0 && (
          <p className="wb-hint" style={{ marginTop: 10 }}>
            四层都长完了，7 块画布已填好。点「确认生成」会生成章节清单并存入作品库；也可以先跳过去微调画布再回来生成。
          </p>
        )}

        {/* v10.29 篇幅体量选择：必须在「确认生成」之前定 —— 章节清单就是按它生成的 */}
        {progress >= 4 && !imported && (
          <div className="brain-scale">
            <div className="brain-scale-head">
              <span className="brain-scale-title">篇幅体量</span>
              <span className="wb-hint">
                先定体量再点「确认生成」—— 它决定接下来拆成多少章、每章大概多少字
              </span>
            </div>
            <div className="brain-scale-opts">
              {SCALES.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className={`brain-scale-opt ${scale === s.id ? 'active' : ''}`}
                  onClick={() => setScale(s.id)}
                  disabled={importing}
                >
                  <span className="brain-scale-name">{s.label}</span>
                  <span className="brain-scale-meta">{s.meta}</span>
                  <span className="brain-scale-desc">{s.desc}</span>
                </button>
              ))}
            </div>
            {/* v10.30 自定义体量：只有选了「自定义字数」才展开输入框 */}
            {scale === 'custom' && (
              <div className="brain-scale-custom">
                <label className="brain-scale-custom-field">
                  <span>全书总字数</span>
                  <input
                    type="number"
                    min={2}
                    max={40}
                    step={0.5}
                    value={customWan}
                    onChange={e => setCustomWan(Number(e.target.value))}
                    disabled={importing}
                  />
                  <span className="brain-scale-custom-unit">万字</span>
                </label>
                <span className="wb-hint">
                  {customWan * 10000 < CUSTOM_MIN || customWan * 10000 > CUSTOM_MAX ? (
                    <b>请填 2–40 万字之间</b>
                  ) : (
                    <>
                      ≈ <b>{estimateCustom(customWan * 10000).chapters}</b> 章 · 每章约{' '}
                      <b>{estimateCustom(customWan * 10000).words}</b> 字（章数按总量自动分，不用你算）
                    </>
                  )}
                </span>
              </div>
            )}
            <p className="wb-hint">
              选完点「确认生成」，章纲会按这个体量拆章；后面想再调，可以在「创作台 · 章节写作」里
              以选中章为基准增删章节。
            </p>
          </div>
        )}

        {imported && (
          <p className="wb-hint" style={{ marginTop: 10 }}>
            本次按
            <b>
              {scale === 'custom'
                ? `自定义体量（${customWan} 万字）`
                : (SCALES.find(s => s.id === scale)?.label ?? scale)}
            </b>
            生成了 {chapterCount} 章清单。
          </p>
        )}

        <div className="brain-nav">
          <button className="ghost-btn" onClick={() => setStep(2)} disabled={runningLayer !== 0}>
            ← 改确认项
          </button>
          <button
            className="primary-btn"
            onClick={() => (imported ? setStep(4) : handleImport())}
            disabled={
              importing ||
              runningLayer !== 0 ||
              progress < 4 ||
              (scale === 'custom' &&
                (customWan * 10000 < CUSTOM_MIN || customWan * 10000 > CUSTOM_MAX))
            }
            title={
              progress < 4
                ? '等四层都长完'
                : imported
                  ? '框架已生成并存入作品库，点这查看完成页'
                  : '确认用这套框架生成章节清单，并存入作品库（生成后可在完成页选择下一步）'
            }
          >
            {importing
              ? '正在生成章节清单…'
              : imported
                ? '已生成 · 查看完成页 →'
                : '确认生成'}
          </button>
        </div>
        {(progress >= 4 || (progress > 0 && runningLayer === 0)) && (
          <button
            className="ghost-btn sm"
            onClick={() => {
              // 框架已长完才算「这一轮结束」，离开时清空流程防止重复导入
              if (progress >= 4) resetFlow()
              onEnterPro()
            }}
            style={{ marginTop: 8 }}
          >
            跳过章节清单，直接去看画布
          </button>
        )}

        {/* v10.41 STEP3-02：等不下去的出口 —— 不让用户被「四层全生成完」卡住 */}
        {progress < 4 && !imported && runningLayer === 0 && (
          <p className="brain-skip">
            不想等了？
            <button className="brain-skip-link" onClick={() => void handleImport()}>
              跳过，我自己在工作台调
            </button>
            <span className="wb-hint">
              （已生成的层会照常填进画布，没生成的留空 —— 你可以在工作台里自己补）
            </span>
          </p>
        )}
      </section>

      {/* ================= 步骤 4：完成 ================= */}
      <section className="wb-block" hidden={step !== 4}>
        <h2 className="brain-h2">框架搭好了</h2>
        <p className="wb-desc">
          7 块画布已经全部填好
          {bookTitle ? `，并生成了《${bookTitle}》的 ${chapterCount} 章清单` : ''}。
        </p>
        <div className="brain-done">
          <div className="brain-done-item">
            <span>画布</span>
            <strong>7 / 7 已填充</strong>
          </div>
          <div className="brain-done-item">
            <span>章节清单</span>
            <strong>{chapterCount ? `${chapterCount} 章 · 已存入作品库` : '未生成'}</strong>
          </div>
        </div>
        <p className="wb-desc">
          接下来你可以：去「多画布」微调设定，或到「创作台 · 章节写作」直接开始写正文。
        </p>
        <div className="brain-nav">
          <button className="ghost-btn" onClick={() => setStep(3)}>
            ← 回看框架
          </button>
          <button
            className="primary-btn brain-cta"
            onClick={() => {
              // v10.27：带上这次生成的书 id，创作台会自动选中它（画布结果同步到创作台）
              onEnterPro(createdBookId ?? undefined)
              // 生成完一次就整个清空：下次进来是干净的步骤1，不会再导出重复的书
              resetFlow()
            }}
          >
            进入高级画布精修
          </button>
        </div>
        <button className="ghost-btn sm" onClick={resetFlow} style={{ marginTop: 8 }}>
          不进工作台了，清空重写一个新脑洞
        </button>
      </section>
    </div>
  )
}
