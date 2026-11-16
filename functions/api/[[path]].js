/**
 * Pages Functions 反向代理：把前端对 /api/* 的请求转发到 Worker。
 *
 * 为什么需要这一层：
 * 1. 前端直接访问 writer-sim-llm.liguolog32.workers.dev 时，部分地区网络会被
 *    屏蔽/限速，表现为登录/调用 Worker 超时（>30s）。
 * 2. 同一 Pages 域名下的 /api/* 走 Cloudflare 边缘内部网络到 Worker，既快又稳，
 *    浏览器端只和同域 pages.dev 通信，不受外部 DNS 拦截影响。
 *
 * 路由：functions/api/[[path]].js 匹配 /api/<anything>，也匹配 /api/。
 * 转发时去掉 /api 前缀，把剩余路径和 query 透传给 Worker 根路径或其子路径。
 */

const WORKER_TARGET = 'https://writer-sim-llm.liguolog32.workers.dev'

export async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)

  // 去掉 /api 前缀，例如 /api/ -> /，/api/foo -> /foo
  const stripped = url.pathname.replace(/^\/api/, '') || '/'
  const target = WORKER_TARGET + stripped + url.search

  const init = {
    method: request.method,
    headers: {
      'Content-Type': request.headers.get('content-type') || 'application/json',
    },
  }

  // 只把 body 往下传（GET/HEAD 没有 body）
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text()
  }

  const resp = await fetch(target, init)

  // 透传状态码和 Worker 的响应头（包括 CORS 头），body 直接流式转发
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  })
}
