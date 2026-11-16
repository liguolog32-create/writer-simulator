// ============================================================
// worker-llm-bridge.js —— LLM 中转调度服务（变体A）
//
// 职责：对话循环主控 / 工具调度 / HMAC 签名 / 失败缓存
//
// 与本项目文档的三个适配（README 有说明）：
//   1. **工具定义只存在于本层**（前端拿不到 schema）——与文档一致，是安全前提。
//   2. LLM 上游默认指向 **DeepSeek 的 OpenAI 兼容端点**（本项目既有 Key 在 DeepSeek），
//      换 OpenAI 只需改 LLM_BASE_URL / LLM_MODEL 两个变量，代码不用动。
//   3. 修正文档里一个会直接跑不通的细节：OpenAI 兼容接口的
//      `tool_calls[i].function.arguments` 是 **JSON 字符串**，
//      文档里直接取 `fc.arguments.query` 是取不到的。这里统一 parse 成对象再签发送网关
//      （网关按文档保持"只接受对象"的严格校验）。
//   4. 签名带时间戳（X-Internal-Timestamp），网关侧做 ±300s 防重放。
// ============================================================

const MAX_SEARCH_ROUNDS = 3 // 单会话一轮对话最多搜索次数（主控制）
const FAIL_CACHE_TTL = 600 // 失败缓存秒数（10 分钟内相同 query 不重试）
const LLM_TIMEOUT_MS = 60000

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''
    const cors = corsHeaders(origin, env)
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors })
    }
    if (request.method === 'GET') {
      return json(
        {
          ok: true,
          service: 'llm-bridge',
          version: 3,
          provider: llmProvider(env),
          model: llmModel(env),
          configured: llmReady(env) && Boolean(env.INTERNAL_SECRET && env.GATEWAY_URL),
        },
        200,
        cors,
      )
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'only POST allowed' }, 405, cors)
    }

    let reqData
    try {
      reqData = await request.json()
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400, cors)
    }

    if (!llmReady(env)) {
      return json({ ok: false, error: 'LLM 尚未配置（免费通道需要 AI 绑定，付费通道需要 LLM_API_KEY）' }, 503, cors)
    }

    // 分路：/cot = 五阶段思维链生成；其余（含 /）= 对话 + 联网
    if (url.pathname.replace(/\/$/, '') === '/cot') {
      return handleCoT(reqData, env, cors)
    }
    return handleChat(reqData, env, cors)
  },
}

/* ============================ 对话（原链路） ============================ */

async function handleChat(reqData, env, cors) {
  const { sessionId, userId, messages, model } = reqData || {}
  if (!sessionId || !Array.isArray(messages) || messages.length === 0) {
    return json({ ok: false, error: 'sessionId/messages required' }, 400, cors)
  }
  const mdl = llmModel(env, model)

  // 工具定义只存在于中转层，前端拿不到
  const tools = [SEARCH_TOOL]
  const safeMessages = sanitizeMessages(messages)

  try {
    const result = await runConversation(env, sessionId, userId, safeMessages, mdl, tools)
    return json({ ok: true, content: result.content, searchCount: result.searchCount }, 200, cors)
  } catch (err) {
    console.error('llm-bridge error:', err)
    return json({ ok: false, error: 'internal error' }, 500, cors)
  }
}

/* ============================ CoT：五阶段思维链生成 ============================ */

/** 工具定义只存在于中转层 */
const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search',
    description:
      '联网搜索事实资料，用于写作查证。禁止把手机号、身份证、银行卡、私人地址等敏感个人信息放入 query。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

/**
 * 五阶段思维链（对应需求文档）：
 *   ① 准备输入：写清题目 / 已知条件 / 限制 / 输出格式
 *   ② 分步计划：拆子问题 + 标出需要查证的事实
 *   ③ 检索取证：只有计划里标了要查的，才走 function calling 链路联网
 *   ④ 起草与自检：先写草稿，再核对约束/格式/与已知条件是否一致
 *   ⑤ 修正与呈现：不一致就先改再输出，只交最终内容（推理过程不写进正文）
 *
 * 每一阶段都把上一阶段的产物显式塞进提示词 —— 这就是"每一步都引用前面的结果"。
 */
async function handleCoT(reqData, env, cors) {
  const { task, known, constraints, format, sessionId, userId, model } = reqData || {}
  if (!task || typeof task !== 'string') {
    return json({ ok: false, error: 'task required' }, 400, cors)
  }

  const sid = String(sessionId || `cot-${Date.now().toString(36)}`)
  const uid = String(userId || 'local')
  const mdl = llmModel(env, model)
  const trace = []
  const t0 = Date.now()
  const mark = (stage, note) => trace.push({ stage, ms: Date.now() - t0, note })

  try {
    /* ---------- ① 准备输入 ---------- */
    const brief = buildBrief({ task, known, constraints, format })
    mark('brief', '已整理题目/已知/限制/输出格式')

    /* ---------- ② 分步计划 ---------- */
    const planRaw = await chatOnce(env, mdl, [
      { role: 'system', content: COT_PLAN_SYSTEM },
      { role: 'user', content: brief },
    ], { maxTokens: 900, temperature: 0.3 })

    let plan = normalizePlan(planRaw)
    let planNote = `拆出 ${plan.subQuestions.length} 个子问题，需查证 ${plan.needsFacts.length} 条`

    // 免费模型（推理型 GLM 尤甚）偶尔不吐可解析 JSON → 先严格重试一次
    if (plan.subQuestions.length === 0) {
      const retry = await chatOnce(env, mdl, [
        { role: 'system', content: '你只输出一个 JSON 对象，不要任何解释、不要 markdown 围栏。字段：subQuestions(string[]), needsFacts(string[]), outputFormat(string), risks(string[])。' },
        { role: 'user', content: brief },
      ], { maxTokens: 900, temperature: 0.1 })
      plan = normalizePlan(retry)
      planNote = `严格重试后拆出 ${plan.subQuestions.length} 个子问题`
    }

    // 还是没有 → 本地兜底计划（关键：保住"事实类任务必须查证"这一步）
    if (plan.subQuestions.length === 0) {
      plan = fallbackPlan(task)
      planNote = `模型未给出可解析计划，已启用本地兜底（需查证 ${plan.needsFacts.length} 条）`
    }
    mark('plan', planNote)

    /* ---------- ③ 检索取证（走标准 function calling 链路） ---------- */
    let evidence = ''
    let searchCount = 0
    if (plan.needsFacts.length > 0) {
      const ask = [
        `请用 search 工具逐条核实下面这些事实，然后只用要点式列出你查到的东西（带来源链接）：`,
        ...plan.needsFacts.slice(0, 3).map((f, i) => `${i + 1}. ${f}`),
        '',
        '如果某条查不到，就明确写"未查到"，不要编造。',
      ].join('\n')
      const res = await runConversation(env, sid, uid, [{ role: 'user', content: ask }], mdl, [SEARCH_TOOL])
      evidence = res.content
      searchCount = res.searchCount
      mark('evidence', `检索 ${searchCount} 次`)
    } else {
      mark('evidence', '计划未要求查证，跳过联网')
    }

    /* ---------- ④ 起草 ---------- */
    const draft = await chatOnce(env, mdl, [
      { role: 'system', content: COT_WRITE_SYSTEM },
      {
        role: 'user',
        content: [
          brief,
          '',
          '===== 你的分步计划（按顺序推进，每步引用上一步的结论）=====',
          plan.subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
          plan.outputFormat ? `\n===== 输出格式要求 =====\n${plan.outputFormat}` : '',
          evidence ? `\n===== 已查证的事实（必须优先采用，与你的记忆冲突时以它为准）=====\n${evidence}` : '',
          plan.risks.length ? `\n===== 计划阶段预判的风险（写作时主动规避）=====\n${plan.risks.map(r => `- ${r}`).join('\n')}` : '',
          '',
          '现在写正文。只输出最终内容，不要输出提纲、计划或说明。',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ], { maxTokens: 3200, temperature: 0.75 })
    mark('draft', `${draft.length} 字`)
    if (!String(draft).trim()) {
      // 宁可报错也不交白卷：免费推理型模型偶发"只回推理、不回正文"
      throw new Error('免费模型没有产出正文（可能只返回了推理）。请重试，或把 LLM_PROVIDER 换成 openai 走付费通道')
    }

    /* ---------- ⑤ 自检 ---------- */
    const verifyRaw = await chatOnce(env, mdl, [
      { role: 'system', content: COT_VERIFY_SYSTEM },
      {
        role: 'user',
        content: [
          brief,
          '',
          '===== 待检查的正文 =====',
          draft,
          evidence ? `\n===== 可作为依据的事实 =====\n${evidence}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ], { maxTokens: 900, temperature: 0.2 })
    const verification = normalizeVerification(verifyRaw)
    mark('verify', verification.passed ? '通过' : `发现 ${verification.issues.length} 处问题`)

    /* ---------- 修正（仅当自检不通过） ---------- */
    let content = draft
    if (!verification.passed && verification.issues.length > 0) {
      content = await chatOnce(env, mdl, [
        { role: 'system', content: COT_WRITE_SYSTEM },
        {
          role: 'user',
          content: [
            brief,
            '',
            '===== 你已经写好的正文 =====',
            draft,
            '',
            '===== 自检发现的问题（逐条修掉，其余部分尽量保持不变）=====',
            verification.issues.map((s, i) => `${i + 1}. ${s}`).join('\n'),
            '',
            '输出修正后的完整正文，只输出正文。',
          ].join('\n'),
        },
      ], { maxTokens: 3200, temperature: 0.75 })
      mark('revise', `${content.length} 字`)
    }

    return json(
      {
        ok: true,
        content,
        plan,
        verification,
        evidence,
        searchCount,
        trace,
        stages: trace.length,
      },
      200,
      cors,
    )
  } catch (err) {
    console.error('cot error:', err)
    return json({ ok: false, error: `生成失败：${String(err && err.message)}`, trace }, 500, cors)
  }
}

/** ① 输入整理：把散装字段拼成一份"清楚的任务书" */
export function buildBrief({ task, known, constraints, format }) {
  const list = v => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : [])
  const cfg = list(constraints)
  const parts = [`【题目】\n${String(task).trim()}`]
  if (list(known).length) parts.push(`【已知条件】\n${list(known).map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
  if (cfg.length) parts.push(`【限制】\n${cfg.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
  parts.push(`【输出格式】\n${format ? String(format) : '按题目本身的体裁与篇幅要求输出'}`)
  return parts.join('\n\n')
}

const COT_PLAN_SYSTEM = `你是写作任务的策划者。请在**不写正文**的前提下，只输出一个 JSON（不要 markdown 代码块之外的任何文字）：
{
  "subQuestions": ["按顺序要解决的子问题，3-6 条，后一条要以前一条为前提"],
  "needsFacts": ["需要联网查证的具体事实（年份/人名/数据/事件细节）；没有就给空数组"],
  "outputFormat": "对最终输出的格式与篇幅要求（一句话）",
  "risks": ["写作时最容易出错或跑偏的地方，1-3 条"]
}
要求：subQuestions 必须是可执行的动作（例如"确定叙事视角与基调""找出主角与核心冲突""设计三个递进场景"），不要写成大而空的形容词。`

const COT_WRITE_SYSTEM = `你是中文写作者。写作时在内部按计划逐步推进，**只输出最终内容**：
- 不要输出提纲、分析、自检过程，也不要说"以下是"。
- 每推进一个子问题，都要与前一个子问题的结论保持一致（人名、设定、时间线不得自相矛盾）。
- 若有"已查证的事实"，必须优先采用，不得用记忆覆盖。

===== 内部自检（写完后在交出去之前做，不要把自检过程写进输出）=====
1. 是否违背任何一条【限制】？（视角、字数、禁忌、人名设定）
2. 格式是否符合【输出格式】？
3. 是否与【已知条件】或已查证事实矛盾？
4. 是否有重复、凑字、解释性旁白？
发现问题就先改好再输出。`

const COT_VERIFY_SYSTEM = `你是严格的校稿员。只输出 JSON（不要任何额外文字）：
{
  "passed": true/false,
  "issues": ["具体问题，一条一句；指出位置与违反了什么"]
}
检查项：
1. 是否违背【限制】中的任意一条（视角/字数/禁忌/人名设定）？
2. 是否符合【输出格式】与篇幅？
3. 是否与【已知条件】或【可作为依据的事实】矛盾（数字、年份、人名、因果）？
4. 是否夹带了提纲、分析、自检说明等非正文内容？
只有当 1-4 全部无问题时 passed 才为 true。`

/** 宽松解析模型返回的 JSON（可能带 ```json 围栏或前后废话） */
export function extractJson(text) {
  const s = String(text || '')
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

export function normalizePlan(raw) {
  const j = extractJson(raw) || {}
  const arr = v => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [])
  return {
    subQuestions: arr(j.subQuestions).slice(0, 8),
    needsFacts: arr(j.needsFacts).slice(0, 3),
    outputFormat: String(j.outputFormat || '').slice(0, 300),
    risks: arr(j.risks).slice(0, 5),
  }
}

/**
 * 本地兜底计划：免费模型（尤其推理型 GLM）偶尔不吐可解析 JSON。
 * 这时**不能就这么把检索步骤跳过** —— 否则"查证"形同虚设，模型只能凭记忆瞎猜。
 * 兜底策略：把任务本身当作唯一子问题，并按关键词判断"是否需要查证事实"。
 */
export function fallbackPlan(task) {
  const t = String(task || '').trim()
  const needsFact = /[0-9０-９]|年|月|日|诺贝尔|得主|谁|多少|几|数据|统计|获奖|出生|逝世|历史/.test(t)
  return {
    subQuestions: t ? [t.slice(0, 160)] : [],
    needsFacts: needsFact && t ? [t.slice(0, 100)] : [],
    outputFormat: '',
    risks: [],
    degraded: true,
  }
}

export function normalizeVerification(raw) {
  const j = extractJson(raw)
  if (!j) {
    // 解析不出来就当作"未通过但无具体条目"，让上层按原稿输出（不阻断）
    return { passed: true, issues: [] }
  }
  const issues = Array.isArray(j.issues) ? j.issues.map(x => String(x).trim()).filter(Boolean).slice(0, 6) : []
  return { passed: Boolean(j.passed) && issues.length === 0, issues }
}

/** 单次对话（不带工具） */
async function chatOnce(env, model, messages, opts = {}) {
  // 统一走 llmComplete：免费通道（Workers AI）与付费通道（OpenAI 兼容）都能跑
  const out = await llmComplete(env, model, messages, { temperature: opts.temperature ?? 0.6, maxTokens: opts.maxTokens ?? 2048 })
  if (typeof out.content !== 'string') throw new Error('LLM response malformed')
  return out.content
}

/* ============================ 消息清洗 ============================ */

/**
 * 只允许 user / assistant 角色；把客户端传来的 system 降级为普通说明，
 * 防止攻击者用 system 覆盖工具规则（工具定义虽在服务端，但 system 仍能干扰判断）。
 */
export function sanitizeMessages(messages) {
  return messages
    .filter(m => m && typeof m === 'object')
    .slice(-20) // 只保留最近 20 条，控制 token 与注入面
    .map(m => {
      const role = m.role === 'assistant' ? 'assistant' : 'user'
      const content = typeof m.content === 'string' ? m.content.slice(0, 8000) : ''
      return { role, content }
    })
    .filter(m => m.content.length > 0)
}

/* ============================ 对话循环主控 ============================ */

export async function runConversation(env, sessionId, userId, messages, model, tools) {
  let currentMessages = [...messages]
  let searchCount = 0
  const provider = llmProvider(env)

  for (let round = 0; round <= MAX_SEARCH_ROUNDS; round++) {
    const out = await llmComplete(env, model, currentMessages, { tools })
    const toolCalls = out.toolCalls || []

    // 无工具调用 → 直接返回文本
    if (toolCalls.length === 0) {
      return { content: out.content || '', searchCount }
    }

    // 本版本只处理第一个工具调用（文档第 13 节已声明）
    const call = toolCalls[0]

    // 有工具调用 → 先检查本轮配额（主控制，KV 持久化）
    const roundCount = await getCount(env, `round:${sessionId}`)
    if (roundCount >= MAX_SEARCH_ROUNDS) {
      // 不再调用网关，直接把限制信息喂回 LLM，让它基于现有信息收尾
      currentMessages = appendToolExchange(provider, currentMessages, out, call, {
        ok: false,
        error: '本轮对话搜索次数已达上限，请基于已有信息继续作答',
      })
      continue
    }

    const fc = normalizeFunctionCall({ id: call.id, function: { name: call.name, arguments: call.arguments } })
    if (!fc || fc.name !== 'search') {
      // 未知工具：明确回绝，绝不放行
      currentMessages = appendToolExchange(provider, currentMessages, out, call, { ok: false, error: 'unsupported tool' })
      continue
    }

    const toolOutput = await dispatchTool(env, sessionId, userId, fc)
    currentMessages = appendToolExchange(provider, currentMessages, out, call, toolOutput)

    // 只有搜索成功才消耗配额；被网关拦截的不消耗配额（但进失败缓存防重试）
    if (toolOutput.ok) {
      await incr(env, `round:${sessionId}`, 3600)
      searchCount += 1
    }
  }

  // 保险兜底（正常逻辑走不到这里）
  const last = await llmComplete(env, model, currentMessages, { tools })
  return { content: last.content || '', searchCount }
}

/**
 * 把「模型申请工具 → 应用执行 → 结果回传」这一步写回对话上下文。
 *
 * 两种协议在这里分流，但**语义完全一致**（都是"应用执行、结果带 ID 回给模型"）：
 *  · openai 兼容：assistant.tool_calls + role:'tool' + tool_call_id（标准 function calling）
 *  · workers-ai：免费模型不一定支持原生 tools，改用提示词协议——
 *    assistant 记住它申请了什么，user 消息里回"工具返回 + 调用 ID"
 */
export function appendToolExchange(provider, messages, out, call, result) {
  const payload = JSON.stringify(result)
  if (provider === 'workers-ai') {
    return [
      ...messages,
      { role: 'assistant', content: out.rawToolText || `【申请调用 ${call.name}】${JSON.stringify(call.arguments)}` },
      { role: 'user', content: `【调用 ${call.id} 已执行】【工具返回】${payload}\n\n请基于以上返回继续作答；如果信息不足，直接说明查不到。` },
    ]
  }
  return [
    ...messages,
    { role: 'assistant', content: out.content || '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } }] },
    { role: 'tool', tool_call_id: call.id, content: payload },
  ]
}

/**
 * 把 OpenAI 兼容格式的 tool_call 归一化成 { name, arguments: Object }。
 * 关键：`arguments` 在接口里是 **JSON 字符串**，不 parse 就永远拿不到 query。
 * 解析失败一律返回 null —— 由调用方按"未知工具"处理，绝不猜测。
 */
export function normalizeFunctionCall(call) {
  const name = call?.function?.name
  const rawArgs = call?.function?.arguments
  if (!name) return null
  let args = {}
  if (typeof rawArgs === 'string') {
    if (rawArgs.trim()) {
      try {
        args = JSON.parse(rawArgs)
      } catch {
        return null
      }
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs
  }
  return { name, arguments: args }
}

/* ============================ LLM 通道选择 ============================ */

/**
 * 两条通道，**默认走免费那条**：
 *  · workers-ai（默认）：Cloudflare Workers AI 绑定，直接用 glm-4.7-flash 等免费模型，
 *    **不需要任何 API Key、不按次计费**（每天 10,000 神经元免费额度）。
 *  · openai：OpenAI 兼容端点（DeepSeek / OpenAI），需要 LLM_API_KEY。
 *
 * 选哪条由环境变量 LLM_PROVIDER 决定；没配就按"有没有 AI 绑定"自动选。
 */
export function llmProvider(env) {
  const explicit = String(env.LLM_PROVIDER || '').toLowerCase()
  if (explicit === 'workers-ai' || explicit === 'openai') return explicit
  return env.AI ? 'workers-ai' : 'openai'
}

export function llmModel(env, override) {
  if (override) return override
  if (env.LLM_MODEL) return env.LLM_MODEL
  return llmProvider(env) === 'workers-ai' ? '@cf/zai-org/glm-4.7-flash' : 'deepseek-chat'
}

export function llmReady(env) {
  return llmProvider(env) === 'workers-ai' ? Boolean(env.AI) : Boolean(env.LLM_API_KEY)
}

/** 免费模型池（与主 Worker 的 FREE_MODELS 保持一致） */
export const FREE_MODELS = {
  glm: '@cf/zai-org/glm-4.7-flash',
  qwen: '@cf/qwen/qwen3-30b-a3b-fp8',
}

/**
 * 从 Workers AI 的返回里取正文。
 * 不同模型/版本返回结构不一样：choices[].message.content（字符串或数组）、choice.text、response。
 * 照抄主 Worker 里已上线验证过的实现，避免"返回为空"这类假故障。
 */
export function extractChatText(data) {
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

/** 免费模型调用（含"正文为空"的兜底：换池里另一个模型再试一次） */
async function runWorkersAI(env, model, messages, opts = {}) {
  const payload = {
    messages: messages.map(m => ({ role: m.role === 'tool' ? 'user' : m.role, content: String(m.content || '') })),
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 2048,
  }

  const call = async mdl => {
    try {
      return extractChatText(await env.AI.run(mdl, payload))
    } catch (e) {
      // 个别模型换了 token 字段名
      if (/max_completion_tokens|max_tokens|deprecat/i.test(String(e && e.message))) {
        const { max_tokens, ...rest } = payload
        return extractChatText(await env.AI.run(mdl, { ...rest, max_completion_tokens: payload.max_tokens }))
      }
      throw e
    }
  }

  let text = await call(model)
  if (text) return { text, usedModel: model }

  // 空内容：推理型模型（GLM 偶发只回推理）→ 换同池另一个模型
  const alt = Object.values(FREE_MODELS).find(m => m !== model)
  if (alt) {
    try {
      const text2 = await call(alt)
      if (text2) return { text: text2, usedModel: alt }
    } catch {
      /* 备用也失败，保持空 */
    }
  }
  return { text: '', usedModel: model }
}

/** 免费模型的工具协议说明（模型不支持原生 tools 时用） */
const PROMPT_TOOL_GUIDE = `

===== 工具使用规则 =====
你可以联网搜索来核实事实。需要搜索时，**只输出下面这一行**（不要输出别的内容）：
<<<TOOL>>>{"name":"search","arguments":{"query":"你的搜索词"}}<<<END>>>
搜索词里禁止包含手机号、身份证、银行卡、邮箱等个人信息。
不需要搜索时，直接用正常文字回答。拿到【工具返回】后，基于返回内容作答；查不到就说查不到，不要编造。`

/**
 * 统一的模型调用：屏蔽两种通道的差异，返回 { content, toolCalls, rawToolText }。
 * toolCalls 统一为 [{ id, name, arguments: Object }]。
 */
export async function llmComplete(env, model, messages, opts = {}) {
  const provider = llmProvider(env)
  const tools = opts.tools || []

  if (provider === 'workers-ai') {
    if (!env.AI) throw new Error('Workers AI 绑定缺失')
    const msgs = tools.length
      ? [{ role: 'system', content: `你是严谨的中文写作与研究助手。${PROMPT_TOOL_GUIDE}` }, ...messages]
      : messages
    // runWorkersAI 内部会把 role:tool 归一成 user（免费模型不认 tool 角色）
    const { text, usedModel } = await runWorkersAI(env, model, msgs, {
      temperature: opts.temperature ?? 0.6,
      maxTokens: opts.maxTokens ?? 2048,
    })
    if (!text) {
      console.warn('workers-ai 返回为空', { model, usedModel })
      return { content: '', toolCalls: [], rawToolText: '' }
    }
    const toolCall = parsePromptToolCall(text)
    if (toolCall) {
      return { content: '', toolCalls: [toolCall], rawToolText: text.trim() }
    }
    return { content: text, toolCalls: [], rawToolText: '' }
  }

  // openai 兼容
  const base = String(env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS)
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        temperature: opts.temperature ?? 0.6,
      }),
      signal: ac.signal,
    })
    if (!resp.ok) throw new Error(`LLM API ${resp.status}`)
    const data = await resp.json()
    const message = data.choices?.[0]?.message
    if (!message) throw new Error('LLM response malformed')

    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const toolCalls = rawCalls
      .map(c => normalizeFunctionCall(c))
      .filter(Boolean)
      .map((fc, i) => ({ id: rawCalls[i]?.id || `call_${i}`, name: fc.name, arguments: fc.arguments }))

    return { content: String(message.content || '').trim(), toolCalls, rawToolText: '' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析免费模型按提示词协议输出的工具申请。
 * 容错：允许前后有零星文字、允许 arguments 是字符串化的 JSON。
 * 解析不出来一律返回 null —— 绝不猜测。
 */
export function parsePromptToolCall(text) {
  const s = String(text || '')
  const m = s.match(/<<<TOOL>>>([\s\S]*?)<<<END>>>/)
  if (!m) return null
  let obj
  try {
    obj = JSON.parse(m[1].trim())
  } catch {
    return null
  }
  const name = String(obj?.name || '').trim()
  if (!name) return null
  let args = obj?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  if (!args || typeof args !== 'object') return null
  return { id: `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, arguments: args }
}

/* ============================ 分派工具（签名调用网关） ============================ */

export async function dispatchTool(env, sessionId, userId, fc) {
  const query = fc?.arguments?.query || ''

  // 失败缓存：同一会话相同 query 被拦截过，直接复用上次拒绝结果，不再转发网关
  const cacheKey = `fail:${sessionId}:${await sha256(query)}`
  const cached = await env.FC_SESSION_COUNTER.get(cacheKey)
  if (cached) {
    return { ok: false, error: cached, cached: true }
  }

  if (!env.GATEWAY_URL || !env.INTERNAL_SECRET) {
    return { ok: false, error: '网关未配置' }
  }

  const payload = JSON.stringify({ sessionId, userId, functionCall: fc })
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = await signPayload(env.INTERNAL_SECRET, `${ts}.${payload}`)

  let result
  try {
    // ⚠️ 同域的两个 Worker 不能用全局 fetch 互调（Cloudflare 1042），
    // 有 Service Binding 时优先走绑定；本地测试没有绑定则回落全局 fetch。
    const doFetch = env.GATEWAY
      ? (url, init) => env.GATEWAY.fetch(new Request(url, init))
      : fetch
    const gwResp = await doFetch(env.GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Signature': signature,
        'X-Internal-Timestamp': ts,
      },
      body: payload,
    })
    result = await gwResp.json()
  } catch (err) {
    return { ok: false, error: `网关不可达：${String(err && err.message)}` }
  }

  // 被网关拦截 → 写入失败缓存，防止 LLM 反复重试同一搜索
  if (!result.ok) {
    const reason = String(result.error || 'blocked').slice(0, 200)
    await env.FC_SESSION_COUNTER.put(cacheKey, reason, { expirationTtl: FAIL_CACHE_TTL })
    return { ok: false, error: reason }
  }
  return result
}

/* ============================ HMAC 签名（Web Crypto） ============================ */

export async function signPayload(secret, raw) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(raw))
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/* ============================ KV 计数工具 ============================ */

async function getCount(env, key) {
  const raw = await env.FC_SESSION_COUNTER.get(key)
  return raw ? parseInt(raw, 10) || 0 : 0
}

async function incr(env, key, ttl) {
  const cur = await getCount(env, key)
  await env.FC_SESSION_COUNTER.put(key, String(cur + 1), { expirationTtl: ttl })
}

/* ============================ CORS ============================ */

function corsHeaders(origin, env) {
  const allow = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  const ok = allow.length === 0 || allow.includes(origin)
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : 'null',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(obj, status, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  })
}
