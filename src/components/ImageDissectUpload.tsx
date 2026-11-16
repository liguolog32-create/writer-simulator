import { useRef, useState } from 'react'
import { fileToCompressedBase64 } from '../lib/imageInput'
import { dissectImageLLM } from '../lib/llmClient'

interface ImageDissectUploadProps {
  /** 已锁定的维度：服务端会直接丢弃，绝不写回 */
  locked?: string[]
  /** 识别成功回调：拿到 7 个维度的内容，由调用方决定填画布还是填脑洞 */
  onResult: (dims: Record<string, string>) => void
  hint?: string
}

/**
 * 上传图片 → AI 视觉识别（思维导图 / 大纲 / 设定图 / 手写笔记）→ 拆解成 7 个维度。
 * 两个模式共用：高级工作台直接填画布，脑洞模式填画布并往下走流程。
 */
export function ImageDissectUpload({ locked = [], onResult, hint }: ImageDissectUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const pick = async (file?: File) => {
    if (!file) return
    setBusy(true)
    setMsg('正在压缩并识别图片…')
    try {
      const { base64, mimeType } = await fileToCompressedBase64(file)
      const { data } = await dissectImageLLM({ imageBase64: base64, mimeType, locked })
      onResult(data)
      setMsg('已识别图片内容，并分配到 7 个画布')
    } catch (e) {
      setMsg(`❌ 图片识别失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="img-upload">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={e => pick(e.target.files?.[0])}
      />
      <button className="ghost-btn sm" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? '识别中…' : '上传图片识别'}
      </button>
      {hint && <span className="wb-hint">{hint}</span>}
      {msg && <p className={msg.includes('失败') ? 'wb-warn' : 'wb-ok'}>{msg}</p>}
    </div>
  )
}
