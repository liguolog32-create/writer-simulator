import { useEffect, useState } from 'react'
import { useApp } from '../store/AppContext'
import {
  toScriptLLM,
  scriptSpecLLM,
  scriptOutlineLLM,
  scriptLineToText,
  scriptSceneHead,
  scriptNovelAnalyzeLLM,
  scriptDevelopLLM,
  scriptAssetsLLM,
  scriptStoryboardLLM,
  scriptVideoPromptsLLM,
  scriptReviewLLM,
  scriptBreakdownLLM,
  type ScriptResult,
  type ScriptEpisode,
  type ScriptScene,
  type ScriptSpec,
  type ScriptOutline,
  type ScriptOutlineEpisode,
  type ScriptNovelAnalyze,
  type ScriptDevelop,
  type ScriptAssets,
  type ScriptStoryboard,
  type ScriptVideoPrompts,
  type ScriptReview,
  type ScriptBreakdown,
  type ReviewIssue,
  type ReviewSeverity,
} from '../lib/llmClient'
import {
  buildDramaBundle,
  renderAssetsMarkdown,
  renderStoryboardMarkdown,
  renderImagePromptsMarkdown,
  renderVideoPromptsMarkdown,
} from '../lib/dramaExport'
import { DIMENSIONS } from '../data/textDissect'
import { ChapterTextReader } from './ChapterTextReader'
import type { TextChapter } from '../lib/textChapters'
import type { SavedBook } from '../types'

const PLATFORMS = ['通用', '抖音', '快手', '红果短剧', '微信短剧', '番茄短剧']
/** v18.8：快捷档位仍在，但集数/时长改成可自由输入的数字框 */
const EP_PRESETS = [8, 12, 30, 60, 100, 150, 200, 250]
const SEC_PRESETS = [60, 90, 120, 180]
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/** 1 → 一、12 → 十二；更大的数字按中文读法拼出来 */
export function cnNum(n: number): string {
  if (CN_NUM[n]) return CN_NUM[n]
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '')
  if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '')
  const h = Math.floor(n / 100)
  const rest = n % 100
  if (!rest) return d[h] + '百'
  if (rest < 10) return d[h] + '百零' + d[rest]
  return d[h] + '百' + (rest < 20 ? cnNum(rest) : cnNum(rest))
}

/** 模型常把「第1集」写进标题里，UI 已经单独显示集号，这里去掉避免重复 */
function cleanEpTitle(t: string): string {
  return (t || '').replace(/^\s*第\s*[\d一二三四五六七八九十]+\s*集\s*[·:：\-\s]*/, '').trim() || '（未命名）'
}

/** 单场戏按行业标准格式渲染成纯文本 */
function sceneToText(sc: ScriptScene): string[] {
  const out: string[] = []
  out.push(scriptSceneHead(sc))
  if (sc.cast.length) out.push(`人物：${sc.cast.join('、')}`)
  for (const l of sc.lines) out.push(scriptLineToText(l))
  const cam = [sc.camera, sc.transition].filter(Boolean).join('　')
  if (cam) out.push(`〔镜头〕${cam}`)
  return out
}

/** 单集渲染成纯文本 */
function episodeToText(ep: ScriptEpisode): string[] {
  const out: string[] = [`第${cnNum(ep.index)}集` + (ep.title ? `　${cleanEpTitle(ep.title)}` : '')]
  if (ep.hook) out.push(`〔本集钩子〕${ep.hook}`)
  for (const sc of ep.scenes) {
    out.push('')
    out.push(...sceneToText(sc))
  }
  if (ep.cliffhanger) {
    out.push('')
    out.push(`〔本集结尾悬念〕${ep.cliffhanger}`)
  }
  return out
}

/** 把结构化剧本拼成符合短剧交付格式的 Markdown */
export function scriptToMarkdown(s: ScriptResult): string {
  const lines: string[] = []
  lines.push(`# ${s.title}`)
  if (s.genre) lines.push(`类型：${s.genre}`)
  if (s.tags.length) lines.push(`标签：${s.tags.join(' + ')}`)
  if (s.castLine) lines.push(`人设：${s.castLine}`)
  if (s.logline) lines.push(`卖点：${s.logline}`)
  lines.push('')
  if (s.platformTip) {
    lines.push(`平台提示：${s.platformTip}`)
    lines.push('')
  }
  if (s.characters.length) {
    lines.push('## 人物')
    for (const c of s.characters) {
      lines.push(`- **${c.name}**（${c.identity}）${c.subtitle ? `　首次出场字幕：${c.subtitle}` : ''}`)
      lines.push(`  - 说话方式：${c.voice}`)
      lines.push(`  - 外形/服化：${c.look}`)
    }
    lines.push('')
  }
  for (const ep of s.episodes) {
    lines.push(`## 第${cnNum(ep.index)}集　${cleanEpTitle(ep.title)}（约 ${ep.durationSec} 秒）`)
    lines.push('')
    if (ep.hook) lines.push(`> 本集钩子：${ep.hook}`)
    for (const sc of ep.scenes) {
      lines.push('')
      lines.push(...sceneToText(sc))
    }
    if (ep.cliffhanger) {
      lines.push('')
      lines.push(`> 本集结尾悬念：${ep.cliffhanger}`)
    }
    lines.push('')
  }
  if (s.prompts.length) {
    lines.push('## AI 出片提示词')
    for (const p of s.prompts) lines.push(`- **${p.scene}**：${p.prompt}`)
    lines.push('')
  }
  if (s.notes.length) {
    lines.push('## 改编说明')
    for (const n of s.notes) lines.push(`- ${n}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 渲染剧本正文里的一行（△动作 / 台词 / VO / OS / 字幕） */
function ScriptLineView({ l }: { l: ScriptScene['lines'][number] }) {
  if (l.kind === 'beat') return <p className="sl-beat">△{l.text}</p>
  if (l.kind === 'sub') {
    const t = l.text.startsWith('【') || l.text.startsWith('△') ? l.text : `【${l.text}】`
    return <p className="sl-sub">{t}</p>
  }
  if (l.kind === 'vo')
    return (
      <p className="sl-line">
        <span className="sl-spk">{l.speaker}VO</span>
        <span className="sl-colon">：</span>
        {l.text}
      </p>
    )
  if (l.kind === 'os')
    return (
      <p className="sl-line sl-os">
        <span className="sl-spk sl-spk-os">{l.speaker}OS</span>
        <span className="sl-colon">：</span>
        {l.text}
      </p>
    )
  return (
    <p className="sl-line">
      <span className="sl-spk">{l.speaker}</span>
      <span className="sl-colon">：</span>
      {l.emotion && <span className="sl-emo">（{l.emotion}）</span>}
      {l.text}
    </p>
  )
}

/** 审查问题严重度：后端 high/medium/low → 中文标签 */
const SEVERITY_CN: Record<ReviewSeverity, string> = { high: '高', medium: '中', low: '低' }

/** 一组审查问题（结构 / 剧情 / 连戏共用） */
function ReviewIssueList({ items, empty }: { items: ReviewIssue[]; empty: string }) {
  if (!items.length) return <p className="drama-muted">{empty}</p>
  return (
    <ul className="drama-issues">
      {items.map((it, i) => (
        <li key={i} className={`drama-issue drama-sev-${it.severity}`}>
          <span className="drama-sev-tag">{SEVERITY_CN[it.severity] ?? it.severity}</span>
          <div>
            <p>{it.issue}</p>
            <p className="drama-issue-sug">建议：{it.suggestion}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * 短剧剧本：把自己写的正文改写成能直接拍的 AI 短剧剧本。
 * 挂在「创作台」第 4 个 tab（与散稿加工共用同一份原文框）。
 */
export function ScriptStudio({
  text,
  onTextChange,
}: {
  text: string
  onTextChange: (v: string) => void
}) {
  const { state, saveBook } = useApp()
  const [episodes, setEpisodes] = useState(100)
  const [secPerEp, setSecPerEp] = useState(90)
  const [platform, setPlatform] = useState('通用')
  const [styleNote, setStyleNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [result, setResult] = useState<ScriptResult | null>(null)
  /** v18.8 新增状态 */
  const [spec, setSpec] = useState<ScriptSpec | null>(null)
  const [outline, setOutline] = useState<ScriptOutline | null>(null)
  const [batchSize, setBatchSize] = useState(8)
  const [busyOutline, setBusyOutline] = useState(false)
  const [writingRange, setWritingRange] = useState('')
  /** 已生成的正文批次：区间起点 -> 剧本结果 */
  const [batches, setBatches] = useState<Record<number, ScriptResult>>({})
  /** 结果区当前查看的集：'all' 或集号。生成后默认落在第 1 集 */
  const [activeEp, setActiveEp] = useState<number | 'all'>('all')
  /** 章节阅读器里当前停在哪一章（切「全文」时为 null） */
  const [scopedChapter, setScopedChapter] = useState<TextChapter | null>(null)
  /** 只把当前这一章送去改编 */
  const [onlyChapter, setOnlyChapter] = useState(false)

  /** drama-skills 迁移：七项新能力各自的结果与进行中状态 */
  const [novelAnalyze, setNovelAnalyze] = useState<ScriptNovelAnalyze | null>(null)
  const [develop, setDevelop] = useState<ScriptDevelop | null>(null)
  const [assets, setAssets] = useState<ScriptAssets | null>(null)
  const [storyboard, setStoryboard] = useState<ScriptStoryboard | null>(null)
  const [videoPrompts, setVideoPrompts] = useState<ScriptVideoPrompts | null>(null)
  const [review, setReview] = useState<ScriptReview | null>(null)
  const [breakdown, setBreakdown] = useState<ScriptBreakdown | null>(null)
  const [busyNovelAnalyze, setBusyNovelAnalyze] = useState(false)
  const [busyDevelop, setBusyDevelop] = useState(false)
  const [busyAssets, setBusyAssets] = useState(false)
  const [busyStoryboard, setBusyStoryboard] = useState(false)
  const [busyVideoPrompts, setBusyVideoPrompts] = useState(false)
  const [busyReview, setBusyReview] = useState(false)
  const [busyBreakdown, setBusyBreakdown] = useState(false)
  /** 对标剧文本：供「对标拆解」使用，独立于要改编的正文 */
  const [benchmarkText, setBenchmarkText] = useState('')

  const canvases = Object.fromEntries(
    Object.values(state.canvases).map(c => [c.dimension, c.content]),
  ) as Record<string, string>
  const hasCanvas = DIMENSIONS.some(d => (canvases[d] || '').trim())

  /** 实际送去改编的正文 */
  const sourceText = onlyChapter && scopedChapter ? scopedChapter.content : text

  // 切换集数下拉时，若已生成的结果集数不匹配，提示需要重新生成
  const epMismatch = !!result && result.settings.episodes !== episodes

  // 结果换了一份就重置到第 1 集
  useEffect(() => {
    if (result) setActiveEp(result.episodes[0]?.index ?? 'all')
  }, [result])

  /** 联网抓网络短剧剧本规格，按原文长度匹配集数 × 单集时长 */
  const matchSpec = async () => {
    const body = sourceText.trim()
    if (!body) {
      setMsg('先贴一段要改编的正文，再点匹配规格')
      return
    }
    setBusy(true)
    setMsg('正在联网核对网络短剧剧本规格…')
    try {
      const { data } = await scriptSpecLLM({ text: body, platform })
      setSpec(data)
      setEpisodes(data.episodes)
      setSecPerEp(data.secPerEp)
      const src = data.market?.sources?.length
        ? `；联网核对 ${data.market.sources.length} 个来源`
        : ''
      setMsg(`✅ 匹配结果：${data.episodes} 集 × ${data.secPerEp} 秒（${data.basis}${src}）`)
    } catch (e) {
      setMsg(`❌ 规格匹配失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 一次生成全本分集大纲（100-250 集只要纲要，不写正文） */
  const makeOutline = async () => {
    const body = sourceText.trim()
    if (!body) {
      setMsg('先贴一段要改编的正文')
      return
    }
    setBusyOutline(true)
    setMsg(`正在生成 ${episodes} 集全本大纲…（只要纲要，不写正文）`)
    try {
      const { data } = await scriptOutlineLLM({
        text: body, canvases, episodes, secPerEp, platform, styleNote,
      })
      setOutline(data)
      setResult(null)
      setBatches({})
      setMsg(`✅ 全本大纲已生成：${data.episodes.length} 集，六幕 ${data.acts.map(a => a.act).join('→') || '未标注'}`)
    } catch (e) {
      setMsg(`❌ 大纲生成失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyOutline(false)
    }
  }

  /** 按区间写一批完整正文；不传 start 就写第 1 批 */
  const run = async (start?: number) => {
    const body = sourceText.trim()
    if (!body) {
      setMsg('先贴一段要改编的正文')
      return
    }
    const s = start ?? 1
    const e = Math.min(episodes, s + batchSize - 1)
    setBusy(true)
    setWritingRange(`${s}-${e}`)
    setMsg(`正在写第 ${s}-${e} 集完整正文…`)
    try {
      const { data } = await toScriptLLM({
        text: body,
        canvases,
        episodes,
        secPerEp,
        platform,
        styleNote,
        rangeStart: s,
        batchSize: e - s + 1,
        outline: outline?.episodes,
      })
      setBatches(prev => ({ ...prev, [s]: data }))
      setResult(data)
      setMsg(`✅ 第 ${data.episodes[0]?.index ?? s}-${data.episodes[data.episodes.length - 1]?.index ?? e} 集正文已生成（全本 ${episodes} 集中的一批）`)
    } catch (err) {
      setMsg(`❌ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
      setWritingRange('')
    }
  }

  /** 把大纲 + 已生成的各批正文合成一份完整 Markdown */
  const fullScriptMarkdown = (): string => {
    if (!outline) return result ? scriptToMarkdown(result) : ''
    const lines: string[] = [`# ${outline.title}`, `类型：${outline.genre || '短剧'}`, `卖点：${outline.logline || ''}`,
      `规格：${episodes} 集 × ${secPerEp} 秒 · ${platform}`, '']
    if (outline.acts.length) {
      lines.push('## 六幕结构')
      for (const a of outline.acts) lines.push(`- ${a.act}（${a.from}-${a.to} 集）${a.goal}`)
      lines.push('')
    }
    const done = Object.keys(batches).map(Number).sort((a, b) => a - b)
    for (const ep of outline.episodes) {
      lines.push(`## 第${cnNum(ep.index)}集　${ep.title}（约 ${ep.durationSec} 秒）`)
      lines.push(`> 钩子：${ep.hook}`)
      lines.push(`> 冲突：${ep.conflict}　反转：${ep.twist}`)
      lines.push(`> 结尾悬念：${ep.cliffhanger}`)
      const owner = done.find(s => {
        const eps = batches[s].episodes
        const last = eps[eps.length - 1]?.index ?? s
        return ep.index >= s && ep.index <= last
      })
      const written = owner ? batches[owner].episodes.find(x => x.index === ep.index) : null
      if (written) {
        lines.push('')
        for (const sc of written.scenes) lines.push(...sceneToText(sc))
      } else {
        lines.push('', '（本集正文尚未生成）')
      }
      lines.push('')
    }
    if (outline.notes.length) {
      lines.push('## 改编说明')
      for (const n of outline.notes) lines.push(`- ${n}`)
    }
    return lines.join('\n')
  }

  const copyMd = async () => {
    if (!result && !outline) return
    const md = fullScriptMarkdown()
    try {
      await navigator.clipboard.writeText(md)
      setMsg('剧本已复制到剪贴板')
    } catch {
      setMsg('复制失败，请手动选中复制')
    }
  }

  const downloadMd = () => {
    if (!result && !outline) return
    const md = fullScriptMarkdown()
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${outline?.title || result?.title || '短剧剧本'}（${episodes}集）.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const saveToLibrary = () => {
    if (!result && !outline) return
    const md = fullScriptMarkdown()
    const words = md.replace(/\s/g, '').length
    const eps: ScriptOutlineEpisode[] = outline?.episodes ?? result!.episodes.map(e => ({
      index: e.index, title: e.title, hook: e.hook, conflict: '', twist: '',
      cliffhanger: e.cliffhanger, act: '', durationSec: e.durationSec,
    }))
    const book: SavedBook = {
      id: `script-${Date.now().toString(36)}`,
      title: `${outline?.title || result!.title}（短剧剧本）`,
      synopsis: outline?.logline || result!.logline || 'AI 短剧剧本',
      outline: eps.map((ep, i) => ({
        index: ep.index || i + 1,
        title: ep.title,
        summary: [ep.hook, ep.conflict, ep.twist, ep.cliffhanger].filter(Boolean).join(' / '),
        tag: (['起', '困', '反', '升', '爽', '合'].includes(ep.act)
          ? ({ 起: '开局', 困: '推进', 反: '反转', 升: '高潮', 爽: '高潮', 合: '收束' } as const)[ep.act as '起' | '困' | '反' | '升' | '爽' | '合']
          : i === 0 ? '开局' : i === eps.length - 1 ? '收束' : i % 3 === 0 ? '反转' : '推进'),
        words: Math.round(words / Math.max(1, eps.length)),
      })),
      sampleChapter: {
        title: `第${cnNum(eps[0]?.index || 1)}集 · ${eps[0]?.title || ''}`,
        content: md,
        beat: eps[0]?.hook || '',
      },
      stats: {
        totalWords: words,
        chapters: eps.length,
        volumes: 1,
        styleLabel: `${platform} · ${episodes}集 × ${secPerEp}秒`,
        anchorSources: [],
      },
      searched: false,
      searchCount: 0,
      usedFallback: false,
      engine: 'deepseek',
      createdAt: new Date().toLocaleString('zh-CN'),
    }
    saveBook(book)
    setMsg('已存入作品库（可在「章节写作」里继续精修）')
  }

  /** 单项能力统一执行：失败只清空本能力结果，不碰 result / batches / 其它能力 */
  const runDramaTask = async <T,>(
    setBusyFlag: (v: boolean) => void,
    setData: (v: T | null) => void,
    label: string,
    task: () => Promise<{ data: T }>,
    ok: (data: T) => string,
  ) => {
    setBusyFlag(true)
    setMsg(`正在${label}…（最长 5 分钟，请耐心等）`)
    try {
      const { data } = await task()
      setData(data)
      setMsg(`✅ ${ok(data)}`)
    } catch (e) {
      setData(null)
      setMsg(`❌ ${label}失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyFlag(false)
    }
  }

  /** 📖 原著快评 */
  const runNovelAnalyze = () => {
    const body = sourceText.trim()
    if (!body) { setMsg('先贴一段原著正文，再做快评'); return }
    return runDramaTask(
      setBusyNovelAnalyze, setNovelAnalyze, '原著快评',
      () => scriptNovelAnalyzeLLM({ text: body, platform }),
      d => `原著快评完成：${d.chapters.length} 章 · ${d.rhythm.acts.length} 幕`,
    )
  }

  /** 🎬 改编方案 */
  const runDevelop = () => {
    const body = sourceText.trim()
    if (!body) { setMsg('先贴一段要改编的正文'); return }
    return runDramaTask(
      setBusyDevelop, setDevelop, '改编方案',
      () => scriptDevelopLLM({
        text: body, canvases, episodes, secPerEp, platform,
        outline: outline?.episodes, styleNote,
      }),
      d => `改编方案完成：${d.episodePlans.length} 集执行计划 · ${d.hookHandbook.length} 种钩子`,
    )
  }

  /** 🎨 视觉设定：优先用 result，否则取最新一批正文 */
  const runAssets = () => {
    const latestKey = Object.keys(batches).map(Number).sort((a, b) => b - a)[0]
    const script = result ?? (latestKey !== undefined ? batches[latestKey] : null)
    if (!script) { setMsg('先写正文，再做视觉设定'); return }
    return runDramaTask(
      setBusyAssets, setAssets, '视觉设定',
      () => scriptAssetsLLM({ script, styleNote }),
      d => `视觉设定完成：${d.characters.length} 位人物 · ${d.locations.length} 处地点`,
    )
  }

  /** 🎥 拆分镜 */
  const runStoryboard = () => {
    if (!result) { setMsg('先写正文，再拆分镜'); return }
    return runDramaTask(
      setBusyStoryboard, setStoryboard, '分镜',
      () => scriptStoryboardLLM({ script: result, assets: assets ?? undefined, styleNote }),
      d => `分镜完成：共 ${d.shots.length} 镜${d.uncoveredScenes.length ? `，${d.uncoveredScenes.length} 场未覆盖` : ''}`,
    )
  }

  /** 💬 视频提示词 */
  const runVideoPrompts = () => {
    if (!storyboard) { setMsg('先拆分镜，再生成视频提示词'); return }
    return runDramaTask(
      setBusyVideoPrompts, setVideoPrompts, '视频提示词',
      () => scriptVideoPromptsLLM({ storyboard, assets: assets ?? undefined, styleNote }),
      d => `视频提示词完成：${d.shots.length} 镜 · ${d.groups.length} 组合生`,
    )
  }

  /** 🔍 剧情审查 */
  const runReview = () => {
    if (!result && !outline && !assets && !storyboard && !videoPrompts) {
      setMsg('先写正文或产出设定/分镜，再做剧情审查'); return
    }
    return runDramaTask(
      setBusyReview, setReview, '剧情审查',
      () => scriptReviewLLM({
        script: result ?? (outline ? fullScriptMarkdown() : undefined),
        assets: assets ?? undefined,
        storyboard: storyboard ?? undefined,
        videoPrompts: videoPrompts ?? undefined,
      }),
      d => `剧情审查完成：评分 ${d.score} · ${d.structural.length + d.plot.length + d.continuity.length} 条问题`,
    )
  }

  /** ⚖️ 对标拆解 */
  const runBreakdown = () => {
    const body = benchmarkText.trim()
    if (!body) { setMsg('先在「对标剧文本」里贴一段对标剧正文'); return }
    return runDramaTask(
      setBusyBreakdown, setBreakdown, '对标拆解',
      () => scriptBreakdownLLM({ text: body, platform }),
      d => `对标拆解完成：${d.beats.length} 个节奏点 · ${d.reverseOutline.length} 集反推大纲`,
    )
  }

  /** 五份文档齐全才真正下载；不全时列出缺项 */
  const bundleReady = !!fullScriptMarkdown() && !!assets && !!storyboard && !!videoPrompts
  const downloadDramaBundle = () => {
    const md = fullScriptMarkdown()
    const missing: string[] = []
    if (!md) missing.push('剧本')
    if (!assets) missing.push('视觉设定')
    if (!storyboard) missing.push('分镜、图片提示词')
    if (!videoPrompts) missing.push('视频提示词')
    if (missing.length) {
      setMsg(`还缺 ${missing.join('、')}，五份齐全后才能导出 ZIP`)
      return
    }
    const blob = buildDramaBundle({
      剧本: md,
      视觉设定: renderAssetsMarkdown(assets!),
      分镜: renderStoryboardMarkdown(storyboard!),
      图片提示词: renderImagePromptsMarkdown(storyboard!, assets ?? undefined),
      视频提示词: renderVideoPromptsMarkdown(videoPrompts!),
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${outline?.title || result?.title || '短剧'}·五份文档.zip`
    a.click()
    URL.revokeObjectURL(url)
    setMsg('✅ 五份文档已打包下载：剧本 / 视觉设定 / 分镜 / 图片提示词 / 视频提示词')
  }

  const shown: ScriptEpisode[] =
    !result ? [] : activeEp === 'all' ? result.episodes : result.episodes.filter(e => e.index === activeEp)

  return (
    <div className="script-studio">
      <p className="wb-desc">
        把你写好的正文改写成**符合短剧行业交付格式、可直接开拍**的竖屏 AI 短剧剧本：按「集-场」编号，
        每场标题 + 人物表，正文用 △动作 / 台词 / 括号表演提示 / VO画外音 / OS内心独白 / 【字幕】六种行写。
        会顺带读取 7 块画布的设定。
      </p>

      <div className="script-settings">
        <label className="script-field">
          <span>集数（可自定义 1–400）</span>
          <input
            type="number"
            min={1}
            max={400}
            value={episodes}
            onChange={e => setEpisodes(Math.max(1, Math.min(400, Number(e.target.value) || 1)))}
          />
        </label>
        <label className="script-field">
          <span>单集时长 / 秒（可自定义 30–900）</span>
          <input
            type="number"
            min={30}
            max={900}
            step={10}
            value={secPerEp}
            onChange={e => setSecPerEp(Math.max(30, Math.min(900, Number(e.target.value) || 30)))}
          />
        </label>
        <label className="script-field">
          <span>每批写几集</span>
          <input
            type="number"
            min={1}
            max={12}
            value={batchSize}
            onChange={e => setBatchSize(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
          />
        </label>
        <label className="script-field">
          <span>平台</span>
          <select value={platform} onChange={e => setPlatform(e.target.value)}>
            {PLATFORMS.map(p => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="script-field grow">
          <span>补充要求（可选）</span>
          <input
            placeholder="例：女主台词要更狠；不要旁白；保留结尾反转"
            value={styleNote}
            onChange={e => setStyleNote(e.target.value)}
          />
        </label>
      </div>

      <div className="script-presets">
        <span>集数快捷：</span>
        {EP_PRESETS.map(n => (
          <button key={n} className={episodes === n ? 'chip on' : 'chip'} onClick={() => setEpisodes(n)}>
            {n}
          </button>
        ))}
        <span className="script-presets-sep">时长：</span>
        {SEC_PRESETS.map(n => (
          <button key={n} className={secPerEp === n ? 'chip on' : 'chip'} onClick={() => setSecPerEp(n)}>
            {n}s
          </button>
        ))}
      </div>
      <p className="script-scope-hint">
        网络短剧规格基准：竖屏单集 60–120 秒 / 550–800 字，主流 60–100 集，长线剧 100–250 集；
        3 秒钩子、30 秒冲突、六幕式（起-困-反-升-爽-合）。
      </p>

      <label className="script-label">要改编的正文</label>
      <ChapterTextReader
        text={text}
        onChange={onTextChange}
        rows={14}
        idPrefix="script"
        placeholder="粘贴你的小说正文、某一章或一段散稿…（在上方「作品」里选书会自动载入；长文会自动按章拆开）"
        onActiveChapterChange={setScopedChapter}
        footer={ch =>
          ch ? (
            <label className="ct-scope">
              <input
                type="checkbox"
                checked={onlyChapter}
                onChange={e => setOnlyChapter(e.target.checked)}
              />
              只改编当前这一章（{ch.title} · {ch.words} 字）
            </label>
          ) : null
        }
      />
      <p className="script-scope-hint">
        将改编：
        {onlyChapter && scopedChapter
          ? `${scopedChapter.title}（${scopedChapter.words} 字）`
          : `全部正文（${text.replace(/\s/g, '').length} 字）`}
      </p>

      <div className="script-actions">
        <button className="ghost-btn" onClick={matchSpec} disabled={busy || !sourceText.trim()}>
          {busy && !writingRange ? '联网匹配中…' : '🌐 按原文匹配集数/时长'}
        </button>
        <button className="ghost-btn" onClick={makeOutline} disabled={busyOutline || busy || !sourceText.trim()}>
          {busyOutline ? '大纲生成中…' : `📋 生成全本大纲（${episodes} 集）`}
        </button>
        <button className="primary-btn" onClick={() => run()} disabled={busy || busyOutline || !sourceText.trim()}>
          {busy ? `写正文中…${writingRange ? `第 ${writingRange} 集` : ''}` : `写正文（第 1-${Math.min(episodes, batchSize)} 集）`}
        </button>
        {(result || outline) && (
          <>
            <button className="ghost-btn" onClick={copyMd}>
              复制剧本
            </button>
            <button className="ghost-btn" onClick={downloadMd}>
              📄 下载当前剧本.md
            </button>
            <button className="ghost-btn" onClick={saveToLibrary}>
              存入作品库
            </button>
          </>
        )}
        <button className="ghost-btn" onClick={runNovelAnalyze} disabled={busyNovelAnalyze || !sourceText.trim()}>
          {busyNovelAnalyze ? '快评中…' : '📖 原著快评'}
        </button>
        <button className="ghost-btn" onClick={runDevelop} disabled={busyDevelop || !sourceText.trim()}>
          {busyDevelop ? '改编方案中…' : '🎬 改编方案'}
        </button>
        <button className="ghost-btn" onClick={runAssets} disabled={busyAssets || !(result || Object.keys(batches).length)}>
          {busyAssets ? '设定中…' : '🎨 视觉设定'}
        </button>
        <button className="ghost-btn" onClick={runStoryboard} disabled={busyStoryboard || !result}>
          {busyStoryboard ? '拆分镜中…' : '🎥 拆分镜'}
        </button>
        <button className="ghost-btn" onClick={runVideoPrompts} disabled={busyVideoPrompts || !storyboard}>
          {busyVideoPrompts ? '提示词中…' : '💬 视频提示词'}
        </button>
        <button
          className="ghost-btn"
          onClick={runReview}
          disabled={busyReview || !(result || outline || assets || storyboard || videoPrompts)}
        >
          {busyReview ? '审查中…' : '🔍 剧情审查'}
        </button>
        <button className="ghost-btn" onClick={runBreakdown} disabled={busyBreakdown || !benchmarkText.trim()}>
          {busyBreakdown ? '拆解中…' : '⚖️ 对标拆解'}
        </button>
      </div>

      <p className="drama-tip">
        剧本按可拍格式写作：对抗场写清谁占上风、破局靠实据；第一拍即钩子；压稿先砍过场水分与嘴碎解释（规则源自 drama-skills，MIT）
      </p>

      <label className="drama-field">
        <span>对标剧文本（供「⚖️ 对标拆解」使用，独立于上面要改编的正文）</span>
        <textarea
          value={benchmarkText}
          onChange={e => setBenchmarkText(e.target.value)}
          rows={3}
          placeholder="粘贴一段对标短剧的正文 / 台词，用来反推它的节奏、钩子与爽点打法…"
        />
      </label>

      <div className="drama-export-bar">
        <button
          className={`ghost-btn ${bundleReady ? '' : 'drama-btn-off'}`}
          onClick={downloadDramaBundle}
          aria-disabled={!bundleReady}
          title={bundleReady ? '打包下载五份 Markdown' : '五份结果齐全后才可导出，点击查看缺项'}
        >
          📦 导出五份文档.zip
        </button>
        <span className="drama-export-hint">
          五份 = 剧本 / 视觉设定 / 分镜 / 图片提示词 / 视频提示词；剧本取自当前正文，其余取自上方各能力结果
        </span>
      </div>

      {msg && <p className={msg.startsWith('❌') ? 'wb-warn' : 'wb-ok'}>{msg}</p>}

      {spec && (
        <div className="script-spec-card">
          <h4>🌐 联网规格匹配结果</h4>
          <div className="spec-big">
            {spec.episodes} 集 <span>×</span> {spec.secPerEp} 秒
          </div>
          <p className="spec-basis">{spec.basis}</p>
          <p className="spec-detail">
            原文 {spec.words} 字 · 每集约 {spec.wordsPerEp} 字 · 平台 {spec.platform} ·
            行业区间 {spec.spec.epRange[0]}–{spec.spec.epRange[1]} 集 / 长线 {spec.spec.longRunRange[0]}–{spec.spec.longRunRange[1]} 集 ·
            单集 {spec.spec.secRange[0]}–{spec.spec.secRange[1]} 秒
          </p>
          {spec.market?.advice && <p className="spec-advice">联网建议：{spec.market.advice}</p>}
          {spec.market?.sources?.length > 0 && (
            <ul className="spec-sources">
              {spec.market.sources.map((s, i) => (
                <li key={i}>{s.name}｜{s.episodes}｜{s.sec}｜{s.words}</li>
              ))}
            </ul>
          )}
          <p className="spec-ref">{spec.reference}</p>
        </div>
      )}

      {outline && (
        <div className="script-outline">
          <h3 className="script-title">
            {outline.title} · 全本分集大纲
            <span className="script-badge">{outline.episodes.length} 集 × {secPerEp} 秒</span>
          </h3>
          {outline.acts.length > 0 && (
            <div className="outline-acts">
              {outline.acts.map((a, i) => (
                <span key={i} className="outline-act">{a.act} {a.from}–{a.to}</span>
              ))}
            </div>
          )}
          <div className="outline-next">
            <button className="primary-btn" onClick={() => run()} disabled={busy}>
              写第 1-{Math.min(episodes, batchSize)} 集正文
            </button>
            {Object.keys(batches).map(Number).sort((a, b) => a - b).map(s => {
              const end = Math.min(episodes, s + batchSize - 1)
              const next = end + 1
              return next <= episodes ? (
                <button key={s} className="ghost-btn" disabled={busy} onClick={() => run(next)}>
                  续写第 {next}-{Math.min(episodes, next + batchSize - 1)} 集
                </button>
              ) : null
            })}
            <span className="outline-progress">
              已写正文 {Object.values(batches).reduce((n, b) => n + b.episodes.length, 0)} / {episodes} 集
            </span>
          </div>
          <div className="outline-grid">
            {outline.episodes.map(ep => {
              const written = Object.values(batches).some(b => b.episodes.some(x => x.index === ep.index))
              return (
                <div key={ep.index} className={`outline-card ${written ? 'written' : ''}`}>
                  <div className="outline-head">
                    <span>第{ep.index}集</span>
                    <b>{ep.title}</b>
                    {ep.act && <span className="outline-act-sm">{ep.act}</span>}
                    {written && <span className="outline-done">已写正文</span>}
                  </div>
                  <p>钩子：{ep.hook}</p>
                  <p>冲突：{ep.conflict}</p>
                  <p>反转：{ep.twist}</p>
                  <p>悬念：{ep.cliffhanger}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── drama-skills 七项新能力，各自独立卡片；对应结果为空则不渲染 ── */}
      {novelAnalyze && (
        <div className="drama-card">
          <h3 className="drama-card-title">
            📖 原著快评
            <span className="script-badge">{novelAnalyze.chapters.length} 章 · {novelAnalyze.rhythm.acts.length} 幕</span>
          </h3>
          <p className="drama-lead">{novelAnalyze.title}｜{novelAnalyze.genre}｜{novelAnalyze.logline}</p>
          {novelAnalyze.tags.length > 0 && <p className="drama-muted">标签：{novelAnalyze.tags.join(' + ')}</p>}
          <div className="drama-sub">章节拆解</div>
          <div className="drama-grid">
            {novelAnalyze.chapters.map((c, i) => (
              <div key={i} className="drama-item">
                <b>第{c.no}章 · {c.title}</b>
                <p>{c.summary}</p>
                {c.characters.length > 0 && <p className="drama-muted">人物：{c.characters.join('、')}</p>}
                {c.hooks.length > 0 && <p className="drama-hook">钩子：{c.hooks.join(' / ')}</p>}
              </div>
            ))}
          </div>
          <div className="drama-sub">节奏</div>
          <div className="drama-acts">
            {novelAnalyze.rhythm.acts.map((a, i) => (
              <span key={i} className="drama-act">{a.act} {a.from}–{a.to}：{a.goal}</span>
            ))}
          </div>
          <p className="drama-muted">{novelAnalyze.rhythm.pacingNote}</p>
          <div className="drama-sub">改编建议</div>
          <ul className="drama-bullets">
            {novelAnalyze.adaptationTips.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
          {novelAnalyze.sources && novelAnalyze.sources.length > 0 && (
            <p className="drama-muted">来源：{novelAnalyze.sources.map(s => s.name).join('、')}</p>
          )}
        </div>
      )}

      {develop && (
        <div className="drama-card">
          <h3 className="drama-card-title">
            🎬 改编方案 · {develop.title}
            <span className="script-badge">{develop.genre || '短剧'}</span>
          </h3>
          <p className="drama-lead">{develop.logline}</p>
          <p className="drama-kv"><b>核心冲突</b>{develop.coreConflict}</p>
          <pre className="drama-pre">改编路径：{develop.adaptationApproach}</pre>
          <pre className="drama-pre">导演阐述：{develop.directorStatement}</pre>
          <div className="drama-sub">钩子手册</div>
          <div className="drama-grid">
            {develop.hookHandbook.map((h, i) => (
              <div key={i} className="drama-item">
                <b>{h.type} · {h.technique}</b>
                <p>{h.example}</p>
              </div>
            ))}
          </div>
          <div className="drama-sub">分集执行计划</div>
          <div className="drama-grid">
            {develop.episodePlans.map(p => (
              <div key={p.index} className="drama-item">
                <b>第{p.index}集 · {p.title}</b>
                <p>目标：{p.goal}</p>
                <ul className="drama-bullets">{p.keyEvents.map((e, i) => <li key={i}>{e}</li>)}</ul>
                <p className="drama-cliff">悬念：{p.cliffhanger}</p>
              </div>
            ))}
          </div>
          <div className="drama-sub">连戏规则</div>
          <ul className="drama-bullets">
            {develop.continuityRules.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {assets && (
        <div className="drama-card">
          <h3 className="drama-card-title">🎨 视觉设定</h3>
          <p className="drama-lead">{assets.productionStyle}</p>
          <p className="drama-muted">时代背景：{assets.eraSetting}</p>
          <div className="drama-sub">人物 / 声线 / 造型 / 生图锚点</div>
          <div className="drama-grid">
            {assets.characters.map((c, i) => (
              <div key={i} className="drama-item">
                <b>{c.name}</b>
                <p>固定外貌：{c.appearance}</p>
                {c.variants.map((v, j) => (
                  <p key={j}>造型 · {v.name}（第 {v.episodes} 集）：{v.appearance}</p>
                ))}
                {c.voice && <p>声线：{c.voice}{c.voiceRef ? `（参考：${c.voiceRef}）` : ''}</p>}
                {c.promptName && <p className="drama-muted">生图锚点：{c.promptName}</p>}
                {c.lockWords.length > 0 && <p className="drama-muted">锁定词：{c.lockWords.join('、')}</p>}
              </div>
            ))}
          </div>
          <div className="drama-sub">地点</div>
          <div className="drama-grid">
            {assets.locations.map((l, i) => (
              <div key={i} className="drama-item">
                <b>{l.name}</b>
                <p>外观：{l.appearance}</p>
                {l.orientation && <p className="drama-muted">朝向 / 机位：{l.orientation}</p>}
              </div>
            ))}
          </div>
          <div className="drama-sub">道具</div>
          <div className="drama-grid">
            {assets.props.map((p, i) => (
              <div key={i} className="drama-item">
                <b>{p.name}</b>
                <p>外观：{p.appearance}</p>
                {p.states.map((s, j) => (
                  <p key={j} className="drama-muted">状态「{s.state}」：{s.from} → {s.to}</p>
                ))}
              </div>
            ))}
          </div>
          <div className="drama-sub">连戏锁</div>
          <ul className="drama-bullets">
            {assets.continuityLocks.map((k, i) => (
              <li key={i}>[{k.id}] {k.label}｜范围：{k.scope}｜锁定词：{k.lockWords.join('、')}</li>
            ))}
          </ul>
        </div>
      )}

      {storyboard && (
        <div className="drama-card">
          <h3 className="drama-card-title">
            🎥 分镜 / 首尾帧
            <span className="script-badge">{storyboard.shots.length} 镜</span>
          </h3>
          <pre className="drama-pre">{storyboard.summary}</pre>
          <div className="drama-shots">
            {storyboard.shots.map((s, i) => (
              <div key={i} className="drama-shot">
                <p className="drama-shot-head">
                  <b>{s.id}</b> · 第{s.episode}集 场{s.sceneNo} · {s.durationSec} 秒
                </p>
                <div className="drama-shot-grid">
                  <span>景别：{s.shotType || '—'}</span>
                  <span>机位：{s.camera || '—'}</span>
                  <span>运镜：{s.movement || '—'}</span>
                  <span>声音：{s.sound || '—'}</span>
                </div>
                <p><b>起帧：</b>{s.startFrame}</p>
                <p><b>动作：</b>{s.action}</p>
                <p><b>落帧：</b>{s.endFrame}</p>
                <p><b>站位：</b>{s.blocking}</p>
                <pre className="drama-pre">首帧提示词：{s.firstFramePrompt}</pre>
                <pre className="drama-pre">尾帧提示词：{s.lastFramePrompt}</pre>
                {s.refImages.length > 0 && <p className="drama-muted">参考图：{s.refImages.join('、')}</p>}
              </div>
            ))}
          </div>
          <div className="drama-sub">未覆盖场景</div>
          <ul className="drama-bullets">
            {storyboard.uncoveredScenes.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </div>
      )}

      {videoPrompts && (
        <div className="drama-card">
          <h3 className="drama-card-title">
            💬 视频提示词
            <span className="script-badge">{videoPrompts.shots.length} 镜 · {videoPrompts.groups.length} 组合生</span>
          </h3>
          <div className="drama-sub">逐镜提示词</div>
          <div className="drama-grid">
            {videoPrompts.shots.map((s, i) => (
              <div key={i} className="drama-item">
                <b>{s.shotId}（{s.durationSec} 秒）</b>
                <pre className="drama-pre">{s.prompt}</pre>
                <p>动作：{s.action}｜运镜：{s.movement}｜机位：{s.camera}</p>
                <p>声音：{s.sound}</p>
                {s.continuityRefs.length > 0 && <p className="drama-muted">连戏引用：{s.continuityRefs.join('、')}</p>}
              </div>
            ))}
          </div>
          <div className="drama-sub">多镜合生（GROUP）</div>
          <div className="drama-grid">
            {videoPrompts.groups.map((g, i) => (
              <div key={i} className="drama-item">
                <b>{g.id}</b>
                <p className="drama-muted">镜头：{g.shotIds.join('、')}</p>
                <pre className="drama-pre">{g.prompt}</pre>
              </div>
            ))}
          </div>
          <div className="drama-sub">配乐表</div>
          <div className="drama-grid">
            {videoPrompts.musicPlan.map((m, i) => (
              <div key={i} className="drama-item">
                <b>第{m.episode}集 · {m.mood}</b>
                <p>{m.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {review && (
        <div className="drama-card">
          <h3 className="drama-card-title">
            🔍 剧情审查
            <span className="script-badge">评分 {review.score}</span>
          </h3>
          <div className="drama-metrics">
            <span className="drama-metric">结构 {review.structural.length} 条</span>
            <span className="drama-metric">剧情 {review.plot.length} 条</span>
            <span className="drama-metric">连戏 {review.continuity.length} 条</span>
          </div>
          <div className="drama-sub">结构问题</div>
          <ReviewIssueList items={review.structural} empty="未发现结构问题" />
          <div className="drama-sub">剧情问题</div>
          <ReviewIssueList items={review.plot} empty="未发现剧情问题" />
          <div className="drama-sub">连戏问题</div>
          <ReviewIssueList items={review.continuity} empty="未发现连戏问题" />
          <div className="drama-sub">优点</div>
          <ul className="drama-bullets">{review.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
          <div className="drama-sub">总评</div>
          <pre className="drama-pre">{review.verdict}</pre>
        </div>
      )}

      {breakdown && (
        <div className="drama-card">
          <h3 className="drama-card-title">⚖️ 对标拆解</h3>
          <div className="drama-metrics">
            <span className="drama-metric">平均单集 {String(breakdown.avgEpisodeSec)} 秒</span>
            <span className="drama-metric">平均单镜 {String(breakdown.avgShotSec)} 秒</span>
            <span className="drama-metric">台词密度 {breakdown.dialogueDensity}</span>
          </div>
          <p className="drama-kv"><b>开头套路</b>{breakdown.openingPattern}</p>
          <p className="drama-kv"><b>结尾套路</b>{breakdown.endingPattern}</p>
          <div className="drama-sub">节奏点</div>
          <div className="drama-grid">
            {breakdown.beats.map((b, i) => (
              <div key={i} className="drama-item">
                <b>{b.position} · {b.type}</b>
                <p>{b.description}</p>
              </div>
            ))}
          </div>
          <div className="drama-sub">可填补的空白</div>
          <ul className="drama-bullets">{breakdown.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
          <div className="drama-sub">反推大纲</div>
          <div className="drama-grid">
            {breakdown.reverseOutline.map((r, i) => (
              <div key={i} className="drama-item">
                <b>第{r.index}集 · {r.title}</b>
                <p>{r.summary}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="script-result">
          <h3 className="script-title">
            {result.title}
            <span className="script-badge">
              {result.settings.episodes} 集 × {result.settings.secPerEp} 秒 · {result.settings.platform}
            </span>
          </h3>

          <div className="script-credits">
            {result.genre && (
              <p className="sb-line">
                <span className="sb-key">类型</span>
                {result.genre}
              </p>
            )}
            {result.tags.length > 0 && (
              <p className="sb-line">
                <span className="sb-key">标签</span>
                {result.tags.join(' + ')}
              </p>
            )}
            {result.castLine && (
              <p className="sb-line">
                <span className="sb-key">人设</span>
                {result.castLine}
              </p>
            )}
            {result.logline && (
              <p className="sb-line">
                <span className="sb-key">卖点</span>
                {result.logline}
              </p>
            )}
          </div>
          {result.platformTip && <p className="script-tip">{result.platformTip}</p>}

          {epMismatch && (
            <p className="wb-warn">
              当前剧本是 {result.settings.episodes} 集，你把集数改成了 {episodes} 集 ——
              点上面的「改编成短剧剧本」重新生成才会按新集数重排。
            </p>
          )}

          {result.characters.length > 0 && (
            <section className="script-sec">
              <h4 className="wb-h4">人物</h4>
              <div className="script-cast">
                {result.characters.map((c, i) => (
                  <div key={i} className="script-cast-card">
                    <p className="cast-name">{c.name}</p>
                    <p className="cast-line">身份：{c.identity}</p>
                    <p className="cast-line">说话：{c.voice}</p>
                    <p className="cast-line">外形：{c.look}</p>
                    {c.subtitle && <p className="cast-line">首场字幕：{c.subtitle}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── 集数切换：点哪一集就看哪一集的剧本 ── */}
          <div className="ep-tabs">
            <span className="ep-tabs-label">集数</span>
            {result.episodes.map(ep => (
              <button
                key={ep.index}
                type="button"
                className={`ep-tab ${activeEp === ep.index ? 'on' : ''}`}
                onClick={() => setActiveEp(ep.index)}
                title={ep.hook || ''}
              >
                第{cnNum(ep.index)}集
              </button>
            ))}
            <button
              type="button"
              className={`ep-tab all ${activeEp === 'all' ? 'on' : ''}`}
              onClick={() => setActiveEp('all')}
            >
              全部（{result.episodes.length}）
            </button>
          </div>

          {shown.map(ep => (
            <section key={ep.index} className="script-ep">
              <h4 className="script-ep-title">
                第{cnNum(ep.index)}集　{cleanEpTitle(ep.title)}
                <span className="script-ep-sec">{ep.durationSec}s</span>
              </h4>
              {ep.hook && <p className="script-hook">本集钩子：{ep.hook}</p>}
              {ep.scenes.map((sc, si) => (
                <div key={si} className="sc-block">
                  <p className="sc-head">{scriptSceneHead(sc)}</p>
                  {sc.cast.length > 0 && <p className="sc-castline">人物：{sc.cast.join('、')}</p>}
                  {sc.lines.map((l, li) => (
                    <ScriptLineView key={li} l={l} />
                  ))}
                  {(sc.camera || sc.transition) && (
                    <p className="sc-cam">
                      {sc.camera}
                      {sc.transition ? `　转场：${sc.transition}` : ''}
                    </p>
                  )}
                </div>
              ))}
              {ep.cliffhanger && <p className="script-cliff">本集结尾悬念：{ep.cliffhanger}</p>}
            </section>
          ))}

          {result.prompts.length > 0 && (
            <section className="script-sec">
              <h4 className="wb-h4">AI 出片提示词（可直接喂给生视频 / 生图模型）</h4>
              <ul className="script-prompts">
                {result.prompts.map((p, i) => (
                  <li key={i}>
                    <span className="prompt-scene">{p.scene}</span>
                    <p className="prompt-text">{p.prompt}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.notes.length > 0 && (
            <section className="script-sec">
              <h4 className="wb-h4">改编说明（删了什么 / 为什么这么改）</h4>
              <ul className="script-notes">
                {result.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
