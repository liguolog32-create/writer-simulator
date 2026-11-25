/**
 * 短剧五份文档导出：Markdown 渲染 + 纯前端 minimal ZIP（store 模式，无压缩）。
 *
 * 不引入任何第三方依赖（项目 deps 仅 jieba-wasm / react / react-dom / tesseract.js）。
 * 文件名含中文，因此 general purpose bit flag 必须置 bit 11（UTF-8 文件名）。
 *
 * 规则参考 drama-skills (MIT, zenstory-ai/drama-skills contributors)。
 */

import type {
  ScriptAssets,
  ScriptStoryboard,
  ScriptVideoPrompts,
} from './llmClient'

/** 每份导出文件顶部的来源声明 */
export const EXPORT_HEADER =
  '<!-- 观澜书房导出 · 规则参考 drama-skills (MIT, zenstory-ai/drama-skills contributors) -->'

/** 五份文档的入参；key 用中文与下载文件名一一对应 */
export interface DramaBundleParts {
  '剧本': string
  '视觉设定': string
  '分镜': string
  '图片提示词': string
  '视频提示词': string
}

const FILE_NAMES: Array<[keyof DramaBundleParts, string]> = [
  ['剧本', '01-剧本.md'],
  ['视觉设定', '02-视觉设定.md'],
  ['分镜', '03-分镜.md'],
  ['图片提示词', '04-图片提示词.md'],
  ['视频提示词', '05-视频提示词.md'],
]

const enc = new TextEncoder()

/* ============================================================
   CRC32（IEEE 802.3，多项式 0xEDB88320）
   ============================================================ */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ============================================================
   最小字节写入器（小端序，DataView）
   ============================================================ */
class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  private pos = 0

  constructor(size: number) {
    this.buf = new Uint8Array(size)
    this.view = new DataView(this.buf.buffer)
  }

  u16(v: number): void {
    this.view.setUint16(this.pos, v & 0xffff, true)
    this.pos += 2
  }

  u32(v: number): void {
    this.view.setUint32(this.pos, v >>> 0, true)
    this.pos += 4
  }

  raw(bytes: Uint8Array): void {
    this.buf.set(bytes, this.pos)
    this.pos += bytes.length
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos)
  }
}

interface ZipEntry {
  name: Uint8Array
  content: Uint8Array
  crc: number
  offset: number
}

/**
 * 把五份 Markdown 打成一个 ZIP Blob。
 *
 * 结构：每个文件 = 30B 本地文件头 + 文件名 + 内容；
 * 随后是 46B × N 的中央目录 + 22B EOCD。压缩方式 0（store）。
 */
export function buildDramaBundle(parts: DramaBundleParts): Blob {
  const now = new Date()
  // DOS 时间/日期：秒只存 2 秒为单位；年份下限 1980
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f)
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f)

  const entries: ZipEntry[] = FILE_NAMES.map(([key, filename]) => {
    const name = enc.encode(filename)
    // 每份文件顶部统一加来源声明；调用方只需给正文
    const content = enc.encode(`${EXPORT_HEADER}\n${parts[key] || ''}`)
    return { name, content, crc: crc32(content), offset: 0 }
  })

  let localSize = 0
  let centralSize = 0
  for (const e of entries) {
    localSize += 30 + e.name.length + e.content.length
    centralSize += 46 + e.name.length
  }
  const w = new ByteWriter(localSize + centralSize + 22)

  let offset = 0
  for (const e of entries) {
    e.offset = offset
    // ---- local file header (30B) ----
    w.u32(0x04034b50)
    w.u16(20) // version needed to extract
    w.u16(0x0800) // general purpose bit flag: UTF-8 文件名
    w.u16(0) // compression method: store
    w.u16(dosTime)
    w.u16(dosDate)
    w.u32(e.crc)
    w.u32(e.content.length) // compressed size
    w.u32(e.content.length) // uncompressed size
    w.u16(e.name.length)
    w.u16(0) // extra field length
    w.raw(e.name)
    w.raw(e.content)
    offset += 30 + e.name.length + e.content.length
  }

  const centralStart = offset
  for (const e of entries) {
    // ---- central directory header (46B) ----
    w.u32(0x02014b50)
    w.u16(20) // version made by
    w.u16(20) // version needed
    w.u16(0x0800) // UTF-8 文件名
    w.u16(0) // store
    w.u16(dosTime)
    w.u16(dosDate)
    w.u32(e.crc)
    w.u32(e.content.length)
    w.u32(e.content.length)
    w.u16(e.name.length)
    w.u16(0) // extra length
    w.u16(0) // comment length
    w.u16(0) // disk number start
    w.u16(0) // internal attributes
    w.u32(0) // external attributes
    w.u32(e.offset) // local header offset
    w.raw(e.name)
    offset += 46 + e.name.length
  }

  // ---- end of central directory (22B) ----
  w.u32(0x06054b50)
  w.u16(0) // disk number
  w.u16(0) // disk with central directory
  w.u16(entries.length)
  w.u16(entries.length)
  w.u32(offset - centralStart)
  w.u32(centralStart)
  w.u16(0) // comment length

  // new Uint8Array(...) 复制一份，确保底层是 ArrayBuffer 而非 ArrayBufferLike，
  // 兼容较新 TS 对 BlobPart 的收窄要求。
  return new Blob([new Uint8Array(w.bytes())], { type: 'application/zip' })
}

/* ============================================================
   五份 Markdown 的结构化渲染（②～⑤；①剧本由 ScriptStudio 提供）
   ============================================================ */

/** 视觉设定：人物 / 造型 / 地点 / 道具 / 连戏锁 / 声线 */
export function renderAssetsMarkdown(a: ScriptAssets): string {
  const L: string[] = ['# 视觉设定', '', `制作风格：${a.productionStyle || '暂无'}`, `时代背景：${a.eraSetting || '暂无'}`, '']

  L.push('## 人物')
  if (!a.characters.length) L.push('（暂无）')
  for (const c of a.characters) {
    L.push(`### ${c.name}`)
    L.push(`- 固定外貌：${c.appearance || '暂无'}`)
    if (c.voice) L.push(`- 声线：${c.voice}${c.voiceRef ? `（参考：${c.voiceRef}）` : ''}`)
    if (c.promptName) L.push(`- 生图锚点（promptName）：${c.promptName}`)
    if (c.lockWords.length) L.push(`- 锁定词：${c.lockWords.join('、')}`)
    if (c.variants.length) {
      L.push('- 可变造型：')
      for (const v of c.variants) L.push(`  - ${v.name}（第 ${v.episodes} 集）：${v.appearance}`)
    }
    L.push('')
  }

  L.push('## 地点')
  if (!a.locations.length) L.push('（暂无）')
  for (const loc of a.locations) {
    L.push(`### ${loc.name}`)
    L.push(`- 外观：${loc.appearance || '暂无'}`)
    if (loc.orientation) L.push(`- 朝向 / 机位关系：${loc.orientation}`)
    L.push('')
  }

  L.push('## 道具')
  if (!a.props.length) L.push('（暂无）')
  for (const p of a.props) {
    L.push(`### ${p.name}`)
    L.push(`- 外观：${p.appearance || '暂无'}`)
    for (const s of p.states) L.push(`- 状态「${s.state}」：${s.from} → ${s.to}`)
    L.push('')
  }

  L.push('## 连戏锁')
  if (!a.continuityLocks.length) L.push('（暂无）')
  for (const k of a.continuityLocks) {
    L.push(`- [${k.id}] ${k.label}｜范围：${k.scope}｜锁定词：${k.lockWords.join('、')}`)
  }
  return L.join('\n')
}

/** 分镜：逐镜渲染镜号 / 景别 / 机位 / 运镜 / 起止 / 声音 / 站位 / 首尾帧提示词 */
export function renderStoryboardMarkdown(sb: ScriptStoryboard): string {
  const L: string[] = ['# 分镜', '', sb.summary || '（暂无总体说明）', '']
  for (const s of sb.shots) {
    L.push(`## 第 ${s.episode} 集 · 场 ${s.sceneNo} · ${s.id}`)
    L.push(`- 镜号：${s.id}`)
    L.push(`- 景别：${s.shotType || '暂无'}｜机位：${s.camera || '暂无'}｜运镜：${s.movement || '暂无'}`)
    L.push(`- 时长：${s.durationSec} 秒`)
    L.push(`- 起帧：${s.startFrame || '暂无'}`)
    L.push(`- 动作：${s.action || '暂无'}`)
    L.push(`- 落帧：${s.endFrame || '暂无'}`)
    L.push(`- 声音：${s.sound || '暂无'}`)
    L.push(`- 站位 / 调度：${s.blocking || '暂无'}`)
    L.push(`- 首帧提示词：${s.firstFramePrompt || '暂无'}`)
    L.push(`- 尾帧提示词：${s.lastFramePrompt || '暂无'}`)
    if (s.refImages.length) L.push(`- 参考图：${s.refImages.join('、')}`)
    L.push('')
  }
  L.push('## 未覆盖场景')
  if (sb.uncoveredScenes.length) for (const u of sb.uncoveredScenes) L.push(`- ${u}`)
  else L.push('（无）')
  return L.join('\n')
}

/** 图片提示词：汇总逐镜首帧提示词，并列出角色的生图锚点 */
export function renderImagePromptsMarkdown(sb: ScriptStoryboard, assets?: ScriptAssets): string {
  const L: string[] = ['# 图片提示词', '', '## 角色生图锚点']
  if (assets?.characters.length) {
    for (const c of assets.characters) {
      if (c.promptName) {
        L.push(`- **${c.name}**｜promptName：${c.promptName}｜外貌：${c.appearance || '暂无'}${
          c.lockWords.length ? `｜锁定词：${c.lockWords.join('、')}` : ''
        }`)
      }
    }
  } else {
    L.push('（暂无视觉设定，或角色未标注 promptName）')
  }
  L.push('', '## 逐镜首帧提示词')
  if (!sb.shots.length) L.push('（暂无分镜）')
  for (const s of sb.shots) {
    L.push(`### ${s.id}（第 ${s.episode} 集 · 场 ${s.sceneNo}）`)
    L.push(s.firstFramePrompt || '（暂无首帧提示词）')
    if (s.lastFramePrompt) L.push('', `尾帧提示词：${s.lastFramePrompt}`)
    L.push('')
  }
  return L.join('\n')
}

/** 视频提示词：逐镜 / 多镜合生 GROUP / 配乐表 */
export function renderVideoPromptsMarkdown(vp: ScriptVideoPrompts): string {
  const L: string[] = ['# 视频提示词', '', '## 逐镜提示词']
  if (!vp.shots.length) L.push('（暂无）')
  for (const s of vp.shots) {
    L.push(`### ${s.shotId}（${s.durationSec} 秒）`)
    L.push(s.prompt || '（暂无提示词）')
    L.push(`- 动作：${s.action || '暂无'}｜运镜：${s.movement || '暂无'}｜机位：${s.camera || '暂无'}`)
    L.push(`- 声音：${s.sound || '暂无'}`)
    if (s.continuityRefs.length) L.push(`- 连戏引用：${s.continuityRefs.join('、')}`)
    L.push('')
  }

  L.push('## 多镜合生（GROUP）')
  if (!vp.groups.length) L.push('（暂无）')
  for (const g of vp.groups) {
    L.push(`### ${g.id}（镜头：${g.shotIds.join('、')}）`)
    L.push(g.prompt || '（暂无提示词）')
    L.push('')
  }

  L.push('## 配乐表')
  if (!vp.musicPlan.length) L.push('（暂无）')
  else {
    L.push('| 集数 | 情绪 | 说明 |', '| --- | --- | --- |')
    for (const m of vp.musicPlan) {
      const cell = (v: string) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
      L.push(`| 第 ${m.episode} 集 | ${cell(m.mood)} | ${cell(m.description)} |`)
    }
  }
  return L.join('\n')
}
