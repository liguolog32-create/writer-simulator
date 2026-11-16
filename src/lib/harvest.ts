/* ============================================================
   灵感采集 · 多渠道抓取（v10.80）
   ------------------------------------------------------------
   渠道：知乎 / 小红书 / 抖音 / Reddit / X（每个渠道一个独立按钮）
   · 服务端（Worker）抓取，浏览器不受目标站点 CORS 限制
   · 每条结果必带来源链接（url）：改编成书后可溯源
   · Reddit / X 天然提供外文（多语言）资料源；知乎 / 抖音 / 小红书 提供中文源
   · 需要登录态的渠道：Cookie 只存浏览器 localStorage、只随请求发给对应渠道
   ============================================================ */

import { postWorkerData } from './api'

export interface HarvestItem {
  id: string
  title: string
  /** 正文（知乎=热榜摘要/答案正文；Reddit=帖子全文；抖音=话题补充；小红书=笔记正文；X=推文原文） */
  text: string
  author: string
  /** 展示用的互动数据（赞数/热度等） */
  metrics: string
  /** 语料语言标注（zh/en/ru/ja/ko…），组语料时标到每条来源头上 */
  lang: string
  /** 来源链接（硬性要求：改编可溯源） */
  url: string
  /** 单条抓取失败的原因（一条挂不影响其他条） */
  error?: string
}

export interface HarvestResult {
  channel: string
  items: HarvestItem[]
  note: string
}

export interface ChannelConfig {
  key: 'reddit' | 'zhihu' | 'douyin' | 'xhs' | 'x'
  label: string
  /** 按钮下方的一句话说明 */
  desc: string
  /** 输入框 placeholder */
  placeholder: string
  /** 是否需要 Cookie：required=必须；optional=可选增强；none=不需要 */
  needCookie: 'required' | 'optional' | 'none'
  /** Cookie 说明（设置区展示） */
  cookieHint?: string
  /** 请求超时：Reddit 要翻归档库、给长一点 */
  timeoutMs: number
}

export const HARVEST_CHANNELS: ChannelConfig[] = [
  {
    key: 'reddit',
    label: 'Reddit',
    desc: 'r/子版块 + 可选关键词，近 30 天按赞数排序，返回帖子全文（多为英文，也可多语种）。浏览器直抓归档库、服务端兜底，网络慢时翻页可能要一两分钟',
    placeholder: 'r/nosleep（故事版）或 r/nosleep 关键词；常用：r/shortscarystories、r/ProRevenge',
    needCookie: 'none',
    timeoutMs: 150000,
  },
  {
    key: 'zhihu',
    label: '知乎',
    desc: '热榜问题 + 链接；粘贴登录 Cookie（z_c0）可连带抓答案正文',
    placeholder: '留空抓热榜（关键词搜索需登录签名，暂不支持）',
    needCookie: 'optional',
    cookieHint: '浏览器登录知乎 → F12 → Network 任一请求 → Request Headers 里复制整行 Cookie 值（需包含 z_c0）',
    timeoutMs: 90000,
  },
  {
    key: 'douyin',
    label: '抖音',
    desc: '热搜话题榜（话题即灵感种子，附搜索页链接）',
    placeholder: '留空抓热搜榜（App 关键词搜索需签名，暂不支持）',
    needCookie: 'none',
    timeoutMs: 45000,
  },
  {
    key: 'xhs',
    label: '小红书',
    desc: '笔记/分享链接 → 标题 + 正文（需登录 Cookie 破风控）',
    placeholder: '粘贴笔记或分享链接，每行一条（https://www.xiaohongshu.com/explore/… 或 https://xhslink.com/…）',
    needCookie: 'required',
    cookieHint: '浏览器登录 www.xiaohongshu.com → F12 → Application → Cookies → 复制整行 Cookie（需包含 a1 与 web_session）',
    timeoutMs: 90000,
  },
  {
    key: 'x',
    label: 'X',
    desc: '推文链接 → 推文原文（匿名 oEmbed，多语言自动识别）',
    placeholder: '粘贴推文链接，每行一条（https://x.com/用户名/status/编号）',
    needCookie: 'none',
    timeoutMs: 60000,
  },
]

/** 语言标注 → 中文显示名（组语料时写进每条来源头） */
const LANG_LABEL: Record<string, string> = {
  zh: '中文',
  en: '英文',
  ru: '俄文',
  ja: '日文',
  ko: '韩文',
}

export function langLabel(lang: string): string {
  return LANG_LABEL[lang] || lang.toUpperCase() || '原文'
}

/** 渠道 key → 中文名（结果区标题用） */
export const CHANNEL_LABEL: Record<string, string> = {
  reddit: 'Reddit',
  zhihu: '知乎',
  douyin: '抖音',
  xhs: '小红书',
  x: 'X',
}

/** 调 Worker 的 sourceFetch：一个渠道一次请求（未登录也能用，与拆解/生成一致） */
export function fetchSource(
  channel: ChannelConfig['key'],
  query: string,
  opts: { limit?: number; cookie?: string } = {},
): Promise<HarvestResult> {
  const cfg = HARVEST_CHANNELS.find(c => c.key === channel)
  return postWorkerData<HarvestResult>(
    {
      action: 'sourceFetch',
      channel,
      query,
      limit: opts.limit ?? 10,
      cookie: opts.cookie ?? '',
    },
    cfg?.timeoutMs ?? 60000,
  )
}

/* ------------------------------------------------------------
   Reddit 专用：浏览器直抓 Arctic Shift 归档库。
   为什么不走 Worker：归档库架在 Cloudflare 上，Worker 出口（CF→CF）会被
   源站防火墙 522 掉；而它开了 CORS（access-control-allow-origin: *）、
   国内也可直连 —— 浏览器直接分页抓取最稳，Worker 只做兜底。
   ------------------------------------------------------------ */
interface ArcticPost {
  id: string
  title: string
  selftext: string
  author: string
  score: number
  num_comments: number
  permalink: string
  created_utc: number
  stickied?: boolean
}

/** 单页归档抓取：源站偶发 522/超时 → 三次重试 + 20s 超时；三次都挂返回 null（调用方决定断点续扫还是放弃） */
async function arcticPage(u: string): Promise<ArcticPost[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const resp = await fetch(u, { signal: ctrl.signal })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data: ArcticPost[] = (await resp.json())?.data || []
      return data
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)))
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

async function redditViaArchive(query: string, limit: number): Promise<HarvestResult> {
  const m = query.trim().match(/^r\/([A-Za-z0-9_]+)\b\s*(.*)$/i)
  const sub = (m?.[1] ?? '').trim() || (query.trim() && !query.trim().includes(' ') ? query.trim() : 'nosleep')
  const kw = (m?.[2] ?? '').trim().toLowerCase()
  const since = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10)
  let before = new Date(Date.now() + 86400e3).toISOString().slice(0, 10)
  const all: ArcticPost[] = []
  for (let page = 0; page < 15; page++) {
    const u = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(
      sub,
    )}&sort_type=created_utc&sort=desc&limit=100&after=${since}&before=${before}`
    const data = await arcticPage(u)
    if (data === null) {
      // 归档库这会儿不稳：已有存货就断点续扫，一页没有就整体回落 Worker
      if (!all.length) throw new Error('归档库连续三次不可达')
      break
    }
    if (!data.length) break
    all.push(...data)
    const cu = Number(data[data.length - 1]?.created_utc)
    if (!cu) break
    const next = new Date((cu - 1) * 1000).toISOString().slice(0, 19)
    if (next <= since || next >= before) break
    before = next
  }
  let stories = all.filter(
    p =>
      p.selftext &&
      p.selftext !== '[removed]' &&
      p.selftext !== '[deleted]' &&
      p.selftext.length > 400 &&
      !p.stickied,
  )
  if (kw) stories = stories.filter(p => `${p.title}\n${p.selftext}`.toLowerCase().includes(kw))
  stories.sort((a, b) => (b.score || 0) - (a.score || 0))
  const items: HarvestItem[] = stories.slice(0, limit).map(p => ({
    id: String(p.id || ''),
    title: String(p.title || ''),
    text: String(p.selftext || '').slice(0, 20000),
    author: 'u/' + (p.author || ''),
    metrics: `${p.score || 0} 赞 · ${p.num_comments || 0} 评论`,
    lang: harvestLangOf(`${p.title} ${p.selftext}`),
    url: 'https://reddit.com' + (p.permalink || ''),
  }))
  return {
    channel: 'reddit',
    items,
    note: `r/${sub} 近 30 天扫描 ${all.length} 帖 → 入选 ${items.length} 条（按赞数排序）${
      kw ? `，关键词「${kw}」` : ''
    }。Reddit 帖子多为英文/多语种，可直接与中文素材混合拆解改编。`,
  }
}

/** 简易语种判定（与 Worker 同口径） */
function harvestLangOf(t: string): string {
  if (!t) return 'en'
  const n = t.length
  if (((t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length / n) > 0.12) return 'zh'
  if (((t.match(/[\u0400-\u04ff]/g) || []).length / n) > 0.12) return 'ru'
  if (((t.match(/[\u3040-\u30ff]/g) || []).length / n) > 0.08) return 'ja'
  if (((t.match(/[\uac00-\ud7af]/g) || []).length / n) > 0.08) return 'ko'
  return 'en'
}

/** 混合入口：Reddit 浏览器直抓优先（归档库有 CORS），其余渠道走 Worker */
export async function fetchSourceHybrid(
  channel: ChannelConfig['key'],
  query: string,
  opts: { limit?: number; cookie?: string } = {},
): Promise<HarvestResult> {
  if (channel === 'reddit') {
    try {
      return await redditViaArchive(query, opts.limit ?? 10)
    } catch (e) {
      console.warn('浏览器直抓 Reddit 归档失败，回落 Worker 通道：', e)
    }
  }
  return fetchSource(channel, query, opts)
}

/** Cookie 的本地存储键（按渠道隔离，只存浏览器 localStorage） */
export function harvestCookieKey(channel: string): string {
  return `ws_harvest_cookie_${channel}`
}

/** 读渠道 Cookie（localStorage） */
export function loadHarvestCookie(channel: string): string {
  try {
    return localStorage.getItem(harvestCookieKey(channel)) || ''
  } catch {
    return ''
  }
}

/** 存渠道 Cookie（localStorage） */
export function saveHarvestCookie(channel: string, cookie: string): void {
  try {
    if (cookie.trim()) localStorage.setItem(harvestCookieKey(channel), cookie.trim())
    else localStorage.removeItem(harvestCookieKey(channel))
  } catch {
    /* 隐私模式等场景存不上就算了 */
  }
}

/* ------------------------------------------------------------
   多语言语料组装：把勾选的条目拼成「带来源链接头」的拆解原文。
   头里带渠道、语言、作者、互动数据与链接 —— 拆解管线看得见这些元信息，
   改编出的书从原文即可溯源。
   ------------------------------------------------------------ */
/** 把勾选条目组语料（channel 标进每条来源头，可多次抓取后合并调用） */
export function buildCorpus(channel: string, items: HarvestItem[]): string {
  const blocks: string[] = []
  let n = 0
  for (const it of items) {
    if (it.error) continue
    n++
    const chLabel = CHANNEL_LABEL[channel] || '资料'
    const head = [
      `【来源 ${n} · ${chLabel} · ${langLabel(it.lang)}】${it.title}`,
      it.author ? `作者：${it.author}${it.metrics ? `（${it.metrics}）` : ''}` : it.metrics ? `热度：${it.metrics}` : '',
      `来源链接：${it.url}`,
      it.text ? '正文：' : '（本条为话题/标题类素材，无正文）',
    ]
      .filter(Boolean)
      .join('\n')
    blocks.push(`${head}\n${it.text || ''}`)
  }
  if (!n) return ''
  return [
    `以下 ${n} 条资料抓取自不同平台（多语言），请按 7 个维度拆解这些真实素材的写作基因：`,
    '',
    blocks.join('\n\n'),
  ].join('\n')
}
