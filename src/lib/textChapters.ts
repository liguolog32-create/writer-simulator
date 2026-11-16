/* ============================================================
   把一整份长文本切成「章节」，供前端按章阅读 / 按章处理
   ------------------------------------------------------------
   两种模式：
     1) 检测到章节标题（第一章 / 第 3 节 / Chapter 2 / ## 标题 …）→ 按标题切
     2) 没检测到 → 按空行分段，再合并成若干等长片段，避免出现一个几千行的巨块
   切出来的片段首尾相接、可覆盖全文，因此支持「改完某章再写回全文」。
   ============================================================ */

export interface TextChapter {
  /** 0 起 */
  index: number
  /** 章名（没有标题时是「片段 N」） */
  title: string
  /** 本章原文（含标题行本身） */
  content: string
  /** content 在全文中的起点（含在 slice(start, end) 里） */
  start: number
  /** 终点 = 下一章起点 / 文末 */
  end: number
  /** 去空白后的字数 */
  words: number
  /** true = 真的识别出了章节标题；false = 自动分块 */
  detected: boolean
}

/** 一行是不是章节标题 */
const HEAD_RE =
  /^\s*(?:#{1,6}\s+\S.{0,40}|第\s*[0-9一二三四五六七八九十百千零两]{1,6}\s*[章节節回卷篇幕集]\s*[^\s]{0,24}|(?:Chapter|CHAPTER|chapter)\s*[0-9]{1,3}[^\s]{0,24}|[（(]\s*[0-9一二三四五六七八九十]{1,3}\s*[)）]\s*\S.{0,24})\s*$/

/** 去掉空白后的字数 */
function countWords(s: string): number {
  return s.replace(/\s/g, '').length
}

/** 把长文本按空行分块（保留每块在全文中的位置） */
function blankLineBlocks(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  const re = /\n[ \t　]*\n+/g
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length
    if (end > cursor) out.push({ start: cursor, end })
    cursor = end
  }
  if (cursor < text.length) out.push({ start: cursor, end: text.length })
  return out.filter(b => text.slice(b.start, b.end).trim())
}

/** 没有标题时的兜底：按段落合并成约 n 段 */
function packBlocks(text: string, total: number): TextChapter[] {
  const blocks = blankLineBlocks(text)
  const wanted = Math.max(2, Math.min(12, Math.round(total / 2500)))
  if (blocks.length <= wanted) {
    return blocks.map((b, i) => ({
      index: i,
      title: `片段 ${i + 1}`,
      content: text.slice(b.start, b.end),
      start: b.start,
      end: b.end,
      words: countWords(text.slice(b.start, b.end)),
      detected: false,
    }))
  }
  const target = Math.max(800, Math.ceil(total / wanted))
  const chapters: TextChapter[] = []
  let start = blocks[0].start
  let acc = 0
  const flush = (end: number) => {
    const content = text.slice(start, end)
    chapters.push({
      index: chapters.length,
      title: `片段 ${chapters.length + 1}`,
      content,
      start,
      end,
      words: countWords(content),
      detected: false,
    })
  }
  for (let i = 0; i < blocks.length; i++) {
    acc = countWords(text.slice(start, blocks[i].end))
    const last = i === blocks.length - 1
    if (acc >= target && !last) {
      flush(blocks[i].end)
      start = blocks[i + 1].start
    }
  }
  if (start < text.length) flush(text.length)
  return chapters
}

/** 真的检测到标题 → 按标题切 */
function splitByHeadings(text: string): TextChapter[] {
  // 逐行扫并累计偏移（不要用带 lastIndex 手改的全局正则，遇到换行会提前退出）
  const heads: number[] = []
  let off = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && trimmed.length <= 44 && HEAD_RE.test(line)) heads.push(off)
    off += line.length + 1
  }
  if (heads.length < 2) return []

  const chapters: TextChapter[] = []
  // 第一个标题之前若有正文，单独作为「前言」
  if (heads[0] > 0 && countWords(text.slice(0, heads[0])) >= 60) {
    const content = text.slice(0, heads[0])
    chapters.push({
      index: 0,
      title: '前言',
      content,
      start: 0,
      end: heads[0],
      words: countWords(content),
      detected: true,
    })
  }
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i]
    const end = i + 1 < heads.length ? heads[i + 1] : text.length
    const content = text.slice(start, end)
    const firstLine = content.split('\n')[0].trim().replace(/^#{1,6}\s*/, '')
    chapters.push({
      index: chapters.length,
      title: firstLine.length > 26 ? `${firstLine.slice(0, 26)}…` : firstLine || `第 ${i + 1} 段`,
      content,
      start,
      end,
      words: countWords(content),
      detected: true,
    })
  }
  return chapters
}

/**
 * 把长文本切成章节。
 * 文本太短（< 900 字）时返回单个片段，调用方据此决定要不要显示章节条。
 */
export function splitChapters(text: string): TextChapter[] {
  const t = text || ''
  const total = countWords(t)
  if (!t.trim()) return []
  const single: TextChapter = {
    index: 0,
    title: '全文',
    content: t,
    start: 0,
    end: t.length,
    words: total,
    detected: false,
  }
  if (total < 900) return [single]
  const byHead = splitByHeadings(t)
  if (byHead.length >= 2) return byHead
  const packed = packBlocks(t, total)
  return packed.length ? packed : [single]
}

/**
 * 把改过的某一章写回全文。
 * 末尾补一个换行：否则用户在章末接着打字时，会把下一章的标题并到同一行上，
 * 下次再切章就认不出那个标题了。
 */
export function replaceChapter(text: string, ch: TextChapter, next: string): string {
  const body = next && !next.endsWith('\n') ? `${next}\n` : next
  return text.slice(0, ch.start) + body + text.slice(ch.end)
}

/* ============================================================
   把散稿里的章节归到某本书的章纲上（「按章写入作品库」用）
   ------------------------------------------------------------
   为什么需要它：散稿框里的文本只是一份临时缓冲，跟书的「章节档案」
   （chapterWritings）没有任何绑定。用户粘进来两章正文，章节写作里仍然是
   「待写」——因为从没人把这两章写进书里。这里负责算出「哪一段 → 第几章」，
   由调用方确认后逐章写入。
   ============================================================ */

/** 归一化标题用于比对：去掉序号、「第X章」、标点与空白 */
export function normalizeChapterTitle(s: string): string {
  return (s || '')
    .replace(/^[\s#＃]+/, '')
    .replace(/第\s*[0-9一二三四五六七八九十百千零两]{1,6}\s*[章节節回卷篇幕集]/g, '')
    .replace(/[《》〈〉「」『』【】\[\]（）()：:、，,。.．·•\-—_～~\s　]/g, '')
    .toLowerCase()
}

/** 一段散稿正文去掉标题行后的纯正文 */
export function stripHeadingLine(ch: Pick<TextChapter, 'title' | 'content'>): string {
  const lines = (ch.content || '').split('\n')
  if (lines.length > 1 && lines[0].trim().replace(/^#{1,6}\s*/, '') === (ch.title || '').trim()) {
    return lines.slice(1).join('\n').trim()
  }
  return (ch.content || '').trim()
}

export interface ChapterImportPlanRow {
  /** 散稿里的第几段（0 起） */
  pieceIndex: number
  /** 散稿里那一段的标题 */
  pieceTitle: string
  /** 去掉标题行后的正文 */
  content: string
  words: number
  /** 归到章纲的第几章（1 起）；null = 章纲里没位置了 */
  targetIndex: number | null
  targetTitle: string
  /** title = 标题对上了；order = 顺序兜底；none = 没地方放 */
  by: 'title' | 'order' | 'none'
}

/**
 * 算「散稿第 i 段 → 章纲第几章」。
 * 先按标题匹配（能识别「第一章 你不合适」↔ 章纲「你不合适」这种差异），
 * 匹配不上就按顺序落到下一个还没被占用的章。同一个章不会被分配两次。
 *
 * ⚠️ 自动分块（detected=false）时直接返回空数组：那种「片段 1/片段 2」是按
 * 字数切的，按顺序硬塞给第 1、2 章会**张冠李戴**，必须由用户先补章节标题。
 */
export function planChapterImport(
  pieces: TextChapter[],
  outline: Array<{ index: number; title: string }>,
): ChapterImportPlanRow[] {
  if (!pieces.length || !pieces[0].detected) return []
  const used = new Set<number>()
  let cursor = 0
  return pieces.map((p, i) => {
    const key = normalizeChapterTitle(p.title)
    let hit = key
      ? outline.find(c => {
          const k = normalizeChapterTitle(c.title)
          return !used.has(c.index) && k.length > 0 && (k === key || k.includes(key) || key.includes(k))
        })
      : undefined
    let by: ChapterImportPlanRow['by'] = 'title'
    if (!hit) {
      while (cursor < outline.length && used.has(outline[cursor].index)) cursor++
      hit = outline[cursor]
      by = 'order'
    }
    if (!hit) {
      return {
        pieceIndex: i,
        pieceTitle: p.title,
        content: stripHeadingLine(p),
        words: p.words,
        targetIndex: null,
        targetTitle: '',
        by: 'none' as const,
      }
    }
    used.add(hit.index)
    cursor = outline.findIndex(c => c.index === hit!.index) + 1
    return {
      pieceIndex: i,
      pieceTitle: p.title,
      content: stripHeadingLine(p),
      words: p.words,
      targetIndex: hit.index,
      targetTitle: hit.title,
      by,
    }
  })
}
