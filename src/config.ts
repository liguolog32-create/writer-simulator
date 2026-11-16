// vite.config.ts 用 define 注入的构建标识（发布流用它锁定版本）
declare const __BUILD_HASH__: string

// 端到端可配置项（部署后所有用户共享此 URL）
// v10.1 起不再直接访问 *.workers.dev：在中国大陆等地区会被屏蔽/限速，
// 改为走 Pages Functions 反代 /api/*，浏览器只和同域 pages.dev 通信。
export const WORKER_URL = '/api'

// 变体A（Function Calling 联网搜索安全网关）的前端入口。
// 走同源 /fc → functions/fc/[[path]].js 反代到 llm-bridge Worker，
// 与 /api 同样的理由：浏览器只和同域 pages.dev 通信，不直连 *.workers.dev。
// 前端在这里拿不到任何密钥，工具 schema 也只存在于中转层。
export const FC_BRIDGE_URL = '/fc'

// LLM 调用超时：v4.1 起 generate 不开 web_search，主流 30-60 秒；给足到 180s
export const LLM_TIMEOUT_MS = 180_000

// AI 填充在本地库命中时是否还要走网络（默认 false：本地快、不花钱）
export const ALWAYS_USE_LLM = false

/* ============================================================
   写作引擎（v10.17）
   ------------------------------------------------------------
   cloud = 云端 DeepSeek：质量最高，支持联网检索同类型范文与读图，
           但每次调用都消耗 DeepSeek API token（要花钱）
   free  = Cloudflare Workers AI：跑在 Cloudflare 上的免费模型，
           每天 10,000 神经元（约 $0.11，UTC 0 点重置），不花钱；
           但没有联网检索、读图能力有限，质量略低于 DeepSeek
   ============================================================ */
export type LLMEngine = 'cloud' | 'free'

/**
 * 免费引擎的可选模型（key → 线上 model id）。
 * ⚠️ 必须和 worker.js 里的 FREE_MODELS 保持一致：key 是前后端之间的约定，
 * worker 拿 key 去查真实 model id，认不出就回落到默认模型。
 */
export const FREE_ENGINE_MODELS = [
  {
    key: 'glm',
    id: '@cf/zai-org/glm-4.7-flash',
    label: 'GLM-4.7-Flash',
    hint: '智谱 · 中文母语级 · 131k 上下文（长篇不断档）',
  },
  {
    key: 'qwen',
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    label: 'Qwen3-30B-A3B',
    hint: '阿里 MoE · 中文强 · 上下文 32k（长书可能被截断）',
  },
] as const

export type FreeEngineModelKey = (typeof FREE_ENGINE_MODELS)[number]['key']

/** 默认引擎：免费优先（省 token）。跑不动时界面会提示一键切云端 */
export const DEFAULT_ENGINE: LLMEngine = 'free'

/** 免费引擎默认模型 */
export const DEFAULT_FREE_MODEL: FreeEngineModelKey = 'glm'

/* ============================================================
   测试版 / 正式版（v10.18，v10.39 修）
   ------------------------------------------------------------
   同一份 dist 会部署到两个 Pages 分支：
     staging 分支 → https://staging.writer-simulator.pages.dev（测试版）
     main   分支 → https://writer-simulator.pages.dev        （正式版）
   改动一律先上测试版，确认没问题后再从测试版发起发布。

   ⚠️ v10.38 踩过的坑：曾经直接拿 `location.hostname` 拼 `staging.` 前缀，
   结果在 **Pages 的部署专属地址**（`448387a8.writer-simulator.pages.dev`）
   上拼出了 `staging.448387a8.writer-simulator.pages.dev` —— 这个子域在
   Cloudflare 上根本不存在、没有证书，点「🧪 测试版」直接 ERR_SSL_VERSION_OR_CIPHER_MISMATCH。
   所以必须先**剥掉 staging. / www. / 部署哈希**这些前缀，拿到「项目基域名」再拼。
   ============================================================ */

const _host = typeof location !== 'undefined' ? location.hostname || '' : ''
const _isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(_host)
/** Pages 部署专属地址的首段：8 位十六进制（如 448387a8） */
const _DEPLOY_HASH_RE = /^[0-9a-f]{8}\./i

/**
 * 剥掉前缀，得到「项目基域名」：
 *   staging.writer-simulator.pages.dev  → writer-simulator.pages.dev
 *   448387a8.writer-simulator.pages.dev → writer-simulator.pages.dev
 *   www.writer-xxx.com                  → writer-xxx.com
 *   writer-xxx.com                      → writer-xxx.com
 */
const _baseHost = (() => {
  let h = _host
  if (/^staging\./i.test(h)) h = h.slice('staging.'.length)
  else if (/^www\./i.test(h)) h = h.slice('www.'.length)
  else if (_DEPLOY_HASH_RE.test(h)) h = h.replace(_DEPLOY_HASH_RE, '')
  return h
})()

/**
 * 当前访问的是不是测试版。
 * 部署专属地址（<hash>.pages.dev）也算测试版 —— 我们的部署都发到 staging 分支，
 * 它本身就是一次预览；而且这样不会在上面显示一个指向正式版的回链。
 */
export const IS_STAGING =
  typeof location !== 'undefined' && (/^staging\./i.test(_host) || _DEPLOY_HASH_RE.test(_host))

const _usable = Boolean(_baseHost) && !_isLocal

/** 正式版地址 */
export const PROD_URL = _usable ? `https://${_baseHost}` : 'https://writer-simulator.pages.dev'
/** 测试版地址（给正式版页面提示用） */
export const STAGING_URL = _usable
  ? `https://staging.${_baseHost}`
  : 'https://staging.writer-simulator.pages.dev'

/** 构建标识（vite 注入）：发布请求会带上它，用来锁定要发的版本 */
export const BUILD_HASH: string =
  typeof __BUILD_HASH__ !== 'undefined' ? String(__BUILD_HASH__) : 'dev'
