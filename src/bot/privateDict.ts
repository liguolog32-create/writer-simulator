/**
 * v10.87 本机私有词典 —— 纯 localStorage 存取与输入解析。
 *
 * ┌────────────────────────── 隐私边界（硬要求） ──────────────────────────┐
 * │ 私有词条（用户自喂的专名，如人名）只存在本机浏览器的 localStorage 里。  │
 * │ 本模块绝不 fetch / POST / XMLHttpRequest，绝不发任何网络请求；          │
 * │ 词条绝不进入 AppState、绝不进入云同步白名单（syncWhitelist）；          │
 * │ 也绝不写入任何公开词典文件 —— 构建产物、上云路径里都不允许出现它。     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 本文件不 import 任何项目模块（保持零依赖，可被任何层安全引用）。
 */

/** 每个用户的私有词条总数上限 */
export const PRIVATE_DICT_LIMIT = 500

/** 存储键前缀；完整键为 `${KEY}::${uid || 'local'}`（与 placement.ts 的 uid 键模式一致） */
const KEY = 'writer-sim-private-dict-v1'

/** 单词条的默认词频（够大，保证 jieba 切分时优先整词） */
const DEFAULT_FREQ = 100000
/** 单词条的默认词性：普通名词 */
const DEFAULT_TAG = 'n'
/** 单个词条的长度上下限（字符数，含中英） */
const WORD_MIN_LEN = 1
const WORD_MAX_LEN = 24

export interface PrivateWord {
  w: string
  freq: number
  tag: string
}

interface PrivateDictData {
  words: PrivateWord[]
}

/** 读私有词典；键损坏 / 值非 JSON / 条目畸形一律退化为空词典，绝不抛出 */
export function readPrivateDict(uid: string | null): PrivateDictData {
  try {
    const raw = localStorage.getItem(`${KEY}::${uid || 'local'}`)
    if (!raw) return { words: [] }
    const data = JSON.parse(raw) as PrivateDictData
    if (!data || !Array.isArray(data.words)) return { words: [] }
    const words = data.words.filter(
      (x): x is PrivateWord => !!x && typeof x.w === 'string' && x.w.length > 0,
    )
    return { words }
  } catch {
    return { words: [] }
  }
}

/** 写私有词典；写不进去（配额满 / 隐私模式）静默失败，不影响本次会话 */
export function writePrivateDict(uid: string | null, words: PrivateWord[]): void {
  try {
    localStorage.setItem(`${KEY}::${uid || 'local'}`, JSON.stringify({ words }))
  } catch {
    /* localStorage 不可用时不阻塞 UI */
  }
}

export interface ParseWordResult {
  added: PrivateWord[]
  errors: string[]
}

/**
 * 把用户输入拆成词条：按换行 / 中英文逗号 / 顿号 / 空白拆分，trim 后校验。
 * 单批最多 PRIVATE_DICT_LIMIT 条（超出部分进 errors）；批内去重。
 */
export function parseWordInput(text: string): ParseWordResult {
  const added: PrivateWord[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  const tokens = (text || '')
    .split(/[\n\r,，、\s]+/)
    .map(t => t.trim())
    .filter(Boolean)
  for (const tok of tokens) {
    if (tok.length < WORD_MIN_LEN || tok.length > WORD_MAX_LEN) {
      errors.push(`「${tok.slice(0, 30)}」长度超出 ${WORD_MIN_LEN}-${WORD_MAX_LEN} 字范围，已跳过`)
      continue
    }
    if (seen.has(tok)) continue
    seen.add(tok)
    if (added.length >= PRIVATE_DICT_LIMIT) {
      errors.push(`单次最多添加 ${PRIVATE_DICT_LIMIT} 条，其余已跳过`)
      break
    }
    added.push({ w: tok, freq: DEFAULT_FREQ, tag: DEFAULT_TAG })
  }
  return { added, errors }
}
