// Cloudflare Worker · 作家模拟器 LLM 代理（v3.1 · 错误诊断加固）
// 入口：POST /，body = { action: "analyze" | "generate", ...args }
// 返回：{ ok: true, data, searched, searchCount } | { ok: false, error, version }
// GET /：返回 { ok: true, version, model, status } 用于确认线上版本
// 环境变量：DEEPSEEK_API_KEY

const VERSION = '4.1'
const API = 'https://api.deepseek.com/responses'
const MODEL = 'deepseek-v4-flash'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
const ok = (data, searched, searchCount) => jsonResp({ ok: true, data, searched, searchCount })
const err = (message, status = 400) => jsonResp({ ok: false, error: message, version: VERSION }, status)

// —— 鲁棒错误字符串化：万一抛出来的是非 Error，也能给出可读消息 ——
function safeStr(e) {
  if (e == null) return 'null/undefined'
  if (typeof e === 'string') return e
  if (e instanceof Error) return `${e.constructor.name}: ${e.message}`
  try {
    const j = JSON.stringify(e)
    if (j && j !== '{}' && j !== 'null') return `Non-Error (${typeof e}): ${j.slice(0, 400)}`
  } catch {}
  return `Unknown (${typeof e}): ${String(e)}`
}

// ── 从 Responses API 的响应里抠出正文 ──
// 坑1：output_text 经常是 null，真正的正文藏在 output[].content[].text
function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text
  }
  const items = Array.isArray(data.output) ? data.output : []
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it?.type === 'message' && Array.isArray(it.content)) {
      for (const part of it.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
          return part.text
        }
      }
    }
  }
  return ''
}

// ── 把任意结构压成纯字符串（修坑2、坑3：模型爱返回数组/嵌套对象）──
function toStr(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(toStr).filter(Boolean).join('；')
  if (typeof v === 'object') {
    return Object.entries(v)
      .map(([k, val]) => `${k}：${toStr(val)}`)
      .filter(Boolean)
      .join('\n')
  }
  return String(v)
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text)
  } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('模型未返回 JSON：' + text.slice(0, 200))
    return JSON.parse(m[0])
  }
}

async function callDeepSeek(env, { instructions, input, maxOutputTokens, useSearch = true }) {
  const body = {
    model: MODEL,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
  }
  // generate 主要依据 7 块画布写书，不需要联网；其他动作（dissect/revise/continue）启用 web_search
  if (useSearch) {
    body.tools = [{ type: 'web_search' }]
    body.tool_choice = 'auto'
  }
  const resp = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    throw new Error(`DeepSeek ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  }

  const data = await resp.json()
  if (data.status === 'failed') throw new Error('DeepSeek failed: ' + JSON.stringify(data.error))

  const text = extractOutputText(data)
  if (!text) {
    throw new Error(
      data.status === 'incomplete'
        ? '响应被截断（max_output_tokens 不够），请调大额度'
        : 'DeepSeek 返回为空'
    )
  }

  const items = Array.isArray(data.output) ? data.output : []
  const searchCount = items.filter(i => i?.type === 'web_search_call').length

  return { parsed: parseJsonLoose(text), searched: searchCount > 0, searchCount }
}

const ANALYZE_SYSTEM = `你是文学分析助手。请先用 web_search 联网检索该作品的真实资料，再针对用户指定的维度做分析。

严格返回如下 JSON，三个字段都必须是**纯字符串**：
{
  "source": "作品名（纯文字，如「凡人修仙传」，禁止写 URL 或来源列表）",
  "features": "该维度的核心特征，2-4 句中文",
  "examples": "具体例证或典型场景，1-3 句中文"
}

硬性要求：
- 三个字段都必须是字符串，禁止嵌套对象、禁止数组
- source 只写作品名，不要把搜索到的网址塞进去
- 检索不到可靠资料时，features 明确写「未检索到可靠资料」，不要编造`

const GENERATE_SYSTEM = `你是小说创作助手。基于用户提供的 7 块画布（设定/人物/文笔/结构/篇幅/情节/节奏）合成一本完整的小说方案。
如需外部资料（如某类题材的惯例），可用 web_search 检索；但主要依据画布内容创作。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "title": "书名（4-8 字）",
  "synopsis": "简介（150-300 字，涵盖设定、人物、核心冲突）",
  "outline": [
    { "index": 1, "title": "章名", "summary": "一句话摘要", "tag": "开局|推进|高潮|反转|收束", "words": 10000 }
  ],
  "sampleChapter": {
    "title": "第一章 章名",
    "content": "样章正文（500-1000 字，必须按【文笔】画布的风格写）",
    "beat": "本段情节依据（1 句话，引用【情节】画布）"
  },
  "stats": {
    "totalWords": 180000,
    "chapters": 18,
    "volumes": 3,
    "styleLabel": "文笔风格标签（≤20 字）",
    "anchorSources": []
  }
}
要求：
- 所有字符串字段都是纯字符串，禁止嵌套对象/数组（anchorSources 除外，它是字符串数组）
- outline 章节数与【结构】画布一致（默认 18 章/3 卷），按【节奏】画布打 tag
- sampleChapter.content 严格遵循【文笔】画布的语气、句法、意象
- 人物姓名与关系用【人物】画布里的，世界观名词用【设定】画布里的
- 禁止编造画布里没有的设定`

// ── 工作台：把一段原文拆成 7 个维度 ──
const DIMENSIONS = ['设定', '人物', '文笔', '结构', '篇幅', '情节', '节奏']

const DISSECT_SYSTEM = `你是文本拆解专家。把用户给的一段小说原文，按 7 个维度拆解分析。

严格返回 JSON（不要解释、不要 markdown 包裹），七个键必须齐全：
{
  "设定": "世界观、时代背景、特殊规则的分析（80-150字）",
  "人物": "主要人物姓名、身份、关系网的分析（80-150字）",
  "文笔": "语气、句法、修辞风格的分析（80-150字）",
  "结构": "章节组织、叙事顺序、视角的分析（80-150字）",
  "篇幅": "文本长度、节奏分布、详略安排的分析（80-150字）",
  "情节": "主线冲突、因果链条、悬念设置的分析（80-150字）",
  "节奏": "张力曲线、高潮分布、快慢交替的分析（80-150字）"
}
要求：
- 七个键一个都不能少，值都是纯字符串
- 必须基于文本实际内容分析，不要泛泛而谈的空话
- 某个维度在文本里没体现，就明确写"文本未体现此维度"，不要编造`

const REVISE_SYSTEM = `你是文稿润色编辑。根据用户提供的「原文」和「修改要求」（来自 7 个画布的设定），对原文进行修改。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "revised": "修改后的完整文本",
  "changes": ["改动说明1", "改动说明2"]
}
要求：
- revised 必须是修改后的完整文本，不是片段、不是摘要
- 严格遵循【文笔】画布描述的语气、句法、意象
- 保留原文的核心情节与人物，只改表达，不要另起炉灶
- changes 列出 3-5 条主要改动说明`

const CONTINUE_SYSTEM = `你是小说续写助手。根据用户提供的「已有文本」和「续写要求」（来自 7 个画布的设定），续写正文。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "continuation": "续写的正文（600-1200字）",
  "rationale": "为什么这样续写（1-3 句，说明依据了哪些画布设定）"
}
要求：
- 延续已有文本的人物姓名、说话口吻、世界观设定
- 严格遵循【文笔】画布的语气与句法
- 按【情节】画布推进主线，按【节奏】画布控制张力
- 不要复述或重复已有内容，直接接着往下写`

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    if (request.method === 'GET') {
      // 版本探活：方便确认线上跑的到底是哪版
      return jsonResp({ ok: true, version: VERSION, model: MODEL, status: 'running' })
    }
    if (request.method !== 'POST') return err('POST only', 405)
    if (!env.DEEPSEEK_API_KEY) return err('Server missing DEEPSEEK_API_KEY', 500)

    let body
    try {
      body = await request.json()
    } catch {
      return err('Invalid JSON body')
    }

    try {
      if (body.action === 'analyze') {
        const { book, dimension } = body
        if (!book || !dimension) return err('需要 book 和 dimension')
        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: ANALYZE_SYSTEM,
          input: `请先联网检索《${book}》的资料，然后分析它的「${dimension}」维度。`,
          maxOutputTokens: 16000, // 推理 + 多次搜索 + 正文，要给足
        })
        return ok(
          { source: toStr(parsed.source) || book, features: toStr(parsed.features), examples: toStr(parsed.examples) },
          searched,
          searchCount,
        )
      }

      if (body.action === 'generate') {
        if (!body.canvases) return err('需要 canvases')
        const compact = Object.entries(body.canvases)
          .map(([k, v]) => `【${k}】\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
          .join('\n\n')
        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: GENERATE_SYSTEM,
          input: `画布内容如下：\n\n${compact}`,
          maxOutputTokens: 32000,
          useSearch: false, // generate 依据 7 画布写书，关联网反而拖慢、易超时
        })
        // 归一化：outline 数组保留（UI 要渲染列表），其余字段压成字符串
        return ok(
          {
            title: toStr(parsed.title) || '未命名',
            synopsis: toStr(parsed.synopsis),
            outline: Array.isArray(parsed.outline)
              ? parsed.outline.map((c, i) => ({
                  index: Number(c?.index) || i + 1,
                  title: toStr(c?.title) || `第 ${i + 1} 章`,
                  summary: toStr(c?.summary),
                  tag: ['开局', '推进', '高潮', '反转', '收束'].includes(toStr(c?.tag)) ? toStr(c?.tag) : '推进',
                  words: Number(c?.words) || 10000,
                }))
              : [],
            sampleChapter: {
              title: toStr(parsed.sampleChapter?.title) || '第一章',
              content: toStr(parsed.sampleChapter?.content),
              beat: toStr(parsed.sampleChapter?.beat),
            },
            stats: {
              totalWords: Number(parsed.stats?.totalWords) || 180000,
              chapters: Number(parsed.stats?.chapters) || 18,
              volumes: Number(parsed.stats?.volumes) || 3,
              styleLabel: toStr(parsed.stats?.styleLabel) || '未标注',
              anchorSources: Array.isArray(parsed.stats?.anchorSources)
                ? parsed.stats.anchorSources.map(toStr).filter(Boolean)
                : [],
            },
          },
          searched,
          searchCount,
        )
      }

      // —— 工作台 1：拆解原文到 7 个维度 ——
      if (body.action === 'dissect') {
        if (!body.text) return err('需要 text')
        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: DISSECT_SYSTEM,
          input: `请拆解分析下面这段小说原文：\n\n${body.text}`,
          maxOutputTokens: 16000,
        })
        // 只保留 7 个维度键，值统一压成字符串
        const dims = {}
        for (const d of DIMENSIONS) {
          dims[d] = toStr(parsed[d]) || '文本未体现此维度'
        }
        return ok(dims, searched, searchCount)
      }

      // —— 工作台 2：按画布设定修改原文 ——
      if (body.action === 'revise') {
        if (!body.text) return err('需要 text')
        const canvases = body.canvases || {}
        const compact = Object.entries(canvases)
          .map(([k, v]) => `【${k}】\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
          .join('\n\n')
        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: REVISE_SYSTEM,
          input: `【原文】\n${body.text}\n\n【修改要求（来自 7 个画布）】\n${compact}`,
          maxOutputTokens: 20000,
        })
        return ok(
          {
            revised: toStr(parsed.revised),
            changes: Array.isArray(parsed.changes)
              ? parsed.changes.map(toStr).filter(Boolean)
              : [],
          },
          searched,
          searchCount,
        )
      }

      // —— 工作台 3：按画布设定续写 ——
      if (body.action === 'continue') {
        if (!body.text) return err('需要 text')
        const canvases = body.canvases || {}
        const compact = Object.entries(canvases)
          .map(([k, v]) => `【${k}】\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
          .join('\n\n')
        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: CONTINUE_SYSTEM,
          input: `【已有文本】\n${body.text}\n\n【续写要求（来自 7 个画布）】\n${compact}`,
          maxOutputTokens: 20000,
        })
        return ok(
          {
            continuation: toStr(parsed.continuation),
            rationale: toStr(parsed.rationale),
          },
          searched,
          searchCount,
        )
      }

      return err(`未知 action: ${body.action}`)
    } catch (e) {
      // 打印到 Cloudflare Workers 日志，用户可以在控制台 Logs 标签页看到
      console.error(`[Worker ${VERSION}] 处理失败:`, e, '| book=', body?.book, '| dim=', body?.dimension)
      return jsonResp({
        ok: false,
        error: safeStr(e),
        version: VERSION,
        book: body?.book,
        dimension: body?.dimension,
      }, 500)
    }
  },
}
