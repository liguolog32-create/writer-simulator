/**
 * v10.79 观察摘要库（前端）—— 把「切分 + 场景解读」的产出存到 Cloudflare
 *
 * 定位（延续用户 2026-10-14 的隔离规则，2026-11-06 扩展）：
 *   · 屏幕**原文**永远只在本机 IndexedDB（72h TTL），哪里都不去；
 *   · 上云的是**转述摘要**（白名单字段：时间/来源/类型/人名/说话人/话题/要点/情绪）；
 *   · 含密码/验证码的一幕，摘要根本不生成（digestScene 返回 null）。
 *
 * 机制：观察时把摘要推进队列（localStorage 兜底持久化），每 45s / 满 10 条 /
 * 停止观察时批量 POST 给 worker 的 obsSave（服务端按白名单重造对象，双保险）。
 * 仅本机模式 / 未登录：完全不发。
 */

import { postWorker } from './api'
import { getToken, isLocalOnly } from './session'
import { createMemory } from '../bot/memory'
import type { ObsDigest } from '../bot/memory'
import type { MemoryItem } from '../bot/types'

const QUEUE_KEY = 'writer-sim-obs-queue-v1'
const FLUSH_MS = 45_000
const FLUSH_THRESHOLD = 10
/** 过期守卫：localStorage 里跨天残留的记录（如 2026-11-07T05:03Z 今天才 flush）不再上云污染 D1 */
const QUEUE_STALE_MS = 24 * 3600 * 1000

let queue: ObsDigest[] = loadQueue()
let flushing = false
let timer: number | null = null

function loadQueue(): ObsDigest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object') : []
  } catch {
    return []
  }
}

function persist() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-200)))
  } catch {
    /* 隐私模式等场景静默 */
  }
}

/** 观察循环每认出一幕就调用（敏感的一幕在 digestScene 里已经是 null，不会到这里） */
export function queueDigest(rec: ObsDigest): void {
  if (isLocalOnly() || !getToken()) return // 仅本机/未登录：不发云端
  // 过期守卫：超过 24h 的残留记录直接丢弃，别把昨天的 leftover 刷进 D1
  const atMs = Date.parse(rec.at)
  if (Number.isFinite(atMs) && Date.now() - atMs > QUEUE_STALE_MS) return
  // 同一幕被反复入队（观察循环按帧回调）只留一条：用白名单字段拼稳定键去重
  const dedupKey = (d: ObsDigest) => `${d.kind}|${d.name}|${(d.gist || '').slice(0, 12)}`
  const key = dedupKey(rec)
  if (queue.some(q => dedupKey(q) === key)) return
  queue.push(rec)
  persist()
  ensureTimer()
  if (queue.length >= FLUSH_THRESHOLD) void flushDigests()
}

function ensureTimer() {
  if (timer !== null) return
  timer = window.setInterval(() => void flushDigests(), FLUSH_MS)
}

/** 手动触发一次上云（停止观察时调用，别把尾巴留在队列里） */
export async function flushDigests(): Promise<number> {
  if (flushing || isLocalOnly() || !getToken() || !queue.length) return 0
  flushing = true
  const batch = queue.splice(0, 50)
  persist()
  try {
    const r = await postWorker<{ saved: number }>({ action: 'obsSave', records: batch }, 30_000)
    return Number(r.data?.saved) || batch.length
  } catch {
    // 失败塞回队首（限流保护），下次再试
    queue.unshift(...batch)
    persist()
    return 0
  } finally {
    flushing = false
    if (!queue.length && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

/**
 * 按需回看的云端通道：本地原文（72h TTL）没有命中时，来云端摘要库找。
 * 这里只查**摘要记录**，屏幕原文依旧无处可寻。
 */
export async function searchDigests(query: string, limit = 100): Promise<ObsDigest[]> {
  if (isLocalOnly() || !getToken()) return []
  try {
    const r = await postWorker<{ records: ObsDigest[] }>({ action: 'obsList', limit }, 30_000)
    const ql = query.toLowerCase()
    return (r.data?.records || []).filter(d => {
      const fields = [d.name, d.gist, ...(d.speakers || []), ...(d.topics || []), ...(d.entities || [])]
        .filter(Boolean)
        .map(f => String(f).toLowerCase())
      // 命中：任一字段出现在问句里（问"夏子豪"→ 名字字段命中）
      return fields.some(f => f.length >= 2 && ql.includes(f))
    })
  } catch {
    return []
  }
}

/** v10.79 UI：列出云端观察摘要（不做筛选，把状态差异交给 UI 显示不同的空态）。
 * 与 searchDigests 不同：后者是「问句命中摘要」的回看通道，且把错误吞成 []。
 */
export type DigestListStatus = 'ok' | 'local' | 'guest' | 'error'
export interface DigestListResult {
  records: ObsDigest[]
  status: DigestListStatus
  message?: string
}

export async function listDigests(limit = 100): Promise<DigestListResult> {
  if (isLocalOnly()) return { records: [], status: 'local' }
  if (!getToken()) return { records: [], status: 'guest' }
  try {
    const r = await postWorker<{ records: ObsDigest[] }>({ action: 'obsList', limit }, 30_000)
    return { records: r.data?.records || [], status: 'ok' }
  } catch (e) {
    return { records: [], status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** 云端摘要 → 记忆条目（按需回看的云端半场）。
 * 摘要记录本身就是白名单转述，直接按 profile/长文形态建记忆，人名进 tags。
 */
export function digestToMemory(r: ObsDigest, nowMs = Date.now()): MemoryItem | null {
  const name = (r.name || '').trim()
  const gist = (r.gist || '').trim()
  if (!name && !gist) return null
  // 用 createMemory 造（衰减/容量等字段由它统一填，别手拼 MemoryItem 漏字段）
  return createMemory({
    content: name
      ? `屏幕上出现过「${name}」${gist ? `：${gist}` : ''}${r.topics?.length ? `（${r.topics.join('、')}）` : ''}。`
      : `屏幕上的内容要点：${gist}。`,
    layer: 'episodic',
    source: 'observed',
    confidence: 0.5,
    importance: 0.5,
    identity: 0.2,
    valence: 0,
    arousal: 0.3,
    emotion: r.mood || '平静',
    tags: [...(name ? [name] : []), ...(r.speakers || []), ...(r.topics || [])].filter(Boolean).slice(0, 8),
    at: r.at || new Date(nowMs).toISOString(),
  })
}

/** 云端半场的回看：本地原文没命中时，来摘要库里找并建记忆。
 * 返回 null = 云端也没有（或都已经被识海覆盖）。
 */
export async function backfillFromCloud(
  memories: MemoryItem[],
  query: string,
  nowMs = Date.now(),
): Promise<MemoryItem | null> {
  const records = await searchDigests(query, 100)
  if (!records.length) return null
  for (const r of records) {
    // 识海已覆盖（同名）就跳过
    if (r.name && memories.some(m => m.tags.includes(r.name))) continue
    const m = digestToMemory(r, nowMs)
    if (m) return m
  }
  return null
}
