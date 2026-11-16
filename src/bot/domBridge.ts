/**
 * DOM 桥 MVP（机器人「观澜」的第三只眼 · v10.93）
 *
 * 用户装了油猴脚本（public/writer-sim-dom-bridge.user.js）后，被观察页面里的
 * 结构化 DOM 区块（article/main/h1/h2…）会经 window.postMessage 流进这里，
 * 给 nlpSlice 的版面区域聚类提供比 OCR 坐标更可靠的对齐参照。
 *
 * ============================ 隔离承诺（与 screensee.ts 同级）============================
 * 1. **不进 AppState、不进 localStorage、不上云** —— 只存本模块级变量，刷新即失；
 * 2. 数据来源是本机其它标签页/窗口经 GM 存储中转的**结构数据**（矩形 + 截断文本），
 *    不含截图、不含原始 HTML，且只在本机窗口间流转；
 * 3. 任何时刻若 payload 陈旧（>10s）或对不上行数，上层一律回退 OCR 几何聚类。
 * =========================================================================================
 */

/** 一个 DOM 区块：视口坐标（getBoundingClientRect 口径）+ 截断后的 innerText */
export interface DomBlock {
  x: number
  y: number
  w: number
  h: number
  text: string
}

/** 油猴脚本 → 应用 的消息契约（window.postMessage 的 data 字段） */
export interface DomPayload {
  __writerSimDom: true
  at: number
  url: string
  title: string
  blocks: DomBlock[]
}

/** 模块级最新 payload（刻意不进任何 store / 持久化 / 云端） */
let latest: { blocks: DomBlock[]; at: number } | null = null
let installed = false

/**
 * 安装 message 监听（幂等，多次调用只装一次）。
 * 校验 __writerSimDom 标记与 blocks 数组形态后才收下；其它消息一律忽略。
 */
export function installDomBridge(): void {
  if (installed) return
  installed = true
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as Partial<DomPayload> | null | undefined
    if (!d || d.__writerSimDom !== true || !Array.isArray(d.blocks)) return
    const blocks = d.blocks.filter(
      b =>
        b &&
        typeof b.x === 'number' &&
        typeof b.y === 'number' &&
        typeof b.w === 'number' &&
        typeof b.h === 'number' &&
        typeof b.text === 'string',
    ) as DomBlock[]
    if (!blocks.length) return
    latest = { blocks, at: Date.now() }
  })
}

/** 取新鲜 DOM 区块；无 payload 或已过期（默认 10s）返回 null（上层回退 OCR 聚类）。 */
export function getFreshDomBlocks(maxAgeMs = 10_000): DomBlock[] | null {
  if (!latest || Date.now() - latest.at > maxAgeMs) return null
  return latest.blocks
}

/**
 * 把 OCR 行对齐到 DOM 区块上，产出与 nlpSlice domRegions 同构的 region 数组
 * （region id = 1_000_000 + 块下标，与 assignScreenRegions 的 col*1000+blockIdx 空间隔离）。
 *
 * 算法：每行取中心点；优先「中心落在（块矩形各向外扩 1.5×medianH 的）外扩矩形内
 * 且行的 x 区间与块 x 区间有重叠」的块（按块顺序取第一个命中）；否则取与块中心
 * 欧氏距离最近的块。
 *
 * 质量闸：若 <50% 的行中心能落进任一外扩矩形 → 整体返回 null（payload 陈旧/错位
 * 时宁可交给 OCR 聚类回退，也不强行带偏切片）。
 */
export function alignRegionsWithDom(
  lines: { x: number; y: number; w: number; h: number }[],
  blocks: DomBlock[],
): number[] | null {
  if (!blocks.length || !lines.length) return null
  const hs = lines.map(l => l.h).filter(h => h > 0).sort((a, b) => a - b)
  const medianH = hs.length
    ? hs.length % 2
      ? hs[(hs.length - 1) / 2]
      : (hs[hs.length / 2 - 1] + hs[hs.length / 2]) / 2
    : 0
  const pad = 1.5 * medianH

  const centers = blocks.map(b => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 }))
  const nearest = (cx: number, cy: number): number => {
    let best = 0
    let bestD = Infinity
    for (let bi = 0; bi < blocks.length; bi++) {
      const dx = cx - centers[bi].cx
      const dy = cy - centers[bi].cy
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = bi
      }
    }
    return best
  }

  const out = new Array<number>(lines.length)
  let inside = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const cx = l.x + l.w / 2
    const cy = l.y + l.h / 2
    let hit = -1
    let inAny = false
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi]
      const inRect =
        cx >= b.x - pad && cx <= b.x + b.w + pad && cy >= b.y - pad && cy <= b.y + b.h + pad
      if (!inRect) continue
      inAny = true
      if (l.x < b.x + b.w && l.x + l.w > b.x) {
        hit = bi
        break
      }
    }
    // 质量闸口径：行中心落进任一外扩矩形即算命中（每行最多计一次）；
    // hit<0 时（中心在矩形内但 x 不重叠，或完全在外）由 nearest 兜底赋块，
    // 是否采纳整组结果交给下方 50% 闸决定。
    if (inAny) inside++
    out[i] = 1_000_000 + (hit >= 0 ? hit : nearest(cx, cy))
  }
  if (inside / lines.length < 0.5) return null
  return out
}
