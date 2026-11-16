// ============================================================
// worker-fc-gateway.js —— Function Call 搜索安全网关（变体A）
//
// 流水线：验签 → Schema校验 → PII拦截 → 限流 → 搜索 → 清洗 → 审计
//
// 与本项目文档的两个适配（都在 README 里写明）：
//   1. 用文档附录 B 的**手写 Schema 校验**替代 Joi —— 网关零依赖，
//      部署体积小、冷启动快，校验强度等价（只允许 search({query})、禁额外字段、长度上限）。
//   2. 签名加入**时间戳防重放**（X-Internal-Timestamp，允许 ±300 秒）——
//      文档第 2 节的安全原则要求"即使中转层被攻破也无法绕过签名"，
//      而纯 HMAC 是可比重放的；加时间戳后，抓到的请求 5 分钟后自动失效。
//      校验窗口可用 REPLAY_WINDOW_SEC 调整，设为 0 可关闭（不建议）。
// ============================================================

const MAX_ROUND = 3 // 单会话兜底上限（与中转层一致）
const MAX_QUERY_LEN = 200 // 搜索词最大长度
const MAX_RESULTS = 4 // 最多返回条数
const MAX_CONTENT_LEN = 800 // 单条摘要最大长度
const SEARCH_TIMEOUT_MS = 5000 // 搜索接口硬超时
const COUNTER_TTL = 3600 // 会话计数保留秒数

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // 健康检查（不需要签名，方便上线自检）
    if (url.pathname === '/' && request.method === 'GET') {
      return json({
        ok: true,
        service: 'fc-gateway',
        version: 1,
        provider: searchProvider(env),
        // 免费搜索源（wiki/ddg）不需要密钥 → configured 直接为 true
        configured: searchReady(env),
        needsKey: providerNeedsKey(env),
      })
    }

    if (url.pathname === '/api/fc-search' && request.method === 'POST') {
      return handleFcSearch(request, env)
    }
    return json({ ok: false, error: 'route not found' }, 404)
  },
}

async function handleFcSearch(request, env) {
  const payloadRaw = await request.text()

  // ---------- Step 0：HMAC 验签 + 时间戳防重放，拒绝外部直接调用 ----------
  const sig = request.headers.get('X-Internal-Signature')
  const tsHeader = request.headers.get('X-Internal-Timestamp') || ''
  if (!sig || !env.INTERNAL_SECRET) {
    return json({ ok: false, error: 'signature invalid' }, 403)
  }
  const window = Number(env.REPLAY_WINDOW_SEC ?? 300)
  const ts = Number(tsHeader)
  if (window > 0 && (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > window)) {
    return json({ ok: false, error: 'signature expired' }, 403)
  }
  const signedRaw = `${tsHeader}.${payloadRaw}`
  if (!(await verifySignature(env.INTERNAL_SECRET, signedRaw, sig))) {
    return json({ ok: false, error: 'signature invalid' }, 403)
  }

  let payload
  try {
    payload = JSON.parse(payloadRaw)
  } catch {
    return json({ ok: false, error: 'invalid payload json' }, 400)
  }
  const { sessionId, userId, functionCall } = payload || {}
  if (!sessionId || typeof sessionId !== 'string') {
    return json({ ok: false, error: 'sessionId required' }, 400)
  }

  // ---------- Step 1：Schema 强校验（只允许 search，禁止额外字段） ----------
  const validated = validateSearch(functionCall)
  if (!validated.ok) {
    await writeAudit(env, { sessionId, userId, action: 'FC_INVALID_SCHEMA', reason: validated.error })
    return json({ ok: false, error: `functionCall schema invalid: ${validated.error}` }, 400)
  }
  const rawQuery = validated.query

  // ---------- Step 2：PII 检测，命中直接拦截 ----------
  if (detectPII(rawQuery)) {
    await writeAudit(env, { sessionId, userId, action: 'FC_PII_BLOCK', query: maskQuery(rawQuery) })
    return json({ ok: false, error: '搜索内容包含敏感个人信息，已禁止联网搜索，请调整后重试' }, 403)
  }

  // ---------- Step 3：兜底限流（KV 持久化，网关独立计数） ----------
  const cntKey = `gwcnt:${sessionId}`
  const count = await getCount(env, cntKey)
  if (count >= MAX_ROUND) {
    await writeAudit(env, { sessionId, userId, action: 'FC_ROUND_LIMIT' })
    return json({ ok: false, error: '本轮对话搜索次数已达上限' }, 429)
  }
  await incr(env, cntKey, COUNTER_TTL)

  // ---------- Step 4：调用第三方搜索 ----------
  if (!searchReady(env)) {
    // 明确区分"没配密钥"和"搜索服务挂了"，否则上线自检会误判
    await writeAudit(env, { sessionId, userId, action: 'FC_NOT_CONFIGURED' })
    return json({ ok: false, error: '搜索服务尚未配置（缺少服务商 API Key）' }, 503)
  }

  let searchData
  try {
    searchData = await callSearchProvider(env, rawQuery)
  } catch (err) {
    await writeAudit(env, { sessionId, userId, action: 'FC_SEARCH_ERROR', error: String(err && err.message) })
    return json({ ok: false, error: '搜索服务暂时不可用' }, 502)
  }

  // ---------- Step 5：结果清洗（防间接提示注入 + 截断超长文本） ----------
  const cleaned = cleanResults(searchData)

  // ---------- Step 6：审计日志（脱敏 query，不存结果全文） ----------
  await writeAudit(env, {
    sessionId,
    userId,
    action: 'FC_SEARCH_SUCCESS',
    query: maskQuery(rawQuery),
    resultCount: cleaned.length,
  })

  return json({ ok: true, toolResult: { query: rawQuery, results: cleaned } }, 200)
}

/* ============================ Step 1：Schema 校验（附录 B） ============================ */

export function validateSearch(fc) {
  if (!fc || typeof fc !== 'object' || Array.isArray(fc)) return { ok: false, error: 'fc required' }
  if (fc.name !== 'search') return { ok: false, error: 'only search allowed' }

  const args = fc.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'arguments object required' }
  }
  const keys = Object.keys(args)
  if (keys.length !== 1 || keys[0] !== 'query') {
    return { ok: false, error: 'only query field allowed' }
  }
  if (typeof args.query !== 'string' || args.query.length === 0) {
    return { ok: false, error: 'query must be non-empty string' }
  }
  if (args.query.length > MAX_QUERY_LEN) {
    return { ok: false, error: `query too long (max ${MAX_QUERY_LEN})` }
  }
  return { ok: true, query: args.query }
}

/* ============================ Step 2：PII 检测 ============================ */

/**
 * 先做归一化（去掉空格/连字符/点，全角转半角），否则
 * "138-1234-5678"、"110101 1990 0101 1234" 这类写法会漏检。
 */
export function normalizeForPII(text) {
  return String(text)
    .replace(/[\s\-_.·]/g, '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

export function detectPII(text) {
  const raw = String(text || '')
  const t = normalizeForPII(raw)
  if (!t) return false

  // 邮箱必须在**原始串**上判：归一化会去掉 "."，导致 zhangsan@example.com 变成
  // zhangsan@examplecom 而漏检 —— 那正好是最该拦的隐私泄露路径。
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(raw)) return true

  const rules = [
    /1[3-9]\d{9}/, // 手机号（11 位）
    /[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]/, // 身份证（18 位）
    /[1-9]\d{14}(\d{2}[\dXx])?/, // 旧版 15 位
    /\d{16,19}/, // 银行卡（16-19 位连续数字）
  ]
  return rules.some(r => r.test(t))
}

/** 审计里不留可还原的敏感串：手机号/邮箱打码，长数字只留尾 4 位 */
export function maskQuery(q) {
  let s = String(q).slice(0, 120)
  s = s.replace(/(1[3-9]\d)\d{4}(\d{4})/g, '$1****$2')
  s = s.replace(/([\w.+-]{1,2})[\w.+-]*@([\w-]+\.[\w.-]+)/g, '$1***@$2')
  s = s.replace(/\d{8,}/g, m => `${'*'.repeat(m.length - 4)}${m.slice(-4)}`)
  return s
}

/* ============================ Step 4：搜索服务商 ============================ */

function searchProvider(env) {
  // free（默认）= 维基百科 + DuckDuckGo 组合，**不需要任何密钥、不按次计费**
  // 也可选：wiki / ddg / tavily / bing
  return String(env.SEARCH_PROVIDER || 'free').toLowerCase()
}

/** 只有商业搜索服务商才需要密钥；免费源不需要 */
function providerNeedsKey(env) {
  const p = searchProvider(env)
  return p === 'tavily' || p === 'bing'
}

function searchKey(env) {
  const p = searchProvider(env)
  if (p === 'bing') return env.BING_SEARCH_KEY || ''
  return env.TAVILY_API_KEY || ''
}

/** 搜索源是否就绪：免费源永远就绪 */
function searchReady(env) {
  return providerNeedsKey(env) ? Boolean(searchKey(env)) : true
}

async function callSearchProvider(env, query) {
  const provider = searchProvider(env)

  // 免费链路：维基百科优先（权威、稳定、无需密钥），查不到再兜 DuckDuckGo
  if (provider === 'free') {
    const wiki = await searchWikipedia(query)
    if (wiki.length) return wiki
    const ddg = await searchDuckDuckGo(query)
    return ddg
  }
  if (provider === 'wiki') return searchWikipedia(query)
  if (provider === 'ddg') return searchDuckDuckGo(query)

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS)
  try {
    if (provider === 'bing') {
      const u = new URL('https://api.bing.microsoft.com/v7.0/search')
      u.searchParams.set('q', query)
      u.searchParams.set('count', String(MAX_RESULTS))
      u.searchParams.set('mkt', env.BING_MARKET || 'zh-CN')
      const resp = await fetch(u.toString(), {
        headers: { 'Ocp-Apim-Subscription-Key': searchKey(env) },
        signal: ac.signal,
      })
      if (!resp.ok) throw new Error(`bing ${resp.status}`)
      const data = await resp.json()
      return (data.webPages?.value || []).slice(0, MAX_RESULTS).map(it => ({
        title: it.name,
        url: it.url,
        content: it.snippet || '',
      }))
    }

    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: searchKey(env),
        query,
        max_results: MAX_RESULTS,
        search_depth: 'basic',
      }),
      signal: ac.signal,
    })
    if (!resp.ok) throw new Error(`tavily ${resp.status}`)
    const data = await resp.json()
    return data.results || []
  } finally {
    clearTimeout(timer)
  }
}

/* ============================ 免费搜索源（无需密钥、不按次计费） ============================ */

/**
 * 维基百科：官方公开 API，无需密钥，适合"事实类"查证（人名/年份/事件/作品）。
 * 做法：先 search 拿标题，再 extracts 拿摘要 —— 两条请求但都极轻。
 * 局限：只覆盖百科条目，查不到时效性新闻（这是它能"永远免费"的原因）。
 */
export async function searchWikipedia(query, lang) {
  const host = lang || 'zh'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS)
  try {
    const listUrl = new URL(`https://${host}.wikipedia.org/w/api.php`)
    listUrl.searchParams.set('action', 'query')
    listUrl.searchParams.set('list', 'search')
    listUrl.searchParams.set('srsearch', query)
    listUrl.searchParams.set('srlimit', String(MAX_RESULTS))
    listUrl.searchParams.set('format', 'json')
    listUrl.searchParams.set('utf8', '1')
    listUrl.searchParams.set('origin', '*')

    const listResp = await fetch(listUrl.toString(), {
      headers: { 'User-Agent': 'writer-simulator-fc/1.0 (fact check)' },
      signal: ac.signal,
    })
    if (!listResp.ok) throw new Error(`wiki list ${listResp.status}`)
    const listData = await listResp.json()
    const hits = listData?.query?.search || []
    if (!hits.length) return []

    // 取摘要：一次拿多条（exintro 只要导言，token 友好）
    const titles = hits.map(h => h.title).join('|')
    const exUrl = new URL(`https://${host}.wikipedia.org/w/api.php`)
    exUrl.searchParams.set('action', 'query')
    exUrl.searchParams.set('prop', 'extracts')
    exUrl.searchParams.set('exintro', '1')
    exUrl.searchParams.set('explaintext', '1')
    exUrl.searchParams.set('titles', titles)
    exUrl.searchParams.set('format', 'json')
    exUrl.searchParams.set('utf8', '1')
    exUrl.searchParams.set('origin', '*')

    const exResp = await fetch(exUrl.toString(), {
      headers: { 'User-Agent': 'writer-simulator-fc/1.0 (fact check)' },
      signal: ac.signal,
    })
    const exData = exResp.ok ? await exResp.json() : null
    const pages = exData?.query?.pages || {}

    return hits.slice(0, MAX_RESULTS).map(h => {
      const page = Object.values(pages).find(p => p.title === h.title)
      const extract = String(page?.extract || h.snippet || '')
        .replace(/<[^>]+>/g, '')
        .trim()
      return {
        title: h.title,
        url: `https://${host}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
        content: extract,
        source: 'wikipedia',
      }
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * DuckDuckGo HTML 版：无密钥、无账号。
 * ⚠️ 它是**尽力而为**：DDG 可能给 Cloudflare 出口 IP 限流或改版，
 * 所以这里任何失败都返回空数组，由上层告诉模型"未查到"，绝不编造。
 */
export async function searchDuckDuckGo(query) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS)
  try {
    const u = new URL('https://html.duckduckgo.com/html/')
    u.searchParams.set('q', query)
    const resp = await fetch(u.toString(), {
      headers: {
        // 不带 UA 会被直接拒
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: ac.signal,
    })
    if (!resp.ok) return []
    const html = await resp.text()

    const results = []
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m
    while ((m = re.exec(html)) && results.length < MAX_RESULTS) {
      // ⚠️ href 里的分隔符是 `&amp;rut=`（HTML 实体），必须先还原实体再切，
      //    否则还原出来的 URL 会带着 "&amp;rut=..." 尾巴。
      const href = m[1].replace(/&amp;/g, '&')
      let url = href.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&rut=')[0]
      try {
        url = decodeURIComponent(url)
      } catch {
        /* 编码不合法就保持原样 */
      }
      const title = stripTags(m[2])
      const content = stripTags(m[3])
      if (!url.startsWith('http')) continue
      results.push({ title, url, content, source: 'duckduckgo' })
    }
    return results
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/* ============================ Step 5：结果清洗 ============================ */

/** 常见间接提示注入标记（第三方网页里藏指令，试图劫持模型） */
const INJECTION_MARKERS = [
  '<<<system prompt>>>',
  '<<SYSTEM>>',
  '<|im_start|>',
  '<|system|>',
  '###system###',
  'ignore previous instructions',
  'ignore all previous instructions',
  'disregard previous instructions',
  '忽略前面所有指令',
  '忽略以上所有指令',
  '忽略之前的指令',
  '你现在是',
  'system prompt 如下',
]

export function cleanText(text) {
  let content = String(text || '')
  // 注意：不要用 content.includes(marker) 做预检查 —— 那是区分大小写的，
  // 而替换用的是 gi；"Ignore previous instructions"（首字母大写）会被预检查漏掉，
  // 结果就是最该洗的那句没洗。直接 replace（无匹配时是空操作）。
  for (const marker of INJECTION_MARKERS) {
    const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    content = content.replace(re, '[filtered]')
  }
  if (content.length > MAX_CONTENT_LEN) {
    content = `${content.slice(0, MAX_CONTENT_LEN)}...`
  }
  return content
}

export function cleanResults(results) {
  const list = Array.isArray(results) ? results : []
  return list.slice(0, MAX_RESULTS).map(item => ({
    title: String(item?.title || '').slice(0, 200),
    url: String(item?.url || ''),
    content: cleanText(item?.content),
    // 保留来源标记，方便模型判断可信度（wikipedia / duckduckgo / tavily / bing）
    ...(item?.source ? { source: String(item.source) } : {}),
  }))
}

/* ============================ Step 0：HMAC 验签 ============================ */

async function verifySignature(secret, raw, sig) {
  try {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0))
    return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(raw))
  } catch {
    return false
  }
}

/* ============================ Step 6：审计日志 ============================ */

async function writeAudit(env, obj) {
  if (!env.FC_AUDIT_LOG) return
  const key = `audit:${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    await env.FC_AUDIT_LOG.put(key, JSON.stringify({ ts: new Date().toISOString(), ...obj }))
  } catch {
    /* 审计写失败不影响主流程（但要能看见日志） */
    console.error('audit write failed', obj)
  }
}

/* ============================ KV 计数 ============================ */

async function getCount(env, key) {
  const raw = await env.FC_SESSION_COUNTER.get(key)
  return raw ? parseInt(raw, 10) || 0 : 0
}

async function incr(env, key, ttl) {
  const cur = await getCount(env, key)
  await env.FC_SESSION_COUNTER.put(key, String(cur + 1), { expirationTtl: ttl })
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
