/**
 * Pages Functions 反向代理：把前端对 /fc/* 的请求转发到「变体A · LLM 中转层」。
 *
 * 为什么不直接调 llm-bridge.xxx.workers.dev：
 *   1. 与 functions/api/[[path]].js 同样的原因 —— 部分地区访问 *.workers.dev 会被
 *      屏蔽/限速，浏览器只跟同域 pages.dev 通信才稳。
 *   2. 同源之后不再需要 CORS 预检，前端也不会知道后端真实地址。
 *
 * 路由：functions/fc/[[path]].js 匹配 /fc/<anything>，也匹配 /fc/。
 * 转发时去掉 /fc 前缀，其余路径与 query 原样透传。
 */
const BRIDGE_TARGET = 'https://llm-bridge.liguolog32.workers.dev'

export async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)

  // /fc/ -> /，/fc/chat -> /chat
  const stripped = url.pathname.replace(/^\/fc/, '') || '/'
  const target = BRIDGE_TARGET + stripped + url.search

  const init = {
    method: request.method,
    headers: {
      'Content-Type': request.headers.get('content-type') || 'application/json',
    },
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text()
  }

  const resp = await fetch(target, init)

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  })
}
