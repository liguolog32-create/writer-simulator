/**
 * jieba-wasm 懒加载器 —— sync / async 桥的「异步侧」（方案 A）。
 *
 * nlpSlice.ts 是纯同步、零 import 的模块，不能静态 import jieba-wasm（会破坏
 * memory.ts 的同步调用链和所有纯 Node 回归）。本模块在运行时被挂载一次，负责：
 *   动态 import → 初始化 wasm → 读同源用户词典 → 把分词函数注入 nlpSlice。
 *
 * 隐私：屏幕文字永不经过本模块（只把「分词函数」交给 nlpSlice），
 * 这里既不缓存也不外发任何屏幕文本；cached 里只有一个 Promise<boolean>。
 */
import { setSegmenter } from './nlpSlice'
import { readPrivateDict } from './privateDict'

type JiebaModule = typeof import('jieba-wasm')

/** 模块级缓存：整个应用生命周期只真正加载一次（幂等）。失败也缓存，避免反复重试。 */
let cached: Promise<boolean> | null = null

/** 已初始化的 jieba 模块实例（load 成功后保存，供私有词典热生效 add_word / 分词试一试使用） */
let mod: JiebaModule | null = null

/** 幂等入口：成功 true / 任何失败 false，绝不抛出、绝不中断观察。 */
export function ensureJieba(): Promise<boolean> {
  if (cached) return cached
  cached = load()
  return cached
}

async function load(): Promise<boolean> {
  try {
    // 动态 import：Vite 会把它拆成独立懒加载 chunk，不进主 bundle。
    const jieba = await import('jieba-wasm')
    // web target 的 default export 就是 init()；它内部 fetch 由 Vite 重写好 URL 的 .wasm。
    await jieba.default()

    // 同源静态词典（离线产出的静态资源）。404 / 空 / 网络异常都退化为仅默认词典。
    // v10.88：userdict.txt（通用行业词）+ names.txt（内置人名词库，Apache-2.0 公开语料）
    // 一次合并喂给 with_dict —— 任何用户开箱即识常见人名，无需逐个投喂。
    const parts = await Promise.all([fetchDictText('/dict/userdict.txt'), fetchDictText('/dict/names.txt')])
    const dictText = parts.filter(Boolean).join('\n')
    if (dictText) jieba.with_dict(dictText)

    // 注入后 sliceScreenText 立即用 jieba 分词；保持同步调用链不变。
    setSegmenter((line: string) => jieba.cut(line, true) as string[])
    mod = jieba
    return true
  } catch (e) {
    console.warn('[jieba] 初始化失败，已回退到 ICU 分词：', e)
    return false
  }
}

/** 只负责取词典文本；404 / 空 / 异常 / SPA 回退页都退化为空串（= 仅默认词典）。 */
async function fetchDictText(path: string): Promise<string> {
  try {
    const res = await fetch(path)
    if (!res.ok) return ''
    // vite preview / Pages 的 SPA 回退会把缺失的 .txt 回成 200 text/html 的 index.html，
    // 绝不能把整页 HTML 当词典喂给 with_dict（否则报错或污染词典）。
    if (/text\/html/i.test(res.headers.get('content-type') || '')) return ''
    const text = (await res.text()).trim()
    if (!text || text[0] === '<') return ''
    return text
  } catch (e) {
    console.warn('[jieba] 用户词典读取失败，使用默认词典：', e)
    return ''
  }
}

/**
 * v10.87：把本机私有词典热注入 jieba（add_word 逐词生效，新增词立刻参与切分）。
 *
 * 隐私：词条只从本机 localStorage（privateDict.ts）读取，绝不发任何网络请求。
 * jieba-wasm 没有 remove_word / 重置接口 —— 删除的词条要刷新页面（重新初始化）后才生效。
 * 绝不抛出：未就绪只 warn 返回 ok:false；单个坏词只计入 failed，不拖垮整批。
 */
export async function applyPrivateDict(
  uid: string | null,
): Promise<{ ok: boolean; applied: number; failed: number }> {
  const ready = await ensureJieba()
  if (!ready || !mod) {
    console.warn('[jieba] 私有词典未应用：分词引擎未就绪')
    return { ok: false, applied: 0, failed: 0 }
  }
  let applied = 0
  let failed = 0
  for (const item of readPrivateDict(uid).words) {
    try {
      mod.add_word(item.w, item.freq, item.tag)
      applied++
    } catch (e) {
      failed++
      console.warn('[jieba] 私有词条 add_word 失败：', item.w, e)
    }
  }
  return { ok: true, applied, failed }
}

/** v10.87：分词试一试 —— 直接取已初始化实例的 cut()；未就绪返回 null。绝不抛出。 */
export function cutTokens(line: string): string[] | null {
  if (!mod) return null
  try {
    return mod.cut(line, true) as string[]
  } catch {
    return null
  }
}
