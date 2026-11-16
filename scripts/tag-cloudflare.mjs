#!/usr/bin/env node
/**
 * Cloudflare 资源打标签（Resource Tagging）—— 用"标签"代替"文件夹"整理控制台
 *
 * 为什么需要它：Cloudflare 的 Workers & Pages 列表**没有文件夹功能**（官方社区里
 * 一直是未实现的功能请求）。官方给的替代方案是 Resource Tagging：
 * 给同一产品的所有资源打同一个标签，然后在
 *   Manage Account → Resource Tagging
 * 按标签筛选，就等价于「只看这一组」。
 *
 * 用法：
 *   1) 在 Cloudflare 控制台创建 API Token（推荐 Account API Token）：
 *      My Profile → API Tokens → Create Token → Custom token
 *      权限：Account → Resource Tagging → Edit
 *      （或角色给 Tag Admin / Workers Admin / Super Administrator）
 *   2) 运行：
 *        CF_API_TOKEN=xxxx node scripts/tag-cloudflare.mjs --dry-run   # 先看要改什么
 *        CF_API_TOKEN=xxxx node scripts/tag-cloudflare.mjs             # 真打
 *
 * 说明：Tagging API 的 PUT 是「整体替换」，所以本脚本走 GET → 合并 → PUT，
 *      不会把你已有的标签冲掉。
 */

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '1b268a6b37988de0cccaee58b7a06a87'
const TOKEN = process.env.CF_API_TOKEN
const DRY = process.argv.includes('--dry-run')

if (!TOKEN) {
  console.error('缺少 CF_API_TOKEN。示例：CF_API_TOKEN=xxx node scripts/tag-cloudflare.mjs --dry-run')
  process.exit(1)
}

/**
 * 分组方案：一个产品一个 product 标签，另加 role 区分「前端 / 后端 / 存储」。
 * 加新资源时，只要在这里补一行。
 */
const PLAN = [
  // ── 作家模拟器 ──────────────────────────────────────────────
  { type: 'worker', id: 'writer-sim-llm', tags: { product: 'writer-sim', role: 'backend' } },
  { type: 'worker', id: 'llm-bridge', tags: { product: 'writer-sim', role: 'backend' } },
  { type: 'worker', id: 'fc-gateway', tags: { product: 'writer-sim', role: 'backend' } },
  { type: 'pages_project', id: 'writer-simulator', tags: { product: 'writer-sim', role: 'frontend' } },
  { type: 'kv_namespace', id: 'ai_writer_kv_store', tags: { product: 'writer-sim', role: 'storage' } },
  { type: 'kv_namespace', id: 'ai_writer_assets_store', tags: { product: 'writer-sim', role: 'storage' } },
  { type: 'kv_namespace', id: 'FC_SESSION_COUNTER', tags: { product: 'writer-sim', role: 'storage' } },
  { type: 'kv_namespace', id: 'FC_AUDIT_LOG', tags: { product: 'writer-sim', role: 'storage' } },
  { type: 'd1_database', id: 'ai_writer_d1_db', tags: { product: 'writer-sim', role: 'storage' } },

  // ── 股市 / 金价监控 ────────────────────────────────────────
  { type: 'worker', id: 'gold-tracker-api', tags: { product: 'stock', role: 'backend' } },
  { type: 'pages_project', id: 'gold-tracker', tags: { product: 'stock', role: 'frontend' } },
  { type: 'kv_namespace', id: 'gold_tracker_pool', tags: { product: 'stock', role: 'storage' } },

  // ── 杂项 / 工具 ────────────────────────────────────────────
  { type: 'pages_project', id: 'wb-api-probe', tags: { product: 'tools', role: 'probe' } },
]

/** 资源 id 需要解析成 UUID 的类型（标签 API 要的是内部 id，不是名字） */
const NAME_TO_ID = {
  kv_namespace: '/storage/kv/namespaces', // result[].{ id, title }
  d1_database: '/d1/database', // result[].{ uuid, name }
}

async function api(path, init = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const body = await r.json().catch(() => null)
  if (!r.ok || !body?.success) {
    const msg = body?.errors?.map(e => `${e.code}: ${e.message}`).join('; ') || `HTTP ${r.status}`
    throw new Error(`${path} → ${msg}`)
  }
  return body.result
}

/** 把名字解析成标签 API 需要的 resource_id */
async function resolveId(type, idOrName) {
  const path = NAME_TO_ID[type]
  if (!path) return idOrName // worker / pages_project 直接用名字
  const list = await api(path)
  const hit = list.find(x => x.id === idOrName || x.title === idOrName || x.uuid === idOrName || x.name === idOrName)
  if (!hit) throw new Error(`找不到 ${type}: ${idOrName}`)
  return hit.uuid || hit.id
}

async function main() {
  // 0) 先验证账号是否开通了标签功能（官方文档的踩坑点：未开通会 403）
  try {
    await api('/tags/keys')
  } catch (e) {
    console.error('\n❌ 标签 API 调用失败：', e.message)
    console.error('   · 403 提到 permission/role → Token 权限不够（要有 Resource Tagging: Edit）')
    console.error('   · 403 提到 feature/gate   → 该账号还没开通 Resource Tagging，需联系 Cloudflare 支持')
    process.exit(1)
  }

  console.log(`${DRY ? '【预演】' : ''}共 ${PLAN.length} 个资源待打标签\n`)

  let ok = 0
  const failed = []
  for (const item of PLAN) {
    try {
      const resourceId = await resolveId(item.type, item.id)
      // GET 现有标签 → 合并 → PUT（PUT 是整体替换，必须先合并）
      let existing = {}
      try {
        const cur = await api(`/tags?resource_type=${encodeURIComponent(item.type)}&resource_id=${encodeURIComponent(resourceId)}`)
        existing = cur?.tags || {}
      } catch {
        // 官方已知限制：从未打过标签的资源查询可能返回 500，当作空标签处理
        existing = {}
      }
      const merged = { ...existing, ...item.tags }
      const added = Object.keys(item.tags).filter(k => existing[k] !== item.tags[k])

      if (DRY) {
        console.log(`  [预演] ${item.type}/${item.id}  +${added.map(k => `${k}=${item.tags[k]}`).join(' ')}`)
      } else {
        await api('/tags', {
          method: 'PUT',
          body: JSON.stringify({ resource_type: item.type, resource_id: resourceId, tags: merged }),
        })
        console.log(`  ✅ ${item.type}/${item.id}  ${JSON.stringify(merged)}`)
      }
      ok++
    } catch (e) {
      failed.push(`${item.type}/${item.id}: ${e.message}`)
      console.log(`  ❌ ${item.type}/${item.id}  ${e.message}`)
    }
  }

  console.log(`\n完成：${ok}/${PLAN.length}${failed.length ? `，失败 ${failed.length}` : ''}`)
  console.log('\n打完之后在控制台这样看分组：')
  console.log('  Manage Account → Resource Tagging → 按标签筛选 product=writer-sim 或 product=stock')
  console.log('  （也可以直接搜 tag: product=writer-sim）')
  if (failed.length) process.exit(1)
}

main()
