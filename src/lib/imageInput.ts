/* ============================================================
   图片上传：压缩后转 base64（给 worker 的视觉识别用）
   ------------------------------------------------------------
   为什么要压缩：原图动辄 3-8MB，base64 后体积再涨 33%，
   直接塞进 JSON body 会超时/被拒。这里统一压到长边 ≤1600px 的 JPEG。
   ============================================================ */

export interface CompressedImage {
  /** 不含 data: 前缀的纯 base64 */
  base64: string
  mimeType: string
}

export async function fileToCompressedBase64(
  file: File,
  maxEdge = 1600,
  quality = 0.85,
): Promise<CompressedImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取图片失败'))
    fr.readAsDataURL(file)
  })

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('图片解码失败'))
    i.src = dataUrl
  })

  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  // 白底：PNG 透明区域在 JPEG 里会变黑，先铺白
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)

  const out = canvas.toDataURL('image/jpeg', quality)
  const comma = out.indexOf(',')
  return { base64: out.slice(comma + 1), mimeType: 'image/jpeg' }
}
