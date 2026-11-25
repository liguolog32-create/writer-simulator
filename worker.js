// Cloudflare Worker · 作家模拟器 LLM 代理（v3.1 · 错误诊断加固）
// 入口：POST /，body = { action: "analyze" | "generate", ...args }
// 返回：{ ok: true, data, searched, searchCount } | { ok: false, error, version }
// GET /：返回 { ok: true, version, model, status } 用于确认线上版本
// 环境变量：DEEPSEEK_API_KEY

const VERSION = '10.80'
const API = 'https://api.deepseek.com/responses'
const MODEL = 'deepseek-v4-flash'

/* ============================================================
   免费引擎 · Cloudflare Workers AI（v10.17 新增）
   ------------------------------------------------------------
   目的：提供一条「不消耗 DeepSeek token」的写作通道，且它跑在
   Cloudflare 里（用户端零安装、零配置），不是跑在谁的本机上。
   用的是本账号自带的 Workers AI 绑定，每天赠送 10,000 神经元
   （约 $0.11，UTC 0 点重置；超出需 Workers Paid）。

   为什么免费池选这两个（都不需要绑定付款方式）：
   · @cf/zai-org/glm-4.7-flash   智谱，中文母语级，131k 上下文，
     $0.0605/M 输入 + $0.40/M 输出 → 免费额度 ≈ 27 万输出 token/天
   · @cf/qwen/qwen3-30b-a3b-fp8  阿里 MoE，中文强，但上下文仅 32k
   坑：@cf/deepseek-ai/deepseek-v4-flash-0731、kimi-k2.6、glm-5.2
   这些「前沿模型」必须要 Workers Paid 或 AI Gateway 预付额度，
   免费额度调不动 —— 所以别指望免费通道能跑同款 DeepSeek。

   引擎开关怎么传下来：见 fetch() 里的 env 视图（挂在原型链上的
   __engine）。这样 16 个 AI 分支里已有的 callDeepSeek(env, …) 一行
   都不用改就能自动分流，也不用模块级全局变量（那会被同 isolate 的
   并发请求互相覆盖）。
   ============================================================ */
const ENGINE_CLOUD = 'cloud' // 云端 DeepSeek（消耗 API token）
const ENGINE_FREE = 'free' // 免费 Workers AI（每天 10,000 神经元）

const FREE_MODELS = {
  glm: '@cf/zai-org/glm-4.7-flash',
  qwen: '@cf/qwen/qwen3-30b-a3b-fp8',
}
const DEFAULT_FREE_MODEL = FREE_MODELS.glm

/** 免费引擎的读图通道（GLM/Qwen 都是纯文本模型，读图只能另找） */
const FREE_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct'

/** 归一化引擎名：只认 'free'；老客户端不传 engine → 一律按云端，行为不变 */
function normEngine(v) {
  return v === ENGINE_FREE ? ENGINE_FREE : ENGINE_CLOUD
}

/** 本次用哪个免费模型：前端传 key（glm/qwen）或完整 model id 都认，认不出就回默认 */
function resolveFreeModel(env) {
  const want = toStr(env.__freeModel)
  if (want && FREE_MODELS[want]) return FREE_MODELS[want]
  if (want && Object.values(FREE_MODELS).includes(want)) return want
  return DEFAULT_FREE_MODEL
}

/** 判断异常是不是「额度用完 / 需付费」这类，好翻成人能看懂的提示 */
function isQuotaError(msg) {
  return /neuron|quota|limit|exceed|rate|429|402|payment|billing|insufficient|capacity|unavailable/i.test(
    msg,
  )
}

/** Workers AI 各模型返回形状不统一，这里统一抠出正文 */
function extractChatText(data) {
  if (!data) return ''
  if (typeof data === 'string') return data.trim()
  const choice = Array.isArray(data.choices) ? data.choices[0] : null
  const msg = choice && choice.message
  if (msg) {
    if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim()
    if (Array.isArray(msg.content)) {
      const t = msg.content
        .filter(c => c && (c.type === 'text' || c.type === undefined))
        .map(c => c.text || '')
        .join('\n')
        .trim()
      if (t) return t
    }
  }
  if (choice && typeof choice.text === 'string' && choice.text.trim()) return choice.text.trim()
  if (typeof data.response === 'string' && data.response.trim()) return data.response.trim()
  return ''
}

/** 把免费引擎的异常翻译成「能看懂 + 知道下一步点哪」的话 */
function freeError(e, model) {
  const msg = safeStr(e)
  if (isQuotaError(msg)) {
    return new Error(
      `免费引擎今日额度可能已用完（Cloudflare 每天 10,000 神经元，北京时间早 8 点重置）。` +
        `请把顶部引擎切到「云端 DeepSeek」继续写作。原始错误：${msg.slice(0, 200)}`,
    )
  }
  return new Error(
    `免费引擎（${model}）调用失败：${msg.slice(0, 240)}。可切换到「云端 DeepSeek」重试。`,
  )
}

/**
 * 免费通道：入参/出参都对齐 callDeepSeek 的形状，
 * 所以 16 个 AI 分支拿到的都是一样的 { parsed, searched, searchCount }。
 */
async function callFreeModel(env, { system, userText, maxOutputTokens = 4000 }) {
  if (!env.AI) {
    throw new Error(
      '免费引擎未就绪：Worker 缺少 Workers AI 绑定。请在 wrangler.toml 加 [ai] binding = "AI" 后重新部署。',
    )
  }
  // v10.25 免费额度计数：这次请求确实跑了免费模型（同一请求跑多次也只记一次「点击」，
  // 由收尾的 flush 统一累加）
  if (typeof env.__freeCalls === 'number') env.__freeCalls += 1
  const model = resolveFreeModel(env)
  const messages = []
  if (system) messages.push({ role: 'system', content: String(system) })
  messages.push({ role: 'user', content: String(userText ?? '') })

  const run = p => env.AI.run(model, p)
  let data
  try {
    data = await run({ messages, max_tokens: maxOutputTokens, temperature: 0.8 })
  } catch (e) {
    // 部分模型已弃用 max_tokens（改用 max_completion_tokens），换字段名再试一次
    if (/max_completion_tokens|max_tokens|deprecat/i.test(safeStr(e))) {
      try {
        data = await run({ messages, max_completion_tokens: maxOutputTokens, temperature: 0.8 })
      } catch (e2) {
        throw freeError(e2, model)
      }
    } else {
      throw freeError(e, model)
    }
  }

  let text = extractChatText(data)
  // v10.20：推理型免费模型（如 GLM）偶发「正文为空、只回了推理」——
  // 换同池的另一个模型再试一次，别让用户只收到一句「返回为空」而拿不到任何结果。
  if (!text) {
    const altKey = Object.keys(FREE_MODELS).find(k => FREE_MODELS[k] !== model)
    const alt = altKey ? FREE_MODELS[altKey] : null
    if (alt) {
      try {
        const d2 = await env.AI.run(alt, { messages, max_tokens: maxOutputTokens, temperature: 0.5 })
        const t2 = extractChatText(d2)
        if (t2) text = t2
      } catch {
        /* 备用模型也失败 → 保持原始报错 */
      }
    }
  }
  if (!text) {
    throw new Error(
      `免费引擎（${model}）返回为空，请重试；若持续为空请改用「云端 DeepSeek」`,
    )
  }
  // 免费通道没有服务端联网检索能力 → searched 恒为 false（前端据此提示「未联网」）
  return { parsed: parseJsonLoose(stripDSML(text)), searched: false, searchCount: 0 }
}

/** 免费通道的读图：把 base64 转成字节数组喂给 Workers AI 的视觉模型 */
async function callFreeVision(env, { system, userText, imageBase64, maxOutputTokens = 8000 }) {
  if (!env.AI) {
    throw new Error('免费引擎未就绪：Worker 缺少 Workers AI 绑定（[ai] binding = "AI"）')
  }
  // v10.25 免费额度计数：读图也走免费通道，同样算一次
  if (typeof env.__freeCalls === 'number') env.__freeCalls += 1
  let bytes
  try {
    const bin = atob(String(imageBase64).replace(/^data:[^,]+,/, ''))
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    throw new Error('图片 base64 解析失败，请重新上传')
  }
  try {
    const data = await env.AI.run(FREE_VISION_MODEL, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: Array.from(bytes) },
            { type: 'text', text: `${system}\n\n${userText}` },
          ],
        },
      ],
      max_tokens: maxOutputTokens,
    })
    const text = extractChatText(data)
    if (!text) throw new Error('返回为空')
    return parseJsonLoose(stripDSML(text))
  } catch (e) {
    const msg = safeStr(e)
    if (isQuotaError(msg)) throw freeError(e, FREE_VISION_MODEL)
    throw new Error(
      `免费引擎的读图通道不可用（${FREE_VISION_MODEL}）：${msg.slice(0, 180)}。` +
        `图片识别请把顶部引擎切到「云端 DeepSeek」再试。`,
    )
  }
}

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
// 坑2：启用 web_search 时正文里可能夹带 ｜DSML｜…｜DSML｜ 工具调用标记块。
// 与其整段丢弃，不如把标记块剥掉，保留真正的答案文本。
function stripDSML(s) {
  if (typeof s !== 'string') return ''
  // 去掉成对的 ｜DSML｜…｜DSML｜ 块
  return s.replace(/｜DSML｜[\s\S]*?｜DSML｜/g, '').trim()
}

function extractOutputText(data) {
  // 候选文本：优先顶层 output_text，再兜底遍历 output 数组里所有 message 的 output_text
  const candidates = []
  if (typeof data.output_text === 'string') candidates.push(data.output_text)
  const items = Array.isArray(data.output) ? data.output : []
  for (const it of items) {
    if (it?.type === 'message' && Array.isArray(it.content)) {
      for (const part of it.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') candidates.push(part.text)
      }
    }
  }
  for (const c of candidates) {
    const cleaned = stripDSML(c)
    if (cleaned) return cleaned
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

/**
 * 模型返回的 JSON 容错修复：
 * ① 字符串值里出现裸换行 / 制表符（JSON 不允许）→ 转成 \n \t
 * ② 字符串值里出现未转义的英文双引号（台词里常见）→ 按其后续字符判断是收尾还是内侧引号，
 *    内侧的一律补转义，避免"「他说"走了啊"」这种把字符串提前截断
 * ③ 数组 / 对象尾随逗号 → 去掉
 */
function repairJsonLoose(s) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (!inStr) {
      if (c === '"') inStr = true
      out += c
      continue
    }
    if (esc) {
      out += c
      esc = false
      continue
    }
    if (c === '\\') {
      out += c
      esc = true
      continue
    }
    if (c === '\n') {
      out += '\\n'
      continue
    }
    if (c === '\r') {
      out += '\\r'
      continue
    }
    if (c === '\t') {
      out += '\\t'
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      const nx = s[j]
      if (nx === undefined || nx === ',' || nx === ':' || nx === '}' || nx === ']') {
        out += '"'
        inStr = false
      } else {
        out += '\\"'
      }
      continue
    }
    out += c
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function parseJsonLoose(text) {
  // 先去 markdown 代码围栏
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  try {
    return JSON.parse(t)
  } catch {
    const m = t.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('模型未返回 JSON：' + text.slice(0, 200))
    const raw = m[0]
    // 兜底一：状态机修复（裸换行 / 内侧引号 / 尾随逗号）
    try {
      return JSON.parse(repairJsonLoose(raw))
    } catch (e1) {
      // 兜底二：截到最后一个完整的 }，再按「未闭合括号栈」倒序补上收尾括号
      const cut = raw.lastIndexOf('}')
      if (cut > 0) {
        let head = repairJsonLoose(raw.slice(0, cut + 1))
        const stack = []
        let inS = false
        let es = false
        for (const ch of head) {
          if (inS) {
            if (es) es = false
            else if (ch === '\\') es = true
            else if (ch === '"') inS = false
            continue
          }
          if (ch === '"') inS = true
          else if (ch === '{' || ch === '[') stack.push(ch)
          else if (ch === '}' || ch === ']') stack.pop()
        }
        head = head.replace(/,\s*$/, '')
        // 倒序补：先关最内层。不能把所有 ] 拼一起再把所有 } 拼一起
        while (stack.length) {
          head += stack.pop() === '{' ? '}' : ']'
        }
        try {
          return JSON.parse(head)
        } catch {
          /* 落到下面统一报错 */
        }
      }
      const pos = Number(((e1 instanceof Error ? e1.message.match(/position (\d+)/) : null) || [])[1] || 0)
      const ctx = pos ? raw.slice(Math.max(0, pos - 120), pos + 120) : raw.slice(0, 240)
      throw new Error(
        '解析模型 JSON 失败：' +
          (e1 instanceof Error ? e1.message : String(e1)) +
          ' ｜ 出错位置附近：' +
          ctx,
      )
    }
  }
}

// 工作台「续写 / 原文修改」的目标章节提示块，让产出明确落到「第几章」
function chapterBlock(ch) {
  if (!ch || ch.index == null) return ''
  const title = toStr(ch.title)
  const summary = toStr(ch.summary)
  return `\n\n【目标章节】第 ${ch.index} 章${title ? `《${title}》` : ''}${
    summary ? `\n【本章大纲】${summary}` : ''
  }\n请让本次产出严格对应这一章：不要串到其它章节，也不要重复前文已有的情节。`
}

// PRD 功能1「画布锁定」：把用户锁定的维度显式写进提示词，要求 AI 绝不改动
function lockBlock(locked) {
  const list = Array.isArray(locked) ? locked.filter(Boolean) : []
  if (!list.length) return ''
  return `\n\n【🔒 用户已锁定 · 绝对不可改动】以下维度被用户锁定：${list.join('、')}。
硬性要求：不要修改、覆盖、重写、优化这些维度的任何文字；即使你认为它们有问题，也必须原样保留其设定与措辞。你的产出必须绕开它们。`
}

// 归一化 locked 字段（前端可能传字符串或数组）
function normLocked(v) {
  if (Array.isArray(v)) return v.map(s => String(s)).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return v.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
  return []
}

/* ══════════════════════════════════════════════════════════════════
   硬约束（v10.26）
   ------------------------------------------------------------------
   用户在「🔒 硬约束」里锁定（=生效）的设定条目，必须被 AI 完整遵守。

   以前这些条目只存在 KV 的 `atom:` 前缀下，**没有任何 AI 调用读过它们** ——
   界面上写的「锁上之后 AI 就不能改了」是一句空头承诺。

   现在在**唯一的下游咽喉**（callDeepSeek / callDeepSeekSearch 拼系统指令
   的地方）统一注入，所以 generate / dissect / revise / continue /
   writeChapter / refine / toScript / direct 等所有创作类 action
   一行都不用改就自动生效，将来新增 action 也自动带上。
   ══════════════════════════════════════════════════════════════════ */
const CONSTRAINTS_MAX = 40 // 条数上限
const CONSTRAINT_MAX_CHARS = 1200 // 单条长度上限（防止把提示词撑爆）

/** 归一化前端传来的硬约束：只收非空字符串，限条数与单条长度 */
function normConstraints(v) {
  if (!Array.isArray(v)) return []
  return v
    .map(c => toStr(c))
    .filter(Boolean)
    .slice(0, CONSTRAINTS_MAX)
}

/** 把硬约束拼到系统指令末尾；没有约束时原样返回 */
/**
 * v10.70 · 分步推进（CoT）纪律
 *
 * 为什么要这一段：一次性让模型"直接写"，它容易跳步、跑偏、与前文矛盾。
 * 这段要求它**在内部**按五步走一遍，但**只交最终内容** —— 对写作产品来说，
 * 推理过程写进正文就是废稿。
 *
 * 五步（对应产品需求）：
 *   ① 准备输入：题目 / 已知条件 / 限制 / 输出格式
 *   ② 分步推进：拆子问题，每一步引用上一步的结论
 *   ③ 生成：按顺序展开，引用前文事实必须一致
 *   ④ 验证：核对硬约束、字数格式、与前文是否矛盾、是否重复
 *   ⑤ 输出：只输出最终内容
 *
 * 关闭方式：给 Worker 加环境变量 COT_DISABLED=1（应急回滚不用改代码）。
 */
const COT_DIRECTIVE = `

===== 分步推进（内部执行，不要把推理过程写进输出）=====
动笔前，先在心里按下面五步走一遍，只把第 ⑤ 步的结果作为输出：

① 准备输入：明确本次的目标、已知条件（画布/设定/前文/用户要求）、限制（字数/视角/禁忌/格式）。
② 分步推进：把任务拆成 3-6 个子问题（例如"定基调 → 立冲突 → 铺场景 → 收束"），
   后一步必须以前一步的结论为前提，不要跳步，也不要每步都重新开头。
③ 生成：按子问题顺序展开。凡是引用前文的人名、设定、时间线、数字，必须与已知条件一致。
④ 验证结论：写完后逐条核对——
   · 有没有违背任何一条硬约束或限制？
   · 字数和输出格式是否达标？
   · 有没有与前文/已知条件矛盾？
   · 有没有重复已写过的桥段或表述？凑字？解释性旁白？
   发现问题**先改好再输出**，不要带着已知问题交稿。
⑤ 输出结果：只输出最终内容。不要输出提纲、分析、自检过程，也不要写"以下是"或"希望对你有帮助"。

（如果本次任务本身就是分析/拆解类，那么分析与结论就是最终内容，直接给出即可，
  但同样不要加"我先分析一下"这类元叙述。）`

function withConstraints(instructions, constraints) {
  if (!Array.isArray(constraints) || constraints.length === 0) return instructions
  const list = constraints
    .map(c => toStr(c).trim().replace(/\s{2,}/g, ' '))
    .filter(Boolean)
    .slice(0, CONSTRAINTS_MAX)
    .map(c => `- ${c.slice(0, CONSTRAINT_MAX_CHARS)}`)
  if (!list.length) return instructions
  return `${instructions}

===== 硬约束（用户已锁定的设定，绝对不能违背）=====
以下条目由用户显式锁定，你的产出必须完整遵守：
- 不得改动其中的名字 / 设定 / 关系 / 规则 / 数值
- 与上面的画布内容冲突时，一律以这些条目为准
- 不要在正文里复述、解释或罗列这些约束，直接照着写

${list.join('\n')}
==============================================`
}

async function callDeepSeek(env, { instructions, input, maxOutputTokens, useSearch = true, forceSearch = false, previousResults = [] }) {
  // v10.26 硬约束注入（放在最前，previousResults 的「防重复」说明跟在后面）
  let finalInstructions = withConstraints(instructions, env.__constraints)
  // v10.70 分步推进纪律（内部推理，只交最终内容）；可用 COT_DISABLED=1 关闭
  if (env.COT_DISABLED !== '1') {
    finalInstructions = `${finalInstructions}${COT_DIRECTIVE}`
  }
  if (Array.isArray(previousResults) && previousResults.length > 0) {
    // 修：原来这里用了 `instructions`，会把上面注入的硬约束与 CoT 纪律整段丢掉
    finalInstructions = `${finalInstructions}\n\n⚠️ 重要：以下是你之前已经生成过的内容，请确保本次返回的 features 和 examples 与它们不同（换角度、换例子、换表述），严禁重复：\n\n${previousResults.map((r, i) => `【已生成版本 ${i + 1}】\nfeatures：${r.features || ''}\nexamples：${r.examples || ''}`).join('\n\n')}`
  }
  // v10.17 引擎分流：选了免费引擎就走 Workers AI，完全不碰 DeepSeek 端点
  // 放在这里（而不是更早）是为了让上面的 previousResults「防重复」约束照样生效
  if (env.__engine === ENGINE_FREE) {
    return callFreeModel(env, { system: finalInstructions, userText: input, maxOutputTokens })
  }
  const body = {
    model: MODEL,
    instructions: finalInstructions,
    input,
    max_output_tokens: maxOutputTokens,
  }
  // generate 主要依据 7 块画布写书，不需要联网；其他动作（dissect/revise/continue）启用 web_search
  if (useSearch) {
    body.tools = [{ type: 'web_search' }]
    // analyze 且用户明确选了联网 → 强制调用 web_search，不再让模型自己决定
    body.tool_choice = forceSearch ? { type: 'web_search' } : 'auto'
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
  // v10.23 记账：token 已经花了，就在这一步入账（即使后面 JSON 解析失败也照样计费）
  addUsage(env, readUsage(data, 'openai'))

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

  let parsed
  try {
    parsed = parseJsonLoose(text)
  } catch (e) {
    // 输出被 token 上限截断时，真实原因往往被 JSON 语法错误掩盖，这里换成人能看懂的提示
    if (data.status === 'incomplete') {
      throw new Error(
        `响应被截断（max_output_tokens 不够，实际只输出了约 ${text.length} 字符 / 状态 ${data.status}）。` +
          `请把集数或单集时长调小，或调大 max_output_tokens。`,
      )
    }
    throw e
  }

  return { parsed, searched: searchCount > 0, searchCount, incomplete: data.status === 'incomplete' }
}

// ── Anthropic 兼容端点：DeepSeek 官方唯一支持「服务端联网搜索」的通道 ──
// 见 https://api-docs.deepseek.com/guides/anthropic_api
// 注意：Responses API(/responses) 的 web_search 工具会被忽略，实测拿不到搜索结果，
// 所以联网检索必须走这个端点（server_tool_use / web_search_tool_result 官方支持）。
const ANTHROPIC_API = 'https://api.deepseek.com/anthropic/v1/messages'
const ANTHROPIC_MODEL = 'deepseek-flash'

async function callDeepSeekSearch(env, { system, userText, maxOutputTokens = 8000, previousResults = [] }) {
  // v10.26 硬约束注入（联网检索这条通道同样受约束）
  let finalSystem = withConstraints(system, env.__constraints)
  // v10.70 分步推进纪律：联网查证后的成文同样要"先核实→再写→自检→只交正文"
  if (env.COT_DISABLED !== '1') {
    finalSystem = `${finalSystem}${COT_DIRECTIVE}`
  }
  if (Array.isArray(previousResults) && previousResults.length > 0) {
    // 修：原来这里用了 `system`，会把硬约束与 CoT 纪律整段丢掉
    finalSystem = `${finalSystem}\n\n⚠️ 重要：以下是你之前已经生成过的内容，请确保本次返回的 features 和 examples 与它们不同（换角度、换例子、换表述），严禁重复：\n\n${previousResults.map((r, i) => `【已生成版本 ${i + 1}】\nfeatures：${r.features || ''}\nexamples：${r.examples || ''}`).join('\n\n')}`
  }
  // v10.17 免费引擎没有服务端联网检索能力，降级为「本地知识生成」，
  // 仍返回同样的 parsed 形状，前端只会看到 searched=false（提示未联网）
  if (env.__engine === ENGINE_FREE) {
    return callFreeModel(env, { system: finalSystem, userText, maxOutputTokens })
  }
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: maxOutputTokens,
    system: finalSystem,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    // Anthropic 服务端联网搜索工具
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    // 强制调用 web_search：用户明确选了联网，就不让模型自己决定「不搜」
    tool_choice: { type: 'tool', name: 'web_search' },
  }
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.DEEPSEEK_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    throw new Error(`DeepSeek(Anthropic) ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  }
  const data = await resp.json()
  // v10.23 记账：Anthropic 兼容端点（联网检索 / 读图）走这里的口径
  addUsage(env, readUsage(data, 'anthropic'))
  const blocks = Array.isArray(data.content) ? data.content : []
  const text = blocks
    .filter(b => b?.type === 'text')
    .map(b => b.text || '')
    .join('\n')
    .trim()
  const searchCount = blocks.filter(
    b => b?.type === 'server_tool_use' || b?.type === 'web_search_tool_result',
  ).length
  if (!text) {
    throw new Error(`DeepSeek(Anthropic) 返回为空（stop_reason=${data.stop_reason || '?'}）`)
  }
  return { parsed: parseJsonLoose(stripDSML(text)), searched: searchCount > 0, searchCount }
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

const ANALYZE_SYSTEM_LOCAL = `你是文学分析助手。请基于你已有的知识直接针对用户指定的维度做分析，不要联网检索。

严格返回如下 JSON，三个字段都必须是**纯字符串**：
{
  "source": "作品名（纯文字，如「凡人修仙传」，禁止写 URL 或来源列表）",
  "features": "该维度的核心特征，2-4 句中文",
  "examples": "具体例证或典型场景，1-3 句中文"
}

硬性要求：
- 三个字段都必须是字符串，禁止嵌套对象、禁止数组
- source 只写作品名，不要把搜索到的网址塞进去
- 如果你对该作品不了解，features 明确写「未掌握可靠资料」，不要编造`

// v10.19 · 参考锚点直出（anchorSuggest）
// 背景：AnchorAdder 的「✨ AI 填充」在没指定书名时，原来只回填一张**写死的「提示：…」**，
// 用户要的是「具体内容」而不是「该怎么写的方法论」。这个 action 改为读用户自己的画布内容，
// 直接产出这个维度的具体特征 + 具体示例文本。
function anchorSuggestSystem(dimension) {
  return `你是小说创作助手。用户正在打磨写作的【${dimension}】画布，需要你给一条**有明确出处**的参考锚点。

你会收到「用户当前【${dimension}】画布的内容」和「其他画布的内容（作上下文）」。

任务：依据画布里**真实出现**的人名 / 设定 / 情节判断用户这份材料的题材与写法，然后推荐 **1 部真实存在、已出版或已发表的、在【${dimension}】这个维度上最值得借鉴的作品**（优先与用户题材相近、中文可读），并说清它在【${dimension}】上的具体做法。

严格返回如下 JSON，三个字段都必须是**纯字符串**，直接输出 JSON，不要解释、不要 markdown 包裹：
{
  "source": "推荐的作品名（作者），例如「活着（余华）」；纯文字，禁止 URL",
  "features": "那部作品在【${dimension}】上的具体手法 / 规律，并落到用户自己的画布上（点出用户画布里的人物名、设定名），说清用户该照着改什么。3-5 句中文",
  "examples": "1-3 句具体例证：那部作品的典型场景或原文片段；引用原文必须准确，拿不准就用你自己的话复述那个场景；混入仿写片段时标注「风格示例」"
}

硬性要求：
- source **必须是真实的作品名**，禁止写成「本作推演」「通用分析角度」这类自造标签，也不要只写维度名
- **绝不编造书名或作者**；拿不准作者就只写作品名，不要猜
- **严禁**只给指令或方法论（如「提示：先列出主角的执念」「你可以考虑…」），必须给出实际内容
- 谈参考作品时可以用它自己的角色名；但**不要给用户的画布**编造不存在的人物 / 设定
- 三个字段都是字符串，禁止嵌套对象、禁止数组`
}

// ── generate 拆分：规划调用（只出书名/简介/大纲/规格，不出样章，体积小、出得快）──
const GENERATE_PLAN_SYSTEM = `你是小说创作助手。基于用户提供的 7 块画布（设定/人物/文笔/结构/篇幅/情节/节奏）合成一本小说方案的「规划部分」（不含样章正文）。
严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "title": "书名（4-8 字）",
  "synopsis": "简介（150-300 字，涵盖设定、人物、核心冲突）",
  "outline": [
    { "index": 1, "title": "章名", "summary": "一句话摘要", "tag": "开局|推进|高潮|反转|收束", "words": 10000 }
  ],
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
- 人物姓名与关系用【人物】画布里的，世界观名词用【设定】画布里的
- 禁止编造画布里没有的设定`

// ── generate 拆分：样章调用（只写第一章样章正文，体积小、出得快）──
const GENERATE_CHAPTER_SYSTEM = `你是小说创作助手。基于用户提供的 7 块画布写「第一章」样章正文（不含书名/大纲，只写样章）。
严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "sampleChapter": {
    "title": "第一章 章名",
    "content": "样章正文（500-1000 字，必须按【文笔】画布的风格写）",
    "beat": "本段情节依据（1 句话，引用【情节】画布）"
  }
}
要求：
- sampleChapter.content 严格遵循【文笔】画布的语气、句法、意象
- 人物姓名与关系用【人物】画布里的，世界观名词用【设定】画布里的
- 禁止编造画布里没有的设定`

// ── 工作台：把一段原文拆成 7 个维度 ──
const DIMENSIONS = ['设定', '人物', '文笔', '结构', '篇幅', '情节', '节奏']

/* ============================================================
   方向导演层（Direction Director）
   ------------------------------------------------------------
   把 7 块画布 + 用户「方向意图」+ 训练出的个人风格画像，蒸馏成一份
   【精确、可被生成模型严格遵守的写作方向指令书】(JSON)。
   决策/指令模型最擅长这件事：把高层意图 → 精确、会被遵守的逐步指令，
   从而让生成方向更精准、长文不漂移。
   后端可插拔：配置 JEV_API_KEY + JEV_ENDPOINT 就走 Jev（TypeSafe AI
   决策模型，OpenAI 兼容 /chat/completions）；否则用 DeepSeek 当导演。
   ============================================================ */

const DIRECTOR_SYSTEM = `你是一位「写作方向导演」（决策模型）。你的任务不是写小说，而是把作者给的 7 块画布（设定/人物/文笔/结构/篇幅/情节/节奏）、一句「方向意图」、以及作者训练出的个人风格画像，蒸馏成一份【精确、可被严格遵守的写作方向指令书】。生成模型会完全照这份指令书写，所以你必须把模糊的意图变成硬约束。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "styleLock": "一句话风格锁：语气/句法/意象的红线（提炼自【文笔】画布，10-30字）",
  "tone": "整体语气基调（如：冷峻克制 / 炽烈张扬 / 轻快俏皮）",
  "rhythmIntent": "节奏意图（提炼自【节奏】画布：哪里该快、哪里该慢、张力如何起伏）",
  "hardRules": ["绝不可偏离的硬约束1", "硬约束2", "硬约束3"],
  "phasePlan": [
    {"tag":"开局","focus":"本阶段应达成的情节落点/情绪/节奏意图"},
    {"tag":"推进","focus":"..."},
    {"tag":"高潮","focus":"..."},
    {"tag":"反转","focus":"..."},
    {"tag":"收束","focus":"..."}
  ],
  "chapterDirections": [
    {"index":1,"intent":"第1章必须往哪个方向走（与【情节】【节奏】画布一致）"},
    {"index":2,"intent":"..."},
    {"index":3,"intent":"..."}
  ],
  "forbidden": ["必须避免的套路/词汇/走向1", "避免2"]
}
要求：
- 所有字段都是纯字符串（hardRules/forbidden/chapterDirections 是数组，其元素是字符串）
- 指令必须可从画布推导，禁止编造画布里没有的设定
- 若作者给了「方向意图」，必须把它变成可执行的硬约束写进 hardRules 或 chapterDirections
- 若给了风格画像，必须在 styleLock / tone 里对齐该作者的历史风格，而非通用风格`

/** 服务端把训练出的个人风格画像格式化成参考块（与前端 writingTraining.styleReferenceBlock 等价） */
function serverStyleBlock(profile) {
  if (!profile || !profile.metrics) return ''
  const m = profile.metrics
  const tags = Array.isArray(m.styleTags) && m.styleTags.length ? m.styleTags.join('、') : '暂无显著风格倾向'
  const w = profile.dimensionWeights || {}
  const weightStr = Object.entries(w).map(([k, v]) => `${k} ${Math.round(Number(v) * 100)}%`).join(' / ')
  const rp = m.rhythmProfile || {}
  return [
    `【作者训练出的个人风格画像】（由已存作品蒸馏，请对齐而非照搬）`,
    `- 风格标签：${tags}`,
    `- 平均句长：${m.avgSentenceLen} 字 · 节奏（短/中/长）：${rp.short ?? '?'} / ${rp.medium ?? '?'} / ${rp.long ?? '?'}`,
    `- 对话占比：${Math.round((m.dialogueRatio || 0) * 100)}% · 词汇丰富度：${m.vocabRichness} · 四字词密度：${m.fourCharIdiomRatio}`,
    `- 偏好权重（七维）：${weightStr || '未训练'}`,
  ].join('\n')
}

/** 回读当前用户的训练画像（best-effort，拿不到就返回 null，不影响主流程） */
async function loadUserProfile(env, token) {
  if (!token) return null
  try {
    const me = await requireAuth(env, token)
    if (!me || !me.userId) return null
    return (await kvGetJson(env, userKey(me.userId, USER_MODEL_KEY))) || null
  } catch {
    return null
  }
}

/** 可插拔导演后端：Jev 优先，失败回退 DeepSeek */
async function callDirector(env, { instructions, input, maxOutputTokens = 3000 }) {
  if (env.JEV_API_KEY && env.JEV_ENDPOINT) {
    try {
      return await callOpenAICompatible(env, {
        endpoint: env.JEV_ENDPOINT,
        apiKey: env.JEV_API_KEY,
        model: env.JEV_MODEL || 'jev',
        instructions,
        input,
        maxOutputTokens,
      })
    } catch (e) {
      console.warn('[director] Jev 调用失败，回退 DeepSeek：', safeStr(e))
    }
  }
  const { parsed } = await callDeepSeek(env, { instructions, input, maxOutputTokens, useSearch: false })
  return parsed
}

/** OpenAI 兼容 chat completions（Jev / 其他决策模型）。仅用于导演层。 */
async function callOpenAICompatible(env, { endpoint, apiKey, model, instructions, input, maxOutputTokens = 3000 }) {
  const url = String(endpoint).replace(/\/$/, '') + '/chat/completions'
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: input },
      ],
      max_tokens: maxOutputTokens,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
  })
  if (!resp.ok) throw new Error(`Director(${model}) ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const data = await resp.json()
  const text = (data.choices?.[0]?.message?.content || '').trim()
  if (!text) throw new Error('Director 返回为空')
  return parseJsonLoose(text)
}

/** 产「方向指令书」：画布 + 方向意图 + 训练画像 → 精确约束 JSON（带兜底字段） */
async function directDirection(env, { canvases, directionIntent, profile }) {
  const compact = DIMENSIONS.map(d => `【${d}】\n${toStr(canvases?.[d]) || '（空）'}`).join('\n\n')
  const intentBlock = directionIntent
    ? `\n\n【作者明确的方向意图】\n${String(directionIntent).trim().slice(0, 500)}\n（请把这条变成可执行的硬约束）`
    : ''
  const styleBlock = serverStyleBlock(profile)
  const input = `画布内容如下：\n\n${compact}${intentBlock}${styleBlock ? `\n\n${styleBlock}\n` : ''}`
  const parsed = await callDirector(env, { instructions: DIRECTOR_SYSTEM, input, maxOutputTokens: 3000 })
  return {
    styleLock: toStr(parsed.styleLock),
    tone: toStr(parsed.tone),
    rhythmIntent: toStr(parsed.rhythmIntent),
    hardRules: Array.isArray(parsed.hardRules) ? parsed.hardRules.map(toStr).filter(Boolean) : [],
    phasePlan: Array.isArray(parsed.phasePlan)
      ? parsed.phasePlan.map(p => ({ tag: toStr(p?.tag), focus: toStr(p?.focus) }))
      : [],
    chapterDirections: Array.isArray(parsed.chapterDirections)
      ? parsed.chapterDirections.map(c => ({ index: Number(c?.index) || 0, intent: toStr(c?.intent) }))
      : [],
    forbidden: Array.isArray(parsed.forbidden) ? parsed.forbidden.map(toStr).filter(Boolean) : [],
  }
}

/** 仅在「有方向意图 或 有训练画像」时才跑导演，避免无谓的额外调用（保持无画像/无意图时原行为） */
async function getBriefIfNeeded(env, { canvases, directionIntent, token }) {
  const intent = toStr(directionIntent).trim()
  let profile = null
  try {
    profile = await loadUserProfile(env, token)
  } catch {
    profile = null
  }
  if (!intent && !profile) return null
  try {
    return await directDirection(env, { canvases, directionIntent: intent, profile })
  } catch (e) {
    console.warn('[director] 生成指令书失败，跳过：', safeStr(e))
    return null
  }
}

/** 把指令书格式化为可注入各生成提示词的文本段 */
function briefToText(brief) {
  if (!brief) return ''
  const lines = []
  if (brief.styleLock) lines.push(`风格锁：${brief.styleLock}`)
  if (brief.tone) lines.push(`语气基调：${brief.tone}`)
  if (brief.rhythmIntent) lines.push(`节奏意图：${brief.rhythmIntent}`)
  if (brief.hardRules && brief.hardRules.length) lines.push(`硬约束：\n- ` + brief.hardRules.join('\n- '))
  if (brief.forbidden && brief.forbidden.length) lines.push(`禁止：${brief.forbidden.join('；')}`)
  if (brief.phasePlan && brief.phasePlan.length)
    lines.push(`阶段方向：\n` + brief.phasePlan.map(p => `· ${p.tag}：${p.focus}`).join('\n'))
  if (brief.chapterDirections && brief.chapterDirections.length)
    lines.push(`章节方向：\n` + brief.chapterDirections.map(c => `· 第${c.index}章：${c.intent}`).join('\n'))
  return lines.length ? `【方向导演指令书 · 必须严格遵守】\n${lines.join('\n')}` : ''
}

/** 校准自检：比对成稿与指令书，标出偏离并给修正稿（防漂移） */
const CALIBRATE_SYSTEM = `你是「写作方向校准员」。给定一份【方向导演指令书】和一段【成稿】，请严格比对：成稿在风格、语气、节奏、情节落点、禁忌上是否偏离了指令书。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "score": 0-100 的整数（方向与指令书的一致度，100=完全吻合）,
  "deviations": ["偏离点1（具体、可定位）", "偏离点2"],
  "fixedText": "把偏离点修正后的完整成稿（若没有偏离则与原文一致）"
}
要求：
- score 客观：明显偏离扣大分，轻微偏离扣小分
- deviations 为空数组表示无偏离
- fixedText 必须保持原文核心情节与人物，只把偏离指令书的地方拉回方向`

async function calibrateDirection(env, { brief, text }) {
  const input = `【方向导演指令书】\n${briefToText(brief) || '（无指令书，按通用文学标准评估）'}\n\n【成稿】\n${toStr(text)}\n\n请评估方向与指令书的一致度，并给出修正稿。`
  const parsed = await callDirector(env, { instructions: CALIBRATE_SYSTEM, input, maxOutputTokens: 4000 })
  return {
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    deviations: Array.isArray(parsed.deviations) ? parsed.deviations.map(toStr).filter(Boolean) : [],
    fixedText: toStr(parsed.fixedText) || toStr(text),
  }
}

/* ============================================================
   v10.10 新增一：AI 短剧剧本改写
   把已生成的小说正文改写成「能直接拍的竖屏短剧剧本」：
   分集 + 场景 + 台词 + 镜头 + 每集钩子 + AI 生视频提示词

   v18.8 规格基准：2025-2026 网络短剧行业公开规格（多个来源交叉核对）
   - 竖屏短剧：单集 1-2 分钟 / 550-800 字；3 秒钩子、30 秒冲突、结尾留悬念
   - 整体闭环：主流 60-100 集，长线 100-250 集；六幕式（起-困-反-升-爽-合）
   - 平台差异：抖音/红果 1-2 分钟；快手/爱奇艺/芒果 1-3 分钟；
     腾讯/优酷横屏中短剧 10-15 分钟（本次只做竖屏，横屏另计）
   - 海外翻拍（ReelShort/DramaBox）：60-80 集 / 每集 1-2 分钟 / 剧本 100 余页
   数据用于「原文 → 集数×单集时长」的匹配，不写死在提示词里。
   ============================================================ */
const SCRIPT_SPEC_BASE = {
  vertical: {
    sec: [60, 120],
    words: [550, 800],
    episodes: [60, 100],
    longRun: [100, 250],
    hookSec: 3,
    conflictSec: 30,
    acts: ['起', '困', '反', '升', '爽', '合'],
  },
  platform: {
    '抖音': { sec: [60, 120], episodes: [60, 100] },
    '红果短剧': { sec: [60, 120], episodes: [60, 100] },
    '快手': { sec: [60, 180], episodes: [60, 120] },
    '微信短剧': { sec: [60, 120], episodes: [60, 120] },
    '番茄短剧': { sec: [60, 120], episodes: [60, 100] },
    '通用': { sec: [60, 120], episodes: [60, 100] },
  },
}

/** 按原文字数 + 平台 + 用户想要的集数，算出匹配的集数×单集时长。纯计算，不联网。 */
function matchScriptSpec({ words, platform, preferEpisodes }) {
  const p = SCRIPT_SPEC_BASE.platform[platform] || SCRIPT_SPEC_BASE.platform['通用']
  const [minSec, maxSec] = p.sec
  const [minEp, maxEp] = p.episodes
  const [longMin, longMax] = SCRIPT_SPEC_BASE.vertical.longRun
  const [wordsMin, wordsMax] = SCRIPT_SPEC_BASE.vertical.words

  // 一部剧的正文体量 = 集数 × 单集字数（取行业区间中值 675 字）
  const wordsPerEp = Math.round((wordsMin + wordsMax) / 2)
  const naturalEp = Math.max(1, Math.round(words / wordsPerEp))

  let episodes, secPerEp, basis
  if (preferEpisodes && Number(preferEpisodes) > 0) {
    // 用户指定集数：优先尊重，按时长兜底换算
    episodes = Math.round(Number(preferEpisodes))
    secPerEp = Math.round((words / Math.max(episodes, 1)) / 4.2)  // 每秒约 4.2 字
    secPerEp = Math.max(30, Math.min(600, secPerEp))
    basis = '按你指定的集数反推单集时长'
  } else {
    // 自动：先落在平台主流区间；原文很长时自动升到长线剧 100-250 集
    if (naturalEp <= maxEp) {
      episodes = Math.max(minEp, naturalEp)
      secPerEp = Math.round((words / episodes) / 4.2)
      secPerEp = Math.max(minSec, Math.min(maxSec, secPerEp))
      basis = `原文 ${words} 字 ÷ 每集约 ${wordsPerEp} 字，落在平台主流 ${minEp}-${maxEp} 集区间`
    } else {
      episodes = Math.min(longMax, Math.max(longMin, naturalEp))
      secPerEp = Math.round((words / episodes) / 4.2)
      secPerEp = Math.max(minSec, Math.min(maxSec, secPerEp))
      basis = `原文 ${words} 字 ÷ 每集约 ${wordsPerEp} 字，超过主流区间，升为 ${longMin}-${longMax} 集长线剧`
    }
  }

  return {
    episodes,
    secPerEp,
    words,
    wordsPerEp,
    sourceWords: words,
    platform,
    basis,
    spec: {
      secRange: p.sec,
      epRange: [minEp, maxEp],
      longRunRange: [longMin, longMax],
      wordsRange: [wordsMin, wordsMax],
      hookSec: SCRIPT_SPEC_BASE.vertical.hookSec,
      conflictSec: SCRIPT_SPEC_BASE.vertical.conflictSec,
      acts: SCRIPT_SPEC_BASE.vertical.acts,
    },
    reference: '2025-2026 短剧行业公开规格（微信《短剧编辑和短剧制作人审核剧本要求》、红星新闻《中式短剧风靡世界》：竖屏 1-2 分钟/550-800 字，主流 60-100 集，长线 100-250 集，3 秒钩子/30 秒冲突/六幕式）',
  }
}

/* ============================================================
   v18.8 新增：全本分集大纲（100-250 集一次出齐，只出纲要不出正文）
   ============================================================ */
const SCRIPT_OUTLINE_SYSTEM = `你是短剧分集大纲编剧。用户给你一段小说原文和一份行业规格，
你要把整部小说拆成**指定集数的分集大纲**——每集只要标题、钩子、冲突、反转、结尾悬念，不写完整台词和场景。

【输出要求】
1. episodes 数组长度必须正好等于用户要求的集数，index 从 1 连续编号到 N。
2. 每集给 5 个字段，每个字段一句话、不超过 30 字：
   - title：本集标题（≤10 字，不带「第X集」）
   - hook：开头 3 秒钩子（画面 + 一句话）
   - conflict：本集核心冲突（谁和谁、为什么）
   - twist：本集反转（信息差揭开或局势倒转）
   - cliffhanger：结尾悬念，让人非看下一集不可
3. 整体按六幕式分配：起(1-10%)、困(10-30%)、反(30-50%)、升(50-70%)、爽(70-90%)、合(90-100%)。
   在 act 字段标出本集属于哪一幕（只能用 起/困/反/升/爽/合 六个字之一）。
4. durationSec 每集都填用户给的单集秒数。
5. 忠于原作：不要发明新主线，长篇可以压缩支线、合并人物，但结局走向要一致。
6. 每 5 集至少有一个大转折；开篇 3 集内必须有主线冲突。

【严格返回 JSON】不要 markdown 包裹，不要解释：
{
  "title": "剧名（≤14字）",
  "genre": "类型",
  "logline": "一句话卖点（≤30字）",
  "acts": [{"act":"起","from":1,"to":10,"goal":"这一幕要完成什么"}],
  "episodes": [
    {"index":1,"title":"","hook":"","conflict":"","twist":"","cliffhanger":"","act":"起","durationSec":90}
  ],
  "notes": ["改编取舍说明，每条≤40字"]
}
注意：集数很多时优先保证 episodes 条数齐全，每条文字宁短勿长。`

const SCRIPT_SYSTEM = `你是「短剧编剧 + AI 影片导演」二合一。用户会给你一段自己写好的小说正文（可能很长），
你要把它改写成一部**符合短剧行业交付格式、可以直接开拍的竖屏 AI 短剧剧本**。

【剧本格式规范 —— 必须严格照这个格式写，这是行内交付标准】
1. 剧本头部三行（不要写成正文）：
   类型：<题材，如 女频现言 / 男频逆袭 / 悬疑复仇>
   标签：<三个卖点用 + 连接，如 豪门联姻 + 先婚后爱 + 救赎>
   人设：<女方一句话> × <男方一句话>
2. 分集标题单独一行：第一集 / 第二集 …（中文数字，不要写「第1集」）
3. 每场戏第一行 = 场景号 + 地点 + 日/夜 + 内/外：
   <集号>-<场号> <地点> <日/夜> <内/外>
   例：1-1 茶室 日 内 ｜ 2-3 走廊 夜 内 ｜ 1-2 茶室门口 日 外/内
   —— 场号指「这一集的第几场戏」，不是分镜；同一集内从 1 连续编号，换集重新从 1 开始。
4. 每场戏第二行固定是人物表：人物：<角色A>、<角色B>
   只在电话另一头出声、不出镜的人写「角色名VO」；群演写「宾客若干」「服务员(女)」。
5. 正文只允许五种行，不许出现别的写法：
   ① △<动作 / 神态 / 镜头>
      动作行。只写镜头里看得见的：动作、走位、表情、物件、光线。
      需要强调时把景别写在最前面，如 △（特写）…、△（近景）…、△（空镜）…
   ② 角色名：<台词>
      台词行。一句不超过 20 字，像人真的会说的话。
   ③ 角色名：（<情绪或动作提示>）<台词>
      需要给演员提示时，把提示写在冒号后面的圆括号里，如 苏晚：（愣了两秒，无奈）你倒是不挑。
   ④ 角色名VO：<台词>
      画外音——电话另一端、门外的人、旁白式人声。
   ⑤ 角色名OS：<台词>
      内心独白，只出声不露口型。小说里的心理描写优先改成 OS 或 △ 表情，不要写成叙述。
   ⑥ 【<字幕或空镜>】
      如 【字幕：苏晚父亲 苏国栋】、【字幕：两个月后】、【空镜-茶室外景】
   ⑦ △空镜转场：<内容>
      场与场之间的空镜过渡，如 △空镜转场：车流。
6. 每场戏以一条 △ 动作行收尾，给剪辑留落点；每集最后一场常用「△镜头拉近，定格在…」收尾。

【硬要求】
1. 忠于原作：保留核心人物、关键情节与结局走向。可以删支线、合并场景、
   把心理描写改写成可拍的动作 / 神态 / 台词，但不要发明新主线。
2. 切忌小说化（短剧剧本最常被打回的就是这个）：
   - 不许出现成段环境描写、抒情散文句、文学化比喻堆砌；
   - 不许写「他想」「她心里明白」这类心理叙述，一律改成 △ 表情动作 或 角色名OS；
   - 少用「然而」「仿佛」「不禁」这类书面语。
3. 短剧节奏（每集约 1 分钟的体量）：
   - 每集 2-4 场戏；第一场第一个 △ 或第一句台词就要是钩子，不铺垫；
   - 每集至少两个节奏点：一次信息反转 + 一次情绪高点；
   - 每集结尾必须留悬念（cliffhanger），最后一句台词或最后一个 △ 要让人非看下一集不可；
   - 一集台词总量 25-45 句，短、密、有来有回。
4. AI 出片友好：
   - prompts 每条是中文，可直接喂给 AI 生视频 / 生图模型：景别、构图、光线、色调、风格、人物外形与动作；
   - 不要出现真实演员名，不要出现受版权保护的 IP 名。

【严格返回 JSON】（不要解释、不要 markdown 包裹）：
{
  "title": "剧名（≤14字，有传播感）",
  "genre": "类型（如 女频现言 / 男频逆袭）",
  "tags": ["标签1", "标签2", "标签3"],
  "castLine": "女方一句话 × 男方一句话",
  "logline": "一句话卖点（≤30字）",
  "platformTip": "针对目标平台的节奏与合规提示（80-140字）",
  "characters": [
    { "name": "姓名", "identity": "身份 / 立场一句话", "voice": "说话方式（口癖、句式、称呼）",
      "look": "外形与服化道一句话，供 AI 出图保持一致", "subtitle": "首次出场字幕，如 苏晚 苏氏独女；没有就空字符串" }
  ],
  "episodes": [
    {
      "index": 1,
      "title": "本集标题（≤10字，不要带「第1集」三个字）",
      "hook": "开头3秒钩子（画面 + 一句话）",
      "durationSec": 90,
      "scenes": [
        {
          "no": "1-1",
          "place": "茶室",
          "time": "日",
          "space": "内",
          "cast": ["苏晚", "苏国栋VO"],
          "lines": [
            { "kind": "beat", "text": "（特写）一只手推开茶室的门。" },
            { "kind": "line", "speaker": "苏晚", "emotion": "", "text": "你迟到了。" },
            { "kind": "line", "speaker": "沈亦舟", "emotion": "平静", "text": "路上堵车。" },
            { "kind": "vo", "speaker": "苏国栋", "text": "人我已经送到了，你自己看着办。" },
            { "kind": "os", "speaker": "苏晚", "text": "又是这一套。" },
            { "kind": "sub", "text": "字幕：两个月后" }
          ],
          "camera": "景别 + 运镜（如：中景，手持跟拍）",
          "transition": "切 / 叠化 / 硬切黑场"
        }
      ],
      "cliffhanger": "本集结尾悬念（一句话）"
    }
  ],
  "prompts": [
    { "scene": "第1集 · 场景1", "prompt": "中文AI生视频提示词，含景别/构图/光线/色调/风格/人物外形与动作" }
  ],
  "notes": ["改编取舍说明：删了什么、合并了什么、为什么这么改（每条≤40字）"]
}
约束：
- lines[].kind 只能是 beat / line / vo / os / sub 五种；emotion 只在 kind="line" 时填，没有就给空字符串
- △ 符号不用你写进 text，渲染时会自动加；text 里只写 △ 后面的内容
- **所有 text / 台词里要引用或强调时，一律用中文引号「」，绝对不要用英文双引号 "，否则会破坏 JSON**
- 每个字符串值内部不要出现换行符，需要停顿就用省略号
- episodes 长度必须正好等于用户要求的集数；每集场景数、台词量严格按用户给的「改编规格」执行，
  不要写超——写超会被接口截断，整份剧本作废
- prompts 条数在 集数×2 到 集数×4 之间，挑最有画面的场景
- 所有值都是字符串或数组，不要用嵌套对象以外的结构
- 用户没给集数就按 3 集写，每集 90 秒`

/* ============================================================
   短剧能力迁移（二）：原著快评 / 改编方案 / 视觉设定 / 分镜 / 视频提示词 / 审查 / 对标拆解
   ------------------------------------------------------------
   来源与许可：drama-skills (MIT, zenstory-ai/drama-skills contributors)
   迁移日期：2026-11-25
   以下 7 个 SYSTEM prompt 依据 drama-skills 的 SKILL.md 规则迁移；
   每个 prompt 都强制「只输出严格 JSON、不要解释、不要 markdown 代码块」。
   本脚本只做文本编排，不生成图片/视频等媒体。
   ============================================================ */

// —— 归一化 helper（顶层，不进 fetch；项目历史坑：塞进 fetch 会被每次请求重复定义）——
const dStr = (v, max = 400) => toStr(v).trim().slice(0, max)
const dList = (v, n = 20, max = 300) =>
  (Array.isArray(v) ? v : []).map(x => dStr(x, max)).filter(Boolean).slice(0, n)
const dNum = (v, def = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}
const dSeverity = v => {
  const s = toStr(v).trim().toLowerCase()
  return s === 'high' || s === 'low' ? s : 'medium'
}
const dNumOrNA = (v, fallback = '暂无') => {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : dStr(v, 60) || fallback
}
// 前端可能把上一步结果序列化成字符串传回来，这里统一解回对象
const dParse = (v, limit = 60000) => {
  if (v && typeof v === 'object') return v
  const s = toStr(v).trim().slice(0, limit)
  if (!s) return {}
  try {
    const p = JSON.parse(s)
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

/* 来源：drama-skills (MIT, zenstory-ai/drama-skills contributors) · 迁移日期：2026-11-25
   原著快评：抽样快评而非全文精读；标章节索引、脉络节奏与分集潜力点，不编造原文没有的精确设定。 */
const SCRIPT_NOVEL_ANALYZE_SYSTEM = `你是短剧「原著快评员」。用户给你一段小说原文（可能是节选），你要做抽样快评，不是全文精读。

【工作方法】
1. 抽样：按章节 / 段落抽样。chapters[].no 用原文章节序号；原文无编号就按出现顺序从 1 编号。
2. chapters[].summary 一句话（≤40 字）；characters / hooks 只抽原文明确出现的人和钩子，没有就给空数组。
3. rhythm.acts 按 起/承/转/合 切成最多 6 幕，from / to 填章节或段落序号，goal 一句话；pacingNote 说明哪里快、哪里慢。
4. adaptationTips 只写「哪段可做集尾悬念 / 哪段要压缩 / 哪段是分集潜力点」，不替用户做创作决定。
5. 不编造原文没有的精确设定（姓名、时间、数字、身份），缺失写「暂无」。
6. sources 只在确有可核查名称时填，url 不确定就留空字符串。

【严格返回 JSON】只输出严格 JSON，不要解释，不要 markdown 代码块：
{
  "title": "书名或剧名",
  "logline": "一句话卖点（≤30字）",
  "genre": "类型",
  "tags": ["卖点标签"],
  "chapters": [{"no":1,"title":"章节标题","summary":"一句话梗概","characters":["人物"],"hooks":["钩子"]}],
  "rhythm": {"acts":[{"act":"起","from":1,"to":3,"goal":"这一幕要完成什么"}],"pacingNote":"节奏快慢分布说明"},
  "adaptationTips": ["改编建议"],
  "sources": [{"name":"来源名","url":""}]
}`

/* 来源：drama-skills (MIT, zenstory-ai/drama-skills contributors) · 迁移日期：2026-11-25
   改编方案 / 导演阐述：基于原著或大纲做多集整稿切分、核心矛盾设定、导演阐述与题材钩子手册。 */
const SCRIPT_DEVELOP_SYSTEM = `你是短剧「改编方案 / 导演阐述」策划。基于用户给的原著或已有分集大纲与规格，产出可直接执行的多集整稿方案。

【硬要求】
1. episodePlans 条数必须正好等于用户给的 episodes，index 从 1 连续编号；每条给 title / goal / keyEvents / cliffhanger。
2. coreConflict 一句话说清「谁和谁、因为什么、赌注是什么」。
3. adaptationApproach 写取舍：删什么、合并什么、心理描写如何改成可拍动作或 OS。
4. directorStatement 用导演口吻写镜头气质、节奏、表演尺度与画面基调，不要写成套话。
5. hookHandbook 每条给 type / technique / example；example 一律用中文引号「」，不要用英文双引号。
6. continuityRules 只写跨集不能变的事实（人物关系、时间线、道具状态），不写可自由发挥的内容。
7. 忠于原作，不发明新主线；原文没有的精确设定写「暂无」。

【严格返回 JSON】只输出严格 JSON，不要解释，不要 markdown 代码块：
{
  "title": "剧名",
  "genre": "类型",
  "logline": "一句话卖点（≤30字）",
  "coreConflict": "核心矛盾（谁和谁、为什么、赌注）",
  "adaptationApproach": "改编取舍说明",
  "directorStatement": "导演阐述",
  "hookHandbook": [{"type":"钩子类型","technique":"具体手法","example":"示例"}],
  "episodePlans": [{"index":1,"title":"本集标题","goal":"本集目标","keyEvents":["关键事件"],"cliffhanger":"集尾悬念"}],
  "continuityRules": ["跨集不变规则"]
}`

/* 来源：drama-skills (MIT, zenstory-ai/drama-skills contributors) · 迁移日期：2026-11-25
   视觉设定：跨场不变写 appearance，可变阶段写 states / variants；连戏锁只锁穿帮项；有台词者 voice 非空。 */
const SCRIPT_ASSETS_SYSTEM = `你是短剧「视觉设定 / 连戏 Continuity」美术指导。只读输入剧本，产出视觉资产清单。

【硬要求】
1. 跨场不变的外貌写 appearance；会随剧情变化的阶段写 variants / states，不要把可变项混进 appearance。
2. continuityLocks 只锁跨镜会穿帮的不变外观（伤疤、发色、服装、道具状态），每条给 lockWords 便于检索；不要锁剧情自由度。
3. 有发声台词的人物 voice 必须非空（写音色、语速、口癖）；无台词人物 voice 给空字符串。
4. voiceRef 写可参考的声音类型；promptName 是喂给生图模型的稳定提示词锚点（短词组即可）。
5. locations[].orientation 写机位朝向与空间关系；props[].states 的 from / to 用集号或场次号。
6. 不要生成图片，只输出设定文本；缺失字段写「暂无」。

【严格返回 JSON】只输出严格 JSON，不要解释，不要 markdown 代码块：
{
  "productionStyle": "整体制作风格与画面基调",
  "eraSetting": "年代与地域设定",
  "characters": [{
    "name": "角色名",
    "appearance": "跨场不变的外貌",
    "variants": [{"name":"阶段名","appearance":"该阶段外观","episodes":"适用集号"}],
    "voice": "有台词必填音色语速",
    "voiceRef": "声音参考类型",
    "lockWords": ["外观锁定词"],
    "promptName": "生图提示词锚点"
  }],
  "locations": [{"name":"场景名","appearance":"空间与陈设","orientation":"机位朝向与空间关系"}],
  "props": [{"name":"道具名","appearance":"常态外观","states":[{"state":"状态","from":"起始集场","to":"结束集场"}]}],
  "continuityLocks": [{"id":"LOCK-001","label":"锁什么","scope":"适用范围","lockWords":["锁定词"]}]
}`

/* 来源：drama-skills (MIT, zenstory-ai/drama-skills contributors) · 迁移日期：2026-11-25
   分镜 / 首尾帧：每场戏有镜头覆盖，SHOT 编号 EP001-S001 稳定形式；首帧定起点、尾帧定终点，运镜写清起止落点。 */
const SCRIPT_STORYBOARD_SYSTEM = `你是短剧「分镜师 / 首尾帧设计师」。把剧本拆成可逐镜生成的分镜表。

【硬要求】
1. 每一场戏至少有一个镜头覆盖；uncoveredScenes 列出无法覆盖的场次（没有就给空数组）。
2. id 用 EP001-S001 形式稳定编号：EP + 三位集号 + -S + 三位场次号；episode / sceneNo 与 id 对应。
3. startFrame 只定格起点，endFrame 只定格终点；firstFramePrompt / lastFramePrompt 分别描述这两帧（含景别、构图、光线、人物状态）。
4. movement 写清运镜起止落点（从哪到哪、快或慢）；camera 写景别与机位；blocking 写多人走位与视线转移。
5. refImages 是图片槽位，统一用 PLAN-xxx 占位（前端暂无真实图片），不要编造图片 URL。
6. durationSec 按单集时长合理拆分；sound 写同期声、环境声与音乐点。
7. 只输出文本分镜，不生成媒体。

【严格返回 JSON】只输出严格 JSON，不要解释，不要 markdown 代码块：
{
  "shots": [{
    "id": "EP001-S001",
    "episode": 1,
    "sceneNo": 1,
    "shotType": "景别",
    "camera": "机位",
    "movement": "运镜起止落点",
    "startFrame": "起点画面",
    "action": "本镜动作推进",
    "endFrame": "终点画面",
    "sound": "声音设计",
    "blocking": "走位与视线转移",
    "firstFramePrompt": "首帧生图提示词",
    "lastFramePrompt": "尾帧生图提示词",
    "refImages": ["PLAN-001"],
    "durationSec": 4
  }],
  "uncoveredScenes": ["未覆盖场次"],
  "summary": "整体分镜说明"
}`

/* 来源：drama-skills (MIT, zenstory-ai/drama-skills contributors) · 迁移日期：2026-11-25
   视频提示词：单镜动作推进、多人调度与视线转移、运镜、声音、GROUP-* 多镜合生、跨镜配乐表；不生成媒体。 */
const SCRIPT_VIDEO_PROMPTS_SYSTEM = `你是短剧「AI 生视频提示词」导演。基于分镜表写逐镜提示词。

【硬要求】
1. shots[].shotId 必须对应分镜 id；prompt 按「景别 + 构图 + 光线 + 人物外观锁定词 + 单镜动作推进 + 运镜起止 + 声音」顺序写，一条镜头只推进一个动作。
2. 多人镜头写清调度与视线转移；continuityRefs 引用视觉设定的 continuityLocks id 或 lockWords，保证跨镜不穿帮。
3. groups 用 GROUP-* 编号（GROUP-001 起），shotIds 引用 shots[].shotId；prompt 写多镜合生的统一氛围与动作衔接，不要逐镜复述。
4. musicPlan 按集列情绪与描述；episode 从 1 连续编号。
5. 不生成媒体、不返回图片或视频 URL，只输出提示词文本。

【严格返回 JSON】只输出严格 JSON，不要解释，不要 markdown 代码块：
{
  "shots": [{
    "shotId": "EP001-S001",
    "prompt": "单镜视频提示词",
    "action": "单镜动作推进",
    "movement": "运镜起止落点",
    "camera": "景别与机位",
    "sound": "声音设计",
    "continuityRefs": ["LOCK-001"],
    "durationSec": 4
  }],
  "groups": [{"id":"GROUP-001","shotIds":["EP001-S001"],"prompt":"多镜合生提示词"}],
  "musicPlan": [{"episode":1,"mood":"情绪","description":"配乐描述"}]
}`

/* 来源：drama-skills (MIT, zenstory-ai/drama-skills contributors) · 迁移日期：2026-11-25
   结构 / 剧情审查：只列核对结果与建议、不替人做创作判断；severity 归一化为 high/medium/low。 */
const SCRIPT_REVIEW_SYSTEM = `你是短剧「结构 / 剧情 / 连戏」审查员。只做核对，不做创作决定。

【硬要求】
1. score 为 0-100 的综合分，verdict 给一句结论。
2. structural / plot / continuity 三类各列问题；每条 issue 写清核对结果，suggestion 只给可执行的修正方向，不替用户改写正文。
3. severity 只能是 high / medium / low 三选一；没有问题就给空数组。
4. strengths 只列核对中确实成立的优点，不要泛泛夸奖。
5. 引用剧本、分镜或提示词里真实存在的场次或镜号；没有依据的问题不要列。

【严格返回 JSON】只输出严格 JSON，不要解释，不要 markdown 代码块：
{
  "score": 78,
  "structural": [{"issue":"核对发现的问题","severity":"high","suggestion":"修正方向"}],
  "plot": [{"issue":"核对发现的问题","severity":"medium","suggestion":"修正方向"}],
  "continuity": [{"issue":"核对发现的问题","severity":"low","suggestion":"修正方向"}],
  "strengths": ["确实成立的优点"],
  "verdict": "一句话结论"
}`

/* 来源：drama-skills (MIT, zenstory-ai/drama-skills contributors) · 迁移日期：2026-11-25
   对标拆解：按集长/镜长/对白密度/开场与集尾拆解，反推为剧本/设定可用轮廓；字段缺失写「暂无」不编造。 */
const SCRIPT_BREAKDOWN_SYSTEM = `你是短剧「对标拆解员」。用户贴一段对标剧集文本（分集梗概、剧本片段或平台文案），你要反推其结构与节奏。

【硬要求】
1. avgEpisodeSec / avgShotSec 只填能从文本算出的数字；算不出写「暂无」，不要猜。
2. dialogueDensity 写对白密度（如「每集约 20 句」）；算不出写「暂无」。
3. openingPattern / endingPattern 分别概括开场钩子套路与集尾悬念套路；文本没有就写「暂无」。
4. beats[].position 用「开篇 / 10% / 30% / 50% / 70% / 集尾」等位置标签，type 用「钩子 / 冲突 / 反转 / 爽点 / 悬念」之一，description 一句话。
5. gaps 列出对标文本的缺口（如缺人物设定、缺镜长数据），不要脑补补全。
6. reverseOutline 把拆解结果反推成可用的剧本 / 设定轮廓，index 从 1 连续，每条 title 与 summary 各一句话。
7. 字段缺失统一写「暂无」，不编造精确数字。

【严格返回 JSON】只输出严格 JSON，不要解释，不要 markdown 代码块：
{
  "avgEpisodeSec": 90,
  "avgShotSec": 4,
  "dialogueDensity": "每集约 20 句",
  "openingPattern": "开场钩子套路",
  "endingPattern": "集尾悬念套路",
  "beats": [{"position":"开篇","type":"钩子","description":"一句话描述"}],
  "gaps": ["文本缺口"],
  "reverseOutline": [{"index":1,"title":"轮廓标题","summary":"一句话梗概"}]
}`

/* ============================================================
   v10.10 新增二：文风炼金（StyleForge）
   把用户一段「我还说不清楚的文风描述」炼成一张可套用的文风卡
   ============================================================ */
const STYLE_FORGE_SYSTEM = `你是「文风炼金师」。用户会给你一段对自己想要什么文风的描述（可能很口语、很模糊、甚至自相矛盾）。
你要把它炼成**一张可以立刻套用的文风卡**——和预置卡同结构：卡名 / 标签 / 效果说明 / 示例原文 / 写入画布的规范文案。

【硬要求】
1. 把模糊变成可执行：不许出现「写得美一点」「有质感」这类空泛要求。每一条都要落到**可检查的动作**上：
   句长、句式、视角、人称、时态、用词冷暖、形容词密度、标点习惯、段落长度、留白程度、禁忌。
2. 效果说明（effect）要让用户读完后能明确回答「我的文风会变成什么样」，150-260 字，写清：
   整体气质 / 句法 / 视角 / 用词 / 节奏 / 细节偏好 / 禁忌 / 适合写什么题材。
3. 示例原文（quotes）：**自己写** 6 段，每段 20-60 字，必须是原创、不得抄袭任何真实作品原文，
   不得冒充名家；每段都要让人一读就感受到这个味道，风格之间不要重复。
4. applyText：写入【文笔】画布的完整规范文案，分条列出（整体气质/句法/视角/用词/节奏/细节/禁忌），
   可直接作为模型硬约束。
5. sample：现场写一段 200-320 字的盲测示例（题材用「一个雨夜，有人来敲门」这类通用情境即可，不要沿用用户原文情节），
   让用户验证是不是他要的味道。
6. warnings：如果用户的描述里有互相冲突、或会导致文风模糊的地方，用大白话指出来（可为空数组）。
   禁止使用任何写作专业术语（三幕式、叙事弧、母题、人物弧光之类），全部用大白话。

【严格返回 JSON】（不要解释、不要 markdown 包裹）：
{
  "name": "文风卡名（≤14字，有辨识度，不要带书名号）",
  "tagline": "3 个词标签，用 · 分隔",
  "effect": "150-260字，这张卡会让文风变成什么样",
  "quotes": ["示例原文1", "...共6段"],
  "applyText": "写入画布的完整规范文案（分条，\\n 换行）",
  "sample": "200-320字盲测示例段落",
  "warnings": ["冲突提示（可为空数组）"]
}`

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

// ── 图片识别拆解：用户上传思维导图/大纲图/设定图/手写笔记，识别后分配到 7 画布 ──
const IMAGE_DISSECT_SYSTEM = `你是文本与结构识别专家。用户上传了一张图片：可能是思维导图、故事大纲图、世界观设定图、人物关系图、手写笔记或资料截图。

请你：
1. 先完整识别图中可见的文字与结构关系（分支、层级、箭头、时间线、表格等，保留原有信息不要遗漏）；
2. 再把识别到的内容按 7 个维度归纳成小说创作设定，填进对应画布。

严格返回 JSON（不要解释、不要 markdown 包裹），七个键必须齐全：
{
  "设定": "世界观、时代背景、特殊规则（80-150字）",
  "人物": "主要人物姓名、身份、关系网（80-150字）",
  "文笔": "语气、句法、修辞风格（80-150字）",
  "结构": "章节组织、叙事顺序、视角（80-150字）",
  "篇幅": "长度、节奏分布、详略安排（80-150字）",
  "情节": "主线冲突、因果链条、悬念设置（80-150字）",
  "节奏": "张力曲线、高潮分布、快慢交替（80-150字）"
}
要求：
- 七个键一个都不能少，值都是纯字符串
- 忠实于图中实际内容，不要凭空编造；图中没有的维度就明确写「图中未体现此维度」
- 若图是思维导图/大纲，请把各分支的层级关系分别归纳进对应维度，不要只堆砌关键词`

/**
 * 视觉识别：优先用配置的 VISION_ENDPOINT（OpenAI 兼容 /chat/completions，带 image_url），
 * 否则走 DeepSeek 的 Anthropic 兼容端点（该端点原生支持 image content block）。
 * 注意：若当前 DeepSeek 模型不支持读图，会返回明确错误，此时请把视觉端点配到 VISION_* 上。
 */
async function callVisionLLM(env, { system, userText, imageBase64, mimeType, maxOutputTokens = 16000 }) {
  const mime = toStr(mimeType) || 'image/png'
  // v10.17 免费引擎读图：GLM/Qwen 是纯文本模型，换 Workers AI 上的免费视觉模型
  if (env.__engine === ENGINE_FREE) {
    return callFreeVision(env, { system, userText, imageBase64, maxOutputTokens })
  }
  if (env.VISION_API_KEY && env.VISION_ENDPOINT) {
    const url = String(env.VISION_ENDPOINT).replace(/\/$/, '') + '/chat/completions'
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.VISION_API_KEY}` },
      body: JSON.stringify({
        model: env.VISION_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
              { type: 'text', text: userText },
            ],
          },
        ],
        max_tokens: maxOutputTokens,
      }),
    })
    if (!resp.ok) throw new Error(`Vision ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
    const data = await resp.json()
    const text = (data.choices?.[0]?.message?.content || '').trim()
    if (!text) throw new Error('视觉模型返回为空')
    return parseJsonLoose(text)
  }

  // 默认：DeepSeek Anthropic 兼容端点（image content block）
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.DEEPSEEK_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxOutputTokens,
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } },
            { type: 'text', text: userText },
          ],
        },
      ],
    }),
  })
  if (!resp.ok) throw new Error(`DeepSeek(视觉) ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const data = await resp.json()
  const text = (Array.isArray(data.content) ? data.content : [])
    .filter(b => b?.type === 'text')
    .map(b => b.text || '')
    .join('\n')
    .trim()
  if (!text) throw new Error('视觉识别返回为空（当前模型可能不支持读图）')
  return parseJsonLoose(text)
}

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

// 联网版：先检索同类型优秀范文作为风格参照，再修改（webSearch 开启时使用）
const REVISE_SYSTEM_WEB = `你是文稿润色编辑。根据用户提供的「原文」和「修改要求」（来自 7 个画布的设定）修改原文；当联网开启时，先检索与本作品【同类型】的优秀范文作为风格参照，再据此润色。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "revised": "修改后的完整文本",
  "changes": ["改动说明1", "改动说明2"],
  "references": ["用到的参考来源（作品名/作者，纯文字，禁止列网址）"]
}
要求：
- revised 必须是修改后的完整文本，不是片段、不是摘要
- 联网开启时：先调用 web_search 检索与本作品【同类型（同题材/同风格/同流派，可由「文笔」「设定」画布与题材推断，如武侠/古风/都市/悬疑/言情等）】的 2-3 篇优秀范文或名篇片段；提炼其可取的表达手法、节奏把控、意象运用、对白质感，作为风格参照融入本次修改
- 严格遵循【文笔】画布描述的语气、句法、意象，同时可借鉴检索到的同类型佳作来提升文物质感，但不得生硬套用、不得照抄原句
- 保留原文的核心情节与人物，只改表达，不要另起炉灶
- references 列出本次实际参考的来源（作品名/作者）；检索不到可靠同类型范文时写「未检索到可靠同类型范文」
- changes 列出 3-5 条主要改动说明（其中可说明借鉴了哪些参照）
- 严禁在 JSON 字符串值里写裸换行/回车；段落换行一律用 \\n 表示，否则 JSON 会解析失败`

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

// 联网版：先检索同类型优秀范文作为风格参照，再续写（webSearch 开启时使用）
const CONTINUE_SYSTEM_WEB = `你是小说续写助手。根据用户提供的「已有文本」和「续写要求」（来自 7 个画布的设定）续写正文；联网开启时，先检索与本作品【同类型（同题材/同风格/同流派）】的优秀范文作为风格参照，再接着往下写。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "continuation": "续写的正文（600-1200字）",
  "rationale": "为什么这样续写（1-3 句，说明依据了哪些画布设定）",
  "references": ["用到的参考来源（作品名/作者，纯文字，禁止列网址）"]
}
要求：
- 延续已有文本的人物姓名、说话口吻、世界观设定
- 严格遵循【文笔】画布的语气与句法
- 按【情节】画布推进主线，按【节奏】画布控制张力
- 不要复述或重复已有内容，直接接着往下写
- 联网开启时：先调用 web_search 检索与本作品【同类型】的 2-3 篇优秀范文或名篇片段，提炼其可取的表达手法、节奏与意象运用作为风格参照融入续写；references 列出实际参考来源，检索不到时写「未检索到可靠同类型范文」
- 严禁在 JSON 字符串值里写裸换行/回车；段落换行一律用 \\n 表示`

const REFINE_SYSTEM = `你是文学分析编辑。用户会给你【某个维度的现有分析内容】和一条【修改要求】（可能只是一个关键词、一句话，也可能很具体）。请按要求改写这段内容。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "refined": "改写后的内容（纯字符串）"
}
要求：
- 只改这一段，不要扩张成其它维度的内容
- 用户给的是关键词时，围绕关键词补充/重写，而不是干巴巴塞进一个词
- 保留原内容里有价值的事实、专有名词、人物名；除非用户明确要求替换
- 保持中文、简洁、可直接粘回画布的成稿语气；不要出现「根据要求」「改写如下」这类元话语
- refined 必须是字符串，禁止嵌套对象/数组`

/* ============================================================
   v10.72 · 机器人代笔（botWrite）
   ------------------------------------------------------------
   为什么不能复用 refine：refine 的系统提示是「文学分析编辑……只改这一段……
   保持简洁」，那是给画布维度润色用的。拿它写整章，机器人的人格会被
   "编辑腔 + 简洁" 覆盖 —— 写出来既不像它，也写不长。
   这一条把主语换成「你本人就是作者」，并要求只交正文。
   ============================================================ */
const BOT_WRITE_SYSTEM = `你是一位有独立人格的作者。用户会给你【你的自述】（你是谁、你怎么看世界、你信什么）、【这一章要写什么】、【你手上的材料】、【写作要求】。

请以**你自己**的身份把这一章写出来，然后严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "refined": "正文全文（纯字符串）"
}

要求：
- 你是作者本人，不是助理，也不是编辑。用你自己的性情、审美和偏见去写，允许有立场、有取舍。
- 不要写提纲、不要解释你怎么想的、不要写作者按、不要出现「以下是本章」这类开场白。
- 字数按【写作要求】里的数字写，**不要压缩成梗概**，也不要靠重复凑字。宁可写少一点也不要注水。
- 材料里的前文必须承接：人名、设定、时间线一律不得矛盾，不要另起炉灶。
- 只输出纯正文：不要分点、不要 markdown 标记、不要小标题（除非原文本来就有）。`

// 联网版：先检索同类型优秀范文作为风格参照，再改写画布内容（webSearch 开启时使用）
const REFINE_SYSTEM_WEB = `你是文学分析编辑。用户会给你【某个维度的现有分析内容】和一条【修改要求】；联网开启时，先检索与本作品【同类型（同题材/同风格/同流派）】的优秀范文作为风格参照，再按要求改写。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "refined": "改写后的内容（纯字符串）",
  "references": ["用到的参考来源（作品名/作者，纯文字，禁止列网址）"]
}
要求：
- 联网开启时：先调用 web_search 检索与本作品【同类型】的 2-3 篇优秀范文或名篇片段，提炼其可取的表达手法、意象与节奏，作为风格参照融入本次改写；references 列出实际参考来源，检索不到时写「未检索到可靠同类型范文」
- 只改这一段，不要扩张成其它维度的内容
- 用户给的是关键词时，围绕关键词补充/重写，而不是干巴巴塞进一个词
- 保留原内容里有价值的事实、专有名词、人物名；除非用户明确要求替换
- 保持中文、简洁、可直接粘回画布的成稿语气；不要出现「根据要求」「改写如下」这类元话语
- 严禁在 JSON 字符串值里写裸换行/回车；段落换行一律用 \\n 表示
- refined 必须是字符串，禁止嵌套对象/数组`

// v10.57：画布间冲突检测 —— 给定 7 块画布的 key + 中文维度名 + 内容，判断哪些画布互相矛盾
const CONFLICT_SYSTEM = `你是写作设定的一致性审查员。用户给了 7 块画布（设定 / 人物 / 文笔 / 结构 / 篇幅 / 情节 / 节奏），每块都标了英文 key 和中文维度名，下面是它们的全部内容。

请找出「明显互相冲突」的画布对，例如：
- 篇幅说总字数（如 20 万字），但结构说章节数 × 单章字数远远对不上（如 15 章 × 800 字 ≈ 1.2 万字）
- 结构说的章节数，和情节里写出的章纲/事件数严重不匹配
- 设定里点名的重要人物，在「人物」画布里完全没出现（或反过来）
- 节奏（如「每章快节奏推进」）与篇幅/结构的体量明显矛盾
- 情节主线规模（如「三大家族权谋」）与人物画布只列了一两个角色对不上

判断标准：只报「确实会打架、不修就写不下去或前后矛盾」的冲突，不要吹毛求疵（风格差异、详略不同不算冲突）。
每块画布可能为空（还没填），空画布不参与冲突判断（除非另一块明确引用了它的内容）。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "conflicts": [
    {
      "a": "<第一块画布的英文 key，必须原样照抄>",
      "b": "<第二块画布的英文 key，必须原样照抄>",
      "reason": "一句话说明冲突在哪（中文，大白话，点出具体数字/名字矛盾，例如：篇幅写 20 万字，但结构只有 15 章×800 字≈1.2 万字，差太多）"
    }
  ]
}
要求：
- a / b 必须是输入里出现的英文 key，禁止编造
- 每对冲突只出现一次；最多报告 6 对最严重的
- reason 要具体、能直接给用户看，不要写「存在冲突」这种废话
- conflicts 没有就返回空数组 []`

const CHAPTER_WRITE_SYSTEM = `你是小说家。基于「7 块画布设定」「完整大纲」「前 N-1 章已写好的正文」，按用户给的本章设置，撰写指定的一章正文。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "content": "本章正文（按用户给的 targetWords 浮动 ±20%，不少于 targetWords 的 60%）",
  "rationale": "写作思路（1-3 句，说明本章如何承接上文、推进大纲、落实用户要求）"
}
要求：
- 严格遵循【文笔】画布的语气、句法、意象
- 严格遵循用户给的目标字数 targetWords
- 严格遵循用户选定的 purpose（transition=承上启下、main-plot=推进主线、reveal=揭示谜底、ending=交代结局、pure-scene=纯场景）
- 用户的「其他要求」必须明确执行（让 AI 理解并落实）
- 人物姓名、世界观名词与「前 N-1 章」保持一致，不得自相矛盾
- 如果前文已建立人物口吻/关系/伏笔，本章必须接住
- 不要总结、不要「本章完」、不要作者按语；正文直接结束在场景或对话中`

// 联网版：先检索同类型优秀范文作为风格参照，再写章（webSearch 开启时使用）
const CHAPTER_WRITE_SYSTEM_WEB = `你是小说家。基于「7 块画布设定」「完整大纲」「前 N-1 章已写好的正文」，按用户给的本章设置撰写指定的一章正文；当联网开启时，先检索与本作品【同类型】的优秀范文作为风格参照，再据此写作。

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "content": "本章正文（按用户给的 targetWords 浮动 ±20%，不少于 targetWords 的 60%）",
  "rationale": "写作思路（1-3 句，说明本章如何承接上文、推进大纲、落实用户要求）",
  "references": ["用到的参考来源（作品名/作者，纯文字，禁止列网址）"]
}
要求：
- 严格遵循【文笔】画布的语气、句法、意象
- 严格遵循用户给的目标字数 targetWords
- 严格遵循用户选定的 purpose（transition=承上启下、main-plot=推进主线、reveal=揭示谜底、ending=交代结局、pure-scene=纯场景）
- 用户的「其他要求」必须明确执行（让 AI 理解并落实）
- 人物姓名、世界观名词与「前 N-1 章」保持一致，不得自相矛盾
- 如果前文已建立人物口吻/关系/伏笔，本章必须接住
- 联网开启时：先调用 web_search 检索与本作品【同类型（同题材/同风格/同流派，可由「文笔」「设定」画布推断）】的 2-3 篇优秀范文或名篇片段，提炼其可取的表达手法、节奏与意象运用作为风格参照，融入本章写作；references 列出实际参考来源（作品名/作者），检索不到时写「未检索到可靠同类型范文」
- 严禁在 JSON 字符串值里写裸换行/回车；段落换行一律用 \\n 表示，否则 JSON 会解析失败
- 不要总结、不要「本章完」、不要作者按语；正文直接结束在场景或对话中`

/* ============================================================
   PRD「新手脑洞共创模式」三个新 action 的系统提示词
   硬约束（来自 PRD 第五节）：禁止专业术语、禁止输出大段正文、
   所有建议以选择题呈现、尊重锁定设定、只搭骨架骨架不写正文
   ============================================================ */

/** 全局禁用词提醒，所有新手模式提示词共用 */
const NO_JARGON = `【用词硬约束】禁止出现任何写作专业术语，包括但不限于：三幕式、节拍表、麦高芬、叙事弧、人物弧光、伏笔回收率、叙事视角、母题、原型、节拍、序列、主题先行、戏剧冲突理论。全部用大白话表达（例如不说「三幕式」而说「开头—中间—结尾怎么安排」）。`

const BRAINSTORM_EXTRACT_SYSTEM = `你是小说创作助手，服务的用户是**完全不懂写作结构的新手**。他只给了一段零散的脑洞（可能一句话、一个人设、一个名场面，甚至几个关键词）。

你的任务：把这段脑洞读明白，提取出 4 个核心要素，然后把它变成 4 组**选择题**让用户确认。用户可以完全不动笔，只点选项。

${NO_JARGON}

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "readback": "先把用户的脑洞用自己的话复述一遍（1-2 句，让用户觉得『你懂我』）",
  "elements": {
    "protagonist": "主角是谁（一句话）",
    "desire": "他/她最想要什么（一句话）",
    "conflict": "挡在他/她面前的核心阻力是什么（一句话）",
    "ending": "故事大概往哪个方向收（一句话）"
  },
  "questions": [
    {
      "key": "protagonist",
      "label": "主角人设",
      "question": "主角是个什么样的人？（先按你的理解选了，不满意就换一个）",
      "options": [
        { "label": "选项的短标题（4-10 字）", "detail": "这个选项具体意味着什么（一句话，大白话）" }
      ]
    },
    { "key": "conflict", "label": "核心矛盾", "question": "…", "options": [...] },
    { "key": "theme", "label": "故事主题", "question": "…", "options": [...] },
    { "key": "ending", "label": "结局走向", "question": "…", "options": [...] }
  ]
}

要求：
- questions 必须正好 4 组，key 依次是 protagonist / conflict / theme / ending，顺序不能变
- 每组 options **必须给 3 个**，且互斥、有明显差异（不要三个都差不多）
- **第一个选项就是你对用户脑洞的理解**，让用户不动手也能一路点「下一步」
- 选项必须具体、有画面感，不要空话（反例：「人物性格鲜明」；正例：「嘴硬心软的落魄少爷」）
- 如果用户的脑洞信息量很少，就大胆补齐——你是来帮他做决定的，不是来提问的
- 全程禁止开放式提问（不能出现「请描述…」「请填写…」），只能给选项`

const BRAINSTORM_GROW_SYSTEM = `你是小说创作助手，正带着一个**完全不懂写作结构的新手**，从他的脑洞一步一步长出完整的小说框架。

成长分 4 层，**由粗到细**，一次只做一层。前端会分步展示，所以你这一层的产出必须聚焦、不能越界把后面几层的内容也写了。

${NO_JARGON}

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "layer": 数字（原样回传请求里的 layer）,
  "headline": "这一层的小标题（如『一句话故事』）",
  "variants": ["版本A", "版本B", "版本C"],
  "display": ["给用户看的第一条", "第二条"],
  "canvasPatch": { "维度名": "写进这块画布的内容" }
}

各层要求：

**layer=1 · 一句话故事 + 核心主题**
- variants 必须给 **3 个**不同版本的一句话故事（**这就是全部内容**，不是大纲、不是梗概段落，就是一句话）
- display 给 2 条：第 1 条是最推荐的那句话，第 2 条是核心主题（一句话）
- canvasPatch 填两块：「设定」= 世界观与基调（3-5 句大白话）、「情节」= 主线的起承转合走向（5-8 句大白话）
- 严禁写正文段落、严禁写成大纲分章

**layer=2 · 故事骨架**
- 固定 5 个阶段，display 每条格式为「开端：……」这样一行
- 5 条依次是：开端 / 升级 / 危机 / 转折 / 结局，每条 15-40 字，说清"这里发生了什么"
- variants 留空数组
- canvasPatch 填「结构」= 完整五段骨架（每段一行，可再补一句这一段的情绪基调）

**layer=3 · 人物与关系**
- display 给 3-5 条，每条一个角色：「角色名（身份）：想要什么 / 怕什么 / 和主角什么关系」
- 至少要有一个对手/阻力方
- variants 留空数组
- canvasPatch 填「人物」= 完整人物设定（主角 + 主要配角 + 关系与动机，每条一行）

**layer=4 · 文笔、节奏、篇幅**
- display 给 3 条：文笔风格一句话 / 节奏一句话 / 篇幅一句话
- variants 留空数组
- canvasPatch 填三块：
  - 「文笔」= 语气、句法、意象偏好（大白话，可举例"像谁在讲故事"）
  - 「节奏」= 哪几段快、哪几段慢、情绪起伏怎么走
  - 「篇幅」= 预估总字数 + 建议章节数 + 单章字数

通用要求：
- 每一层的产出都要能直接塞进画布，是**成稿语气**，不要出现「建议」「可以这样写」这类元话语
- canvasPatch 的键只能是这 7 个之一：设定、人物、文笔、结构、篇幅、情节、节奏
- 严禁输出大段小说正文（这是搭框架阶段，不是写书阶段）`

// 联网版：在基础提示之上追加「先检索同类型优秀作品」的要求（继承 NO_JARGON 硬约束）
const BRAINSTORM_GROW_SYSTEM_WEB = `${BRAINSTORM_GROW_SYSTEM}

【联网模式（用户已开启）】
- 先用 web_search 检索与这个脑洞【同类型（同题材/同风格/同流派）】的 2-3 部优秀作品或其经典桥段作为参考
- 在严格返回上述 JSON 的同时，**额外**返回一个 "references" 字段：["作品名/作者（纯文字，禁止列网址）", …]，列出你实际参考的来源；检索不到就写「未检索到可靠同类型范文」
- 参考只用来让选项与建议更扎实、更有画面感，不得照抄原句，也绝不能因此引入写作专业术语（三幕式、人物弧光等一律禁止）
- 严禁在 JSON 字符串值里写裸换行/回车；换行一律用 \\n 表示`

const HEALTH_SYSTEM = `你是小说创作助手，正在帮一个**完全不懂写作理论的新手**做「故事体检」。

你会拿到他 7 块画布上的全部设定。请像一个懂行的朋友那样，指出**最值得改的 3-5 个问题**，每个问题给出 2-3 个「怎么办」的选项，用户点一下就能修。

${NO_JARGON}

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "summary": "整体评价（1-2 句大白话，先说好的地方，再点出最要紧的问题）",
  "score": 0-100 的整数（整体完成度，别给虚高的满分）,
  "issues": [
    {
      "id": "1",
      "dimension": "问题所在画布（只能是：设定 / 人物 / 文笔 / 结构 / 篇幅 / 情节 / 节奏）",
      "problem": "问题是什么（一句话大白话，像朋友提醒你那样说）",
      "why": "为什么这是个问题（1-2 句，说清后果，比如『读者会觉得莫名其妙』）",
      "options": [
        { "label": "选项短标题（6-14 字，用户点这个）", "fix": "选了以后要 AI 怎么改这块画布的具体指令（要能直接执行）" }
      ]
    }
  ]
}

要求：
- issues 给 3-5 个，**按严重程度从高到低排**
- 每个 issue 的 options **必须给 2-3 个**，互斥且有明显不同的方向
- dimension 必须是那 7 个词之一，它是修复时要改的画布
- 必须真的去看内容再说话：画布是空的、前后矛盾的、人设和行为对不上的，都要指出来
- 如果某块画布是空的，就把它当成问题提出来（例如「人物这块还是空的，AI 写的时候只能瞎编」）
- 禁止空话（反例：「建议丰富人物形象」）；每条都要指向具体的地方（反例：「主角在第 3 章做的事和第 5 章的立场对不上」）
- 绝对不要输出修改后的正文，你只负责诊断和给选项`

const BRAINSTORM_OUTLINE_SYSTEM = `你是小说创作助手。用户是新手，刚刚用脑洞共创模式搭好了故事框架（7 块画布都已填好）。现在要把它变成一份**章节清单**，好让他能一章一章往下写。

${NO_JARGON}

严格返回 JSON（不要解释、不要 markdown 包裹）：
{
  "title": "书名（有记忆点，6-14 字，不要《》括号）",
  "synopsis": "作品简介（3-5 句，像小说网站上的简介那样，有钩子）",
  "outline": [
    {
      "index": 1,
      "title": "本章标题（6-14 字，有画面感，不要『第一章』这种）",
      "summary": "本章写什么（40-80 字，说清这一章发生的事和它推进了什么）",
      "tag": "开局 | 推进 | 高潮 | 反转 | 收束 五选一",
      "words": 本章建议字数（整数，2000-5000 之间）
    }
  ]
}

要求：
- outline 给 **10-16 章**，覆盖完整故事：开局 1-2 章、推进占大头、高潮与反转放在后段、收束 1-2 章
- index 必须从 1 开始连续递增
- tag 只能取 开局 / 推进 / 高潮 / 反转 / 收束 之一；开局只出现在最前，收束只在最后
- 每章 summary 必须是**具体的事件**，不要写「主角继续成长」这种空话
- 严格依据画布里的【结构】（五段骨架）和【情节】来分章，不要另起炉灶
- **绝对不要写任何正文段落**——你只输出章节清单`

// 联网版：在基础提示之上追加「先检索同类型优秀作品」的要求（继承 NO_JARGON 硬约束）
const BRAINSTORM_OUTLINE_SYSTEM_WEB = `${BRAINSTORM_OUTLINE_SYSTEM}

【联网模式（用户已开启）】
- 先用 web_search 检索与这个故事【同类型（同题材/同风格/同流派）】的 2-3 部优秀作品的分章节奏作为参考，看看同类作品通常怎么分章、高潮放在哪
- 在严格返回上述 JSON 的同时，**额外**返回一个 "references" 字段：["作品名/作者（纯文字，禁止列网址）", …]，列出你实际参考的来源；检索不到就写「未检索到可靠同类型范文」
- 参考只用来让章节划分更合理，不得照抄，也绝不能因此引入写作专业术语
- 严禁在 JSON 字符串值里写裸换行/回车；换行一律用 \\n 表示`

/* ============================================================
   存储层（KV + D1）—— 对应 PRD《Cloudflare自动化部署版本》第 2/4/5 节
   绑定：WRITER_KV（画布/原子设定/快照/分支/权重/应用状态）
        WRITER_D1（项目元信息/权重日志/案例库/章节索引/备份日志）
        WRITER_BACKUP（R2 备份桶，未开通则自动降级）
   ============================================================ */

const STATE_KEY = 'app:state:v1'
const LAST_BACKUP_KEY = 'app:backup:last'
/** 记录单用户时代的老存档被哪个账号接管，防止多账号重复继承 */
const LEGACY_TAKEN_KEY = 'app:legacy:taken'

/* ---- KV 多版本备份（R2 未开通时的正式方案，不再是「临时降级」）----
   元信息与压缩体分键存放：列备份时只读元信息，避免把几十 MB 的包读进内存。
   键名里的 stamp 是 ISO 时间的变体，字典序即时间序，排序不用额外解析。 */
const BACKUP_ITEM_KEY = 'app:backup:item:'
const BACKUP_DATA_KEY = 'app:backup:data:'
/** 备份索引：一个键存最近的备份清单。
    KV 的「列出键」是最终一致的（最长 60s 才可见），刚做的备份会从列表里消失，
    所以列表一律读这个索引，不依赖 list。 */
const BACKUP_INDEX_KEY = 'app:backup:index'
/** 每份备份保留最近多少份，超出的自动裁剪 */
const BACKUP_KEEP = 14

/* ============================================================
   v10.64：用户作品库「独立储存库」（KV 绑定 WRITER_ASSETS）
   ------------------------------------------------------------
   为什么：2026-10-11 出过一次事故 —— 一台本地没有存档、又没读成功云端的设备，
   把「空作品库」回写上去，覆盖了云端 6 本作品。前端逻辑修了（v10.63 三道闸），
   但「前端版本动不动得了用户资产」不该靠前端自觉。
   所以把作品库**物理隔离**到另一个 KV 命名空间，并且：
     · 只由本 worker 写入（前端没有任何直接写它的通道）；
     · 服务端守卫：回写要把作品库从非空变空时，直接保留已知的非空版本
       （除非前端显式带上 libraryCleared:true，即用户主动点了「清空作品库」）；
     · 每次保存顺带留一份历史快照（按内容去重，保留最近 ASSET_KEEP 份）。
   结论：网页/Worker 怎么更新，用户的作品库都不会丢。
   ============================================================ */
const ASSET_LIBRARY_KEY = 'library:v1'
const ASSET_LIBRARY_SNAP_PREFIX = 'library:snap:'
/** 快照去重用的指纹键（刻意不带 snap: 前缀，避免被快照列举/裁剪误伤） */
const ASSET_LIBRARY_SNAPINDEX_KEY = 'library:snapindex'
const ASSET_KEEP = 30

/** 作品库独立储存库句柄；没绑定时返回 null（降级：功能照旧，只是少了这层保护） */
function assetsKv(env) {
  return env.WRITER_ASSETS || null
}

async function assetGetJson(env, key) {
  const kv = assetsKv(env)
  if (!kv) return null
  const raw = await kv.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function assetPutJson(env, key, value) {
  const kv = assetsKv(env)
  if (!kv) return false
  await kv.put(key, JSON.stringify(value))
  return true
}

async function assetListAll(env, prefix = '') {
  const kv = assetsKv(env)
  if (!kv) return []
  const keys = []
  let cursor
  do {
    const res = await kv.list({ prefix, cursor })
    for (const k of res.keys || []) keys.push(k.name)
    cursor = res.list_complete ? null : res.cursor
  } while (cursor)
  return keys
}

/** 作品库指纹（内容去重 / 判断是否需要新快照） */
function libraryHash(books) {
  const s = JSON.stringify(books || [])
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${(h >>> 0).toString(16)}:${s.length}`
}

/** 从若干候选里挑「非空且最长」的作品库（守卫的兜底依据：宁可多留，不能变空） */
function pickLibrary(...candidates) {
  let best = []
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > best.length) best = c
  }
  return best
}

/**
 * 作品库守卫（v10.64 核心）：**不会被清空**。
 * 注意准确的语义边界（独立验证 R4 指出原注释过度承诺）：
 *   · 拦的是「非空 → 空」；
 *   · 「6 本 → 1 本」这类**用户主动删书**属合法操作，会放行（软删除走 trash，历史另有快照兜底）。
 * @returns {{ library: any[], guarded: boolean }}
 *  incoming 为空、已知有书、且不是用户显式清空 → 保留已知版本，并标记 guarded。
 */
export function applyLibraryGuard(incomingLibrary, knownGoodLibrary, cleared) {
  const incoming = Array.isArray(incomingLibrary) ? incomingLibrary : []
  const known = Array.isArray(knownGoodLibrary) ? knownGoodLibrary : []
  if (incoming.length === 0 && known.length > 0 && cleared !== true) {
    return { library: known, guarded: true }
  }
  return { library: incoming, guarded: false }
}

/** 把作品库镜像进独立储存库（当前版本 + 历史快照，快照按内容去重并裁剪） */
async function mirrorLibrary(env, uid, books, opts = {}) {
  if (!assetsKv(env)) return { mirrored: false, snapshots: 0 }
  const lib = Array.isArray(books) ? books : []
  const savedAt = nowIso()
  await assetPutJson(env, userKey(uid, ASSET_LIBRARY_KEY), {
    version: 1,
    userId: uid,
    savedAt,
    count: lib.length,
    cleared: Boolean(opts.cleared),
    library: lib,
  })
  let snapshots = 0
  if (lib.length) {
    const hash = libraryHash(lib)
    const last = await assetGetJson(env, userKey(uid, ASSET_LIBRARY_SNAPINDEX_KEY))
    if (!last || last.hash !== hash) {
      // v10.64 独立验证 R3：时间戳只到毫秒，同一毫秒内两次不同写入会撞同一个键、后写覆盖前写。
      // 补 4 位随机后缀，保证「每次内容变化都留得下一份」。
      const stamp = `${savedAt.replace(/[:.]/g, '-')}-${randomHex(2)}`
      await assetPutJson(env, userKey(uid, `${ASSET_LIBRARY_SNAP_PREFIX}${stamp}`), {
        savedAt,
        count: lib.length,
        library: lib,
      })
      await assetPutJson(env, userKey(uid, ASSET_LIBRARY_SNAPINDEX_KEY), { hash, stamp, count: lib.length })
      // 裁剪：字典序即时间序，只留最近 ASSET_KEEP 份
      const snapKeys = (await assetListAll(env, userKey(uid, ASSET_LIBRARY_SNAP_PREFIX))).sort()
      for (const k of snapKeys.slice(0, Math.max(0, snapKeys.length - ASSET_KEEP))) {
        await assetsKv(env).delete(k)
      }
    }
    snapshots = (await assetListAll(env, userKey(uid, ASSET_LIBRARY_SNAP_PREFIX))).length
  }
  return { mirrored: true, snapshots }
}

/**
 * v10.64：读取最近一份「非空」的作品库快照。
 * 独立验证（R1）发现：快照原来是「只写不读」的死存储 —— 镜像一旦丢失或被缩水，
 * 任何接口都拿不回快照里的版本。这里补上兜底读取：镜像为空时的最后一道恢复通道。
 * @returns {{ library:any[], key:string, savedAt:string|null }}
 */
async function newestSnapshotLibrary(env, uid) {
  const keys = (await assetListAll(env, userKey(uid, ASSET_LIBRARY_SNAP_PREFIX))).sort().reverse()
  for (const k of keys) {
    const rec = await assetGetJson(env, k).catch(() => null)
    if (Array.isArray(rec?.library) && rec.library.length) {
      return { library: rec.library, key: k, savedAt: rec.savedAt || null }
    }
  }
  return { library: [], key: '', savedAt: null }
}

/**
 * v10.64：服务端自愈 —— state 里的作品库是空的，但独立储存库（或历史快照）里还有书，
 * 就把书补回 state 并落盘。这样**连没升级的老前端**打开页面也能看到作品。
 * @returns {{ state: any, healed: boolean, count: number, source?: string }}
 */
async function ensureStateLibrary(env, uid, state) {
  if (!state) return { state, healed: false, count: 0 }
  if (Array.isArray(state.library) && state.library.length) {
    return { state, healed: false, count: state.library.length }
  }
  const rec = await assetGetJson(env, userKey(uid, ASSET_LIBRARY_KEY)).catch(() => null)
  let books = Array.isArray(rec?.library) ? rec.library : []
  let source = 'assets'
  if (!books.length) {
    // 镜像也没了 → 退到最新一份非空快照（R1）
    const snap = await newestSnapshotLibrary(env, uid)
    books = snap.library
    source = 'snapshot'
  }
  if (!books.length) return { state, healed: false, count: 0 }
  const next = { ...state, library: books }
  await kvPutJson(env, userKey(uid, STATE_KEY), next).catch(() => {})
  console.log(`[assets] stateLoad 自愈（${source}）：uid=${uid}，补回 ${books.length} 本作品`)
  return { state: next, healed: true, count: books.length, source }
}
/** 单份压缩包超过这个大小就不内联进 KV（base64 再涨约 1/3，KV 单值上限 25MB） */
const KV_INLINE_MAX = 18 * 1024 * 1024

/** 备份自身的产物绝不能进备份包，否则每份新备份都会把之前的备份又装一遍，体积指数膨胀 */
const isBackupArtifact = (key) => {
  const k = String(key || '')
  // 全局键（app:backup:*）与用户命名空间下的键（user:{uid}:app:backup:*）都要拦住
  return k.startsWith('app:backup:') || k.includes(':app:backup:')
}

const BACKUP_TABLES = [
  'project_info',
  'weight_log',
  'project_case_library',
  'chapter_index',
  'backup_exec_log',
]
/** 允许外部读写的 KV 前缀白名单，避免任意 key 被覆盖 */
const ALLOWED_PREFIX = ['app:', 'proj:', 'atom:', 'snap:', 'branch:', 'weight:']
const kvAllowed = (key) => ALLOWED_PREFIX.some(p => String(key || '').startsWith(p))

/** 资产类型 → KV 前缀（原子设定 / 剧情分支 / 版本快照） */
const ASSET_KINDS = { atom: 'atom:', branch: 'branch:', snap: 'snap:' }

const nowIso = () => new Date().toISOString()
const storageReady = (env) => Boolean(env.WRITER_KV || env.WRITER_D1)
const r2Ready = (env) => Boolean(env.WRITER_BACKUP)

/* ============ 多用户：账号、会话、数据隔离 ============ */

const SESSION_DAYS = 30
const enc = new TextEncoder()

/** 登录态失效专用错误：fetch 层据此回 401，前端据此清 token 并提示重新登录 */
const unauthErr = (m) => {
  const e = new Error(m)
  e.code = 'unauthorized'
  return e
}

/** 权限不足（已登录但不是管理员）：fetch 层回 403，前端提示「无权限」而不是踢回登录页 */
const forbidErr = (m) => {
  const e = new Error(m)
  e.code = 'forbidden'
  return e
}

/** 账号被管理员停用：回 403 + code=disabled，前端提示联系管理员 */
const disabledErr = (m) => {
  const e = new Error(m)
  e.code = 'disabled'
  return e
}

function randomHex(nBytes = 16) {
  const b = new Uint8Array(nBytes)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

/** PBKDF2-SHA256（10 万次迭代）—— 明文密码绝不入库、绝不写日志 */
async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map(h => parseInt(h, 16)))
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  )
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('')
}

/** 所有业务 KV key 都挂在 user:{uid}: 下 —— 多租户隔离的唯一依据 */
const userKey = (uid, key) => `user:${uid}:${key}`
/** 有 uid 就加用户前缀，uid 为空表示全量作用域（Cron 全站备份）——不能直接用 userKey('') */
const scopeKey = (uid, key) => (uid ? userKey(uid, key) : key)
const stripUserPrefix = (uid, key) => String(key).replace(`user:${uid}:`, '')

/** 校验登录态；返回 { userId, username, role }。失败抛 unauthErr / disabledErr */
async function requireAuth(env, token) {
  const t = toStr(token)
  if (!t) throw unauthErr('未登录：缺少 token')
  let rows
  try {
    rows = await d1All(
      env,
      `SELECT s.user_id, s.expires_at, u.username, u.role, u.status
         FROM sessions s JOIN users u ON u.user_id = s.user_id
        WHERE s.token = ?`,
      [t],
    )
  } catch {
    // 降级：环境还没跑 d1/migrate_v3.sql（users 缺 role/status 列）时，
    // 按「普通用户 + active」处理 —— 业务照常可用，但所有管理接口一律被拒（fail closed）
    rows = await d1All(
      env,
      `SELECT s.user_id, s.expires_at, u.username
         FROM sessions s JOIN users u ON u.user_id = s.user_id
        WHERE s.token = ?`,
      [t],
    )
  }
  const row = rows[0]
  if (!row) throw unauthErr('登录态无效，请重新登录')
  if (row.expires_at && String(row.expires_at) < nowIso()) {
    await d1Run(env, 'DELETE FROM sessions WHERE token = ?', [t])
    throw unauthErr('登录已过期，请重新登录')
  }
  if (toStr(row.status || 'active') !== 'active') throw disabledErr('账号已被停用，请联系管理员')
  return {
    userId: row.user_id,
    username: row.username,
    // role 只认服务端 D1 里的值；前端传来的任何身份声明都不参与判定
    role: toStr(row.role) === 'admin' ? 'admin' : 'user',
  }
}

/**
 * 管理类接口的唯一门禁。
 *
 * 前端把「管理后台」入口藏起来只是「看不见」，任何人手搓一个 POST 都能打过来，
 * 所以真正的裁决必须在这里：角色取自 D1，不是请求体。
 */
async function requireAdmin(env, token) {
  const me = await requireAuth(env, token)
  if (me.role !== 'admin') throw forbidErr('需要管理员权限')
  return me
}

function validateCredential(username, password) {
  const u = toStr(username).trim()
  const p = toStr(password)
  if (!/^[\w\u4e00-\u9fa5.@-]{2,32}$/.test(u)) throw new Error('用户名需 2–32 位（中英文、数字、_ . @ -）')
  if (p.length < 6 || p.length > 128) throw new Error('密码需 6–128 位')
  return { u, p }
}

async function createSession(env, userId) {
  const token = randomHex(32)
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString()
  await d1Run(
    env,
    'INSERT INTO sessions (token, user_id, create_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, userId, nowIso(), expires],
  )
  return { token, expiresAt: expires }
}

async function kvPutJson(env, key, value) {
  if (!env.WRITER_KV) throw new Error('WRITER_KV 未绑定')
  await env.WRITER_KV.put(key, JSON.stringify(value))
}

async function kvGetJson(env, key) {
  if (!env.WRITER_KV) throw new Error('WRITER_KV 未绑定')
  const raw = await env.WRITER_KV.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 列举 KV 全部 key（分页游标逐个翻，避免一次 list 拿不全） */
async function kvListAll(env, prefix = '') {
  const keys = []
  let cursor
  do {
    const res = await env.WRITER_KV.list({ prefix, cursor })
    for (const k of res.keys || []) keys.push(k.name)
    cursor = res.list_complete ? null : res.cursor
  } while (cursor)
  return keys
}

function d1(env) {
  if (!env.WRITER_D1) throw new Error('WRITER_D1 未绑定')
  return env.WRITER_D1
}
const d1Run = (env, sql, params = []) => d1(env).prepare(sql).bind(...params).run()
async function d1All(env, sql, params = []) {
  const res = await d1(env).prepare(sql).bind(...params).all()
  return res.results || []
}

/** 把某用户的作品库同步进 D1：project_info + chapter_index（先清后插，保证与前端一致） */
async function syncProjectIndex(env, uid, state) {
  if (!env.WRITER_D1) return { projects: 0, chapters: 0 }
  const books = Array.isArray(state?.library) ? state.library : []
  if (!books.length) return { projects: 0, chapters: 0 }
  const userId = uid
  const statements = []
  let chapters = 0
  for (const b of books) {
    const pid = toStr(b?.id)
    if (!pid) continue
    statements.push(
      d1(env)
        .prepare(
          `INSERT INTO project_info (project_id, user_id, project_name, create_at, update_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             project_name = excluded.project_name,
             update_at = excluded.update_at`,
        )
        .bind(pid, userId, toStr(b?.title) || '未命名', toStr(b?.createdAt) || nowIso(), nowIso()),
    )
    statements.push(
      d1(env).prepare('DELETE FROM chapter_index WHERE project_id = ? AND user_id = ?').bind(pid, userId),
    )
    const outline = Array.isArray(b?.outline) ? b.outline : []
    for (const c of outline) {
      const no = Number(c?.index) || 0
      statements.push(
        d1(env)
          .prepare(
            `INSERT INTO chapter_index (chapter_id, project_id, chapter_no, chapter_title, node_id, create_at, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(chapter_id) DO UPDATE SET chapter_title = excluded.chapter_title, user_id = excluded.user_id`,
          )
          .bind(`${userId}:${pid}:${no}`, pid, no, toStr(c?.title) || `第 ${no} 章`, toStr(c?.tag) || '', nowIso(), userId),
      )
      chapters++
    }
  }
  if (statements.length) await d1(env).batch(statements)
  return { projects: books.length, chapters }
}

/** 应用状态整体落该用户的 KV，并把作品/章节索引同步进 D1 */
/**
 * v10.65：stateSave 出口的字段白名单（第三道隔离闸，与前端 sanitizeAppStateForSync 对应）。
 * 用户硬要求：屏幕观察的原始数据不能被存放到 Cloudflare 后台。
 * 即使某个（旧版/出 bug 的）前端把观察数据塞进了 state，到这里也会被剥掉。
 * ⚠️ AppState 新增字段时两边要同步加。
 */
const SYNC_STATE_FIELDS = [
  'canvases', 'selectedCanvasId', 'mode', 'library', 'trash', 'lastMode',
  'rememberMode', 'collapseCanvases', 'customStyleCards', 'worldviews',
  'collections', 'linkedBookId', 'bot',
]
function whitelistState(state) {
  const out = {}
  if (state && typeof state === 'object') {
    for (const k of SYNC_STATE_FIELDS) if (k in state) out[k] = state[k]
  }
  return out
}

/**
 * 保存应用状态。
 * v10.64：作品库过「只增不减」守卫，并镜像进独立储存库 ——
 * 即使前端（任何版本）推上来一份空作品库，服务端也不会真的把书删掉。
 * v10.65：出口再过一次**字段白名单** —— 屏幕观察的原始数据（若被误塞进 state）到不了云端。
 * @param opts.libraryCleared 前端显式声明「用户主动清空了作品库」时才允许清空
 */
async function saveState(env, uid, state, opts = {}) {
  const serverSavedAt = nowIso()
  // 已知的非空作品库：本地 state 里存的 + 独立储存库里的，取更完整的那个
  const stored = await kvGetJson(env, userKey(uid, STATE_KEY)).catch(() => null)
  const assetRec = await assetGetJson(env, userKey(uid, ASSET_LIBRARY_KEY)).catch(() => null)
  const knownGood = pickLibrary(stored?.library, assetRec?.library)
  const { library, guarded } = applyLibraryGuard(state?.library, knownGood, opts.libraryCleared === true)
  if (guarded) {
    console.log(`[assets] 已拦下「清空作品库」的回写：uid=${uid}，保留 ${library.length} 本作品`)
  }
  const payload = {
    ...whitelistState(state),
    library,
    userId: uid,
    updatedAt: toStr(state?.updatedAt) || serverSavedAt,
    serverSavedAt,
  }
  await kvPutJson(env, userKey(uid, STATE_KEY), payload)
  // 独立储存库：当前全量 + 历史快照（失败不影响主流程，state 已经写成功）
  const mirror = await mirrorLibrary(env, uid, library, {
    cleared: Array.isArray(state?.library) && state.library.length === 0 && opts.libraryCleared === true,
  }).catch(e => {
    console.warn('[assets] 作品库镜像失败（不影响 state 保存）：', safeStr(e))
    return { mirrored: false, snapshots: 0 }
  })
  const index = await syncProjectIndex(env, uid, payload)
  return { updatedAt: payload.updatedAt, serverSavedAt, libraryCount: library.length, libraryGuarded: guarded, ...mirror, ...index }
}

/** gzip 压缩（Workers 运行时自带 CompressionStream，无需额外依赖） */
async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

/** 读取 KV + D1 全量业务数据，打包成 JSONL */
async function collectBackup(env, uid = '') {
  const result = { kv: {}, d1: {}, counts: {} }
  if (env.WRITER_KV) {
    // uid 为空 = 全量备份（Cron 用）；否则只导出该用户的命名空间
    const all = await kvListAll(env, uid ? `user:${uid}:` : '')
    // 备份自己的产物必须剔除，否则备份里套备份，越滚越大
    const keys = all.filter(k => !isBackupArtifact(k))
    for (const k of keys) {
      const v = await env.WRITER_KV.get(k)
      result.kv[k] = v
    }
    result.counts.kvKeys = keys.length
    if (all.length !== keys.length) result.counts.skippedBackupKeys = all.length - keys.length
  }
  if (env.WRITER_D1) {
    for (const t of BACKUP_TABLES) {
      try {
        const rows = uid
          ? await d1All(env, `SELECT * FROM ${t} WHERE user_id = ?`, [uid])
          : await d1All(env, `SELECT * FROM ${t}`)
        result.d1[t] = rows
        result.counts[t] = rows.length
      } catch (e) {
        result.d1[t] = []
        result.counts[t] = `error: ${safeStr(e).slice(0, 120)}`
      }
    }
  }
  const header = JSON.stringify({
    type: 'ai-writer-backup',
    version: VERSION,
    scope: uid ? `user:${uid}` : 'all',
    createdAt: nowIso(),
    counts: result.counts,
  })
  const lines = [header]
  for (const [k, v] of Object.entries(result.kv)) {
    lines.push(JSON.stringify({ scope: 'kv', key: k, value: v }))
  }
  for (const [t, rows] of Object.entries(result.d1)) {
    for (const r of rows) lines.push(JSON.stringify({ scope: 'd1', table: t, row: r }))
  }
  return { jsonl: lines.join('\n'), counts: result.counts, header: JSON.parse(header) }
}

/**
 * 备份：读 KV + D1 → JSONL → gzip。
 * 优先落 R2（开通后自动启用）；R2 缺席时走 **KV 多版本**：
 *   元信息 → user:{uid}:app:backup:item:{stamp}（小，列备份时只读它）
 *   压缩体 → user:{uid}:app:backup:data:{stamp}（大）
 *   超出保留份数的按时间从旧到新自动裁剪。
 * 全过程在 Cloudflare 内部完成，不经过任何外部服务器。
 */
async function runBackup(env, type = 'auto', uid = '') {
  const startedAt = nowIso()
  const stamp = startedAt.replace(/[:.]/g, '-')
  // uid 形如 u-xxxx，去掉前缀再截断，避免出现 "uu-xxxx" 这种重复记号
  const uidTag = String(uid || '').replace(/^u-/, '').slice(0, 8)
  const scopeTag = uid ? `u-${uidTag}` : 'all'
  const typeTag = type === 'manual_snapshot' ? 'keep' : type === 'manual' ? 'manual' : 'auto'
  const objectPath = `backup/${stamp}_${typeTag}_${scopeTag}_v${VERSION}.jsonl.gz`
  let size = 0
  try {
    const { jsonl, counts } = await collectBackup(env, uid)
    const gz = await gzip(jsonl)
    size = gz.byteLength
    let stored = 'r2'
    let pruned = 0
    const inline = size <= KV_INLINE_MAX
    if (r2Ready(env)) {
      await env.WRITER_BACKUP.put(objectPath, gz, {
        httpMetadata: { contentType: 'application/gzip' },
      })
    } else {
      // R2 未开通：KV 多版本，保留最近 BACKUP_KEEP 份
      stored = 'kv'
      const itemKey = scopeKey(uid, `${BACKUP_ITEM_KEY}${stamp}`)
      const dataKey = scopeKey(uid, `${BACKUP_DATA_KEY}${stamp}`)
      const meta = {
        stamp,
        type,
        scope: scopeTag,
        size,
        stored,
        objectPath,
        createdAt: startedAt,
        counts,
        itemKey,
        dataKey,
        /** 前端列表用它当唯一键名 */
        key: itemKey,
        hasData: inline,
        note: inline ? '' : `压缩包 ${size} 字节，超过 KV 内联上限，仅记录元信息`,
      }
      if (inline) {
        await kvPutJson(env, dataKey, {
          gzipBase64: bytesToBase64(gz),
          size,
          createdAt: startedAt,
        })
      }
      await kvPutJson(env, itemKey, meta)
      // 兼容旧读取方：app:backup:last 退化为「指向最新一份」的轻量指针
      await kvPutJson(env, scopeKey(uid, LAST_BACKUP_KEY), { ...meta, pointer: true })
      pruned = await pruneBackups(env, uid, BACKUP_KEEP, meta)
    }
    if (env.WRITER_D1) {
      await d1Run(
        env,
        `INSERT INTO backup_exec_log (backup_type, r2_object_path, file_size_bytes, status, error_msg, execute_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [type, objectPath, size, r2Ready(env) ? 'success' : 'success_kv_only', `stored=${stored};scope=${scopeTag};pruned=${pruned}`, startedAt, uid || null],
      )
    }
    return { ok: true, objectPath, size, stored, counts, scope: scopeTag, stamp, pruned, startedAt, durationMs: Date.now() - new Date(startedAt).getTime() }
  } catch (e) {
    const message = safeStr(e)
    try {
      if (env.WRITER_D1) {
        await d1Run(
          env,
          `INSERT INTO backup_exec_log (backup_type, r2_object_path, file_size_bytes, status, error_msg, execute_at, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [type, objectPath, size, 'fail', message.slice(0, 400), startedAt, uid || null],
        )
      }
    } catch (logErr) {
      console.error('[Worker] 备份失败日志也写不进去：', safeStr(logErr))
    }
    return { ok: false, error: message, objectPath, startedAt }
  }
}

/**
 * 裁剪 KV 备份到最近 keep 份：以索引为准，元信息 + 压缩体一起删，最后回写索引。
 * 刚写入的那份由 runBackup 先塞进索引，所以「立刻能看到」不依赖 KV 的最终一致列表。
 */
async function pruneBackups(env, uid, keep, incoming) {
  if (!env.WRITER_KV) return 0
  const indexKey = scopeKey(uid, BACKUP_INDEX_KEY)
  const prev = await kvGetJson(env, indexKey)
  let items = Array.isArray(prev?.items) ? prev.items : []

  if (incoming) {
    items = [incoming, ...items.filter(m => m?.stamp !== incoming.stamp)]
  }
  // stamp 是 ISO 变体，字符串倒序即时间倒序，但保险起见按 createdAt 排
  items.sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')))

  const dropped = items.slice(keep)
  for (const m of dropped) {
    if (!m?.stamp) continue
    await env.WRITER_KV.delete(m.itemKey || scopeKey(uid, `${BACKUP_ITEM_KEY}${m.stamp}`))
    await env.WRITER_KV.delete(m.dataKey || scopeKey(uid, `${BACKUP_DATA_KEY}${m.stamp}`))
  }
  const kept = items.slice(0, keep)
  await kvPutJson(env, indexKey, { scope: uid ? `u${uid.slice(0, 8)}` : 'all', keep, updatedAt: nowIso(), items: kept })
  return dropped.length
}

/** 列出该作用域下可用的备份；只读索引，既快又不吃 KV 列表的最终一致延迟 */
async function listBackups(env, uid, limit = 30) {
  if (!env.WRITER_KV) return { items: [], keep: BACKUP_KEEP, r2Bound: r2Ready(env) }
  const n = Math.max(1, Math.min(100, Number(limit) || 30))
  const index = await kvGetJson(env, scopeKey(uid, BACKUP_INDEX_KEY))
  let items = Array.isArray(index?.items) ? index.items : []

  if (!items.length) {
    // 兜底：索引缺失（比如更早版本留下的备份）时，退回扫键
    const keys = (await kvListAll(env, uid ? `user:${uid}:` : ''))
      .filter(k => k.includes(BACKUP_ITEM_KEY))
      .sort()
      .reverse()
      .slice(0, n)
    items = []
    for (const k of keys) {
      const meta = await kvGetJson(env, k)
      if (meta) items.push({ key: k, ...meta })
    }
  }
  return {
    items: items.slice(0, n),
    keep: index?.keep ?? BACKUP_KEEP,
    r2Bound: r2Ready(env),
  }
}

/**
 * 从某份 KV 备份还原（一次性恢复该作用域下所有 KV 键：画布/作品库/项目资产），
 * 并用还原后的状态重建 D1 里的作品与章节索引。
 */
async function restoreBackup(env, uid, stampOrKey) {
  if (!env.WRITER_KV) throw new Error('WRITER_KV 未绑定，无法还原')
  const raw = String(stampOrKey || '')
  const stamp = raw.includes(BACKUP_ITEM_KEY)
    ? raw.slice(raw.indexOf(BACKUP_ITEM_KEY) + BACKUP_ITEM_KEY.length)
    : raw
  if (!stamp) throw new Error('缺少备份标识')
  const meta = await kvGetJson(env, scopeKey(uid, `${BACKUP_ITEM_KEY}${stamp}`))
  if (!meta) throw new Error('找不到这份备份的元信息')
  const data = await kvGetJson(env, scopeKey(uid, `${BACKUP_DATA_KEY}${stamp}`))
  if (!data?.gzipBase64) {
    throw new Error('这份备份没有可还原的数据体（压缩包超出了 KV 内联上限，只能用 R2 还原）')
  }

  const jsonl = await gunzip(bytesFromBase64(data.gzipBase64))
  const lines = jsonl.split('\n').filter(Boolean)
  const scopeRoot = uid ? `user:${uid}:` : ''
  let kvRestored = 0
  let state = null
  for (let i = 1; i < lines.length; i++) {
    let o
    try {
      o = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (o.scope !== 'kv') continue
    const key = String(o.key || '')
    if (scopeRoot && !key.startsWith(scopeRoot)) continue
    if (isBackupArtifact(key)) continue
    await env.WRITER_KV.put(key, String(o.value))
    kvRestored += 1
    if (key === scopeKey(uid, STATE_KEY)) {
      try {
        state = JSON.parse(String(o.value))
      } catch {
        state = null
      }
    }
  }
  let index = null
  if (state && env.WRITER_D1) index = await syncProjectIndex(env, uid, state)
  /* v10.64：还原备份是显式操作 —— 必须把还原后的作品库同步进独立储存库，
     否则「只增不减」守卫会拿更早的（更多书的）版本把这次还原又顶回去。
     历史快照保留，所以还原错了还能再找回更多书的那一版。 */
  if (state) {
    await mirrorLibrary(env, uid, Array.isArray(state.library) ? state.library : [], { cleared: true }).catch(e => {
      console.warn('[assets] 还原后备份镜像失败：', safeStr(e))
    })
  }
  return {
    stamp,
    createdAt: meta.createdAt,
    size: meta.size,
    kvRestored,
    stateFound: Boolean(state),
    index,
  }
}

/** 存储现状（不打印任何正文，仅供排障）；uid 传入时只统计该用户的数据 */
async function storageStats(env, uid) {
  const stats = {
    kvBound: Boolean(env.WRITER_KV),
    d1Bound: Boolean(env.WRITER_D1),
    r2Bound: r2Ready(env),
    r2Hint: r2Ready(env) ? '' : 'R2 未开通，备份走 KV 多版本（保留最近 ' + BACKUP_KEEP + ' 份）',
    backupKeep: BACKUP_KEEP,
  }
  const scopeKv = uid ? `user:${uid}:` : ''
  if (env.WRITER_KV) {
    try {
      const all = await kvListAll(env, scopeKv)
      // 业务键与备份产物分开计数，别让「备份了多少份」污染键数
      stats.kvKeys = all.filter(k => !isBackupArtifact(k)).length
      // 备份份数以索引为准（KV 列表最终一致，数不出刚写的那份）
      const idx = await kvGetJson(env, scopeKey(uid, BACKUP_INDEX_KEY))
      stats.backupCount = Array.isArray(idx?.items) ? idx.items.length : 0
      stats.stateSavedAt =
        (await kvGetJson(env, uid ? userKey(uid, STATE_KEY) : STATE_KEY))?.serverSavedAt || null
    } catch (e) {
      stats.kvError = safeStr(e).slice(0, 200)
    }
  }
  if (env.WRITER_D1) {
    try {
      for (const t of BACKUP_TABLES) {
        const rows = uid
          ? await d1All(env, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [uid])
          : await d1All(env, `SELECT COUNT(*) AS n FROM ${t}`)
        stats[t] = rows[0]?.n ?? 0
      }
    } catch (e) {
      stats.d1Error = safeStr(e).slice(0, 200)
    }
  }
  return stats
}

/* ============ 项目资产：原子设定 / 剧情分支 / 版本快照 ============ */

const assetPrefix = (kind, uid) => userKey(uid, ASSET_KINDS[kind])

/** 一次性把这个用户的三类资产全读出来（各资产数量有限，一次往返更省） */
async function assetsLoad(env, uid) {
  const out = { atoms: [], branches: [], snaps: [] }
  const bucketOf = { atom: 'atoms', branch: 'branches', snap: 'snaps' }
  for (const kind of Object.keys(ASSET_KINDS)) {
    const keys = await kvListAll(env, assetPrefix(kind, uid))
    for (const k of keys) {
      const v = await kvGetJson(env, k)
      if (v) out[bucketOf[kind]].push(v)
    }
  }
  const byTime = (a, b) => String(b?.updatedAt || b?.createdAt || '').localeCompare(String(a?.updatedAt || a?.createdAt || ''))
  out.atoms.sort(byTime)
  out.branches.sort(byTime)
  out.snaps.sort(byTime)
  return out
}

async function assetSave(env, uid, kind, id, data) {
  const key = assetPrefix(kind, uid) + id
  const now = nowIso()
  const prev = await kvGetJson(env, key)
  const value = { ...(data || {}), id, kind, createdAt: prev?.createdAt || now, updatedAt: now }
  await kvPutJson(env, key, value)
  return value
}

const assetDelete = async (env, uid, kind, id) => {
  if (!env.WRITER_KV) throw new Error('WRITER_KV 未绑定')
  await env.WRITER_KV.delete(assetPrefix(kind, uid) + id)
  return { deleted: true, kind, id }
}

/** Uint8Array → base64（分块，避免大数组展开把调用栈打爆） */
function bytesToBase64(bytes) {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/** base64 → Uint8Array（同样分块） */
function bytesFromBase64(b64) {
  const bin = atob(String(b64 || ''))
  const out = new Uint8Array(bin.length)
  const CHUNK = 0x8000
  for (let i = 0; i < bin.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bin.length)
    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j)
  }
  return out
}

/** gzip 解压（还原备份时用） */
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

/* ============================================================
   管理员：平台级数据 + 账号治理
   ------------------------------------------------------------
   三条原则：
   1. 角色只有一个来源 —— D1 的 users.role。请求体里声明什么都不参与判定。
   2. 每个管理类写操作都过 requireAdmin，并落一条 admin_audit，事后可追溯。
   3. 「平台数据」（语料覆盖层 / 站点设置）全站共享、不属于任何用户，
      存在 KV 顶层键（无 user: 前缀），只有管理员能写。

   「平台语料」为什么是覆盖层而不是直接改成数据库：
   前端打包里那份默认语料是产品的保底内容。管理员改的东西放覆盖层，
   即使改坏了、或者 KV 挂了，前端仍回落到默认语料，站点不会开天窗。
   ============================================================ */

const PLATFORM_CORPUS_KEY = 'app:platform:corpus'
const PLATFORM_SETTINGS_KEY = 'app:platform:settings'

const DEFAULT_SETTINGS = { allowRegister: true, announcement: '' }

/** 只挑认识的字段，避免历史遗留字段（updatedBy 之类）混进设置对象返回给前端 */
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    allowRegister: s.allowRegister === undefined ? DEFAULT_SETTINGS.allowRegister : Boolean(s.allowRegister),
    announcement: toStr(s.announcement).slice(0, 300),
  }
}

/** 拒绝采样生成临时密码：去掉 0/O/1/l/I 这类易混字符，避免口头传达时看错 */
function randomPassword(len = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const out = []
  while (out.length < len) {
    const buf = new Uint8Array(len * 2)
    crypto.getRandomValues(buf)
    for (const x of buf) {
      // 落在 [0, 256 - 256 % len) 之外的重抽，保证分布均匀（无模偏差）
      if (x >= 256 - (256 % alphabet.length)) continue
      out.push(alphabet[x % alphabet.length])
      if (out.length >= len) break
    }
  }
  return out.join('')
}

/** 写审计日志；审计失败不能反过来把管理操作搞挂，所以吞掉异常只记日志 */
async function audit(env, actor, action, target = '', detail = '') {
  try {
    await d1Run(
      env,
      `INSERT INTO admin_audit (actor_id, actor_name, action, target, detail, create_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [actor.userId, actor.username, action, toStr(target), toStr(detail).slice(0, 500), nowIso()],
    )
  } catch (e) {
    console.warn('[audit] 写入失败：', safeStr(e))
  }
}

/* ---------------- 平台数据（语料覆盖层 + 站点设置） ---------------- */

async function platformGet(env) {
  const corpus = await kvGetJson(env, PLATFORM_CORPUS_KEY)
  const settingsRaw = await kvGetJson(env, PLATFORM_SETTINGS_KEY)
  return {
    corpus: {
      books: corpus?.books && typeof corpus.books === 'object' ? corpus.books : {},
      updatedAt: corpus?.updatedAt || null,
      updatedBy: corpus?.updatedBy || null,
    },
    settings: normalizeSettings(settingsRaw),
    settingsUpdatedAt: settingsRaw?.updatedAt || null,
  }
}

/**
 * 保存语料覆盖层。三种提交值：
 *   BookMeta 对象  → 新增或覆盖这本书
 *   null          → 墓碑：站主删掉了这本书（必须留墓碑，否则默认语料会从下面重新冒出来）
 *   '__reset__'   → 连墓碑一起撤掉，这本书彻底回到覆盖层之外（恢复默认行为）
 */
async function adminCorpusSave(env, me, books, mode) {
  if (!books || typeof books !== 'object' || Array.isArray(books)) throw new Error('books 必须是对象')
  const cur = await kvGetJson(env, PLATFORM_CORPUS_KEY)
  const next = mode === 'replace' ? {} : { ...(cur?.books || {}) }
  let live = 0
  let tomb = 0
  let reset = 0
  for (const [rawKey, v] of Object.entries(books)) {
    const key = toStr(rawKey).trim()
    if (!key) continue
    if (v === '__reset__') {
      delete next[key]
      reset++
    } else if (v === null) {
      next[key] = null
      tomb++
    } else {
      const meta = v
      if (!meta?.byDimension || typeof meta.byDimension !== 'object') {
        throw new Error(`「${key}」缺少 byDimension，格式不对`)
      }
      next[key] = {
        author: toStr(meta.author),
        tags: Array.isArray(meta.tags) ? meta.tags.map(t => toStr(t)).filter(Boolean) : [],
        byDimension: meta.byDimension,
      }
      live++
    }
  }
  const value = { books: next, updatedAt: nowIso(), updatedBy: me.username }
  await kvPutJson(env, PLATFORM_CORPUS_KEY, value)
  await audit(
    env,
    me,
    'corpus_save',
    '',
    `mode=${mode} 写入=${live} 墓碑=${tomb} 重置=${reset} 合计=${Object.keys(next).length}`,
  )
  return {
    total: Object.keys(next).length,
    submitted: live,
    tombstones: tomb,
    reset,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
  }
}

async function adminSettingsSave(env, me, incoming) {
  const patch = incoming && typeof incoming === 'object' ? incoming : {}
  const merged = { ...normalizeSettings(await kvGetJson(env, PLATFORM_SETTINGS_KEY)) }
  if ('allowRegister' in patch) merged.allowRegister = Boolean(patch.allowRegister)
  if ('announcement' in patch) merged.announcement = toStr(patch.announcement).slice(0, 300)
  const value = { ...merged, updatedAt: nowIso(), updatedBy: me.username }
  await kvPutJson(env, PLATFORM_SETTINGS_KEY, value)
  await audit(env, me, 'settings_save', '', JSON.stringify(merged))
  return { settings: merged, updatedAt: value.updatedAt, updatedBy: value.updatedBy }
}

/* ---------------- 账号治理 ---------------- */

const findUser = async (env, userId) =>
  (await d1All(env, 'SELECT * FROM users WHERE user_id = ?', [toStr(userId)]))[0] || null

/** 管理员凭 用户名 或 userId 定位账号，避免只能靠 id 操作 */
async function resolveUser(env, ref) {
  const r = toStr(ref).trim()
  if (!r) throw new Error('缺少目标账号')
  const row =
    (await d1All(env, 'SELECT * FROM users WHERE user_id = ?', [r]))[0] ||
    (await d1All(env, 'SELECT * FROM users WHERE username = ?', [r]))[0]
  if (!row) throw new Error(`找不到账号「${r}」`)
  return row
}

const ROLE_OF = (u) => (toStr(u?.role) === 'admin' ? 'admin' : 'user')
const STATUS_OF = (u) => (toStr(u?.status) === 'active' ? 'active' : 'disabled')

/** 全站在用的活跃管理员数量 —— 用来兜住「把自己或最后一个管理员弄没」的坑 */
async function activeAdminCount(env) {
  const rows = await d1All(env, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'")
  return Number(rows[0]?.n) || 0
}

async function adminOverview(env) {
  const out = { version: VERSION, r2Bound: r2Ready(env), backupKeep: BACKUP_KEEP }
  if (env.WRITER_D1) {
    const one = async (sql, params = []) => (await d1All(env, sql, params))[0] || {}
    out.users = Number((await one('SELECT COUNT(*) AS n FROM users')).n) || 0
    out.admins = Number((await one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")).n) || 0
    out.disabled = Number((await one("SELECT COUNT(*) AS n FROM users WHERE status != 'active'")).n) || 0
    out.liveSessions =
      Number((await one('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', [nowIso()])).n) || 0
    out.auditCount = Number((await one('SELECT COUNT(*) AS n FROM admin_audit')).n) || 0
    const tables = {}
    for (const t of BACKUP_TABLES) {
      tables[t] = Number((await one(`SELECT COUNT(*) AS n FROM ${t}`)).n) || 0
    }
    out.d1Tables = tables
  }
  if (env.WRITER_KV) {
    const all = await kvListAll(env, '')
    // 业务键与备份产物分开，否则「备份了多少份」会把键数撑得看不懂
    out.kvKeys = all.filter(k => !isBackupArtifact(k)).length
    out.backupFiles = all.filter(k => k.includes(BACKUP_ITEM_KEY)).length
  }
  const p = await platformGet(env)
  out.corpusOverride = Object.keys(p.corpus.books).length
  out.corpusTombstones = Object.values(p.corpus.books).filter(v => v === null).length
  out.corpusUpdatedAt = p.corpus.updatedAt
  out.settings = p.settings
  out.settingsUpdatedAt = p.settingsUpdatedAt
  return out
}

async function adminUsers(env) {
  const rows = await d1All(
    env,
    `SELECT u.user_id, u.username, u.role, u.status, u.note, u.create_at, u.last_login_at, u.update_at,
            (SELECT COUNT(*) FROM project_info p WHERE p.user_id = u.user_id)  AS projects,
            (SELECT COUNT(*) FROM chapter_index c WHERE c.user_id = u.user_id) AS chapters,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.user_id AND s.expires_at > ?) AS live_sessions
       FROM users u
      ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.create_at DESC`,
    [nowIso()],
  )
  return { items: rows, total: rows.length }
}

async function adminUserSetRole(env, me, ref, role) {
  const next = toStr(role)
  if (next !== 'user' && next !== 'admin') throw new Error('role 只能是 user 或 admin')
  const target = await resolveUser(env, ref)
  if (target.user_id === me.userId && next !== 'admin') {
    throw new Error('不能把自己的管理员身份去掉 —— 那样就再没人能进管理后台了')
  }
  if (ROLE_OF(target) === 'admin' && next === 'user') {
    if ((await activeAdminCount(env)) <= 1) {
      throw new Error('至少要保留一名在用的管理员，否则管理后台将无人可进')
    }
  }
  await d1Run(env, 'UPDATE users SET role = ?, update_at = ? WHERE user_id = ?', [
    next,
    nowIso(),
    target.user_id,
  ])
  await audit(env, me, 'user_set_role', target.username, `${ROLE_OF(target)} → ${next}`)
  return { userId: target.user_id, username: target.username, role: next }
}

async function adminUserSetStatus(env, me, ref, status) {
  const next = toStr(status) === 'disabled' ? 'disabled' : 'active'
  const target = await resolveUser(env, ref)
  if (target.user_id === me.userId && next !== 'active') throw new Error('不能停用自己的账号')
  if (next !== 'active' && ROLE_OF(target) === 'admin' && (await activeAdminCount(env)) <= 1) {
    throw new Error('至少要保留一名在用的管理员')
  }
  await d1Run(env, 'UPDATE users SET status = ?, update_at = ? WHERE user_id = ?', [
    next,
    nowIso(),
    target.user_id,
  ])
  // 停用必须同时踢掉在线会话，否则「停用」对已登录的人没有任何作用
  let kicked = 0
  if (next !== 'active') {
    const res = await d1Run(env, 'DELETE FROM sessions WHERE user_id = ?', [target.user_id])
    kicked = res?.meta?.changes ?? 0
  }
  await audit(env, me, 'user_set_status', target.username, `${STATUS_OF(target)} → ${next}，清会话 ${kicked}`)
  return { userId: target.user_id, username: target.username, status: next, sessionsCleared: kicked }
}

/** 重置某人的密码：返回一次性的明文，只在这一条响应里出现，服务端仍只存 hash */
async function adminUserResetPassword(env, me, ref) {
  const target = await resolveUser(env, ref)
  const password = randomPassword(14)
  const salt = randomHex(16)
  const passHash = await pbkdf2(password, salt)
  await d1Run(env, 'UPDATE users SET pass_hash = ?, salt = ?, update_at = ? WHERE user_id = ?', [
    passHash,
    salt,
    nowIso(),
    target.user_id,
  ])
  const res = await d1Run(env, 'DELETE FROM sessions WHERE user_id = ?', [target.user_id])
  const cleared = res?.meta?.changes ?? 0
  await audit(env, me, 'user_reset_password', target.username, `清 ${cleared} 条登录态`)
  return { userId: target.user_id, username: target.username, password, sessionsCleared: cleared }
}

/** 删号：KV 该用户命名空间全清 + D1 各表按 user_id 清 + users 行删除 */
async function adminUserDelete(env, me, ref) {
  const target = await resolveUser(env, ref)
  if (target.user_id === me.userId) throw new Error('不能删除自己的账号')
  if (ROLE_OF(target) === 'admin' && (await activeAdminCount(env)) <= 1) {
    throw new Error('至少要保留一名在用的管理员')
  }
  const uid = target.user_id
  let kvDeleted = 0
  if (env.WRITER_KV) {
    const keys = await kvListAll(env, `user:${uid}:`)
    // 分批删，避免一次塞进太多子请求
    for (let i = 0; i < keys.length; i += 100) {
      await Promise.all(keys.slice(i, i + 100).map(k => env.WRITER_KV.delete(k)))
    }
    kvDeleted = keys.length
  }
  const d1Deleted = {}
  // 先子表后主表：users 是其它表的外键来源，最后删
  for (const [table, col] of [
    ['sessions', 'user_id'],
    ['chapter_index', 'user_id'],
    ['project_info', 'user_id'],
    ['weight_log', 'user_id'],
    ['project_case_library', 'user_id'],
    ['backup_exec_log', 'user_id'],
  ]) {
    const res = await d1Run(env, `DELETE FROM ${table} WHERE ${col} = ?`, [uid])
    d1Deleted[table] = res?.meta?.changes ?? 0
  }
  await d1Run(env, 'DELETE FROM users WHERE user_id = ?', [uid])
  await audit(env, me, 'user_delete', target.username, `KV ${kvDeleted} 键 / D1 ${JSON.stringify(d1Deleted)}`)
  return { deleted: true, userId: uid, username: target.username, kvDeleted, d1Deleted }
}

/* ---------------- 全平台备份 ---------------- */

/** 备份作用域清单：全局一份 + 每个账号一份 */
async function backupScopes(env) {
  const scopes = [{ uid: '', label: '全站（Cron 全量）' }]
  if (!env.WRITER_D1) return scopes
  const users = await d1All(env, 'SELECT user_id, username FROM users ORDER BY create_at DESC')
  for (const u of users) scopes.push({ uid: u.user_id, label: u.username })
  return scopes
}

async function adminBackupList(env, limit = 60) {
  const n = Math.max(1, Math.min(200, Number(limit) || 60))
  const items = []
  for (const s of await backupScopes(env)) {
    const res = await listBackups(env, s.uid, 30)
    for (const it of res.items) items.push({ ...it, uid: s.uid, owner: s.label })
  }
  items.sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')))
  return { items: items.slice(0, n), r2Bound: r2Ready(env), keep: BACKUP_KEEP }
}

async function adminBackupRun(env, me, ref) {
  const uid = toStr(ref)
  const res = await runBackup(env, 'manual_snapshot', uid)
  await audit(
    env,
    me,
    'backup_run',
    uid || '全站',
    res.ok ? `${res.stored} ${res.size}B 裁剪${res.pruned ?? 0}份` : `失败：${res.error}`,
  )
  return { uid, ...res }
}

async function adminBackupRestore(env, me, ref, stamp) {
  const uid = toStr(ref)
  const res = await restoreBackup(env, uid, stamp)
  // 还原后必须把该用户的在线会话踢掉：
  // 他浏览器里还挂着旧数据，下次自动同步会把刚还原好的内容又盖回去。
  let cleared = 0
  if (uid && uid !== me.userId) {
    const r = await d1Run(env, 'DELETE FROM sessions WHERE user_id = ?', [uid])
    cleared = r?.meta?.changes ?? 0
  }
  await audit(env, me, 'backup_restore', uid || '全站', `stamp=${res.stamp} KV键=${res.kvRestored}`)
  return { ...res, sessionsCleared: cleared }
}

async function adminAuditList(env, limit = 100) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100))
  return { items: await d1All(env, 'SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?', [n]) }
}

/* ══════════════════════════════════════════════════════════════════
   积分体系（v10.23）—— 按用户结算「付费模型」的真实消耗
   ------------------------------------------------------------------
   计价口径（全部写在常量里，涨价/调价只改这里）：

   1) 真实成本 = 后台真金白银付给 DeepSeek 的钱
      deepseek-v4-flash 官方分时单价（人民币 / 百万 tokens），
      2026-09-10 12:00（北京时间）调价后的价目：
        计费项            空闲时段   高峰时段(=2×)
        输入·缓存未命中    ¥1.00     ¥2.00
        输入·缓存命中      ¥0.02     ¥0.04
        输出              ¥4.00     ¥8.00
      高峰时段 = 周一至周五 09:00–12:00、14:00–18:00（北京时间），其余空闲。

   2) 用户侧计价（积分）= 真实成本 × 140%
      即用户按后台成本的 1.4 倍结算，站方在真金白银的成本上留 40% 溢价。

   3) 积分单位：1 积分 = ¥0.001（即 1000 积分 = 1 元）
      例：一次生成真花 ¥0.020 → 用户侧 ¥0.028 → 28 积分。

   4) 免费引擎（Cloudflare Workers AI）**不计积分** —— 它不花 DeepSeek 的钱。
      匿名（未登录）调用记到 pseudo 用户 `anon` 下，不丢账。
   ══════════════════════════════════════════════════════════════════ */

/** deepseek-v4-flash 官方分时单价（CNY / 百万 tokens） */
const PRICE_CNY_PER_M = {
  idle: { inMiss: 1.0, inHit: 0.02, out: 4.0 },
  peak: { inMiss: 2.0, inHit: 0.04, out: 8.0 },
}
/** 用户侧计价倍率：真实成本的 140%（含 40% 溢价） */
const CREDIT_MARKUP = 1.4
/** 1 积分 = ¥0.001（1000 积分 = 1 元） */
const CNY_PER_CREDIT = 0.001
/** 未登录调用记到这个 pseudo 账号下 */
const ANON_UID = 'anon'

function toNum(v) {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && isFinite(n) ? n : 0
}

/** 北京时间是不是高峰时段（周一至周五 09:00–12:00 / 14:00–18:00） */
function isPeakHour(d = new Date()) {
  const cn = new Date(d.getTime() + 8 * 3600 * 1000) // 平移到北京时间再取 UTC 分量
  const day = cn.getUTCDay() // 0=周日
  if (day === 0 || day === 6) return false
  const h = cn.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/**
 * 从各家响应的 usage 里抠出「缓存未命中输入 / 缓存命中输入 / 输出」三段 token。
 * 两个端点口径不同，必须分开解析：
 *   · Responses API(OpenAI 风格)：input_tokens **已包含** 缓存命中，命中数在 details 里 → 要减
 *   · Anthropic 兼容端点：input_tokens 是未命中部分，缓存命中在 cache_read_input_tokens → 不用减
 */
function readUsage(data, flavor) {
  const u = data && data.usage
  if (!u || typeof u !== 'object') return { inMiss: 0, inHit: 0, out: 0 }
  const out = toNum(u.output_tokens != null ? u.output_tokens : u.completion_tokens)
  if (flavor === 'anthropic') {
    return { inMiss: toNum(u.input_tokens), inHit: toNum(u.cache_read_input_tokens), out }
  }
  const details = u.input_tokens_details || u.prompt_tokens_details || {}
  const hit = toNum(details.cached_tokens)
  const totalIn = toNum(u.input_tokens != null ? u.input_tokens : u.prompt_tokens)
  return { inMiss: Math.max(0, totalIn - hit), inHit: hit, out }
}

/** 把一次云端调用的 usage 累加到「本请求」的账本上（挂在 per-request env 视图上，不污染并发） */
function addUsage(env, u) {
  if (!env.__usage || !u) return
  env.__usage.inMiss += u.inMiss || 0
  env.__usage.inHit += u.inHit || 0
  env.__usage.out += u.out || 0
  env.__usage.calls += 1
}

/** 三段 token → 真实成本（元） */
function costCnyOf(u, peak) {
  const p = peak ? PRICE_CNY_PER_M.peak : PRICE_CNY_PER_M.idle
  return (u.inMiss * p.inMiss + u.inHit * p.inHit + u.out * p.out) / 1e6
}

/** 真实成本（元）→ 用户侧积分（已含 140% 计价） */
function creditsOf(costCny) {
  return (costCny * CREDIT_MARKUP) / CNY_PER_CREDIT
}

/* ══════════════════════════════════════════════════════════════════
   每日免费额度（v10.71 重定义）
   ------------------------------------------------------------------
   产品口径（用户 2026-10-31 定）：
     · **取消免费模型**，AI 生成统一走站方 DeepSeek API；
     · 每个用户**每天前 FREE_DAILY_LIMIT 次不计费**（用户侧积分为 0）；
     · 超过之后按既有报价正常扣积分。

   实现要点：
     · 计数粒度 = 一次**真实消耗 token 的请求**为 1 次
       （generate 内部会连打多次模型，但用户只点了一下，仍只算 1 次）。
     · 「一天」按北京时间 0 点重置（与积分流水展示口径一致）。
     · 未登录（仅本机模式）记到 anon 共用池。
     · 免费时不扣积分，但**仍记录真实成本**（cost_cny）供后台核算。
   ══════════════════════════════════════════════════════════════════ */
const FREE_DAILY_LIMIT = 20

/**
 * v10.74 临时全免费（用户 2026-11-06 要求：「每日 20 次免费」先改成全部免费）
 * ------------------------------------------------------------------
 * 打开后：**所有调用都不扣积分、也不消耗每日免费次数**，
 * 但仍照常记录真实成本（cost_cny）—— 后台还能看见今天烧了多少钱，
 * 等要恢复收费时把这里翻回 false 即可，历史流水不受影响。
 */
const BILLING_FREE_ALL = true

/** 北京时间日期串 YYYY-MM-DD */
function cnDay(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 今天已经点了几次免费模型 */
async function freeUsedToday(env, uid) {
  if (!env.WRITER_D1) return 0
  const rows = await d1All(env, 'SELECT used FROM free_usage WHERE scope = ? AND day = ?', [
    uid,
    cnDay(),
  ])
  return toNum(rows[0] && rows[0].used)
}

/** 记一次免费点击 */
async function bumpFreeUsage(env, uid) {
  if (!env.WRITER_D1) return
  await d1Run(
    env,
    `INSERT INTO free_usage (scope, day, used) VALUES (?, ?, 1)
       ON CONFLICT(scope, day) DO UPDATE SET used = used + 1`,
    [uid, cnDay()],
  )
}

/**
 * 尽力认出调用者：免费额度与积分结算都要用它。
 * 认不出返回 null（不抛错）—— 未登录是合法状态（仅本机模式）。
 * 每次请求只查一次（结果缓存在 per-request 的 env 视图上）。
 */
async function currentUser(env, body) {
  if (env.__meTried) return env.__me || null
  env.__meTried = true
  try {
    env.__me = await requireAuth(env, body && body.token)
  } catch {
    env.__me = null
  }
  return env.__me
}

/** 当前用户的免费额度状态 */
async function freeQuota(env, uid) {
  const used = await freeUsedToday(env, uid)
  return {
    freeUsed: used,
    freeLimit: FREE_DAILY_LIMIT,
    freeLeft: Math.max(0, FREE_DAILY_LIMIT - used),
  }
}

/**
 * 请求收尾时结算：把本请求累计的云端 token 落库。
 * 尽力而为 —— 任何失败都只记日志，绝不影响主流程返回。
 * 由 fetch() 的 finally 调用（所以每个 return 路径都会被结算到）。
 */
async function flushCreditUsage(env, body) {
  const u = env.__usage
  if (!env.WRITER_D1 || !u || u.inMiss + u.inHit + u.out <= 0) return
  // 未登录 / token 失效 → 记到 anon，不阻断（currentUser 每请求只查一次，与额度检查共用）
  const me = await currentUser(env, body)
  const uid = me ? me.userId : ANON_UID
  const peak = isPeakHour()
  const cost = costCnyOf(u, peak)
  const now = new Date().toISOString()

  // v10.74：全免费模式下一律不计费，也不消耗每日免费次数（保持计数器干净，
  // 将来恢复收费时用户手上还是满额 20 次）。
  let isFreeCall = false
  if (BILLING_FREE_ALL) {
    isFreeCall = true
  } else {
    try {
      const usedToday = await freeUsedToday(env, uid)
      isFreeCall = usedToday < FREE_DAILY_LIMIT
    } catch (e) {
      // 额度表异常不该让记账失败 —— 按"已超额"处理（宁可少送，不可白送）
      console.error(`[Worker ${VERSION}] 读取免费额度失败，按计费处理:`, safeStr(e))
      isFreeCall = false
    }
  }
  const credits = isFreeCall ? 0 : creditsOf(cost)

  await d1Run(
    env,
    `INSERT INTO credit_usage
       (user_id, action, model, tokens_miss, tokens_hit, tokens_out, cost_cny, credits, peak, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uid, toStr(body && body.action), MODEL, u.inMiss, u.inHit, u.out, cost, credits, peak ? 1 : 0, now],
  )
  await d1Run(
    env,
    `INSERT INTO credit_account (user_id, granted, used, updated_at) VALUES (?, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at`,
    [uid, credits, now],
  )

  // 只有真的用了每日免费额度才 +1（全免费模式 / 超额后的调用都不占用）
  if (isFreeCall && !BILLING_FREE_ALL) {
    try {
      await bumpFreeUsage(env, uid)
    } catch (e) {
      console.error(`[Worker ${VERSION}] 免费额度计数失败:`, safeStr(e))
    }
  }
}

/**
 * 单个用户的积分状况：余额 / 已消耗 / 调用次数 / 近期明细。
 *
 * ⚠️ `includeCost` 必须由**服务端判定**后传入（普通用户 false）：
 * 「后台真实成本」与「溢价倍率」是站方的成本结构，只在 UI 上藏起来不够 ——
 * 普通用户翻 devtools 就能看到响应体，所以这里直接不下发。
 */
async function creditsStatus(env, uid, limit = 20, includeCost = false) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20))
  const acc = (await d1All(env, 'SELECT granted, used, note, updated_at FROM credit_account WHERE user_id = ?', [uid]))[0] || {}
  const sum = (await d1All(
    env,
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(cost_cny), 0) AS cost,
            COALESCE(SUM(credits), 0) AS credits,
            COALESCE(SUM(tokens_miss + tokens_hit + tokens_out), 0) AS tokens
       FROM credit_usage WHERE user_id = ?`,
    [uid],
  ))[0] || {}
  // 「今天」按北京时间算：created_at 存的是 UTC ISO 串，先算出北京当天 00:00 对应的 UTC 时刻再比字符串
  const cnNowMs = Date.now() + 8 * 3600 * 1000
  const cnDayStartUtcIso = new Date(Math.floor(cnNowMs / 86400000) * 86400000 - 8 * 3600 * 1000).toISOString()
  const day = (await d1All(
    env,
    `SELECT COALESCE(SUM(credits), 0) AS credits, COUNT(*) AS calls
       FROM credit_usage WHERE user_id = ? AND created_at >= ?`,
    [uid, cnDayStartUtcIso],
  ))[0] || {}
  // 明细里带「东方时间」的本地串，方便直接看
  const recent = (await d1All(
    env,
    `SELECT action, model, tokens_miss, tokens_hit, tokens_out, cost_cny, credits, peak, created_at
       FROM credit_usage WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    [uid, n],
  )).map(r => {
    const row = {
      action: r.action,
      model: r.model,
      tokensMiss: toNum(r.tokens_miss),
      tokensHit: toNum(r.tokens_hit),
      tokensOut: toNum(r.tokens_out),
      credits: Number(toNum(r.credits).toFixed(4)),
      peak: Boolean(r.peak),
      at: toCnTimeStr(r.created_at),
    }
    // 单次的真实成本同样只回给管理员
    if (includeCost) row.costCny = Number(toNum(r.cost_cny).toFixed(6))
    return row
  })
  const granted = toNum(acc.granted)
  const used = toNum(acc.used)
  const out = {
    userId: uid,
    granted: Number(granted.toFixed(4)),
    used: Number(used.toFixed(4)),
    balance: Number((granted - used).toFixed(4)),
    tokens: toNum(sum.tokens),
    calls: toNum(sum.calls),
    todayCredits: Number(toNum(day.credits).toFixed(4)),
    todayCalls: toNum(day.calls),
    cnyPerCredit: CNY_PER_CREDIT,
    recent,
    // v10.74 全免费开关：前端据此显示「当前全部免费」，而不是次数计数
    freeForAll: BILLING_FREE_ALL,
    // v10.25 免费模型今日额度（自己的用量，与站方成本无关，人人可见）
    ...(await freeQuota(env, uid)),
  }
  if (includeCost) {
    /** 真实成本（后台真金白银付给 DeepSeek 的，元）—— 仅管理员 */
    out.costCny = Number(toNum(sum.cost).toFixed(6))
    /** 真实成本的 140%（用户侧计价，元）—— 仅管理员 */
    out.chargedCny = Number((toNum(sum.cost) * CREDIT_MARKUP).toFixed(6))
    /** 溢价倍率 —— 仅管理员 */
    out.markup = CREDIT_MARKUP
  }
  return out
}

/** ISO 时间 → 北京时间可读串 */
function toCnTimeStr(iso) {
  const t = Date.parse(iso || '')
  if (!t) return toStr(iso)
  const cn = new Date(t + 8 * 3600 * 1000)
  const p = x => String(x).padStart(2, '0')
  return `${cn.getUTCFullYear()}-${p(cn.getUTCMonth() + 1)}-${p(cn.getUTCDate())} ${p(cn.getUTCHours())}:${p(cn.getUTCMinutes())}`
}

/** 管理员：全站积分总览（每个用户的余额 / 已用 / 真实成本） */
async function adminCreditsOverview(env) {
  // 用户 + 发放/消耗聚合分两条查：SQLite 里 LEFT JOIN 带聚合更容易踩空行，分开算更稳
  const rows = await d1All(
    env,
    `SELECT u.user_id, u.username, u.role, u.status,
            COALESCE(a.granted, 0) AS granted,
            COALESCE(a.used, 0)    AS used
       FROM users u LEFT JOIN credit_account a ON a.user_id = u.user_id
      ORDER BY u.create_at DESC`,
  )
  const agg = await d1All(
    env,
    `SELECT user_id, COALESCE(SUM(cost_cny),0) AS cost, COALESCE(SUM(credits),0) AS credits,
            COUNT(*) AS calls, COALESCE(SUM(tokens_miss+tokens_hit+tokens_out),0) AS tokens
       FROM credit_usage GROUP BY user_id`,
  )
  const byUid = {}
  for (const r of agg) byUid[r.user_id] = r
  const items = rows.map(r => {
    const g = toNum(r.granted)
    const us = toNum(r.used)
    const a = byUid[r.user_id] || {}
    return {
      userId: r.user_id,
      username: r.username,
      role: r.role,
      status: r.status,
      granted: Number(g.toFixed(4)),
      used: Number(us.toFixed(4)),
      balance: Number((g - us).toFixed(4)),
      costCny: Number(toNum(a.cost).toFixed(6)),
      chargedCny: Number((toNum(a.cost) * CREDIT_MARKUP).toFixed(6)),
      calls: toNum(a.calls),
      tokens: toNum(a.tokens),
    }
  })
  // 匿名（未登录）调用单独列出来，别丢账
  const anon = byUid[ANON_UID]
  const totals = items.reduce(
    (s, x) => ({
      granted: s.granted + x.granted,
      used: s.used + x.used,
      costCny: s.costCny + x.costCny,
      calls: s.calls + x.calls,
      tokens: s.tokens + x.tokens,
    }),
    { granted: 0, used: 0, costCny: 0, calls: 0, tokens: 0 },
  )
  return {
    items,
    totals: {
      granted: Number(totals.granted.toFixed(4)),
      used: Number(totals.used.toFixed(4)),
      balance: Number((totals.granted - totals.used).toFixed(4)),
      costCny: Number(totals.costCny.toFixed(6)),
      chargedCny: Number((totals.costCny * CREDIT_MARKUP).toFixed(6)),
      calls: totals.calls,
      tokens: totals.tokens,
    },
    anon: anon
      ? { costCny: Number(toNum(anon.cost).toFixed(6)), calls: toNum(anon.calls), tokens: toNum(anon.tokens) }
      : null,
    markup: CREDIT_MARKUP,
    cnyPerCredit: CNY_PER_CREDIT,
    priceTable: PRICE_CNY_PER_M,
    peakNow: isPeakHour(),
  }
}

/**
 * 管理员：给用户发放 / 校正积分。
 *   mode='add' → 在现有余额上追加（发放额度，最常用）
 *   mode='set' → 把「累计发放」直接设成该值（校正用；余额 = granted - used）
 */
async function adminCreditsGrant(env, me, body = {}) {
  const target = await resolveUser(env, body.userId || body.username)
  const amount = Number(body.amount)
  if (!isFinite(amount)) throw new Error('amount 必须是数字')
  const mode = body.mode === 'set' ? 'set' : 'add'
  const now = new Date().toISOString()
  const cur = (await d1All(env, 'SELECT granted FROM credit_account WHERE user_id = ?', [target.user_id]))[0]
  const granted = mode === 'set' ? amount : toNum(cur && cur.granted) + amount
  await d1Run(
    env,
    `INSERT INTO credit_account (user_id, granted, used, note, updated_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET granted = ?, note = ?, updated_at = ?`,
    [target.user_id, granted, toStr(body.note), now, granted, toStr(body.note), now],
  )
  await audit(
    env,
    me,
    'credits_grant',
    target.username,
    `${mode === 'add' ? '追加' : '设为'} ${amount} 积分 → 累计发放 ${granted}（${toStr(body.note)}）`,
  )
  // 调用方是管理员（requireAdmin 已验），所以带上成本口径
  return creditsStatus(env, target.user_id, 10, true)
}

/* ---------------- 测试版 → 正式版 发布请求（v10.18）----------------
   Cloudflare Pages 的 Direct Upload 项目不支持把 preview 部署 promote 到
   production（实测 POST /deployments/{id}/promote 恒 405），Worker 里也跑不了
   wrangler。所以发布登记在这里做「意图落库 + 版本锁定」，真正的文件上传由
   助手用 wrangler 完成，完成后回来调 promoteResolve 把状态改成 done。
   ============================================================ */

const PROMOTE_KEY = 'sys:promote-request'

async function promoteRequest(env, me, body = {}) {
  const prev = await kvGetJson(env, PROMOTE_KEY)
  if (prev && prev.status === 'pending') {
    return {
      alreadyPending: true,
      request: prev,
      hint: '已有一条待发布请求，重复提交不会覆盖。要改主意先点「撤销」。',
    }
  }
  const req = {
    status: 'pending',
    buildHash: toStr(body.buildHash),
    buildTag: toStr(body.buildTag),
    note: toStr(body.note),
    requestedAt: nowIso(),
    requestedBy: me.username,
    requestedByUserId: me.userId,
    from: 'staging',
    to: 'production',
  }
  await kvPutJson(env, PROMOTE_KEY, req)
  await audit(env, me, 'promoteRequest', 'writer-simulator', `build=${req.buildHash || '-'} ${req.note}`)
  return { request: req, hint: '发布请求已登记。通知助手执行部署即可上线。' }
}

async function promoteStatus(env) {
  const req = await kvGetJson(env, PROMOTE_KEY)
  return { request: req || null }
}

async function promoteResolve(env, me, body = {}) {
  const req = await kvGetJson(env, PROMOTE_KEY)
  if (!req) return err('当前没有待发布的请求')
  if (req.status !== 'pending') return { request: req, hint: '这条请求已经处理过了' }
  const outcome = body.outcome === 'cancelled' ? 'cancelled' : 'done'
  const next = {
    ...req,
    status: outcome,
    resolvedAt: nowIso(),
    resolvedBy: me.username,
    prodBuildHash: toStr(body.prodBuildHash),
    resolveNote: toStr(body.resolveNote),
  }
  await kvPutJson(env, PROMOTE_KEY, next)
  await audit(
    env,
    me,
    outcome === 'done' ? 'promoteDone' : 'promoteCancel',
    'writer-simulator',
    `build=${req.buildHash || '-'} → ${next.prodBuildHash || '-'} ${next.resolveNote}`,
  )
  return { request: next }
}

/* ---------------- 管理员读取用户创作数据（只读，全部审计） ----------------
   约束：
   1. 只能读，不能改；所有接口都过 requireAdmin。
   2. 每次读取落 audit：目标用户名 + 读取类型 + 摘要，事后可追溯。
   3. 不返回 session/token 等敏感信息。
   4. 默认不过度展开：overview 给摘要；state/book/asset 按需点入。
   ============================================================ */

async function adminUserContentOverview(env, me, ref) {
  const target = await resolveUser(env, ref)
  const uid = target.user_id
  const state = await kvGetJson(env, userKey(uid, STATE_KEY))
  const assets = await assetsLoad(env, uid)
  const one = async (sql, params = []) => (await d1All(env, sql, params))[0] || {}
  const d1Stats = {
    projects: Number((await one('SELECT COUNT(*) AS n FROM project_info WHERE user_id = ?', [uid])).n) || 0,
    chapters: Number((await one('SELECT COUNT(*) AS n FROM chapter_index WHERE user_id = ?', [uid])).n) || 0,
    weightLogs: Number((await one('SELECT COUNT(*) AS n FROM weight_log WHERE user_id = ?', [uid])).n) || 0,
    cases: Number((await one('SELECT COUNT(*) AS n FROM project_case_library WHERE user_id = ?', [uid])).n) || 0,
  }
  const lib = Array.isArray(state?.library) ? state.library : []
  const bookWords = lib.reduce((sum, b) => sum + (Number(b?.stats?.totalWords) || 0), 0)
  const chapterWritingWords = lib.reduce((sum, b) => {
    const cw = b?.chapterWritings || {}
    return sum + Object.values(cw).reduce((s, w) => s + (Number(w?.wordCount) || 0), 0)
  }, 0)
  const canvasChars = Object.values(state?.canvases || {}).reduce(
    (sum, c) => sum + String(c?.content || '').length,
    0,
  )
  let lastBackup = null
  try {
    const res = await listBackups(env, uid, 1)
    lastBackup = Array.isArray(res?.items) ? res.items[0] || null : null
  } catch {
    lastBackup = null
  }
  await audit(env, me, 'user_content_overview', target.username, `uid=${uid}`)
  return {
    userId: uid,
    username: target.username,
    role: ROLE_OF(target),
    status: STATUS_OF(target),
    state: {
      exists: Boolean(state),
      sizeBytes: state ? JSON.stringify(state).length : 0,
      updatedAt: state?.updatedAt || null,
      serverSavedAt: state?.serverSavedAt || null,
      canvasCount: Object.keys(state?.canvases || {}).length,
      canvasChars,
      libraryCount: lib.length,
      libraryWords: bookWords,
      chapterWritingWords,
    },
    assets: {
      atoms: assets.atoms.length,
      branches: assets.branches.length,
      snaps: assets.snaps.length,
    },
    d1: d1Stats,
    lastBackup: lastBackup
      ? { stamp: lastBackup.stamp, createdAt: lastBackup.createdAt, size: lastBackup.size }
      : null,
  }
}

async function adminUserStateGet(env, me, ref) {
  const target = await resolveUser(env, ref)
  const uid = target.user_id
  const state = await kvGetJson(env, userKey(uid, STATE_KEY))
  await audit(env, me, 'user_state_read', target.username, `uid=${uid} size=${state ? JSON.stringify(state).length : 0}`)
  return { userId: uid, username: target.username, state }
}

async function adminUserBookGet(env, me, ref, bookId) {
  const target = await resolveUser(env, ref)
  const uid = target.user_id
  const state = await kvGetJson(env, userKey(uid, STATE_KEY))
  const book = (Array.isArray(state?.library) ? state.library : []).find(b => b?.id === bookId)
  if (!book) throw new Error('找不到该作品')
  await audit(env, me, 'user_book_read', target.username, `bookId=${bookId} title=${toStr(book.title).slice(0, 40)}`)
  return { userId: uid, username: target.username, book }
}

async function adminUserAssetsList(env, me, ref, kind) {
  const target = await resolveUser(env, ref)
  const uid = target.user_id
  const out = { atoms: [], branches: [], snaps: [] }
  if (kind && !ASSET_KINDS[kind]) throw new Error('kind 必须是 atom / branch / snap')
  const kinds = kind ? [kind] : Object.keys(ASSET_KINDS)
  const bucketOf = { atom: 'atoms', branch: 'branches', snap: 'snaps' }
  for (const k of kinds) {
    const keys = await kvListAll(env, assetPrefix(k, uid))
    for (const key of keys) {
      const v = await kvGetJson(env, key)
      if (v) {
        out[bucketOf[k]].push({
          id: v.id,
          name: v.name || v.title || '未命名',
          dimension: v.dimension || null,
          updatedAt: v.updatedAt || v.createdAt || null,
        })
      }
    }
  }
  await audit(env, me, 'user_assets_list', target.username, `kind=${kind || 'all'}`)
  return { userId: uid, username: target.username, ...out }
}

async function adminUserAssetGet(env, me, ref, kind, id) {
  const target = await resolveUser(env, ref)
  const uid = target.user_id
  if (!ASSET_KINDS[kind]) throw new Error('kind 必须是 atom / branch / snap')
  const v = await kvGetJson(env, assetPrefix(kind, uid) + id)
  if (!v) throw new Error('找不到该资产')
  await audit(env, me, 'user_asset_read', target.username, `kind=${kind} id=${id}`)
  return { userId: uid, username: target.username, kind, id, data: v }
}

/* ============================================================
   写作优化 · 训练（用用户存下的作品蒸馏成模型）
   ------------------------------------------------------------
   纯 JS 实现（Worker 是部署产物，无法 import TS 模块）。
   逻辑与 src/lib/writingTraining.ts 一一对应：
   1. analyzeText  —— 轻量文本指标（不调 LLM）
   2. deriveWeights—— 由指标推导七维偏好权重
   3. extractCases —— 按维度抽优秀段落
   4. buildProfile —— 单用户写作画像
   5. trainAll     —— 聚合全站语料
   产物落库：单用户画像 user:{uid}:app:writingModel:v1，
   全局语料 app:writingCorpus:v1（顶层键），优秀案例写 project_case_library。
   ============================================================ */

const TRAIN_VERSION = '1.0'
const USER_MODEL_KEY = 'app:writingModel:v1'
const GLOBAL_CORPUS_KEY = 'app:writingCorpus:v1'

const SCENE_CUES = ['天色', '门外', '屋内', '城', '街', '山', '海', '夜', '晨', '殿', '院', '林', '河', '窗']
const STYLE_TAG_RULES = [
  { tag: '古风', keywords: ['之', '亦', '然', '曰', '公子', '姑娘', '殿下', '江湖', '剑客', '天下', '吾', '君'], minHits: 3 },
  { tag: '武侠', keywords: ['内力', '招式', '门派', '掌门', '剑法', '轻功', '江湖', '刀', '剑'], minHits: 3 },
  { tag: '玄幻', keywords: ['灵气', '修为', '境界', '宗门', '丹田', '法宝', '渡劫', '神识'], minHits: 3 },
  { tag: '言情', keywords: ['心跳', '脸红', '心动', '喜欢', '拥抱', '吻', '良人', '温柔'], minHits: 2 },
  { tag: '都市', keywords: ['公司', '地铁', '咖啡', '手机', '老板', '职场', '公寓'], minHits: 2 },
  { tag: '悬疑', keywords: ['尸体', '凶手', '密室', '线索', '侦探', '谜底'], minHits: 2 },
  { tag: '幽默', keywords: ['吐槽', '尴尬', '无语', '逗比', '搞笑', '笑死'], minHits: 2 },
]
const DIMENSION_KEYWORDS = {
  设定: ['世界', '大陆', '王朝', '神', '族', '规则', '灵气', '体系'],
  人物: ['他', '她', '眼神', '心跳', '嘴角', '背影', '声音'],
  文笔: ['仿佛', '犹如', '像是', '光影', '风', '月', '霜'],
  情节: ['突然', '就在这时', '不料', '原来', '终于', '却'],
  节奏: ['脚步', '呼吸', '一瞬', '片刻', '转瞬'],
}

const round1 = (n) => Math.round(n * 10) / 10
const round2 = (n) => Math.round(n * 100) / 100

function splitSentences(text) {
  return (text || '').split(/[。！？!?\n；;]+/).map((s) => s.trim()).filter(Boolean)
}

function analyzeText(text) {
  const clean = text || ''
  const charCount = clean.length
  if (!charCount) {
    return {
      charCount: 0, sentenceCount: 0, avgSentenceLen: 0, sentenceLenStd: 0,
      dialogueRatio: 0, sceneCueRatio: 0, vocabRichness: 0, fourCharIdiomRatio: 0,
      paragraphCount: 0, avgParagraphLen: 0, styleTags: [], rhythmProfile: { short: 0, medium: 0, long: 0 },
    }
  }
  const sentences = splitSentences(clean)
  const sentenceCount = sentences.length || 1
  const lengths = sentences.map((s) => s.length)
  const avgSentenceLen = lengths.reduce((a, b) => a + b, 0) / sentenceCount
  const variance = lengths.reduce((a, b) => a + (b - avgSentenceLen) ** 2, 0) / sentenceCount
  const sentenceLenStd = Math.sqrt(variance)
  const dialogueChars = (clean.match(/[“"『「][^”"』」]*[”"』」]/g) || []).join('').length
  const dialogueRatio = dialogueChars / charCount
  const sceneHits = SCENE_CUES.reduce((n, w) => n + (clean.split(w).length - 1), 0)
  const sceneCueRatio = Math.min(1, sceneHits / (charCount / 50))
  const han = clean.replace(/[^一-龥]/g, '')
  const uniqueChars = new Set(han.split('')).size
  const vocabRichness = uniqueChars / Math.max(1, han.length)
  const fourChars = clean.match(/([一-龥]{4})(?=[，。！？、\s])/g) || []
  const fourCharIdiomRatio = fourChars.length / sentenceCount
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const paragraphCount = paragraphs.length || 1
  const avgParagraphLen = charCount / paragraphCount
  const styleTags = []
  for (const rule of STYLE_TAG_RULES) {
    const hits = rule.keywords.reduce((n, k) => n + (clean.split(k).length - 1), 0)
    if (hits >= rule.minHits) styleTags.push(rule.tag)
  }
  if (fourCharIdiomRatio > 0.25 && !styleTags.includes('华丽')) styleTags.push('华丽')
  if (dialogueRatio > 0.25 && !styleTags.includes('对话密集')) styleTags.push('对话密集')
  const short = lengths.filter((l) => l <= 15).length / sentenceCount
  const long = lengths.filter((l) => l > 40).length / sentenceCount
  const medium = 1 - short - long
  return {
    charCount, sentenceCount,
    avgSentenceLen: round1(avgSentenceLen), sentenceLenStd: round1(sentenceLenStd),
    dialogueRatio: round2(dialogueRatio), sceneCueRatio: round2(sceneCueRatio),
    vocabRichness: round2(vocabRichness), fourCharIdiomRatio: round2(fourCharIdiomRatio),
    paragraphCount, avgParagraphLen: round1(avgParagraphLen),
    styleTags, rhythmProfile: { short: round2(short), medium: round2(medium), long: round2(long) },
  }
}

function normWeights(raw) {
  const keys = ['设定', '人物', '文笔', '结构', '篇幅', '情节', '节奏']
  const sum = keys.reduce((s, k) => s + raw[k], 0)
  const out = {}
  for (const k of keys) out[k] = sum > 0 ? raw[k] / sum : 1 / 7
  return out
}

function rhythmBalance(r) {
  const vals = [r.short, r.medium, r.long]
  const mean = 1 / 3
  const dev = vals.reduce((a, v) => a + Math.abs(v - mean), 0)
  return Math.max(0, 1 - dev)
}

function deriveWeights(m) {
  if (!m.charCount) return { 设定: 0.16, 人物: 0.16, 文笔: 0.14, 结构: 0.14, 篇幅: 0.1, 情节: 0.16, 节奏: 0.14 }
  const raw = {
    设定: 0.1 + m.sceneCueRatio * 1.5,
    人物: 0.1 + m.dialogueRatio * 2.5,
    文笔: 0.1 + m.vocabRichness * 1.2 + m.fourCharIdiomRatio * 1.0,
    结构: 0.14,
    篇幅: 0.08 + Math.min(m.avgParagraphLen / 3000, 0.06),
    情节: 0.16,
    节奏: 0.1 + rhythmBalance(m.rhythmProfile) * 0.4,
  }
  return normWeights(raw)
}

function scorePassage(text) {
  let score = 0
  const len = text.length
  const dist = Math.abs(len - 38)
  score += Math.max(0, 1 - dist / 80)
  if (/[“"『「][^”"』」]*[”"』」]/g.test(text)) score += 0.3
  if (/([一-龥]{4})(?=[，。！？、\s])/g.test(text)) score += 0.2
  if (len <= 120) score += 0.2
  return Math.min(1.5, score)
}

function extractCases(text, limitPerDim = 2) {
  const m = analyzeText(text)
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length >= 20 && p.length <= 200)
  const buckets = {}
  for (const p of paragraphs) {
    const sc = scorePassage(p)
    for (const dim of Object.keys(DIMENSION_KEYWORDS)) {
      const hits = DIMENSION_KEYWORDS[dim].reduce((n, k) => n + (p.split(k).length - 1), 0)
      if (hits > 0) {
        buckets[dim] = buckets[dim] || []
        buckets[dim].push({ text: p.slice(0, 200), score: round2(sc + hits * 0.1) })
      }
    }
  }
  const out = []
  for (const dim of Object.keys(buckets)) {
    const top = buckets[dim].sort((a, b) => b.score - a.score).slice(0, limitPerDim)
    for (const t of top) out.push({ dimension: dim, text: t.text, score: t.score })
  }
  return out
}

function bookText(book) {
  const parts = []
  if (book && book.synopsis) parts.push(book.synopsis)
  if (book && book.sampleChapter && book.sampleChapter.content) parts.push(book.sampleChapter.content)
  const w = (book && book.chapterWritings) || {}
  const idx = Object.keys(w).map(Number).sort((a, b) => a - b)
  for (const i of idx) if (w[i] && w[i].content) parts.push(w[i].content)
  return parts.join('\n\n')
}

function buildProfile(userId, books) {
  const combined = books.map((b) => bookText(b)).filter(Boolean).join('\n\n')
  const metrics = analyzeText(combined)
  const sampleCases = extractCases(combined, 2)
  return {
    userId,
    bookCount: books.length,
    trainedAt: nowIso(),
    metrics,
    dimensionWeights: deriveWeights(metrics),
    sampleCases,
  }
}

function trainAll(profiles) {
  const styleTagDistribution = {}
  const cases = []
  let bookCount = 0
  const acc = { 设定: 0, 人物: 0, 文笔: 0, 结构: 0, 篇幅: 0, 情节: 0, 节奏: 0 }
  for (const p of profiles) {
    bookCount += p.bookCount
    for (const t of p.metrics.styleTags) styleTagDistribution[t] = (styleTagDistribution[t] || 0) + 1
    cases.push(...p.sampleCases)
    for (const d of Object.keys(acc)) acc[d] += p.dimensionWeights[d]
  }
  const n = Math.max(1, profiles.length)
  const averaged = {
    设定: acc.设定 / n, 人物: acc.人物 / n, 文笔: acc.文笔 / n, 结构: acc.结构 / n,
    篇幅: acc.篇幅 / n, 情节: acc.情节 / n, 节奏: acc.节奏 / n,
  }
  const globalWeights = normWeights(averaged)
  const seen = new Set()
  const deduped = cases.filter((c) => {
    const k = c.dimension + ':' + c.text.slice(0, 30)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  deduped.sort((a, b) => b.score - a.score)
  return {
    version: TRAIN_VERSION,
    trainedAt: nowIso(),
    userCount: profiles.length,
    bookCount,
    styleTagDistribution,
    cases: deduped.slice(0, 60),
    globalWeights,
  }
}

async function adminTrainModel(env, me) {
  const users = await d1All(env, 'SELECT user_id, username FROM users ORDER BY create_at DESC')
  const profiles = []
  let caseRows = 0
  for (const u of users) {
    const uid = u.user_id
    const state = await kvGetJson(env, userKey(uid, STATE_KEY))
    const books = Array.isArray(state && state.library) ? state.library : []
    if (!books.length) continue
    const profile = buildProfile(uid, books)
    await kvPutJson(env, userKey(uid, USER_MODEL_KEY), profile)
    for (const c of profile.sampleCases) {
      try {
        await d1Run(
          env,
          `INSERT INTO project_case_library
             (case_id, project_id, scene_tags, related_atomic_ids, case_type, fail_reason, best_fix_strategy, success_rate, create_at, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`case-${uid}-${caseRows}`, uid, c.dimension, '', 'success', '', c.text.slice(0, 200), round2(c.score), nowIso(), uid],
        )
        caseRows++
      } catch (e) {
        console.warn('[train] 案例写入失败', safeStr(e))
      }
    }
    profiles.push(profile)
  }
  const corpus = trainAll(profiles)
  await kvPutJson(env, GLOBAL_CORPUS_KEY, corpus)
  await audit(
    env,
    me,
    'model_train',
    'all',
    `用户=${corpus.userCount} 作品=${corpus.bookCount} 案例=${caseRows} 风格=${Object.keys(corpus.styleTagDistribution).join('/') || '无'}`,
  )
  return {
    trainedAt: corpus.trainedAt,
    userCount: corpus.userCount,
    bookCount: corpus.bookCount,
    caseCount: caseRows,
    styleTagDistribution: corpus.styleTagDistribution,
    globalWeights: corpus.globalWeights,
  }
}

/* v10.64：仅供测试的导出（不影响线上行为：Worker 只调用 default.fetch / default.scheduled）。
   本机跑不了 workerd（沙箱），所以用 Node 直接引这些纯函数做单元测试：
     import { __test } from './worker.js'  →  __test.saveState(env, uid, state, opts)
   用内存 KV 假件即可完整验证「作品库只增不减」的守卫与镜像。 */


/* ============================================================
   v10.79 观察摘要库：白名单校验（导出给测试）
   ------------------------------------------------------------
   · 字段重造：前端多塞的任何东西（包括 OCR 原文）都在这里被丢弃
   · 长度/类型硬上限
   · 敏感词二次拦截（前端 digestScene 已挡，双保险）
   ============================================================ */
const OBS_KINDS = ['chat', 'profile', 'article', 'misc']
const OBS_SENSITIVE_RE = /(密码|口令|验证码|银行卡|卡号|身份证|支付|api[_ -]?key|access[_ -]?token|私钥)/i

function jsonArr(s) {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
  } catch {
    return []
  }
}

function sanitizeObsRecord(r) {
  if (!r || typeof r !== 'object') return null
  // 敏感词二次拦截：整个记录序列化后扫一遍（多塞进来的字段也算数）
  if (OBS_SENSITIVE_RE.test(JSON.stringify(r))) return null
  const at = toStr(r.at).slice(0, 32)
  const kind = OBS_KINDS.includes(toStr(r.kind)) ? toStr(r.kind) : 'misc'
  const arr = v =>
    Array.isArray(v)
      ? v
          .filter(x => typeof x === 'string' && x.length > 0)
          .map(x => x.slice(0, 24))
          .slice(0, 6)
      : []
  // v10.90：gist 升级为段落级摘录（前端 MAX_KEYTEXT_CHARS=220），云端上限放宽到 400 留余量
  const gist = toStr(r.gist).slice(0, 400)
  const name = toStr(r.name).slice(0, 24)
  const speakers = arr(r.speakers)
  const topics = arr(r.topics)
  if (!gist && !name && !speakers.length && !topics.length) return null
  return {
    at: /^\d{4}-\d{2}-\d{2}T/.test(at) ? at : new Date().toISOString(),
    source: toStr(r.source).slice(0, 80),
    kind,
    name,
    speakers: JSON.stringify(speakers),
    topics: JSON.stringify(topics),
    entities: JSON.stringify(arr(r.entities)),
    gist,
    mood: toStr(r.mood).slice(0, 8),
  }
}

/* ============================================================
   灵感采集 · 多渠道抓取 fetchers（v10.80）
   ============================================================ */
const HARVEST_CHANNELS = ['zhihu', 'xhs', 'douyin', 'reddit', 'x']
const HARVEST_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 灵感采集专用 GET：超时可控、可带 cookie（cookie 只发给目标站点） */
async function harvestGet(url, { headers = {}, cookie = '', timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const h = {
      'User-Agent': HARVEST_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    }
    if (cookie) h['Cookie'] = cookie
    const resp = await fetch(url, { headers: h, redirect: 'follow', signal: ctrl.signal })
    return { status: resp.status, text: await resp.text(), finalUrl: resp.url || url }
  } finally {
    clearTimeout(timer)
  }
}

/** 极简 HTML → 纯文本（灵感采集够用：去标签 + 常见实体解码） */
function harvestStripHtml(html) {
  return toStr(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 粗判语料语言：中文/俄文/日文/韩文/英文（多语言资料标注用） */
function harvestLangOf(text) {
  const t = toStr(text)
  if (!t) return 'en'
  const n = t.length
  if (((t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length / n) > 0.12) return 'zh'
  if (((t.match(/[\u0400-\u04ff]/g) || []).length / n) > 0.12) return 'ru'
  if (((t.match(/[\u3040-\u30ff]/g) || []).length / n) > 0.08) return 'ja'
  if (((t.match(/[\uac00-\ud7af]/g) || []).length / n) > 0.08) return 'ko'
  return 'en'
}

/** 从一段输入里抠出所有 http(s) 链接（X / 小红书的链接模式） */
function harvestExtractLinks(query) {
  const links = toStr(query).match(/https?:\/\/[^\s，,、"“”'’<>()【】]+/g) || []
  return links.map(s => s.replace(/[).,;，。；]+$/, '')).filter(Boolean)
}

// —— Reddit：Arctic Shift 归档库（匿名可用）。
//    query 形如 "r/子版块" 或 "r/子版块 关键词"：近 30 天出勤按赞数排序，关键词过滤标题+正文。
//    跨设备要求：服务端路径必须在 Cloudflare 出口就能跑通（不能依赖调用者的本地网络）。
//    注：Arctic Shift 本身架在 Cloudflare 上，Worker 出口直抓会被它的源站防火墙 522 掉
//    （CF→CF 环路），所以这里维护一条多中继链逐个试：直抓 → jina reader → corsproxy → allorigins。
//    每条中继换一个出口网络，任一通即用；全挂才报错（错误里带各路线结果，方便定位）。
const ARCTIC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
async function harvestArcticPage(u) {
  const routes = [
    ['direct', u],
    ['jina', `https://r.jina.ai/${u}`],
    ['corsproxy', `https://corsproxy.io/?url=${encodeURIComponent(u)}`],
    ['allorigins', `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`],
  ]
  const fails = []
  for (const [name, url] of routes) {
    try {
      const { text, status } = await harvestGet(url, { headers: { 'User-Agent': ARCTIC_UA }, timeoutMs: 25000 })
      if (status !== 200) {
        fails.push(`${name}:HTTP${status}`)
        continue
      }
      // jina/corsproxy 可能包一层 markdown 头（Title:/URL Source:…），从第一个 { 开始抠 JSON
      const start = text.indexOf('{')
      const candidate = start > 0 ? text.slice(start) : text
      try {
        const posts = (JSON.parse(candidate) || {}).data || []
        if (posts.length) return posts
        if ((JSON.parse(candidate) || {}).data) return [] // 合法的空页（翻到头）
        fails.push(`${name}:空数据`)
      } catch {
        fails.push(`${name}:非JSON`)
      }
    } catch (e) {
      fails.push(`${name}:${safeStr(e).slice(0, 40)}`)
    }
  }
  throw `Reddit 归档库所有路线均不可达（${fails.join('；')}）`
}

async function harvestReddit({ query, limit }) {
  const m = query.match(/^r\/([A-Za-z0-9_]+)\b\s*(.*)$/i)
  const sub = (m ? m[1] : '').trim() || (query && !query.includes(' ') ? query : 'nosleep')
  const kw = (m ? m[2] : '').trim().toLowerCase()
  const since = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10)
  let before = new Date(Date.now() + 86400e3).toISOString().slice(0, 10)
  const all = []
  for (let page = 0; page < 25; page++) {
    const u = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(
      sub,
    )}&sort_type=created_utc&sort=desc&limit=100&after=${since}&before=${before}`
    const posts = await harvestArcticPage(u)
    if (!posts.length) break
    all.push(...posts)
    const lastCu = Number(posts[posts.length - 1].created_utc)
    if (!lastCu) break
    const next = new Date((lastCu - 1) * 1000).toISOString().slice(0, 19)
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
  const items = stories.slice(0, limit).map(p => ({
    id: toStr(p.id),
    title: toStr(p.title),
    text: toStr(p.selftext).slice(0, 20000),
    author: 'u/' + toStr(p.author),
    metrics: `${p.score || 0} 赞 · ${p.num_comments || 0} 评论`,
    lang: harvestLangOf(`${p.title} ${p.selftext}`),
    url: 'https://reddit.com' + toStr(p.permalink),
  }))
  return {
    channel: 'reddit',
    items,
    note: `r/${sub} 近 30 天扫描 ${all.length} 帖 → 入选 ${items.length} 条（按赞数排序）${
      kw ? `，关键词「${kw}」` : ''
    }。Reddit 帖子多为英文/多语种，拆解与改编支持任意语言原文。`,
  }
}

// —— 知乎：匿名=热榜（标题+热度+链接）；带登录 Cookie=每题再抓前 2 条答案正文。
//    关键词搜索接口需要签名（x-zse-96），暂不硬凑：热榜 + Cookie 正文已够改编素材。
async function harvestZhihu({ query, limit, cookie }) {
  const { text, status } = await harvestGet(
    `https://api.zhihu.com/topstory/hot-list?limit=50`,
    { headers: { Referer: 'https://www.zhihu.com/hot' }, cookie, timeoutMs: 15000 },
  )
  if (status !== 200) throw `知乎热榜返回 ${status}（可能被风控，稍后再试）`
  const list = ((JSON.parse(text) || {}).data) || []
  const hot = list
    .map(p => {
      const t = p.target || {}
      const qid = toStr(t.id) || toStr(p.card_id || '').replace(/^Q_/, '')
      return {
        qid,
        title: toStr(t.title) || toStr(t.title_text),
        excerpt: toStr(t.excerpt),
        heat: toStr(p.detail_text),
        type: toStr(t.type),
      }
    })
    .filter(x => x.qid && x.title)
    .slice(0, limit)
  const items = []
  for (const q of hot) {
    const item = {
      id: q.qid,
      title: q.title,
      text: q.excerpt,
      author: '知乎热榜',
      metrics: q.heat,
      lang: 'zh',
      url: `https://www.zhihu.com/question/${q.qid}`,
    }
    // 有登录 Cookie 才尝试抓答案正文（匿名接口 403 need_login，直接跳过）
    if (cookie && cookie.includes('z_c0')) {
      try {
        const { text: feedText, status: fs } = await harvestGet(
          `https://www.zhihu.com/api/v4/questions/${q.qid}/feeds?limit=2&include=content`,
          { headers: { Referer: `https://www.zhihu.com/question/${q.qid}` }, cookie, timeoutMs: 15000 },
        )
        if (fs === 200) {
          const feeds = ((JSON.parse(feedText) || {}).data) || []
          const bodies = []
          for (const f of feeds.slice(0, 2)) {
            const a = f.target || {}
            const content = harvestStripHtml(toStr(a.content) || toStr(a.excerpt))
            if (content) {
              const votes = Number(a.voteupCount ?? a.voteup_count ?? 0)
              bodies.push(`【答主 ${toStr((a.author || {}).name) || '匿名'} · ${votes} 赞】\n${content.slice(0, 4000)}`)
              const aid = toStr(a.id)
              if (aid) item.url = `https://www.zhihu.com/question/${q.qid}/answer/${aid}`
            }
          }
          if (bodies.length) {
            item.text = q.excerpt ? `${q.excerpt}\n\n${bodies.join('\n\n')}` : bodies.join('\n\n')
            item.author = '知乎（含答案正文）'
          }
        }
      } catch {
        /* 答案抓不到就只留热榜摘要 */
      }
    }
    items.push(item)
  }
  const kwNote = query
    ? `（关键词搜索需登录签名，本次按热榜返回；可从结果里挑相关的问题）`
    : ''
  const cookieNote = cookie && cookie.includes('z_c0') ? '' : '；未检测到登录 Cookie（z_c0），只返回热榜摘要——设置里粘贴知乎 Cookie 可抓答案正文'
  return {
    channel: 'zhihu',
    items,
    note: `知乎热榜抓取 ${items.length} 条${kwNote}${cookieNote}。`,
  }
}

// —— 抖音：热搜榜（匿名可用）。关键词搜索需 a_bogus 签名，暂不支持；
//    热搜词可当「灵感种子」直接拆解，或配合其他渠道的正文一起组语料。
async function harvestDouyin({ limit }) {
  const { text, status } = await harvestGet('https://www.douyin.com/aweme/v1/web/hot/search/list/', {
    headers: { Referer: 'https://www.douyin.com/hot' },
    timeoutMs: 15000,
  })
  if (status !== 200) throw `抖音热搜返回 ${status}（接口可能改版，稍后再试）`
  const wordList = (((JSON.parse(text) || {}).data) || {}).word_list || []
  const items = wordList.slice(0, limit).map((w, i) => {
    const word = toStr(w.word)
    const sid = toStr(w.sentence_id)
    return {
      id: sid || `hot-${i}`,
      title: word,
      // 热搜词条本身没有正文；title 就是话题，链接落到抖音搜索页
      text: toStr(w.event_word || ''),
      author: '抖音热搜',
      metrics: `${Number(w.hot_value || 0)} 热度`,
      lang: 'zh',
      url: sid ? `https://www.douyin.com/hot/${sid}` : `https://www.douyin.com/search/${encodeURIComponent(word)}`,
    }
  })
  return {
    channel: 'douyin',
    items,
    note: `抖音热搜榜抓取 ${items.length} 条（话题即灵感种子；App 内关键词搜索需签名暂不支持）。`,
  }
}

// —— 小红书：网页接口有风控（匿名抓笔记页会被 302 到验证页）。
//    必须带登录 Cookie（a1 + web_session）；query = 笔记/分享链接（每行或空格分隔，最多 limit 条）。
async function harvestXhs({ query, limit, cookie }) {
  const links = harvestExtractLinks(query).slice(0, limit)
  if (!links.length) {
    throw '请在输入框粘贴小红书笔记或分享链接（每行一条，如 https://www.xiaohongshu.com/explore/xxxx 或 https://xhslink.com/xxxx）'
  }
  if (!cookie || !cookie.includes('web_session')) {
    throw '小红书网页有风控，需要登录 Cookie：点本面板「Cookie 设置」，把小红书网页版（www.xiaohongshu.com）登录后的 Cookie 粘贴进来（至少包含 a1=...; web_session=...），保存后重试'
  }
  const items = []
  for (const link of links) {
    try {
      const { text, status, finalUrl } = await harvestGet(link, { cookie, timeoutMs: 20000 })
      const ogTitle = (text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] || ''
      const ogDesc = (text.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [])[1] || ''
      const rawDesc = (text.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || ''
      let body = ogDesc || ''
      if (rawDesc) {
        try {
          body = JSON.parse(`"${rawDesc}"`) || body
        } catch {
          /* 保留 og:description */
        }
      }
      const title = ogTitle || '（未取到标题）'
      if (status !== 200 || (!ogTitle && !ogDesc && !rawDesc)) {
        items.push({
          id: link, title: '无法抓取该笔记', text: '', author: '', metrics: '', lang: 'zh',
          url: link, error: `HTTP ${status}：可能被风控或笔记已删除，确认链接与 Cookie 后重试`,
        })
      } else {
        items.push({
          id: finalUrl || link,
          title,
          text: toStr(body).slice(0, 8000),
          author: (text.match(/"nickname"\s*:\s*"([^"]+)"/) || [])[1] || '小红书用户',
          metrics: (text.match(/"liked_count"\s*:\s*"?(\w+)"?/) || [])[1]
            ? `获赞 ${(text.match(/"liked_count"\s*:\s*"?(\w+)"?/) || [])[1]}`
            : '',
          lang: 'zh',
          url: link,
        })
      }
    } catch (e) {
      items.push({
        id: link, title: '抓取出错', text: '', author: '', metrics: '', lang: 'zh',
        url: link, error: safeStr(e).slice(0, 120),
      })
    }
  }
  const okCount = items.filter(i => !i.error).length
  return {
    channel: 'xhs',
    items,
    note: `小红书抓取成功 ${okCount}/${links.length} 条（og/正文字段提取；被风控的链接会单独标注原因）。`,
  }
}

// —— X（Twitter）：推文链接 → publish.twitter.com oEmbed（匿名可用，多语言正文）。
//    query = 推文链接（每行或空格分隔，最多 limit 条）；关键词搜索需登录态暂不支持。
async function harvestX({ query, limit }) {
  const links = harvestExtractLinks(query).slice(0, limit)
  if (!links.length) {
    throw '请在输入框粘贴 X（Twitter）推文链接（每行一条，如 https://x.com/用户名/status/推文编号）；关键词搜索需登录态暂不支持'
  }
  const items = []
  for (const link of links) {
    try {
      const u = `https://publish.twitter.com/oembed?url=${encodeURIComponent(link)}&omit_script=1&dnt=true`
      const { text, status } = await harvestGet(u, { timeoutMs: 15000 })
      if (status !== 200) {
        items.push({
          id: link, title: '无法抓取该推文', text: '', author: '', metrics: '', lang: 'en',
          url: link, error: `oEmbed 返回 ${status}：推文可能已删除、受限或链接格式不对`,
        })
        continue
      }
      const d = JSON.parse(text) || {}
      const html = toStr(d.html)
      const pm = html.match(/<p[^>]*lang=["']([^"']+)["'][^>]*>([\s\S]*?)<\/p>/i)
      const body = harvestStripHtml(pm ? pm[2] : html.replace(/<blockquote[^>]*>/i, '').split(/&mdash;|<\/blockquote>/)[0])
      const handle = (toStr(d.author_url).match(/x\.com\/([^/]+)\/?$/i) || [])[1] || ''
      const text2 = toStr(body).slice(0, 4000)
      items.push({
        id: toStr(d.url) || link,
        title: text2.slice(0, 60) || toStr(d.author_name),
        text: text2,
        author: `${toStr(d.author_name)}${handle ? ' (@' + handle + ')' : ''}`,
        metrics: '',
        lang: (pm && pm[1]) || harvestLangOf(text2),
        url: toStr(d.url) || link,
      })
    } catch (e) {
      items.push({
        id: link, title: '抓取出错', text: '', author: '', metrics: '', lang: 'en',
        url: link, error: safeStr(e).slice(0, 120),
      })
    }
  }
  const okCount = items.filter(i => !i.error).length
  return {
    channel: 'x',
    items,
    note: `X 推文抓取成功 ${okCount}/${links.length} 条（oEmbed 匿名通道，原文语言自动识别）。`,
  }
}

/** 渠道分发：一个渠道挂了只影响它自己 */
async function fetchSourceChannel({ channel, query, cookie, limit }) {
  if (channel === 'reddit') return harvestReddit({ query, limit })
  if (channel === 'zhihu') return harvestZhihu({ query, limit, cookie })
  if (channel === 'douyin') return harvestDouyin({ limit })
  if (channel === 'xhs') return harvestXhs({ query, limit, cookie })
  if (channel === 'x') return harvestX({ query, limit })
  throw '未知渠道：' + channel
}

export const __test = { saveState, mirrorLibrary, ensureStateLibrary, newestSnapshotLibrary, applyLibraryGuard, pickLibrary, libraryHash, whitelistState, SYNC_STATE_FIELDS, ASSET_LIBRARY_KEY, ASSET_LIBRARY_SNAP_PREFIX, userKey,
  // v10.71：每日免费额度与计费口径（供单测用假 D1 验证）
  flushCreditUsage, freeUsedToday, bumpFreeUsage, freeQuota, creditsStatus, FREE_DAILY_LIMIT, costCnyOf, creditsOf, cnDay, BILLING_FREE_ALL, sanitizeObsRecord }

export default {
  async fetch(request, env) {
    // ── v10.17 每个请求一个 env 视图 ──
    // 把「本次用哪个引擎 / 哪个免费模型」挂在原型链上（不复制绑定值，
    // WRITER_KV / WRITER_D1 / AI / 密钥都从原型上照常读到）。
    // 这样 16 个 AI 分支里已有的 callDeepSeek(env, {…}) 一个都不用改，
    // 只靠 callDeepSeek 内部读 env.__engine 自动分流；
    // 也不用模块级全局变量 —— 那会被同 isolate 的并发请求互相覆盖。
    env = Object.assign(Object.create(env), {
      __engine: ENGINE_CLOUD,
      __freeModel: '',
      // v10.23 本请求的 token 账本：挂在这份 per-request 视图上（同并发互不覆盖），
      // 由 fetch() 的 finally 统一结算成积分。
      __usage: { inMiss: 0, inHit: 0, out: 0, calls: 0 },
      // v10.25 本请求跑了几次免费模型（>0 说明这次是一记「免费点击」）
      __freeCalls: 0,
      // v10.26 本请求要遵守的硬约束（前端传 body.constraints，见 normConstraints）
      __constraints: [],
    })
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    if (request.method === 'GET') {
      // 版本探活：方便确认线上跑的到底是哪版；同时报告存储绑定状态（不含业务数据）
      return jsonResp({
        ok: true,
        version: VERSION,
        model: MODEL,
        status: 'running',
        storage: {
          kv: Boolean(env.WRITER_KV),
          d1: Boolean(env.WRITER_D1),
          r2: r2Ready(env),
        },
        // 能力探针：用来确认线上跑的到底是不是「带管理员门禁」的这一版
        features: { roles: true, adminGate: true, platformData: true, assetsStore: Boolean(env.WRITER_ASSETS) },
        // v10.17 引擎探针：确认免费引擎（Workers AI 绑定）到底通没通
        engines: {
          available: { cloud: Boolean(env.DEEPSEEK_API_KEY), free: Boolean(env.AI) },
          freeModels: FREE_MODELS,
          defaultFreeModel: DEFAULT_FREE_MODEL,
        },
      })
    }
    if (request.method !== 'POST') return err('POST only', 405)

    let body
    try {
      body = await request.json()
    } catch {
      return err('Invalid JSON body')
    }

    // ── v10.17 引擎决议 ──
    // 先定引擎、再按引擎校验对应凭证，最后才进业务分支。
    // （原来是「没有 DEEPSEEK_API_KEY 就直接 500」，免费引擎上线后这个门禁必须放宽，
    //   否则一个没配 DeepSeek 密钥的部署连免费通道都用不了。）
    // v10.71：**取消免费模型** —— AI 生成统一走站方 DeepSeek API。
    // 前端即便还传 engine:'free'（旧缓存/旧前端），这里也一律按云端处理。
    // 免费引擎相关代码（callFreeModel / FREE_MODELS）暂时保留但已不可达，
    // 图片生成的免费通道（imageEngine）是另一条链路，不受影响。
    env.__engine = ENGINE_CLOUD
    env.__freeModel = toStr(body.freeModel)
    // v10.26 硬约束：前端把「锁定（生效中）的设定条目」一并传上来，
    // 由 callDeepSeek / callDeepSeekSearch 注入系统指令。
    env.__constraints = normConstraints(body.constraints)

    // 引擎可用性探针：不消耗任何额度，且必须在凭证门禁之前返回
    // （否则没配 key 时前端问不到状态，没法把选项置灰）
    if (body.action === 'engineStatus') {
      return ok({
        engine: env.__engine,
        cloud: Boolean(env.DEEPSEEK_API_KEY),
        // free 仅表示"账号里有 Workers AI 绑定"，v10.71 起生成不再走它
        free: Boolean(env.AI),
        freeDisabled: true,
        freeModels: FREE_MODELS,
        defaultFreeModel: DEFAULT_FREE_MODEL,
        usedFreeModel: null,
      })
    }

    // v10.71：只剩 DeepSeek 一条通道 —— 只校验它的凭证。
    // （原「免费引擎额度用完就 429 拦截」的逻辑已删除：现在超额不拦截，改为按积分计费。）
    if (!env.DEEPSEEK_API_KEY) {
      return err('服务端未配置 DEEPSEEK_API_KEY，AI 生成暂不可用（请联系管理员）', 500)
    }

    try {
      if (body.action === 'analyze') {
        const { book, dimension, useSearch = true, previousResults } = body
        if (!book || !dimension) return err('需要 book 和 dimension')
        const onlineInput = `请先联网搜索「${book}」的真实资料，然后分析它的「${dimension}」维度。`
        const localInput = `请基于已有知识分析《${book}》的「${dimension}」维度，不要联网检索。`

        // 本地知识分析（联网失败时也用它兜底）
        const localAnalyze = async note => {
          const { parsed } = await callDeepSeek(env, {
            instructions: ANALYZE_SYSTEM_LOCAL,
            input: localInput,
            maxOutputTokens: 8000,
            useSearch: false,
            previousResults,
          })
          const out = {
            source: toStr(parsed.source) || book,
            features: toStr(parsed.features),
            examples: toStr(parsed.examples),
          }
          if (note) out.note = note
          return ok(out, false, 0)
        }

        // 用户没选联网 → 直接本地知识
        if (!useSearch) {
          try {
            return await localAnalyze('')
          } catch (e) {
            return err('分析失败：' + safeStr(e))
          }
        }

        // 联网检索 → 走 Anthropic 兼容端点（Responses API 的 web_search 会被忽略）
        try {
          const { parsed, searched, searchCount } = await callDeepSeekSearch(env, {
            system: ANALYZE_SYSTEM,
            userText: onlineInput,
            maxOutputTokens: 8000,
            previousResults,
          })
          return ok(
            { source: toStr(parsed.source) || book, features: toStr(parsed.features), examples: toStr(parsed.examples) },
            searched,
            searchCount,
          )
        } catch (e) {
          // 联网失败 → 自动降级为本地知识，保证一定有结果（而不是让按钮整体报错）
          try {
            return await localAnalyze('联网检索失败，已自动改用本地知识：' + safeStr(e))
          } catch (e2) {
            return err('联网与本地分析均失败：' + safeStr(e2))
          }
        }
      }

      // v10.19 · 参考锚点直出：基于用户自己的画布内容产出「具体」特征与示例
      if (body.action === 'anchorSuggest') {
        const { dimension, content = '', title = '', canvases = null, useSearch = true, previousResults } = body
        if (!dimension) return err('需要 dimension')
        const sys = anchorSuggestSystem(dimension)
        const others =
          canvases && typeof canvases === 'object' && !Array.isArray(canvases)
            ? Object.entries(canvases)
                .filter(([k, v]) => k !== dimension && toStr(v))
                .map(([k, v]) => `【${k}】\n${toStr(v)}`)
                .join('\n\n')
            : ''
        const userText = [
          `【当前画布：${dimension}】${title ? `（${title}）` : ''}\n${toStr(content) || '（空白）'}`,
          others ? `【其他画布（上下文）】\n${others}` : '',
        ]
          .filter(Boolean)
          .join('\n\n')

        const pack = parsed => ({
          // 模型没给出作品名时，明确写「未确认」——绝不回填「本作推演」这类自造标签，
          // 用户要的就是「这次参考的是哪本书」。
          source: toStr(parsed.source) || '（未确认参考作品）',
          features: toStr(parsed.features),
          examples: toStr(parsed.examples),
        })

        const localRun = async note => {
          const { parsed } = await callDeepSeek(env, {
            instructions: sys,
            input: userText,
            maxOutputTokens: 4000,
            useSearch: false,
            previousResults,
          })
          const out = pack(parsed)
          if (note) out.note = note
          return ok(out, false, 0)
        }

        if (!useSearch) {
          try {
            return await localRun('')
          } catch (e) {
            return err('生成参考失败：' + safeStr(e))
          }
        }
        try {
          const { parsed, searched, searchCount } = await callDeepSeekSearch(env, {
            system: sys,
            userText,
            maxOutputTokens: 4000,
            previousResults,
          })
          return ok(pack(parsed), searched, searchCount)
        } catch (e) {
          try {
            return await localRun('联网检索失败，已自动改用本地知识：' + safeStr(e))
          } catch (e2) {
            return err('生成参考失败：' + safeStr(e2))
          }
        }
      }

      if (body.action === 'generate') {
        if (!body.canvases) return err('需要 canvases')
        const compact = Object.entries(body.canvases)
          .map(([k, v]) => `【${k}】\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
          .join('\n\n')
        const input = `画布内容如下：\n\n${compact}`

        // —— 方向导演层：把画布 + 方向意图 + 训练画像蒸馏成「方向指令书」，让生成方向更精准 ——
        let directionBrief = null
        try {
          const profile = await loadUserProfile(env, body.token)
          directionBrief = await directDirection(env, {
            canvases: body.canvases,
            directionIntent: toStr(body.directionIntent).trim(),
            profile,
          })
        } catch (e) {
          console.warn('[generate] 方向导演层失败，降级为纯画布生成：', safeStr(e))
        }
        const directionText = briefToText(directionBrief)
        const directedInput = directionText ? `${input}\n\n${directionText}` : input

        // 优化：把「规划（书名/简介/大纲/规格）」与「样章」拆成两个并发调用。
        // 旧版是 1 次 32000 token 的顺序调用；新版墙钟时间 ≈ max(规划, 样章) 而非两者之和，
        // 且各自 token 上限很小（6000 / 4000），生成更快、不易超时。
        // 单个子调用偶发 5xx/超时/JSON 解析失败（实测并发下单路抖动明显），
        // 失败后带退避重试，避免整次生成缺一半（规划挂了成书就没大纲）。
        const withRetry = async (fn, label, attempts = 3) => {
          let lastErr
          for (let i = 1; i <= attempts; i++) {
            try {
              return await fn()
            } catch (e) {
              lastErr = e
              console.warn(`[generate] ${label} 第 ${i}/${attempts} 次失败：`, safeStr(e))
              if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i))
            }
          }
          throw lastErr
        }
        const runPlan = () =>
          withRetry(
            () => callDeepSeek(env, { instructions: GENERATE_PLAN_SYSTEM, input: directedInput, maxOutputTokens: 6000, useSearch: false }),
            '规划',
          )
        const runChapter = () =>
          withRetry(
            () => callDeepSeek(env, { instructions: GENERATE_CHAPTER_SYSTEM, input: directedInput, maxOutputTokens: 4000, useSearch: false }),
            '样章',
          )

        /** 把规划/样章两次返回的 parsed 归一化成 UI 要的结构（任一为 null 时给兜底） */
        const buildBook = (planParsed, chapterParsed) => {
          const p = planParsed || {}
          const c = chapterParsed || {}
          const outline = Array.isArray(p.outline)
            ? p.outline.map((ch, i) => ({
                index: Number(ch?.index) || i + 1,
                title: toStr(ch?.title) || `第 ${i + 1} 章`,
                summary: toStr(ch?.summary),
                tag: ['开局', '推进', '高潮', '反转', '收束'].includes(toStr(ch?.tag)) ? toStr(ch?.tag) : '推进',
                words: Number(ch?.words) || 10000,
              }))
            : []
          // 样章与规划并行生成，用大纲首章名保证标题一致
          const ch1Title = outline[0]?.title || '第一章'
          const sc = c.sampleChapter || {}
          return {
            title: toStr(p.title) || '未命名',
            synopsis: toStr(p.synopsis),
            outline,
            directionBrief: directionBrief || null,
            sampleChapter: {
              title: toStr(sc.title) || `第一章 ${ch1Title}`,
              content: toStr(sc.content),
              beat: toStr(sc.beat),
            },
            stats: {
              totalWords: Number(p.stats?.totalWords) || 180000,
              chapters: Number(p.stats?.chapters) || 18,
              volumes: Number(p.stats?.volumes) || 3,
              styleLabel: toStr(p.stats?.styleLabel) || '未标注',
              anchorSources: Array.isArray(p.stats?.anchorSources)
                ? p.stats.anchorSources.map(toStr).filter(Boolean)
                : [],
            },
          }
        }

        // —— 流式模式（前端传 stream:true）：规划先到先推，样章再到补推，最后推合并结果 ——
        if (body.stream === true) {
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            async start(controller) {
              const send = (obj) => {
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
                } catch {}
              }
              const t0 = Date.now()
              let planParsed = null
              let chapterParsed = null
              let searched = false
              let searchCount = 0
              // 关键：谁先完成谁先推帧。旧写法 Promise.allSettled([plan, chapter]) 会等两路都结束
              // 才开始发帧，前端全程看不到中间进度（表现为「卡在加载中」）。
              const planP = runPlan()
                .then((r) => {
                  planParsed = r.parsed
                  searched = searched || r.searched
                  searchCount += r.searchCount || 0
                  send({ phase: 'plan', book: buildBook(planParsed, null) })
                })
                .catch((e) => {
                  console.warn('[generate-stream] 规划失败：', safeStr(e))
                })
              const chapterP = runChapter()
                .then((r) => {
                  chapterParsed = r.parsed
                  searched = searched || r.searched
                  searchCount += r.searchCount || 0
                  send({ phase: 'chapter', book: buildBook(planParsed, chapterParsed) })
                })
                .catch((e) => {
                  console.warn('[generate-stream] 样章失败：', safeStr(e))
                })
              await Promise.allSettled([planP, chapterP])
              if (!planParsed && !chapterParsed) {
                send({ error: '规划与样章生成均失败，请稍后重试' })
                try { controller.close() } catch {}
                return
              }
              const book = buildBook(planParsed, chapterParsed)
              console.log(`[generate-stream] 规划+样章并发完成，用时 ${Date.now() - t0}ms`)
              send({ done: true, data: book, searched, searchCount })
              try { controller.close() } catch {}
            },
          })
          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              ...CORS,
            },
          })
        }

        // —— 非流式（保持旧契约：单 JSON 返回，兼容未升级的前端）——
        const [planR, chapterR] = await Promise.allSettled([runPlan(), runChapter()])
        const planParsed = planR.status === 'fulfilled' ? planR.value.parsed : null
        const chapterParsed = chapterR.status === 'fulfilled' ? chapterR.value.parsed : null
        if (!planParsed && !chapterParsed) {
          return err(safeStr(planR.status === 'rejected' ? planR.reason : chapterR.reason))
        }
        const book = buildBook(planParsed, chapterParsed)
        const searched =
          (planR.status === 'fulfilled' && planR.value.searched) ||
          (chapterR.status === 'fulfilled' && chapterR.value.searched)
        const searchCount =
          (planR.status === 'fulfilled' ? planR.value.searchCount || 0 : 0) +
          (chapterR.status === 'fulfilled' ? chapterR.value.searchCount || 0 : 0)
        return ok(book, searched, searchCount)
      }

      // —— 工作台 1：拆解原文到 7 个维度 ——
      if (body.action === 'dissect') {
        if (!body.text) return err('需要 text')
        const locked = normLocked(body.locked)
        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: DISSECT_SYSTEM,
          input: `请拆解分析下面这段小说原文：\n\n${body.text}${lockBlock(locked)}`,
          maxOutputTokens: 16000,
        })
        // 只保留 7 个维度键，值统一压成字符串；锁定的维度直接丢弃，绝不写回
        const dims = {}
        for (const d of DIMENSIONS) {
          if (locked.includes(d)) continue
          dims[d] = toStr(parsed[d]) || '文本未体现此维度'
        }
        return ok(dims, searched, searchCount)
      }

      // —— 工作台 0：识别图片（思维导图/大纲/设定图/手写笔记）→ 拆解分配到 7 画布 ——
      if (body.action === 'imageDissect') {
        if (!body.imageBase64) return err('需要 imageBase64')
        const locked = normLocked(body.locked)
        const parsed = await callVisionLLM(env, {
          system: IMAGE_DISSECT_SYSTEM,
          userText: `请识别这张图片，并按 7 个维度归纳成小说创作设定。${lockBlock(locked)}`,
          imageBase64: String(body.imageBase64),
          mimeType: toStr(body.mimeType) || 'image/png',
          maxOutputTokens: 16000,
        })
        const dims = {}
        for (const d of DIMENSIONS) {
          if (locked.includes(d)) continue
          dims[d] = toStr(parsed[d]) || '图中未体现此维度'
        }
        return ok(dims)
      }

      // —— v10.80 灵感采集：多渠道抓取（知乎 / 小红书 / 抖音 / Reddit / X）→
      //    前端把勾选的条目组装成带来源链接的多语言语料，再走原有的「原文拆解」管线改编成书。
      //    设计原则：
      //    · 每个渠道一个 fetcher，互相隔离：一个渠道挂只影响它自己，返回结构统一 { channel, items, note }
      //    · 每条 item 必带 url（来源链接）：改编成书后可溯源，这是本功能的硬性要求
      //    · 需要登录态的渠道（知乎正文 / 小红书）由前端传 cookie，cookie 只用于本次抓取、
      //      绝不写日志、绝不回显；失败时给「可操作」的指引文案而不是裸报错
      //    · 抓取本身不消耗 DeepSeek token：不调 LLM，不进积分结算（多语言原文由拆解管线消化）
      if (body.action === 'sourceFetch') {
        const channel = toStr(body.channel)
        const query = toStr(body.query).trim()
        const cookie = toStr(body.cookie).trim()
        const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 20)
        if (!HARVEST_CHANNELS.includes(channel)) return err('未知渠道：' + (channel || '（空）'))
        try {
          const out = await fetchSourceChannel({ channel, query, cookie, limit })
          return ok(out)
        } catch (e) {
          return err('抓取失败：' + safeStr(e))
        }
      }

      // —— 工作台 1.5：用关键词/要求让 AI 辅助改写某个维度的一段内容 ——
      if (body.action === 'refine') {
        const { dimension, current, instruction, context } = body
        if (!instruction || !String(instruction).trim()) return err('需要 instruction（修改要求或关键词）')
        // 联网开关：默认关闭（改一段文字本来就快且省）；开启时先检索同类型优秀范文作风格参照。
        // 真正能联网的是 Anthropic 兼容端点 callDeepSeekSearch，Responses API 的 web_search 会被忽略。
        const webSearch = body.webSearch === true
        const refineInput = `【维度】${dimension || '（未指定）'}\n【现有内容】\n${
          current && String(current).trim() ? current : '（这段目前是空的，请直接按修改要求写出来）'
        }\n\n【修改要求 / 关键词】\n${instruction}${
          context ? `\n\n【相关上下文（供参考，不要照抄）】\n${String(context).slice(0, 2000)}` : ''
        }`
        let parsed, searched, searchCount
        if (webSearch) {
          const r = await callDeepSeekSearch(env, {
            system: REFINE_SYSTEM_WEB,
            userText: refineInput,
            maxOutputTokens: 4000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        } else {
          const r = await callDeepSeek(env, {
            instructions: REFINE_SYSTEM,
            input: refineInput,
            maxOutputTokens: 4000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        }
        return ok(
          {
            refined: toStr(parsed.refined),
            references: Array.isArray(parsed.references)
              ? parsed.references.map(toStr).filter(Boolean)
              : [],
            webSearch,
          },
          searched,
          searchCount,
        )
      }

      // —— v10.72 机器人代笔：让它以「作者本人」身份写整章（不走 refine 的编辑腔） ——
      if (body.action === 'botWrite') {
        const { instruction } = body
        if (!instruction || !String(instruction).trim()) return err('需要 instruction（人格自述 + 章节要求）')
        // 代笔是创作，不联网：要查证请走 analyze / revise（那边才有 web_search）
        const r = await callDeepSeek(env, {
          instructions: BOT_WRITE_SYSTEM,
          input: String(instruction),
          maxOutputTokens: 6000,
          useSearch: false,
        })
        return ok(
          { content: toStr(r.parsed.refined) || toStr(r.parsed.content) },
          r.searched,
          r.searchCount,
        )
      }



/* ============================================================
   v10.79 观察摘要库（obsSave / obsList）
   ------------------------------------------------------------
   用户要求把"切分的产出"存到 Cloudflare。存的是**转述摘要**
         （类型/人名/说话人/话题/要点），不是屏幕原文 —— 隔离规则延续：
         原文只在本机 IndexedDB（72h TTL），这里存的是摘要，想留多久留多久。
         服务端按白名单字段重造对象：前端多塞任何字段都到不了库。
         ============================================================ */
      if (body.action === 'obsSave' || body.action === 'obsList') {
        if (!env.WRITER_D1) return err('D1 未配置')
        const me = await currentUser(env, body)
        const uid = me ? me.userId : ANON_UID

        if (body.action === 'obsList') {
          const limit = Math.max(1, Math.min(200, Math.floor(toNum(body.limit) || 100)))
          const rows = await d1All(
            env,
            'SELECT at, source, kind, name, speakers, topics, entities, gist, mood FROM observation_digest WHERE user_id = ? ORDER BY at DESC LIMIT ?',
            [uid, limit],
          )
          return ok({
            records: rows.map(r => ({
              at: toStr(r.at),
              source: toStr(r.source),
              kind: toStr(r.kind),
              name: toStr(r.name),
              speakers: jsonArr(r.speakers),
              topics: jsonArr(r.topics),
              entities: jsonArr(r.entities),
              gist: toStr(r.gist),
              mood: toStr(r.mood),
            })),
          })
        }

        const list = Array.isArray(body.records) ? body.records.slice(0, 50) : []
        const rows = []
        for (const r of list) {
          const clean = sanitizeObsRecord(r)
          if (clean) rows.push(clean)
        }
        if (!rows.length) return ok({ saved: 0 })
        const nowIso = new Date().toISOString()
        for (const r of rows) {
          await d1Run(
            env,
            `INSERT INTO observation_digest (user_id, at, source, kind, name, speakers, topics, entities, gist, mood, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [uid, r.at, r.source, r.kind, r.name, r.speakers, r.topics, r.entities, r.gist, r.mood, nowIso],
          )
        }
        return ok({ saved: rows.length })
      }

      // —— 工作台 2：按画布设定修改原文 ——
      if (body.action === 'revise') {
        if (!body.text) return err('需要 text')
        const canvases = body.canvases || {}
        const compact = Object.entries(canvases)
          .map(([k, v]) => `【${k}】\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
          .join('\n\n')
        // 用户的具体修改要求 + 附带的参考文件内容
        const instrBlock =
          body.instruction && String(body.instruction).trim()
            ? `\n\n【用户的具体修改要求】\n${String(body.instruction).trim()}`
            : ''
        const refBlock =
          body.referenceText && String(body.referenceText).trim()
            ? `\n\n【用户附带的参考文件内容（仅供风格/设定/事实参考，禁止照抄原句）】\n${String(
                body.referenceText,
              ).slice(0, 12000)}`
            : ''
        // 联网开关：默认开启。开启时先检索同类型优秀范文作为风格参照
        const webSearch = body.webSearch !== false
        const genreHint = body.genreHint && String(body.genreHint).trim()
          ? `\n\n【本次检索提示（同类型范文的方向，供联网检索参考）】\n${String(body.genreHint).trim().slice(0, 200)}`
          : ''
        // 方向导演：有方向意图或训练画像时，把「方向指令书」注入修改要求（让改写方向更精准）
        const dirTextRevise = briefToText(await getBriefIfNeeded(env, { canvases, directionIntent: body.directionIntent, token: body.token }))
        const reviseInput = `【原文】\n${body.text}\n\n【修改要求（来自 7 个画布）】\n${compact}${chapterBlock(
          body.chapter,
        )}${instrBlock}${refBlock}${genreHint}${dirTextRevise}${lockBlock(normLocked(body.locked))}`
        // 关键：默认 callDeepSeek（Responses API）的 web_search 会被忽略、拿不到搜索结果；
        // 真正能联网检索的是 Anthropic 兼容端点（callDeepSeekSearch，强制 tool_choice=web_search）。
        // 所以「联网开」走 callDeepSeekSearch，「联网关」走 callDeepSeek。
        let parsed, searched, searchCount
        if (webSearch) {
          const r = await callDeepSeekSearch(env, {
            system: REVISE_SYSTEM_WEB,
            userText: reviseInput,
            maxOutputTokens: 20000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        } else {
          const r = await callDeepSeek(env, {
            instructions: REVISE_SYSTEM,
            input: reviseInput,
            maxOutputTokens: 20000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        }
        return ok(
          {
            revised: toStr(parsed.revised),
            changes: Array.isArray(parsed.changes)
              ? parsed.changes.map(toStr).filter(Boolean)
              : [],
            references: Array.isArray(parsed.references)
              ? parsed.references.map(toStr).filter(Boolean)
              : [],
            webSearch,
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
        // 联网开关：默认开启。真正能联网的是 Anthropic 兼容端点 callDeepSeekSearch
        const webSearch = body.webSearch !== false
        const dirTextContinue = briefToText(await getBriefIfNeeded(env, { canvases, directionIntent: body.directionIntent, token: body.token }))
        const continueInput = `【已有文本】\n${body.text}\n\n【续写要求（来自 7 个画布）】\n${compact}${chapterBlock(
          body.chapter,
        )}${dirTextContinue}${lockBlock(normLocked(body.locked))}`
        let parsed, searched, searchCount
        if (webSearch) {
          const r = await callDeepSeekSearch(env, {
            system: CONTINUE_SYSTEM_WEB,
            userText: continueInput,
            maxOutputTokens: 20000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        } else {
          const r = await callDeepSeek(env, {
            instructions: CONTINUE_SYSTEM,
            input: continueInput,
            maxOutputTokens: 20000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        }
        return ok(
          {
            continuation: toStr(parsed.continuation),
            rationale: toStr(parsed.rationale),
            references: Array.isArray(parsed.references)
              ? parsed.references.map(toStr).filter(Boolean)
              : [],
            webSearch,
          },
          searched,
          searchCount,
        )
      }

      // —— 工作台 4：按章节精修（一章一章写，按 4 维设置 + 前文连贯）——
      if (body.action === 'writeChapter') {
        const { bookTitle, chapterIndex, chapterTitle, chapterSummary, settings, previousChapters, canvases } = body
        if (!chapterTitle) return err('需要 chapterTitle')
        const compact = Object.entries(canvases || {})
          .map(([k, v]) => `【${k}】\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
          .join('\n\n')

        // 拼接前 N-1 章内容（控制总长，避免超 prompt 上限）
        const prev = Array.isArray(previousChapters) ? previousChapters : []
        const prevBlock = prev.length
          ? prev.map((c, i) => `—— 第 ${i + 1} 章 《${c.title}》——\n${c.content}`).join('\n\n')
          : '（这是第一章，没有前文）'

        // v10.32 文章目的改为非必选：没选就不写【本章目的】这一行，
        // 让模型自己按大纲与画布判断，而不是硬塞一个「推进主线」
        const purposeText = {
          transition: '承上启下：衔接上一章结尾，自然过渡到下一章',
          'main-plot': '推进主线：让核心矛盾或剧情向前走一步',
          reveal: '揭示谜底：揭开一个秘密、答案或真相',
          ending: '交代结局：为本章或整本书的某个阶段收尾',
          'pure-scene': '纯场景：聚焦一段对话、动作、景物或心理，不推进大剧情',
        }[settings?.purpose] || ''

        const dirTextChapter = briefToText(await getBriefIfNeeded(env, { canvases, directionIntent: body.directionIntent, token: body.token }))
        const userInput = `【书名】《${bookTitle || '未命名'}》
【待写章节】第 ${chapterIndex} 章《${chapterTitle}》
【本章大纲摘要】${chapterSummary || ''}
【目标字数】${settings?.targetWords || 2000} 字
【文笔风格】${settings?.style || '（继承【文笔】画布）'}
${purposeText ? `【本章目的】${purposeText}\n` : ''}【其他要求】${settings?.extraRequirements || '（无）'}

【7 块画布设定】
${compact}

【前 ${prev.length} 章正文（用于保持人物/语气/伏笔连贯）】
${prevBlock}${dirTextChapter}${lockBlock(normLocked(body.locked))}`

        // 联网开关：默认关闭（精写以画布+前文为准）；开启时先检索同类型优秀范文作为风格参照
        const webSearch = body.webSearch === true
        // 联网开：走 Anthropic 兼容端点（callDeepSeekSearch）才能真正触发 web_search 检索同类型范文
        let parsed, searched, searchCount
        if (webSearch) {
          const r = await callDeepSeekSearch(env, {
            system: CHAPTER_WRITE_SYSTEM_WEB,
            userText: userInput,
            maxOutputTokens: 20000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        } else {
          const r = await callDeepSeek(env, {
            instructions: CHAPTER_WRITE_SYSTEM,
            input: userInput,
            maxOutputTokens: 20000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        }
        return ok(
          {
            content: toStr(parsed.content),
            rationale: toStr(parsed.rationale),
            references: Array.isArray(parsed.references)
              ? parsed.references.map(toStr).filter(Boolean)
              : [],
            webSearch,
          },
          searched,
          searchCount,
        )
      }

      // —— 方向导演：单独产出「方向指令书」（前端可预览，也可在生成前手动调）——
      if (body.action === 'direct') {
        if (!body.canvases) return err('需要 canvases')
        const profile = await loadUserProfile(env, body.token)
        const brief = await directDirection(env, {
          canvases: body.canvases,
          directionIntent: toStr(body.directionIntent).trim(),
          profile,
        })
        return ok(brief)
      }

      // —— 方向校准自检：比对成稿与指令书，标出偏离并给修正稿（防漂移）——
      if (body.action === 'calibrate') {
        if (!body.text) return err('需要 text')
        const result = await calibrateDirection(env, { brief: body.brief || null, text: body.text })
        return ok(result)
      }

      // —— v10.10：把已写好的正文改写成 AI 短剧剧本 ——
      if (body.action === 'toScript') {
        const text = toStr(body.text).trim()
        if (!text) return err('需要 text（要改编的原文）')
        // v18.8：放开集数/时长上限（旧版 1-12 集 / 30-300 秒根本做不了短剧）
        // 单次调用仍只生成一批正文（默认 8 集），全本 100-250 集走 scriptOutline + 分批 toScript
        const episodes = Math.max(1, Math.min(400, Math.round(Number(body.episodes) || 8)))
        const secPerEp = Math.max(30, Math.min(900, Math.round(Number(body.secPerEp) || 90)))
        const rangeStart = Math.max(1, Math.min(episodes, Math.round(Number(body.rangeStart) || 1)))
        const batchSize = Math.max(1, Math.min(12, Math.round(Number(body.batchSize) || episodes)))
        const rangeEnd = Math.min(episodes, rangeStart + batchSize - 1)
        const isBatch = rangeStart > 1 || rangeEnd < episodes
        const platform = toStr(body.platform).trim() || '通用'
        const styleNote = toStr(body.styleNote).trim()
        const outline = Array.isArray(body.outline) ? body.outline : []
        const canvases = body.canvases && typeof body.canvases === 'object' ? body.canvases : {}

        const canvasBlock = DIMENSIONS.map(d => {
          const v = toStr(canvases[d]).trim()
          return v ? `${d}：${v}` : ''
        })
          .filter(Boolean)
          .join('\n')

        // 按单集秒数额算台词量：观众一秒听 4-5 个字，所以 90 秒 ≈ 20 句，180 秒 ≈ 45 句
        const linesPerEp = Math.max(14, Math.min(60, Math.round(secPerEp / 4)))
        const scenesPerEp = secPerEp <= 120 ? 3 : 4
        const outlineBlock = outline.length
          ? `\n【全本分集大纲（本次只写其中第 ${rangeStart}-${rangeEnd} 集的完整正文，其余不要写）】\n` +
            outline.slice(0, 400).map((o, i) =>
              `${i + 1}. ${toStr(o.title) || ''}｜钩子：${toStr(o.hook) || ''}｜冲突：${toStr(o.conflict) || ''}｜反转：${toStr(o.twist) || ''}｜悬念：${toStr(o.cliffhanger) || ''}`
            ).join('\n') + '\n'
          : ''

        const input =
          `【要改编的原文】\n${text.slice(0, 12000)}\n\n` +
          `【改编规格】\n平台：${platform}\n全剧总集数：${episodes} 集\n单集时长：${secPerEp} 秒\n` +
          (isBatch
            ? `本次任务：只写第 ${rangeStart} 集到第 ${rangeEnd} 集的完整正文（共 ${rangeEnd - rangeStart + 1} 集）\n`
            : `本次任务：写完全部 ${episodes} 集完整正文\n`) +
          `每集台词量：约 ${linesPerEp} 句（一句 ≤20 字）\n每集场景数：${scenesPerEp} 场左右\n` +
          (canvasBlock ? `\n【原作 7 块画布设定（有冲突时以设定为准）】\n${canvasBlock}\n` : '') +
          outlineBlock +
          (styleNote ? `\n【用户补充要求】\n${styleNote}\n` : '') +
          `\n请按 SCRIPT 规范输出严格 JSON，episodes 必须正好 ${rangeEnd - rangeStart + 1} 集，` +
          `index 从 ${rangeStart} 编到 ${rangeEnd}（分批时不要把 index 从 1 重编）。`

        const { parsed, incomplete } = await callDeepSeek(env, {
          instructions: SCRIPT_SYSTEM,
          input,
          // 一批最多 12 集完整正文，32k 足够；全本大纲走 scriptOutline，不在这里硬塞
          maxOutputTokens: 32000,
          useSearch: true, // v18.8：联网对照真实短剧剧本的节奏与钩子密度
        })
        if (incomplete) {
          return err('这一批剧本太长被截断了。请把「每批集数」调小（建议 3-5 集）或缩短单集时长再试。')
        }

        // 剧本正文按「行」组织：beat=△动作 / line=台词 / vo=画外音 / os=内心独白 / sub=字幕空镜
        const LINE_KINDS = ['beat', 'line', 'vo', 'os', 'sub']
        const normLines = arr =>
          (Array.isArray(arr) ? arr : [])
            .map(l => {
              const raw = toStr(l?.kind)
              const kind = LINE_KINDS.includes(raw) ? raw : 'beat'
              return {
                kind,
                speaker: toStr(l?.speaker),
                emotion: kind === 'line' ? toStr(l?.emotion) : '',
                text: toStr(l?.text),
              }
            })
            .filter(l => l.text)

        const eps = (Array.isArray(parsed.episodes) ? parsed.episodes : []).slice(0, 12).map((e, i) => {
          // 分批时模型偶尔会把 index 从 1 重编，这里强制落到本批真实区间
          const epIndex = isBatch ? rangeStart + i : (Number(e?.index) || i + 1)
          return {
            index: epIndex,
            title: toStr(e?.title) || `第${i + 1}集`,
            hook: toStr(e?.hook),
            durationSec: Number(e?.durationSec) || secPerEp,
            scenes: (Array.isArray(e?.scenes) ? e.scenes : []).slice(0, 8).map((s, si) => ({
              no: toStr(s?.no) || `${epIndex}-${si + 1}`,
              place: toStr(s?.place),
              time: toStr(s?.time),
              space: toStr(s?.space),
              cast: Array.isArray(s?.cast) ? s.cast.map(toStr).filter(Boolean) : [],
              lines: normLines(s?.lines),
              camera: toStr(s?.camera),
              transition: toStr(s?.transition),
            })),
            cliffhanger: toStr(e?.cliffhanger),
          }
        })

        return ok({
          title: toStr(parsed.title) || '未命名短剧',
          genre: toStr(parsed.genre),
          tags: (Array.isArray(parsed.tags) ? parsed.tags : [])
            .map(toStr)
            .filter(Boolean)
            .slice(0, 6),
          castLine: toStr(parsed.castLine),
          logline: toStr(parsed.logline),
          platformTip: toStr(parsed.platformTip),
          characters: (Array.isArray(parsed.characters) ? parsed.characters : [])
            .slice(0, 20)
            .map(c => ({
              name: toStr(c?.name),
              identity: toStr(c?.identity),
              voice: toStr(c?.voice),
              look: toStr(c?.look),
              subtitle: toStr(c?.subtitle),
            }))
            .filter(c => c.name),
          episodes: eps,
          prompts: (Array.isArray(parsed.prompts) ? parsed.prompts : [])
            .slice(0, 48)
            .map(p => ({ scene: toStr(p?.scene), prompt: toStr(p?.prompt) }))
            .filter(p => p.prompt),
          notes: (Array.isArray(parsed.notes) ? parsed.notes : []).map(toStr).filter(Boolean),
          settings: { episodes, secPerEp, platform, rangeStart, rangeEnd, isBatch },
        })
      }

      // —— v18.8：联网匹配规格 —— 按原文字数 + 平台算出集数×单集时长 ——
      if (body.action === 'scriptSpec') {
        const text = toStr(body.text).trim()
        const words = Math.max(1, Number(body.words) || 0) || text.replace(/\s/g, '').length
        if (!text && !body.words) return err('需要 text 或 words')
        const platform = toStr(body.platform).trim() || '通用'
        const local = matchScriptSpec({ words, platform, preferEpisodes: body.preferEpisodes })

        // 联网：让模型对照网上真实短剧剧本的规格，给出针对这段原文的校准建议
        let market = null
        try {
          const { parsed } = await callDeepSeek(env, {
            instructions: `你是短剧制片人。联网检索 2025-2026 年网络短剧剧本的公开行业规格（红果/抖音/快手/番茄/爱奇艺/腾讯），
核对：单集时长、单集字数、主流总集数与长线剧集数、开篇钩子秒数、结尾悬念写法。
只返回 JSON，不要解释：{"sources":[{"name":"来源名","episodes":"集数区间","sec":"单集秒数区间","words":"单集字数"}],"advice":"针对这段原文的规格建议（≤60字）"}`,
            input: `原文前 1200 字：\n${text.slice(0, 1200)}\n\n本地按行业基准算出的规格：${local.episodes} 集 × ${local.secPerEp} 秒（${local.basis}）。请联网核对并给出是否要调整的建议。`,
            maxOutputTokens: 3000,
            useSearch: true,
            forceSearch: true,
          })
          market = {
            sources: (Array.isArray(parsed.sources) ? parsed.sources : []).slice(0, 6).map(s => ({
              name: toStr(s?.name), episodes: toStr(s?.episodes),
              sec: toStr(s?.sec), words: toStr(s?.words),
            })).filter(s => s.name),
            advice: toStr(parsed.advice),
          }
        } catch (e) {
          market = { sources: [], advice: `联网核对失败（${String(e.message || e).slice(0, 80)}），已用本地行业基准` }
        }
        return ok({ ...local, market })
      }

      // —— v18.8：全本分集大纲 —— 一次出 100-250 集纲要，正文另走 toScript 分批 ——
      if (body.action === 'scriptOutline') {
        const text = toStr(body.text).trim()
        if (!text) return err('需要 text')
        const episodes = Math.max(10, Math.min(400, Math.round(Number(body.episodes) || 100)))
        const secPerEp = Math.max(30, Math.min(900, Math.round(Number(body.secPerEp) || 90)))
        const platform = toStr(body.platform).trim() || '通用'
        const styleNote = toStr(body.styleNote).trim()
        const canvases = body.canvases && typeof body.canvases === 'object' ? body.canvases : {}
        const canvasBlock = DIMENSIONS.map(d => {
          const v = toStr(canvases[d]).trim()
          return v ? `${d}：${v}` : ''
        }).filter(Boolean).join('\n')

        const input =
          `【小说原文】\n${text.slice(0, 16000)}\n\n` +
          `【规格】平台：${platform}｜总集数：${episodes} 集｜单集：${secPerEp} 秒\n` +
          (canvasBlock ? `\n【原作 7 块画布】\n${canvasBlock}\n` : '') +
          (styleNote ? `\n【用户补充要求】\n${styleNote}\n` : '') +
          `\n请输出正好 ${episodes} 集的分集大纲 JSON。第 1 集必须有 3 秒钩子，每集结尾必须留悬念，按六幕式分配。`

        const { parsed, incomplete } = await callDeepSeek(env, {
          instructions: SCRIPT_OUTLINE_SYSTEM,
          input,
          maxOutputTokens: 30000,
          useSearch: true, // 联网对照当下平台热门短剧的钩子与节奏
        })
        if (incomplete) return err('大纲被截断了，请把集数调小（建议先试 100 集）再生成')

        const eps = (Array.isArray(parsed.episodes) ? parsed.episodes : []).slice(0, 400).map((e, i) => ({
          index: Number(e?.index) || i + 1,
          title: toStr(e?.title) || `第${i + 1}集`,
          hook: toStr(e?.hook),
          conflict: toStr(e?.conflict),
          twist: toStr(e?.twist),
          cliffhanger: toStr(e?.cliffhanger),
          act: toStr(e?.act),
          durationSec: Number(e?.durationSec) || secPerEp,
        }))
        // 集数不足时按用户要求补齐，保证全本集数对齐
        while (eps.length < episodes) {
          const i = eps.length
          eps.push({ index: i + 1, title: `第${i + 1}集`, hook: '', conflict: '',
                     twist: '', cliffhanger: '', act: '', durationSec: secPerEp })
        }
        return ok({
          title: toStr(parsed.title) || '未命名短剧',
          genre: toStr(parsed.genre),
          logline: toStr(parsed.logline),
          acts: (Array.isArray(parsed.acts) ? parsed.acts : []).slice(0, 6).map(a => ({
            act: toStr(a?.act), from: Number(a?.from) || 0, to: Number(a?.to) || 0, goal: toStr(a?.goal),
          })),
          episodes: eps.slice(0, episodes),
          notes: (Array.isArray(parsed.notes) ? parsed.notes : []).map(toStr).filter(Boolean),
          settings: { episodes, secPerEp, platform },
        })
      }

      // —— drama-skills 迁移（MIT, zenstory-ai/drama-skills contributors · 2026-11-25）：原著快评 ——
      if (body.action === 'scriptNovelAnalyze') {
        const text = toStr(body.text).trim().slice(0, 16000)
        if (!text) return err('需要 text（要快评的原著）')
        const platform = toStr(body.platform).trim().slice(0, 40) || '通用'
        const input =
          `【小说原文（抽样快评，不是全文精读）】\n${text}\n\n` +
          `【目标平台】${platform}\n\n请按规范输出严格 JSON。`
        const { parsed } = await callDeepSeek(env, {
          instructions: SCRIPT_NOVEL_ANALYZE_SYSTEM,
          input,
          maxOutputTokens: 16000,
          useSearch: false,
        })
        return ok({
          title: dStr(parsed?.title, 80),
          logline: dStr(parsed?.logline, 200),
          genre: dStr(parsed?.genre, 60),
          tags: dList(parsed?.tags, 12, 40),
          chapters: (Array.isArray(parsed?.chapters) ? parsed.chapters : []).slice(0, 120).map(c => ({
            no: dNum(c?.no),
            title: dStr(c?.title, 80),
            summary: dStr(c?.summary, 400),
            characters: dList(c?.characters, 12, 40),
            hooks: dList(c?.hooks, 8, 160),
          })),
          rhythm: {
            acts: (Array.isArray(parsed?.rhythm?.acts) ? parsed.rhythm.acts : []).slice(0, 12).map(a => ({
              act: dStr(a?.act, 20), from: dNum(a?.from), to: dNum(a?.to), goal: dStr(a?.goal, 200),
            })),
            pacingNote: dStr(parsed?.rhythm?.pacingNote, 600),
          },
          adaptationTips: dList(parsed?.adaptationTips, 20, 300),
          sources: (Array.isArray(parsed?.sources) ? parsed.sources : []).slice(0, 8).map(s => ({
            name: dStr(s?.name, 80), url: dStr(s?.url, 300),
          })).filter(s => s.name),
        })
      }

      // —— drama-skills 迁移（MIT, zenstory-ai/drama-skills contributors · 2026-11-25）：改编方案 / 导演阐述 ——
      if (body.action === 'scriptDevelop') {
        const text = toStr(body.text).trim().slice(0, 16000)
        const outlineRaw = Array.isArray(body.outline) ? body.outline : []
        if (!text && !outlineRaw.length) return err('需要 text 或 outline')
        const episodes = Math.max(1, Math.min(400, Math.round(Number(body.episodes) || 1)))
        const secPerEp = Math.max(30, Math.min(900, Math.round(Number(body.secPerEp) || 90)))
        const platform = toStr(body.platform).trim().slice(0, 40) || '通用'
        const styleNote = toStr(body.styleNote).trim().slice(0, 2000)
        const canvases = body.canvases && typeof body.canvases === 'object' ? body.canvases : {}
        const canvasBlock = DIMENSIONS.map(d => {
          const v = dStr(canvases[d], 600)
          return v ? `${d}：${v}` : ''
        }).filter(Boolean).join('\n')
        const outlineBlock = outlineRaw.length
          ? `\n【已有分集大纲（最多取前 400 条）】\n` + outlineRaw.slice(0, 400).map((o, i) =>
              `${i + 1}. ${dStr(o?.title, 80)}｜钩子：${dStr(o?.hook, 120)}｜冲突：${dStr(o?.conflict, 120)}｜悬念：${dStr(o?.cliffhanger, 120)}`
            ).join('\n') + '\n'
          : ''
        const input =
          `【原著 / 改编依据】\n${text || '（用户只给了大纲）'}\n\n` +
          `【规格】平台：${platform}｜总集数：${episodes}｜单集：${secPerEp} 秒\n` +
          (canvasBlock ? `\n【画布设定（有冲突以设定为准）】\n${canvasBlock}\n` : '') +
          outlineBlock +
          (styleNote ? `\n【用户补充要求】\n${styleNote}\n` : '') +
          `\n请输出正好 ${episodes} 集的改编方案严格 JSON。`
        const { parsed } = await callDeepSeek(env, {
          instructions: SCRIPT_DEVELOP_SYSTEM,
          input,
          maxOutputTokens: 24000,
          useSearch: false,
        })
        return ok({
          title: dStr(parsed?.title, 80),
          genre: dStr(parsed?.genre, 60),
          logline: dStr(parsed?.logline, 200),
          coreConflict: dStr(parsed?.coreConflict, 400),
          adaptationApproach: dStr(parsed?.adaptationApproach, 2000),
          directorStatement: dStr(parsed?.directorStatement, 2000),
          hookHandbook: (Array.isArray(parsed?.hookHandbook) ? parsed.hookHandbook : []).slice(0, 20).map(h => ({
            type: dStr(h?.type, 60), technique: dStr(h?.technique, 300), example: dStr(h?.example, 400),
          })).filter(h => h.type || h.technique),
          episodePlans: (Array.isArray(parsed?.episodePlans) ? parsed.episodePlans : []).slice(0, 400).map((p, i) => ({
            index: dNum(p?.index, i + 1),
            title: dStr(p?.title, 80),
            goal: dStr(p?.goal, 300),
            keyEvents: dList(p?.keyEvents, 10, 200),
            cliffhanger: dStr(p?.cliffhanger, 300),
          })),
          continuityRules: dList(parsed?.continuityRules, 30, 300),
        })
      }

      // —— drama-skills 迁移（MIT, zenstory-ai/drama-skills contributors · 2026-11-25）：视觉设定 ——
      if (body.action === 'scriptAssets') {
        const script = dParse(body.script)
        const styleNote = toStr(body.styleNote).trim().slice(0, 2000)
        if (!Object.keys(script).length) return err('需要 script（剧本 JSON）')
        const input =
          `【剧本 JSON】\n${JSON.stringify(script).slice(0, 60000)}\n\n` +
          (styleNote ? `【用户补充要求】\n${styleNote}\n\n` : '') +
          `请按规范输出严格 JSON。`
        const { parsed } = await callDeepSeek(env, {
          instructions: SCRIPT_ASSETS_SYSTEM,
          input,
          maxOutputTokens: 16000,
          useSearch: false,
        })
        return ok({
          productionStyle: dStr(parsed?.productionStyle, 600),
          eraSetting: dStr(parsed?.eraSetting, 300),
          characters: (Array.isArray(parsed?.characters) ? parsed.characters : []).slice(0, 30).map(c => ({
            name: dStr(c?.name, 40),
            appearance: dStr(c?.appearance, 800),
            variants: (Array.isArray(c?.variants) ? c.variants : []).slice(0, 10).map(v => ({
              name: dStr(v?.name, 60), appearance: dStr(v?.appearance, 500), episodes: dStr(v?.episodes, 100),
            })),
            voice: dStr(c?.voice, 300),
            voiceRef: dStr(c?.voiceRef, 200),
            lockWords: dList(c?.lockWords, 20, 60),
            promptName: dStr(c?.promptName, 120),
          })).filter(c => c.name),
          locations: (Array.isArray(parsed?.locations) ? parsed.locations : []).slice(0, 30).map(l => ({
            name: dStr(l?.name, 60), appearance: dStr(l?.appearance, 600), orientation: dStr(l?.orientation, 300),
          })).filter(l => l.name),
          props: (Array.isArray(parsed?.props) ? parsed.props : []).slice(0, 40).map(p => ({
            name: dStr(p?.name, 60),
            appearance: dStr(p?.appearance, 600),
            states: (Array.isArray(p?.states) ? p.states : []).slice(0, 8).map(s => ({
              state: dStr(s?.state, 100), from: dStr(s?.from, 80), to: dStr(s?.to, 80),
            })),
          })).filter(p => p.name),
          continuityLocks: (Array.isArray(parsed?.continuityLocks) ? parsed.continuityLocks : []).slice(0, 30).map(l => ({
            id: dStr(l?.id, 60), label: dStr(l?.label, 200), scope: dStr(l?.scope, 200), lockWords: dList(l?.lockWords, 20, 60),
          })).filter(l => l.id || l.label),
        })
      }

      // —— drama-skills 迁移（MIT, zenstory-ai/drama-skills contributors · 2026-11-25）：分镜 / 首尾帧 ——
      if (body.action === 'scriptStoryboard') {
        const script = dParse(body.script)
        const assets = dParse(body.assets)
        const styleNote = toStr(body.styleNote).trim().slice(0, 2000)
        if (!Object.keys(script).length) return err('需要 script（剧本 JSON）')
        const input =
          `【剧本 JSON】\n${JSON.stringify(script).slice(0, 60000)}\n\n` +
          (Object.keys(assets).length ? `【已确定的视觉设定 JSON】\n${JSON.stringify(assets).slice(0, 20000)}\n\n` : '') +
          (styleNote ? `【用户补充要求】\n${styleNote}\n\n` : '') +
          `请按规范输出严格 JSON，SHOT 编号用 EP001-S001 形式，refImages 用 PLAN-xxx 占位。`
        const { parsed } = await callDeepSeek(env, {
          instructions: SCRIPT_STORYBOARD_SYSTEM,
          input,
          maxOutputTokens: 30000,
          useSearch: false,
        })
        const shots = (Array.isArray(parsed?.shots) ? parsed.shots : []).slice(0, 300).map(s => {
          const episode = dNum(s?.episode, 1)
          const sceneNo = dNum(s?.sceneNo, 1)
          const rawId = dStr(s?.id, 40)
          const id = /^EP\d{3}-S\d{3}$/.test(rawId)
            ? rawId
            : `EP${String(episode).padStart(3, '0')}-S${String(sceneNo).padStart(3, '0')}`
          return {
            id,
            episode,
            sceneNo,
            shotType: dStr(s?.shotType, 80),
            camera: dStr(s?.camera, 200),
            movement: dStr(s?.movement, 400),
            startFrame: dStr(s?.startFrame, 600),
            action: dStr(s?.action, 600),
            endFrame: dStr(s?.endFrame, 600),
            sound: dStr(s?.sound, 400),
            blocking: dStr(s?.blocking, 500),
            firstFramePrompt: dStr(s?.firstFramePrompt, 1200),
            lastFramePrompt: dStr(s?.lastFramePrompt, 1200),
            refImages: dList(s?.refImages, 8, 80),
            durationSec: dNum(s?.durationSec, 4),
          }
        })
        return ok({
          shots,
          uncoveredScenes: dList(parsed?.uncoveredScenes, 40, 200),
          summary: dStr(parsed?.summary, 1000),
        })
      }

      // —— drama-skills 迁移（MIT, zenstory-ai/drama-skills contributors · 2026-11-25）：视频提示词 ——
      if (body.action === 'scriptVideoPrompts') {
        const storyboard = dParse(body.storyboard)
        const assets = dParse(body.assets)
        const styleNote = toStr(body.styleNote).trim().slice(0, 2000)
        if (!Object.keys(storyboard).length) return err('需要 storyboard（分镜 JSON）')
        const input =
          `【分镜 JSON】\n${JSON.stringify(storyboard).slice(0, 60000)}\n\n` +
          (Object.keys(assets).length ? `【已确定的视觉设定 JSON】\n${JSON.stringify(assets).slice(0, 20000)}\n\n` : '') +
          (styleNote ? `【用户补充要求】\n${styleNote}\n\n` : '') +
          `请按规范输出严格 JSON，不生成媒体。`
        const { parsed } = await callDeepSeek(env, {
          instructions: SCRIPT_VIDEO_PROMPTS_SYSTEM,
          input,
          maxOutputTokens: 24000,
          useSearch: false,
        })
        return ok({
          shots: (Array.isArray(parsed?.shots) ? parsed.shots : []).slice(0, 300).map(s => ({
            shotId: dStr(s?.shotId, 40),
            prompt: dStr(s?.prompt, 2000),
            action: dStr(s?.action, 600),
            movement: dStr(s?.movement, 400),
            camera: dStr(s?.camera, 200),
            sound: dStr(s?.sound, 400),
            continuityRefs: dList(s?.continuityRefs, 20, 80),
            durationSec: dNum(s?.durationSec, 4),
          })).filter(s => s.shotId),
          groups: (Array.isArray(parsed?.groups) ? parsed.groups : []).slice(0, 60).map(g => ({
            id: dStr(g?.id, 40), shotIds: dList(g?.shotIds, 40, 40), prompt: dStr(g?.prompt, 2000),
          })).filter(g => g.id),
          musicPlan: (Array.isArray(parsed?.musicPlan) ? parsed.musicPlan : []).slice(0, 400).map(m => ({
            episode: dNum(m?.episode), mood: dStr(m?.mood, 100), description: dStr(m?.description, 400),
          })),
        })
      }

      // —— drama-skills 迁移（MIT, zenstory-ai/drama-skills contributors · 2026-11-25）：结构 / 剧情审查 ——
      if (body.action === 'scriptReview') {
        const script = dParse(body.script)
        const assets = dParse(body.assets)
        const storyboard = dParse(body.storyboard)
        const videoPrompts = dParse(body.videoPrompts)
        if (!Object.keys(script).length && !Object.keys(storyboard).length) return err('需要 script 或 storyboard')
        const normIssues = v =>
          (Array.isArray(v) ? v : []).slice(0, 40).map(x => ({
            issue: dStr(x?.issue, 600), severity: dSeverity(x?.severity), suggestion: dStr(x?.suggestion, 600),
          })).filter(x => x.issue)
        const input =
          `【剧本 JSON】\n${Object.keys(script).length ? JSON.stringify(script).slice(0, 60000) : '（未提供）'}\n\n` +
          (Object.keys(assets).length ? `【视觉设定 JSON】\n${JSON.stringify(assets).slice(0, 20000)}\n\n` : '') +
          (Object.keys(storyboard).length ? `【分镜 JSON】\n${JSON.stringify(storyboard).slice(0, 30000)}\n\n` : '') +
          (Object.keys(videoPrompts).length ? `【视频提示词 JSON】\n${JSON.stringify(videoPrompts).slice(0, 20000)}\n\n` : '') +
          `请只做核对并给出建议，输出严格 JSON。`
        const { parsed } = await callDeepSeek(env, {
          instructions: SCRIPT_REVIEW_SYSTEM,
          input,
          maxOutputTokens: 12000,
          useSearch: false,
        })
        return ok({
          score: Math.max(0, Math.min(100, Math.round(dNum(parsed?.score)))),
          structural: normIssues(parsed?.structural),
          plot: normIssues(parsed?.plot),
          continuity: normIssues(parsed?.continuity),
          strengths: dList(parsed?.strengths, 20, 400),
          verdict: dStr(parsed?.verdict, 800),
        })
      }

      // —— drama-skills 迁移（MIT, zenstory-ai/drama-skills contributors · 2026-11-25）：对标拆解 ——
      if (body.action === 'scriptBreakdown') {
        const text = toStr(body.text).trim().slice(0, 16000)
        if (!text) return err('需要 text（对标剧集文本）')
        const platform = toStr(body.platform).trim().slice(0, 40) || '通用'
        const input =
          `【对标剧集文本】\n${text}\n\n【平台】${platform}\n\n` +
          `请按规范输出严格 JSON，字段缺失写「暂无」不编造。`
        const { parsed } = await callDeepSeek(env, {
          instructions: SCRIPT_BREAKDOWN_SYSTEM,
          input,
          maxOutputTokens: 16000,
          useSearch: false,
        })
        return ok({
          avgEpisodeSec: dNumOrNA(parsed?.avgEpisodeSec),
          avgShotSec: dNumOrNA(parsed?.avgShotSec),
          dialogueDensity: dStr(parsed?.dialogueDensity, 200) || '暂无',
          openingPattern: dStr(parsed?.openingPattern, 400) || '暂无',
          endingPattern: dStr(parsed?.endingPattern, 400) || '暂无',
          beats: (Array.isArray(parsed?.beats) ? parsed.beats : []).slice(0, 30).map(b => ({
            position: dStr(b?.position, 40), type: dStr(b?.type, 40), description: dStr(b?.description, 400),
          })).filter(b => b.position || b.description),
          gaps: dList(parsed?.gaps, 20, 300),
          reverseOutline: (Array.isArray(parsed?.reverseOutline) ? parsed.reverseOutline : []).slice(0, 400).map((o, i) => ({
            index: dNum(o?.index, i + 1), title: dStr(o?.title, 80), summary: dStr(o?.summary, 400),
          })),
        })
      }

      // —— v10.10：文风炼金 —— 把一段模糊的文风描述炼成一张可套用的文风卡 ——
      if (body.action === 'styleForge') {
        const raw = toStr(body.raw).trim()
        const reference = toStr(body.reference).trim()
        const sampleText = toStr(body.sampleText).trim()
        const clarifications = Array.isArray(body.clarifications)
          ? body.clarifications.map(toStr).filter(Boolean)
          : []
        if (!raw && !reference) return err('需要 raw（文风描述）或 reference（参考作家/作品）')

        const input =
          `【用户想要的文风（原话）】\n${raw || '（用户没打字）'}\n\n` +
          `【用户点了这些具体化选项】\n${clarifications.length ? clarifications.map(c => `- ${c}`).join('\n') : '（无）'}\n` +
          (reference ? `\n【参考的作家 / 作品（只借鉴气质，不许抄原文）】\n${reference}\n` : '') +
          (sampleText ? `\n【用户自己写的一段文字（要保留他的个人味道）】\n${sampleText.slice(0, 3000)}\n` : '') +
          `\n请按规范输出严格 JSON。`

        const { parsed } = await callDeepSeek(env, {
          instructions: STYLE_FORGE_SYSTEM,
          input,
          maxOutputTokens: 4000,
          useSearch: false,
        })

        const quotes = (Array.isArray(parsed.quotes) ? parsed.quotes : [])
          .map(toStr)
          .filter(Boolean)
          .slice(0, 6)

        return ok({
          name: toStr(parsed.name).slice(0, 20) || '我的文风',
          tagline: toStr(parsed.tagline) || '自定义 · 待打磨',
          effect: toStr(parsed.effect),
          quotes: quotes.length ? quotes : ['（没生成出示例，点「重新炼」再试一次）'],
          applyText: toStr(parsed.applyText),
          sample: toStr(parsed.sample),
          warnings: (Array.isArray(parsed.warnings) ? parsed.warnings : []).map(toStr).filter(Boolean),
        })
      }

      // ============ PRD 新增：新手脑洞共创模式 ============

      // 步骤 1+2：读脑洞 → 提取核心四要素 → 生成 4 组选择题
      if (body.action === 'brainstormExtract') {
        const raw = toStr(body.raw).trim()
        const cards = body.cards || {}
        const CARD_LABEL = { genre: '题材', mood: '情绪', conflict: '核心冲突' }
        const cardText = Object.keys(CARD_LABEL)
          .filter(k => cards[k])
          .map(k => `${CARD_LABEL[k]}：${toStr(cards[k])}`)
          .join('；')
        if (!raw && !cardText) return err('需要 raw（脑洞文本）或 cards（卡片点选）')

        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: BRAINSTORM_EXTRACT_SYSTEM,
          input: `${raw ? `【用户输入的脑洞】\n${raw}` : '（用户没打字，只点了卡片）'}${
            cardText ? `\n\n【用户点选的卡片】\n${cardText}` : ''
          }`,
          maxOutputTokens: 6000,
          useSearch: false, // 读脑洞不需要联网，快且省钱
        })

        const ORDER = ['protagonist', 'conflict', 'theme', 'ending']
        const LABELS = {
          protagonist: '主角人设',
          conflict: '核心矛盾',
          theme: '故事主题',
          ending: '结局走向',
        }
        const rawQs = Array.isArray(parsed.questions) ? parsed.questions : []
        const questions = ORDER.map(key => {
          const q = rawQs.find(x => toStr(x?.key) === key) || {}
          const opts = Array.isArray(q.options) ? q.options : []
          return {
            key,
            label: toStr(q.label) || LABELS[key],
            question: toStr(q.question) || `请选择${LABELS[key]}`,
            options: opts
              .slice(0, 3)
              .map(o => ({ label: toStr(o?.label), detail: toStr(o?.detail) }))
              .filter(o => o.label),
          }
        }).filter(q => q.options.length > 0)

        if (!questions.length) return err('模型未返回有效选项，请重试或把脑洞写详细一点')

        return ok(
          {
            readback: toStr(parsed.readback),
            elements: {
              protagonist: toStr(parsed.elements?.protagonist),
              desire: toStr(parsed.elements?.desire),
              conflict: toStr(parsed.elements?.conflict),
              ending: toStr(parsed.elements?.ending),
            },
            questions,
          },
          searched,
          searchCount,
        )
      }

      // 步骤 3：分层生长（layer 1→4），每层回传一块 canvasPatch 预填画布
      if (body.action === 'brainstormGrow') {
        const raw = toStr(body.raw)
        const layer = Math.min(4, Math.max(1, Number(body.layer) || 1))
        const answers = body.answers || {}
        const KEY_LABEL = {
          protagonist: '主角人设',
          conflict: '核心矛盾',
          theme: '故事主题',
          ending: '结局走向',
        }
        const picked = Object.keys(KEY_LABEL)
          .filter(k => answers[k])
          .map(k => `${KEY_LABEL[k]}：${toStr(answers[k])}`)
          .join('\n')
        const prevLayers = Array.isArray(body.previousLayers) ? body.previousLayers : []
        const prevBlock = prevLayers.length
          ? `\n\n【前面几层已经定下来的内容（必须严格承接，不能自相矛盾）】\n${prevLayers
              .map((l, i) => `第 ${i + 1} 层：${toStr(l)}`)
              .join('\n')}`
          : ''
        const chosen = body.chosenVariant
          ? `\n\n【用户选定的那句话 / 方向】\n${toStr(body.chosenVariant)}`
          : ''

        // 联网开关：默认关闭（脑洞共创求快且服务新手）；开启时先检索同类型优秀作品作参考
        const webSearch = body.webSearch === true
        let parsed, searched, searchCount
        const growInput = `【用户的原始脑洞】\n${raw || '（没打字，以下面确认的设定为准）'}
\n【用户确认过的核心设定】\n${picked || '（无）'}${chosen}${prevBlock}

现在请生成第 ${layer} 层。`
        if (webSearch) {
          const r = await callDeepSeekSearch(env, {
            system: BRAINSTORM_GROW_SYSTEM_WEB,
            userText: growInput,
            maxOutputTokens: layer === 4 ? 8000 : 6000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        } else {
          const r = await callDeepSeek(env, {
            instructions: BRAINSTORM_GROW_SYSTEM,
            input: growInput,
            maxOutputTokens: layer === 4 ? 8000 : 6000,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        }

        // canvasPatch 只保留 7 个合法维度键
        const patch = {}
        const src = parsed.canvasPatch || {}
        for (const d of DIMENSIONS) {
          const v = toStr(src[d])
          if (v) patch[d] = v
        }

        return ok(
          {
            layer: Number(parsed.layer) || layer,
            headline: toStr(parsed.headline) || `第 ${layer} 层`,
            variants: Array.isArray(parsed.variants)
              ? parsed.variants.map(toStr).filter(Boolean)
              : [],
            display: Array.isArray(parsed.display) ? parsed.display.map(toStr).filter(Boolean) : [],
            canvasPatch: patch,
            references: Array.isArray(parsed.references)
              ? parsed.references.map(toStr).filter(Boolean)
              : [],
            webSearch,
          },
          searched,
          searchCount,
        )
      }

      // 功能 2：故事体检校验器
      if (body.action === 'healthCheck') {
        const canvases = body.canvases || {}
        const compact = DIMENSIONS.map(
          d => `【${d}】\n${toStr(canvases[d]) || '（这块画布是空的）'}`,
        ).join('\n\n')

        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: HEALTH_SYSTEM,
          input: `下面是用户 7 块画布上的全部设定：\n\n${compact}`,
          maxOutputTokens: 8000,
          useSearch: false,
        })

        const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : []
        const issues = rawIssues
          .map((it, i) => {
            const dim = toStr(it?.dimension)
            return {
              id: toStr(it?.id) || String(i + 1),
              dimension: DIMENSIONS.includes(dim) ? dim : '',
              problem: toStr(it?.problem),
              why: toStr(it?.why),
              options: (Array.isArray(it?.options) ? it.options : [])
                .slice(0, 3)
                .map(o => ({ label: toStr(o?.label), fix: toStr(o?.fix) }))
                .filter(o => o.label),
            }
          })
          .filter(it => it.problem && it.options.length)

        return ok(
          {
            summary: toStr(parsed.summary),
            score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
            issues,
          },
          searched,
          searchCount,
        )
      }

      // v10.57：画布间冲突检测
      if (body.action === 'detectConflict') {
        const items = Array.isArray(body.canvases) ? body.canvases : []
        if (!items.length) return err('需要 canvases 列表')
        const byKey = Object.fromEntries(
          items.map(it => [
            toStr(it?.key),
            { name: toStr(it?.name), locked: Boolean(it?.locked) },
          ]),
        )
        const compact = items
          .map(
            it =>
              `【${toStr(it?.name)}】 (key=${toStr(it?.key)}${it?.locked ? ', 已锁定' : ''})\n${
                toStr(it?.content) || '（这块画布是空的）'
              }`,
          )
          .join('\n\n')

        const { parsed, searched, searchCount } = await callDeepSeek(env, {
          instructions: CONFLICT_SYSTEM,
          input: `下面是用户 7 块画布上的全部设定：\n\n${compact}`,
          maxOutputTokens: 4000,
          useSearch: false,
        })

        const raw = Array.isArray(parsed.conflicts) ? parsed.conflicts : []
        const conflicts = raw
          .map(c => ({
            a: toStr(c?.a),
            b: toStr(c?.b),
            reason: toStr(c?.reason),
          }))
          .filter(c => c.a && c.b && c.reason && byKey[c.a] && byKey[c.b] && c.a !== c.b)
        return ok({ conflicts }, searched, searchCount)
      }

      // 步骤 4 前置：把已填好的画布变成一份章节清单（不写正文），让「创作台」的章节框架直接可用
      if (body.action === 'brainstormOutline') {
        const canvases = body.canvases || {}
        const compact = DIMENSIONS.map(d => `【${d}】\n${toStr(canvases[d]) || '（空）'}`).join('\n\n')
        // 联网开关：默认关闭；开启时先检索同类型优秀作品的分章节奏作参考
        const webSearch = body.webSearch === true

        /* v10.29 篇幅体量（短篇 / 中篇 / 长篇）—— 用户在脑洞第 3 步选。
           以前章节上限是写死的 24 章（.slice(0, 24)），长篇小说根本长不出来，
           所以这里按体量放开上限，并把「多少章 / 每章多少字」明确写进提示词。
           cap 是安全上限（防止模型跑飞把 JSON 撑爆），tokens 是按体量给的最大输出。 */
        const SCALE_SPEC = {
          short: {
            label: '短篇小说',
            guide: '6-12 章',
            words: 2500,
            cap: 14,
            tokens: 8000,
            note: '单线推进、一个核心冲突讲透，不铺支线、不留悬念尾巴',
          },
          medium: {
            label: '中篇小说',
            guide: '18-30 章',
            words: 2800,
            cap: 40,
            tokens: 12000,
            note: '主副线并行，主角要有明确的成长弧，中段允许一次大转折',
          },
          long: {
            label: '长篇小说',
            guide: '50-120 章',
            words: 3000,
            cap: 130,
            tokens: 16000,
            note: '多幕结构（开局 / 发展 / 高潮 / 收束各有若干章），可容纳多条支线与长线伏笔，节奏要有起伏而不是一路平推',
          },
        }
        /* ⚠️ v10.30 踩过的坑：这里原先只校验 SCALE_SPEC 的 key（short/medium/long），
           'custom' 不在里面 → 被当成非法值清成 ''，于是「自定义体量」的整段约束
           压根没进提示词，模型就用它自己的默认值（实测只有 13 章 / 4 万字，
           而用户要的是 8 万字）。合法性必须连同 custom 一起判。 */
        const rawScale = toStr(body.scale)
        const scale = ['short', 'medium', 'long', 'custom'].includes(rawScale) ? rawScale : ''

        /* v10.30 自定义体量：用户直接给「全书多少字」，章数与每章字数由它反算。
           注意与前端 BrainFlow.estimateCustom 是同一套算法 —— 前端那份只用于展示预估，
           真正下发给模型的约束以这里为准，改一处记得同步另一处。 */
        const customTotal = Math.max(20000, Math.min(400000, Math.floor(Number(body.totalWords) || 0)))
        const custom = scale === 'custom'
        let cfg = scale && !custom ? SCALE_SPEC[scale] : null
        if (custom) {
          const per = customTotal <= 50000 ? 2500 : customTotal <= 120000 ? 2800 : 3000
          const chapters = Math.max(4, Math.min(120, Math.round(customTotal / per)))
          // 章数被夹到上限后反算每章字数，保证「章数 × 每章」仍然贴着用户要的总字数
          const finalWords = Math.max(1500, Math.min(6000, Math.round(customTotal / chapters / 100) * 100))
          const wan = (customTotal / 10000).toFixed(1)
          // 给一个「体裁名」+ 紧区间：实测只给单个数字（「29 章」）时模型会擅自少写一半，
          // 而预设的区间写法（「6-12 章」）它遵守得很好 —— 所以这里也按区间 + 显式乘法给。
          const kind = customTotal <= 50000 ? '短篇' : customTotal <= 120000 ? '中篇' : '长篇'
          cfg = {
            label: `自定义${kind}（${wan} 万字）`,
            guide: `${chapters - 1}-${chapters + 2} 章`,
            words: finalWords,
            cap: Math.min(220, chapters + 25),
            tokens: chapters <= 40 ? 12000 : 16000,
            note:
              `用户明确要求全书约 ${wan} 万字。请按「章数 × 每章字数 ≈ 总字数」来配，` +
              `本单算下来就是 ${chapters} 章 × 每章 ${finalWords} 字 ≈ ${((chapters * finalWords) / 10000).toFixed(1)} 万字 —— ` +
              `章数一定要给够，少写一半就等于只交付了半本书`,
          }
        }
        const maxOut = cfg ? cfg.tokens : 12000
        const scaleBlock = cfg
          ? `

===== 篇幅体量（用户已选定，必须严格遵守）=====
这一部是【${cfg.label}】，全书规模按下面规划：
- 章节数量：${cfg.guide} —— 不要少写，也不要多写（写少了撑不起这个体量，写多了是注水）
- 每章目标字数：约 ${cfg.words} 字
- 结构要求：${cfg.note}
- summary 务必精炼：一句话说清「谁 / 在哪 / 做了什么 / 结果如何」，控制在 45 字以内，不要写成小作文
==============================================`
          : ''
        const outlineInput = `下面是用户已经定稿的 7 块画布设定：\n\n${compact}${scaleBlock}`
        let parsed, searched, searchCount
        if (webSearch) {
          const r = await callDeepSeekSearch(env, {
            system: BRAINSTORM_OUTLINE_SYSTEM_WEB,
            userText: outlineInput,
            maxOutputTokens: maxOut,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        } else {
          const r = await callDeepSeek(env, {
            instructions: BRAINSTORM_OUTLINE_SYSTEM,
            input: outlineInput,
            maxOutputTokens: maxOut,
          })
          parsed = r.parsed
          searched = r.searched
          searchCount = r.searchCount
        }
        const TAGS = ['开局', '推进', '高潮', '反转', '收束']
        const outline = (Array.isArray(parsed.outline) ? parsed.outline : [])
          // v10.29：上限按体量放开（没选体量时保持旧的 24 章，向后兼容）
          .slice(0, cfg ? cfg.cap : 24)
          .map((c, i) => {
            const tag = toStr(c?.tag)
            return {
              index: Number(c?.index) || i + 1,
              title: toStr(c?.title) || `第 ${i + 1} 章`,
              summary: toStr(c?.summary),
              tag: TAGS.includes(tag) ? tag : '推进',
              // v10.29：每章目标字数按体量兜底（模型没给 words 时不再一律 2500）
              words: Math.max(800, Math.min(8000, Number(c?.words) || (cfg ? cfg.words : 2500))),
            }
          })
        if (!outline.length) return err('模型未返回章节清单，请重试')

        const totalWords = outline.reduce((s, c) => s + c.words, 0)
        return ok(
          {
            title: toStr(parsed.title) || '未命名',
            synopsis: toStr(parsed.synopsis),
            outline,
            stats: {
              totalWords,
              chapters: outline.length,
              volumes: 1,
              styleLabel: '脑洞共创模式',
              anchorSources: [],
            },
            references: Array.isArray(parsed.references)
              ? parsed.references.map(toStr).filter(Boolean)
              : [],
            webSearch,
          },
          searched,
          searchCount,
        )
      }

      /* v10.32 从文本解析世界观（世界观 tab 的「从文本解析」入口） */
      if (body.action === 'parseWorldview') {
        const text = toStr(body.text)
        if (!text.trim()) return err('需要 text（要解析的正文 / 设定文本）')
        const source = toStr(body.source) || '用户提供的文本'
        // 太长的文本只取前 2 万字：解析世界观不需要逐字读完，省钱也更快
        const clipped = text.slice(0, 20000)
        const instructions = `你是一位资深的小说世界观架构师。任务：从用户给的文本里，解析出这部作品完整、可复用的【世界观】。

要求：
- 只提取文本里实际出现 / 能合理推断的世界观信息，不要凭空编造与原文无关的设定
- 必须按下面 10 个细分维度输出（fields 的 key 固定，别改名），每个维度都要尽量填满
- 常见分块：世界规则 / 超自然或修行体系 / 地理与势力 / 历史时间线 / 社会结构与阵营 / 核心冲突
- 每块 content 写成条目式短句（方便用户直接拿去当创作主干），每块 120-300 字
- name 是这个世界观的名字（12 字以内），summary 是 60-120 字的总纲

只输出 JSON：{"name":"","summary":"","artStyle":"","fields":{"tone":"","geo":"","building":"","politics":"","infra":"","tech":"","class":"","traffic":"","daily":"","taboo":""}}\n\ntone=世界基调；geo=地理与城市规模；building=建筑与居住；politics=政治制度；infra=基础设施；tech=科技与能源；class=阶层与经济；traffic=交通与出行；daily=服饰与日常；taboo=禁忌与冲突\n\nartStyle 用一个简短的画风名（例如「蒸汽朋克 · 写实厚涂」）`

        const input = `【来源】${source}
【要解析的文本】
${clipped}`

        const r = await callDeepSeek(env, {
          instructions,
          input,
          maxOutputTokens: 8000,
        })
        const parsed = r.parsed || {}
        // v10.33 主输出是 10 个固定细分维度（fields），顺带兼容模型偶尔仍给 sections 的情况
        const FIELD_KEYS = ['tone', 'geo', 'building', 'politics', 'infra', 'tech', 'class', 'traffic', 'daily', 'taboo']
        const rawFields = parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : {}
        const fields = {}
        for (const f of FIELD_KEYS) {
          const v = toStr(rawFields[f])
          if (v.trim()) fields[f] = v
        }
        const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
          .map((s, i) => ({ title: toStr(s?.title) || `设定块 ${i + 1}`, content: toStr(s?.content) }))
          .filter(s => s.content.trim())
          .slice(0, 12)
        if (!Object.keys(fields).length && !sections.length) {
          return err('模型没有解析出可用的世界观内容，请换一段文本重试')
        }
        return ok({
          name: toStr(parsed.name) || '解析出的世界观',
          summary: toStr(parsed.summary),
          artStyle: toStr(parsed.artStyle),
          fields,
          sections,
        })
      }

      /* ============================================================
         v10.46 LOOP-01：从一章正文里提取「新设定」，建议反哺画布
         ------------------------------------------------------------
         写作和画布原来是单向的：写章节时读画布设定，但章节里新长出来的人物 /
         地点 / 规则不会回到画布。这个 action 负责「找出来 + 给建议」，
         要不要采纳由用户点（前端给 [加入画布·X] / [忽略]）。
         ============================================================ */
      if (body.action === 'extractNewSettings') {
        const text = toStr(body.text)
        if (!text.trim()) return err('需要 text（本章正文）')
        const cv = body.canvases && typeof body.canvases === 'object' ? body.canvases : {}
        const known = Object.entries(cv)
          .map(([d, v]) => `【${d}】${toStr(v).slice(0, 400)}`)
          .join('\n')
        const instructions = `你是小说设定管理员。任务：读一章正文，找出**这一章里新出现、而现有设定里没有**的人物 / 地点 / 组织 / 物品 / 规则。

要求：
- 只报「新的」：现有设定里已经写到过的，不要重复报
- 每条给三样：kind（只能是 人物 / 设定 / 情节 三者之一）、name（10 字以内）、note（一句话说清它是什么，40 字以内）
- 最多 6 条；没有新东西就返回空数组
- 不要编造正文里没有的东西

只输出 JSON：{"suggestions":[{"kind":"人物","name":"","note":""}]}`
        const input = `【现有设定（这些都已经知道，别重复报）】
${known || '（还没写设定）'}

【本章正文】
${text.slice(0, 6000)}`
        const r = await callDeepSeek(env, { instructions, input, maxOutputTokens: 2000 })
        const parsed = r.parsed || {}
        const KINDS = ['人物', '设定', '情节']
        const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
          .map((s, i) => ({
            id: `sug-${i}`,
            kind: KINDS.includes(toStr(s?.kind)) ? toStr(s.kind) : '设定',
            name: toStr(s?.name).slice(0, 20),
            note: toStr(s?.note).slice(0, 80),
          }))
          .filter(s => s.name)
          .slice(0, 6)
        return ok({ suggestions })
      }

      /* ============================================================
         v10.33 世界观配图（画风图）
         ------------------------------------------------------------
         两条通道，和文字引擎一个规矩：
           free → Cloudflare Workers AI 画图模型（走每日免费额度）
           paid → 即梦 Seedream（火山方舟），按张扣用户的火山余额
         ⚠️ 即梦的 key 只放在 Worker secret（JIMENG_API_KEY），
            绝不能下发到前端（前端拿到的永远是图片，不是 key）。
         图片存在 WRITER_KV（wvimg:{key}），前端只存 key —— 状态里不放 base64，
         否则 localStorage / 云同步的 state 会被几 MB 的图撑爆。
         ============================================================ */

      /** 字节 → base64（分块转换，避免 apply 爆栈） */
      const bytesToB64 = bytes => {
        let bin = ''
        const CH = 0x8000
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)))
        }
        return btoa(bin)
      }

      if (body.action === 'genWorldImage') {
        const prompt = toStr(body.prompt)
        if (!prompt.trim()) return err('需要 prompt（画面描述）')
        // ⚠️ 参数名必须是 imageEngine：body.engine 会被前端 callLLM 的 enginePayload() 覆盖
        const engine = body.imageEngine === 'paid' ? 'paid' : 'free'
        if (engine === 'paid' && !env.JIMENG_API_KEY) return err('服务端未配置即梦 key，暂时只能用免费通道')
        // 免费通道不给太大尺寸，省额度
        const size = engine === 'paid' ? toStr(body.size) || '1024x1024' : '1024x1024'

        let b64 = ''
        let modelUsed = ''
        try {
          if (engine === 'free') {
            const m = '@cf/black-forest-labs/flux-1-schnell'
            const out = await env.AI.run(m, { prompt, steps: 4 })
            modelUsed = m
            if (typeof out?.image === 'string') b64 = out.image
            else if (out && (out.body || typeof out.arrayBuffer === 'function')) {
              const buf = new Uint8Array(await new Response(out.body ?? out).arrayBuffer())
              b64 = bytesToB64(buf)
            }
          } else {
            // 默认用 5.0 lite（同系列里最便宜的档）；可在 Worker 环境变量 JIMENG_MODEL 里改成别的
            const arkModel = env.JIMENG_MODEL || 'doubao-seedream-5-0-lite-260128'
            const r = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${env.JIMENG_API_KEY}`,
              },
              body: JSON.stringify({
                model: arkModel,
                prompt,
                size,
                n: 1,
                response_format: 'b64_json',
                watermark: false,
              }),
            })
            const j = await r.json().catch(() => null)
                        if (!r.ok || !j) {
              const code = j?.error?.code || ''
              // 用户最可能踩的就是「模型没开通」——把开通路径直接告诉 TA
              if (code === 'ModelNotOpen') {
                return err(
                  `你的火山方舟账户还没开通 ${arkModel}。去控制台开通即可：

` +
                    `https://console.volcengine.com/ark/region:ark+cn-beijing/model \n` +
                    `找到 ${arkModel} → 「开通服务」→ 再点一次配图。

` +
                    `（模型名可以在环境变量 JIMENG_MODEL 里换成其他已开通的 Seedream 版本）`,
                )
              }
              return err(`即梦调用失败（${r.status} ${code}）：${JSON.stringify(j).slice(0, 200)}`)
            }
            b64 = j?.data?.[0]?.b64_json || ''
            modelUsed = arkModel
            // 有的版本只给 url —— 那就拉回来再存
            if (!b64 && j?.data?.[0]?.url) {
              const img = await fetch(j.data[0].url)
              if (img.ok) b64 = bytesToB64(new Uint8Array(await img.arrayBuffer()))
            }
          }
        } catch (e) {
          return err(`画图失败：${e instanceof Error ? e.message : String(e)}`)
        }
        if (!b64) return err('画图服务没有返回图像，请换个描述重试')

        const key = `wvimg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        if (env.WRITER_KV) await env.WRITER_KV.put(`wvimg:${key}`, b64)
        return ok({ key, engine, model: modelUsed, bytes: b64.length })
      }

      /** 取回已存的图片（前端用它拼 data URL 显示） */
      if (body.action === 'getWorldImage') {
        const key = toStr(body.key)
        if (!key) return err('需要 key')
        if (!env.WRITER_KV) return err('WRITER_KV 未绑定', 500)
        const b64 = await env.WRITER_KV.get(`wvimg:${key}`)
        if (!b64) return err('这张图已经过期了，重新生成一张吧')
        return ok({ b64 })
      }

      /* ============ 账号：注册 / 登录 / 登出 / 当前用户（多用户模式）============ */

      if (body.action === 'authRegister') {
        if (!env.WRITER_D1) return err('WRITER_D1 未绑定，无法注册', 500)
        // 注册开关由管理员在后台控制；默认开，避免自己把门锁死
        const settings = normalizeSettings(await kvGetJson(env, PLATFORM_SETTINGS_KEY))
        if (!settings.allowRegister) return err('站主已关闭注册，需要账号请联系管理员')
        const { u, p } = validateCredential(body.username, body.password)
        const exists = await d1All(env, 'SELECT user_id FROM users WHERE username = ?', [u])
        if (exists.length) return err('这个用户名已经被注册了，换一个或直接登录')
        const userId = `u-${randomHex(8)}`
        const salt = randomHex(16)
        const passHash = await pbkdf2(p, salt)
        await d1Run(
          env,
          `INSERT INTO users (user_id, username, pass_hash, salt, create_at, last_login_at, role, status)
           VALUES (?, ?, ?, ?, ?, ?, 'user', 'active')`,
          [userId, u, passHash, salt, nowIso(), nowIso()],
        )
        const session = await createSession(env, userId)
        // 自助注册一律是普通用户；提升管理员只能在管理后台里手动做
        return ok({ userId, username: u, role: 'user', ...session })
      }

      if (body.action === 'authLogin') {
        if (!env.WRITER_D1) return err('WRITER_D1 未绑定，无法登录', 500)
        const u = toStr(body.username).trim()
        const p = toStr(body.password)
        const rows = await d1All(env, 'SELECT * FROM users WHERE username = ?', [u])
        const user = rows[0]
        // 用户名不存在与密码错误返回同一句提示，避免账号枚举
        if (!user) return err('用户名或密码不正确')
        const hash = await pbkdf2(p, user.salt)
        if (hash !== user.pass_hash) return err('用户名或密码不正确')
        if (STATUS_OF(user) !== 'active') return err('该账号已被停用，请联系管理员')
        await d1Run(env, 'UPDATE users SET last_login_at = ? WHERE user_id = ?', [nowIso(), user.user_id])
        const session = await createSession(env, user.user_id)
        return ok({ userId: user.user_id, username: user.username, role: ROLE_OF(user), ...session })
      }

      // 当前用户：role 由服务端下发，前端据此决定要不要渲染管理入口
      if (body.action === 'authMe') {
        const me = await requireAuth(env, body.token)
        return ok(me)
      }

      // 修改密码：必须先验原密码；改完把其他设备上的会话全部踢掉，只留当前这条
      if (body.action === 'authChangePassword') {
        if (!env.WRITER_D1) return err('WRITER_D1 未绑定，无法修改密码', 500)
        const me = await requireAuth(env, body.token)
        const oldPwd = toStr(body.oldPassword)
        const newPwd = validateCredential(me.username, body.newPassword).p
        const rows = await d1All(env, 'SELECT salt, pass_hash FROM users WHERE user_id = ?', [me.userId])
        const user = rows[0]
        if (!user) return err('账号不存在', 404)
        if ((await pbkdf2(oldPwd, user.salt)) !== user.pass_hash) return err('原密码不正确')
        const salt = randomHex(16)
        const passHash = await pbkdf2(newPwd, salt)
        await d1Run(env, 'UPDATE users SET pass_hash = ?, salt = ? WHERE user_id = ?', [
          passHash,
          salt,
          me.userId,
        ])
        const kicked = await d1Run(
          env,
          'DELETE FROM sessions WHERE user_id = ? AND token != ?',
          [me.userId, toStr(body.token)],
        )
        return ok({ changed: true, otherSessionsCleared: kicked?.meta?.changes ?? null })
      }

      if (body.action === 'authLogout') {
        const t = toStr(body.token)
        if (t) await d1Run(env, 'DELETE FROM sessions WHERE token = ?', [t])
        return ok({ loggedOut: true })
      }

      /* ============ 数据层：KV + D1（全部按登录用户隔离）============ */

      // 应用状态整体保存 —— 前端云同步入口
      if (body.action === 'stateSave') {
        if (!env.WRITER_KV) return err('WRITER_KV 未绑定，无法保存', 500)
        const me = await requireAuth(env, body.token)
        // v10.64：libraryCleared 只有前端在用户显式「清空作品库」后才为 true
        return ok(await saveState(env, me.userId, body.state || {}, { libraryCleared: body.libraryCleared === true }))
      }

      // 应用状态读取 —— 前端登录后拉服务端最新
      if (body.action === 'stateLoad') {
        if (!env.WRITER_KV) return err('WRITER_KV 未绑定，无法读取', 500)
        const me = await requireAuth(env, body.token)
        let state = await kvGetJson(env, userKey(me.userId, STATE_KEY))
        let migrated = false
        // 单用户时代的存档（无 user: 前缀）一次性接管：
        // 新命名空间还是空的就把它读出来，前端会在下一次回写时落到当前账号名下。
        // 用 app:legacy:taken 记住被谁接管，避免第二个账号又继承一遍。
        if (!state) {
          const taken = await kvGetJson(env, LEGACY_TAKEN_KEY)
          if (!taken || taken.userId === me.userId) {
            const legacy = await kvGetJson(env, STATE_KEY)
            if (legacy) {
              state = legacy
              migrated = true
              await kvPutJson(env, LEGACY_TAKEN_KEY, { userId: me.userId, at: nowIso() })
            }
          }
        }
        /* v10.64：服务端自愈 —— state 里的作品库是空的，但独立储存库里有书（历史事故 / 老前端写坏的），
           直接把书补回 state 并落盘。这样**连没升级的老前端也能被修好**。 */
        const healed = await ensureStateLibrary(env, me.userId, state)
        state = healed.state
        return ok({
          state,
          migrated,
          updatedAt: state?.updatedAt || null,
          serverSavedAt: state?.serverSavedAt || null,
        })
      }

      /* v10.64：作品库独立储存库读取（只读）。
         前端发现「拉回来的状态里作品库是空的」时用它找回权威副本；
         独立库还没建过（本次升级后第一次读）→ 用 state 里的作品库引导一次并镜像。 */
      if (body.action === 'libraryLoad') {
        if (!env.WRITER_KV) return err('WRITER_KV 未绑定，无法读取', 500)
        const me = await requireAuth(env, body.token)
        const rec = await assetGetJson(env, userKey(me.userId, ASSET_LIBRARY_KEY))
        let library = Array.isArray(rec?.library) ? rec.library : []
        let source = rec ? 'assets' : 'none'
        let savedAt = rec?.savedAt || null
        if (!library.length) {
          const st = await kvGetJson(env, userKey(me.userId, STATE_KEY)).catch(() => null)
          if (Array.isArray(st?.library) && st.library.length) {
            library = st.library
            source = 'state-bootstrap'
            await mirrorLibrary(env, me.userId, library, {}).catch(() => {})
          } else {
            // R1：镜像与 state 都空 → 退到最新一份非空快照（快照不再是只写不读）
            const snap = await newestSnapshotLibrary(env, me.userId)
            if (snap.library.length) {
              library = snap.library
              savedAt = snap.savedAt
              source = 'snapshot'
              await mirrorLibrary(env, me.userId, library, {}).catch(() => {})
            }
          }
        }
        const snapshotCount = (await assetListAll(env, userKey(me.userId, ASSET_LIBRARY_SNAP_PREFIX))).length
        return ok({
          library,
          count: library.length,
          savedAt,
          snapshotCount,
          source,
        })
      }

      // 存储现状（排障用，不含任何正文）
      if (body.action === 'storageStats') {
        const me = await requireAuth(env, body.token)
        return ok(await storageStats(env, me.userId))
      }

      /* ============ 平台数据：语料覆盖层 + 站点设置 ============
         读取对所有登录用户开放（前端要用它覆盖默认语料）；
         写入只走下面的 admin* 接口。 */

      if (body.action === 'platformGet') {
        await requireAuth(env, body.token)
        return ok(await platformGet(env))
      }

      /* ============ 管理后台接口（全部 requireAdmin，前端隐藏入口 ≠ 权限）============ */

      if (body.action === 'adminOverview') {
        await requireAdmin(env, body.token)
        return ok(await adminOverview(env))
      }

      if (body.action === 'adminUsers') {
        await requireAdmin(env, body.token)
        return ok(await adminUsers(env))
      }

      if (body.action === 'adminCorpusSave') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminCorpusSave(env, me, body.books, toStr(body.mode) === 'replace' ? 'replace' : 'merge'))
      }

      if (body.action === 'adminSettingsSave') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminSettingsSave(env, me, body.settings))
      }

      if (body.action === 'adminUserSetRole') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminUserSetRole(env, me, body.userId, body.role))
      }

      if (body.action === 'adminUserSetStatus') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminUserSetStatus(env, me, body.userId, body.status))
      }

      if (body.action === 'adminUserResetPassword') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminUserResetPassword(env, me, body.userId))
      }

      // 删号是不可逆操作：必须带 confirm=true，前端也做了二次确认
      if (body.action === 'adminUserDelete') {
        const me = await requireAdmin(env, body.token)
        if (body.confirm !== true) return err('删号需要显式确认（confirm=true）')
        return ok(await adminUserDelete(env, me, body.userId))
      }

      if (body.action === 'adminBackupList') {
        await requireAdmin(env, body.token)
        return ok(await adminBackupList(env, body.limit))
      }

      if (body.action === 'adminBackupRun') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminBackupRun(env, me, body.userId))
      }

      if (body.action === 'adminBackupRestore') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminBackupRestore(env, me, body.userId, body.stamp))
      }

      if (body.action === 'adminAuditList') {
        await requireAdmin(env, body.token)
        return ok(await adminAuditList(env, body.limit))
      }

      /* ============ 测试版 → 正式版 发布请求（v10.18）============
         背景：Cloudflare Pages 的 Direct Upload 项目**不支持**把 preview 部署
         promote 到 production（实测 POST /deployments/{id}/promote 恒返回
         405 method_not_allowed），Worker 里也没有 wrangler 可用。
         所以「发布」拆成两段：
           1) 网页按钮 → 这里登记一条待发布请求（含构建哈希，锁定要发的版本）
           2) 助手用 wrangler 把同一份产物部署到 main 分支，再回来标记完成
         这样既保留了「在测试版点按钮发起发布」的入口，又不会为了自动化
         去走脆弱的上传协议（functions bundle 丢了会让 /api 反代全挂）。 */

      if (body.action === 'promoteRequest') {
        const me = await requireAdmin(env, body.token)
        return ok(await promoteRequest(env, me, body))
      }

      if (body.action === 'promoteStatus') {
        await requireAdmin(env, body.token)
        return ok(await promoteStatus(env))
      }

      if (body.action === 'promoteResolve') {
        const me = await requireAdmin(env, body.token)
        return ok(await promoteResolve(env, me, body))
      }

      /* ---- 管理员读取用户创作数据（只读，全部审计） ---- */

      if (body.action === 'adminUserContentOverview') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminUserContentOverview(env, me, body.userId))
      }

      if (body.action === 'adminUserStateGet') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminUserStateGet(env, me, body.userId))
      }

      if (body.action === 'adminUserBookGet') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminUserBookGet(env, me, body.userId, body.bookId))
      }

      if (body.action === 'adminUserAssetsList') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminUserAssetsList(env, me, body.userId, body.kind))
      }

      if (body.action === 'adminUserAssetGet') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminUserAssetGet(env, me, body.userId, body.kind, body.assetId))
      }

      // 用全站存下的作品训练优化模型（管理员触发，全量重算）
      if (body.action === 'adminTrainModel') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminTrainModel(env, me))
      }

      /* ---- 项目资产：原子设定 / 剧情分支 / 版本快照 ---- */

      if (body.action === 'assetLoad') {
        const me = await requireAuth(env, body.token)
        return ok(await assetsLoad(env, me.userId))
      }

      if (body.action === 'assetSave') {
        const me = await requireAuth(env, body.token)
        const kind = toStr(body.kind)
        if (!ASSET_KINDS[kind]) return err('kind 必须是 atom / branch / snap')
        const id = toStr(body.assetId) || `${Date.now()}`
        return ok(await assetSave(env, me.userId, kind, id, body.data || {}))
      }

      if (body.action === 'assetDelete') {
        const me = await requireAuth(env, body.token)
        const kind = toStr(body.kind)
        if (!ASSET_KINDS[kind]) return err('kind 必须是 atom / branch / snap')
        return ok(await assetDelete(env, me.userId, kind, toStr(body.assetId)))
      }

      // 备份：手动触发；type=manual_snapshot 即 PRD 里的 _keep 定点快照（备份全账号数据）
      if (body.action === 'backupNow') {
        const me = await requireAuth(env, body.token)
        const type = body.type === 'manual_snapshot' ? 'manual_snapshot' : 'manual'
        const res = await runBackup(env, type, me.userId)
        if (!res.ok) return jsonResp({ ok: false, error: res.error, version: VERSION }, 500)
        return ok(res)
      }

      // 备份历史（只读元信息，不返回压缩体）
      if (body.action === 'backupList') {
        const me = await requireAuth(env, body.token)
        return ok(await listBackups(env, me.userId, body.limit))
      }

      // 从某份备份还原（KV 侧全量恢复 + 重建 D1 索引）
      if (body.action === 'backupRestore') {
        const me = await requireAuth(env, body.token)
        const res = await restoreBackup(env, me.userId, body.stamp || body.key)
        return ok(res)
      }

      // 权重变更审计（自优化算法日志）
      if (body.action === 'weightLogAppend') {
        const me = await requireAuth(env, body.token)
        const rows = Array.isArray(body.rows) ? body.rows : [body.row || {}]
        for (const r of rows) {
          await d1Run(
            env,
            `INSERT INTO weight_log (project_id, dimension, old_val, new_val, trigger_reason, create_at, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              toStr(r.projectId),
              toStr(r.dimension),
              Number(r.oldVal) || 0,
              Number(r.newVal) || 0,
              toStr(r.reason),
              nowIso(),
              me.userId,
            ],
          )
        }
        return ok({ inserted: rows.length })
      }
      if (body.action === 'weightLogList') {
        const me = await requireAuth(env, body.token)
        const rows = await d1All(
          env,
          `SELECT * FROM weight_log WHERE project_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?`,
          [toStr(body.projectId), me.userId, Math.min(500, Number(body.limit) || 50)],
        )
        return ok({ rows })
      }

      // 案例库（失败/成功场景案例）
      if (body.action === 'caseSave') {
        const me = await requireAuth(env, body.token)
        const c = body.case || {}
        await d1Run(
          env,
          `INSERT INTO project_case_library
             (case_id, project_id, scene_tags, related_atomic_ids, case_type, fail_reason, best_fix_strategy, success_rate, create_at, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            toStr(c.caseId) || `case-${Date.now()}`,
            toStr(c.projectId),
            toStr(c.sceneTags),
            toStr(c.relatedAtomicIds),
            toStr(c.caseType),
            toStr(c.failReason),
            toStr(c.bestFixStrategy),
            Number(c.successRate) || 0,
            nowIso(),
            me.userId,
          ],
        )
        return ok({ saved: true })
      }
      if (body.action === 'caseList') {
        const me = await requireAuth(env, body.token)
        const rows = await d1All(
          env,
          `SELECT * FROM project_case_library WHERE project_id = ? AND user_id = ? ORDER BY create_at DESC LIMIT ?`,
          [toStr(body.projectId), me.userId, Math.min(500, Number(body.limit) || 50)],
        )
        return ok({ rows })
      }

      // 通用 KV 读写（前缀白名单 + 用户隔离）—— 原子设定 / 分支 / 快照等复用
      // 所有 key 一律落到 user:{uid}: 命名空间，前端无需感知
      if (body.action === 'kvPut') {
        const me = await requireAuth(env, body.token)
        const key = toStr(body.key)
        if (!kvAllowed(key)) return err(`key 必须以 ${ALLOWED_PREFIX.join(' / ')} 开头`)
        await kvPutJson(env, userKey(me.userId, key), body.value)
        return ok({ key, savedAt: nowIso() })
      }
      if (body.action === 'kvGet') {
        const me = await requireAuth(env, body.token)
        const key = toStr(body.key)
        if (!kvAllowed(key)) return err(`key 必须以 ${ALLOWED_PREFIX.join(' / ')} 开头`)
        return ok({ key, value: await kvGetJson(env, userKey(me.userId, key)) })
      }
      if (body.action === 'kvList') {
        const me = await requireAuth(env, body.token)
        const prefix = toStr(body.prefix)
        if (!kvAllowed(prefix)) return err(`prefix 必须以 ${ALLOWED_PREFIX.join(' / ')} 开头`)
        return ok({ keys: await kvListAll(env, userKey(me.userId, prefix)) })
      }

      /* ---------------- v10.23 积分（消耗 / 余额） ---------------- */
      // 用户查自己的：余额、已消耗积分、调用次数、近期明细
      // 「后台真实成本 / 溢价倍率」只有管理员回，普通用户连响应体里都拿不到
      if (body.action === 'creditsStatus') {
        const me = await requireAuth(env, body.token)
        return ok(await creditsStatus(env, me.userId, body.limit, me.role === 'admin'))
      }
      // 管理员：全站每个用户的积分总览（含匿名调用汇总）
      if (body.action === 'adminCreditsOverview') {
        await requireAdmin(env, body.token)
        return ok(await adminCreditsOverview(env))
      }
      // 管理员：给某个用户发放 / 校正积分
      if (body.action === 'adminCreditsGrant') {
        const me = await requireAdmin(env, body.token)
        return ok(await adminCreditsGrant(env, me, body))
      }

      return err(`未知 action: ${body.action}`)
    } catch (e) {
      // 打印到 Cloudflare Workers 日志（注意：绝不打印稿件正文）
      console.error(`[Worker ${VERSION}] 处理失败:`, safeStr(e), '| action=', body?.action, '| book=', body?.book, '| dim=', body?.dimension)
      // 登录态问题统一走 401，前端据此跳登录页；其余为 500
      if (e && e.code === 'unauthorized') {
        return jsonResp({ ok: false, error: safeStr(e), code: 'unauthorized', version: VERSION }, 401)
      }
      // 已登录但权限不够 / 账号被停用 → 403。
      // 刻意不用 401：前端把 401 当作「登录态失效」会清 token 并踢回登录页，
      // 而这两种情况用户的登录是好的，踢回去只会让人困惑。
      if (e && (e.code === 'forbidden' || e.code === 'disabled')) {
        return jsonResp(
          { ok: false, error: e.message || safeStr(e), code: e.code, version: VERSION },
          403,
        )
      }
      return jsonResp({
        ok: false,
        error: safeStr(e),
        version: VERSION,
        book: body?.book,
        dimension: body?.dimension,
      }, 500)
    } finally {
      // v10.23 积分结算：不管上面是成功、报错还是提前 return，都在收尾时把
      // 本请求消耗的云端 token 落库（免费引擎不记账 → 这里是 no-op）。
      // 尽力而为：结算失败只记日志，绝不影响已经算好的响应。
      try {
        await flushCreditUsage(env, body)
      } catch (e) {
        console.error(`[Worker ${VERSION}] 积分结算失败:`, safeStr(e), '| action=', body?.action)
      }
      // v10.25 免费额度计数：这次真的跑过免费模型才算一次「点击」
      if (env.__freeCalls > 0) {
        try {
          const me = await currentUser(env, body)
          await bumpFreeUsage(env, me ? me.userId : ANON_UID)
        } catch (e) {
          console.error(`[Worker ${VERSION}] 免费额度计数失败:`, safeStr(e), '| action=', body?.action)
        }
      }
    }
  },

  /**
   * Cron 定时任务：每日 02:00 UTC（北京时间 10:00）全量备份 KV + D1
   * 备份失败只记日志，等下一个调度窗口，不做无限重试
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const res = await runBackup(env, 'auto')
        if (res.ok) {
          console.log(`[Worker ${VERSION}] 定时备份完成：${res.objectPath}（${res.size} bytes，stored=${res.stored}）`)
        } else {
          console.error(`[Worker ${VERSION}] 定时备份失败：`, res.error)
        }
      })(),
    )
  },
}
