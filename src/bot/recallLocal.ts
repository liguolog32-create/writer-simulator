/**
 * v10.78 按需回看（backfill）—— 机器人「当场去翻本机的观察原文」
 *
 * 要解决的场景（用户 2026-11-06 实测）：观察循环的"场景判定"不可能万无一失 ——
 * 微信整屏 OCR 会把左侧聊天列表、顶栏、气泡混在一起，偶尔整个场景判错，
 * 人名就没落进识海。但**OCR 原文就在本机**（72 小时内）：
 * 用户一提到某个名字，它就该回去翻原始记录，当场把记忆补上。
 *
 * 边界（隔离硬规则不破）：
 *   · 原文只在**本机** IndexedDB 里被读取，从不外发；
 *   · 进识海的仍然是 ingestObserved 产出的**转述摘要**；
 *   · 敏感信息闸照常生效（含密码/验证码的一幕照样拒绝）。
 */

import { listLocalObservations, summarizeLocally } from './screensee'
import { ingestObserved, tokenize } from './memory'
import type { MemoryItem } from './types'

type SegmenterCtor = new (
  locale: string,
  opts: { granularity: 'word' },
) => { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> }

/** 问句里的停用词 —— 这些不算"要找的人/事" */
const QUERY_STOP = /^(什么|怎么|如何|为什么|这个|那个|还是|就是|不是|你觉得|印象|认识|他|她|它|你|我|现在|今天|一个|什么样|哪|谁的了)$/

/**
 * 从本机观察原文里就地补一条记忆。
 * 返回 null = 没找到值得补的（或都已经被识海覆盖）。
 */
export async function backfillFromLocal(
  memories: MemoryItem[],
  query: string,
  nowMs = Date.now(),
): Promise<MemoryItem | null> {
  // 候选词（三路并集）：
  //   ① Intl.Segmenter 词级切分（最干净："夏子豪"若被 ICU 认成一个词就直接用它）
  //   ② 中文连续段的全部 2-4 字子串（兜底：ICU 把人名切碎时，子串仍能匹配到原文）
  //   ③ 英文词。停用词与识海已覆盖的去掉。
  const known = new Set(memories.flatMap(m => tokenize(`${m.content} ${m.tags.join(' ')}`)))
  const candidates: string[] = []
  const push = (s: string) => {
    const w = s.trim()
    if (w.length >= 2 && w.length <= 24 && !QUERY_STOP.test(w) && !candidates.includes(w) && candidates.length < 20)
      candidates.push(w)
  }
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter
  if (Seg) {
    try {
      const seg = new Seg('zh', { granularity: 'word' })
      for (const s of seg.segment(String(query || ''))) if (s.isWordLike) push(s.segment)
    } catch {
      /* 忽略 */
    }
  }
  for (const run of String(query || '').match(/[一-龥]{2,}/g) || []) {
    for (let len = 2; len <= Math.min(4, run.length); len++) {
      for (let i = 0; i + len <= run.length; i++) push(run.slice(i, i + len))
    }
  }
  for (const w of String(query || '').match(/[A-Za-z][A-Za-z0-9]{2,}/g) || []) push(w)
  // 只留"识海没覆盖"的候选
  const fresh = candidates.filter(s => {
    const g = tokenize(s)
    return !g.length || !g.every(x => known.has(x))
  })
  if (!fresh.length) return null

  let records: Array<{ text: string }> = []
  try {
    records = await listLocalObservations(80)
  } catch {
    return null // 本地库打不开就当没有
  }
  if (!records.length) return null

  // 逐个候选词回翻原文：包含它的最近几条合并成"一幕"走正常摄入闸门
  // （闸门里有敏感信息检查 —— 含密码/验证码的一幕照样拒绝）
  for (const cand of fresh) {
    const merged = records
      .map(r => r.text)
      .filter(t => t.includes(cand))
      .slice(0, 4)
      .join('\n')
    if (merged.trim().length < 12) continue
    const d = ingestObserved(memories, merged, summarizeLocally(merged), nowMs)
    if (d.keep && d.memory) return d.memory
  }
  return null
}
