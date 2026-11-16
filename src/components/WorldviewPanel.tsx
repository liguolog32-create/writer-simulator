import { useEffect, useState } from 'react'
import { useApp } from '../store/AppContext'
import { genWorldImage, getWorldImage, parseWorldview } from '../lib/llmClient'
import { useEnginePref } from '../lib/engine'
import { ART_STYLES, WORLDVIEW_FIELDS } from '../types'
import { WorldviewMap } from './WorldviewMap'
import type { Worldview, WorldviewSection } from '../types'

/* ============================================================
   世界观 · 设定主干 —— v10.33
   ------------------------------------------------------------
   两条路径，同一个终点：
     A) 自由创作：按**固定的细分维度**填（房子 / 城市规模 / 政治制度 / 基础设施 /…）
        —— 不只是「写个大概」，而是真的把世界搭出来；每个维度都能配画风图
     B) 从文本解析：选自己作品库里的一本书 / 贴一段文本，AI 按同样的维度拆出来，再自己改
   都能保存 → 「以这个世界观为主干」写进画布 → 一键生成小说 → 收进合集。

   配图两条通道（和文字引擎一个规矩）：
     free → Workers AI（免费额度，默认）
     paid → 即梦 Seedream（按张扣用户的火山余额）
   key 只在 Worker secret 里，前端永远拿不到；图片存服务端 KV，state 里只存 key。
   ============================================================ */

const nowIso = () => new Date().toISOString()
const newId = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const emptyWorldview = (): Worldview => ({
  id: newId('wv'),
  name: '',
  summary: '',
  source: 'manual',
  fields: {},
  custom: [],
  artStyle: ART_STYLES[0],
  images: {},
  createdAt: nowIso(),
  updatedAt: nowIso(),
})

/** 生成配图的提示词：画风 + 维度内容 */
const imagePromptFor = (wv: Worldview, label: string, body: string) =>
  `${wv.artStyle || '写实插画'}风格，${label}。${(body || '').slice(0, 260)}。` +
  `要求：构图完整、细节丰富、能当这个世界观的设定参考图；画面干净，不要出现任何文字、招牌字或水印。`

export function WorldviewPanel({ onGoCanvases }: { onGoCanvases?: () => void }) {
  const {
    state,
    saveWorldview,
    deleteWorldview,
    saveCollection,
    deleteCollection,
    bulkUpdateContent,
    listCanvases,
  } = useApp()
  // 配图沿用顶栏的引擎偏好：free=免费额度，cloud(付费)=即梦
  const pref = useEnginePref()
  const imagePaid = pref.engine === 'cloud'

  const worldviews = state.worldviews
  const collections = state.collections
  const library = state.library

  const [editing, setEditing] = useState<Worldview | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('') // '' | 'parse' | 'img:<slot>'

  const [parseOpen, setParseOpen] = useState(false)
  const [parseSource, setParseSource] = useState<'book' | 'paste'>('book')
  const [bookId, setBookId] = useState('')
  const [pasteText, setPasteText] = useState('')

  /** v10.35 排版参考 LoL 地区页：地图浏览 / 编辑 两种模式 */
  const [viewMode, setViewMode] = useState<'map' | 'edit'>('map')

  /** v10.37 每个合集各自选中的待收录作品 id */
  const [bookPick, setBookPick] = useState<Record<string, string>>({})

  /** v10.44 WORLD-01：待挂入这个世界观的作品 */
  const [seriesPick, setSeriesPick] = useState('')
  /** v10.44 WORLD-01：解析结果默认复用（同一本书不重复调 AI）；勾了这个才强制重解析 */
  const [forceParse, setForceParse] = useState(false)

  const [colName, setColName] = useState('')
  const [colNote, setColNote] = useState('')

  /** 已取回的图片：维度 key / 'cover' → data URL */
  const [imgs, setImgs] = useState<Record<string, string>>({})

  const flash = (m: string) => {
    setMsg(m)
    window.setTimeout(() => setMsg(cur => (cur === m ? '' : cur)), 6000)
  }

  /* 选中某个世界观时，把它存的图取回来 */
  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!editing?.images || !Object.keys(editing.images).length) {
        setImgs({})
        return
      }
      const got: Record<string, string> = {}
      await Promise.all(
        Object.entries(editing.images).map(async ([k, key]) => {
          try {
            const { data } = await getWorldImage(key)
            if (data?.b64) got[k] = `data:image/png;base64,${data.b64}`
          } catch {
            /* 过期就忽略，重新生成即可 */
          }
        }),
      )
      if (alive) setImgs(got)
    }
    void load()
    return () => {
      alive = false
    }
    // 只在切换世界观时拉图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id])

  const patch = (p: Partial<Worldview>) => setEditing(e => (e ? { ...e, ...p } : e))
  const setField = (k: string, v: string) =>
    setEditing(e => (e ? { ...e, fields: { ...e.fields, [k]: v } } : e))

  /* ---------- 保存 / 删除 ---------- */
  const commit = () => {
    if (!editing) return
    if (!editing.name.trim()) {
      flash('⚠️ 给这个世界观起个名字')
      return
    }
    const wv: Worldview = { ...editing, name: editing.name.trim(), updatedAt: nowIso() }
    saveWorldview(wv)
    setEditing(wv)
    flash(`✅ 已保存世界观「${wv.name}」`)
  }

  /* ---------- 以世界观为主干写进画布 ---------- */
  const startNovel = () => {
    if (!editing) return
    const canvasIdByDim: Record<string, string> = {}
    listCanvases().forEach(c => {
      canvasIdByDim[c.dimension] = c.id
    })
    const patchMap: Record<string, string> = {}

    // 固定维度 → 全部汇总进【设定】画布（前面加总纲）
    const parts: string[] = []
    if (editing.summary.trim()) parts.push(`【总纲】${editing.summary.trim()}`)
    for (const f of WORLDVIEW_FIELDS) {
      const v = (editing.fields[f.key] || '').trim()
      if (v) parts.push(`【${f.title}】${v}`)
    }
    // 自定义块：标题等于维度名 → 写进对应画布；否则也汇总进设定
    for (const s of editing.custom) {
      const t = (s.title || '').trim()
      const body = (s.content || '').trim()
      if (!body) continue
      const id = canvasIdByDim[t]
      if (id) patchMap[id] = body
      else parts.push(`【${t || '设定'}】${body}`)
    }
    if (parts.length) patchMap[canvasIdByDim['设定']] = parts.join('\n\n')

    if (!Object.keys(patchMap).length) {
      flash('⚠️ 这个世界观还没有可写进画布的内容')
      return
    }
    bulkUpdateContent(patchMap, '世界观写回画布（作为创作主干）')
    flash(`✅ 已把「${editing.name}」写进 ${Object.keys(patchMap).length} 块画布，去「多画布」点生成即可开写。`)
    onGoCanvases?.()
  }

  /* ---------- 从文本解析 ---------- */
  const bookText = (id: string) => {
    const b = library.find(x => x.id === id)
    if (!b) return ''
    const chapters = Object.entries(b.chapterWritings ?? {})
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map(([idx, w]) => `【第 ${idx} 章 ${b.outline.find(o => o.index === Number(idx))?.title ?? ''}】\n${w.content}`)
      .join('\n\n')
    const outline = b.outline.map(c => `${c.index}. ${c.title}：${c.summary}`).join('\n')
    return `《${b.title}》\n${b.synopsis}\n\n【章纲】\n${outline}\n\n【正文】\n${chapters}`.slice(0, 20000)
  }

  const runParse = async () => {
    const text = parseSource === 'book' ? bookText(bookId) : pasteText
    const src =
      parseSource === 'book'
        ? `作品《${library.find(x => x.id === bookId)?.title ?? ''}》`
        : '手动粘贴的文本'
    if (!text.trim()) {
      flash('⚠️ 请先选一本书，或粘贴一段文本')
      return
    }
    // v10.36 双保险：已经解析过的作品不重复解析（按钮也会禁用，这里再拦一道）
    if (!forceParse && parseSource === 'book' && parsedFrom(bookId)) {
      flash('⚠️ 这本已经解析过了，不重复解析。点上面「打开已有世界观 →」看结果。')
      return
    }
    setBusy('parse')
    setMsg('')
    try {
      const { data } = await parseWorldview({ text, source: src })
      setEditing({
        id: newId('wv'),
        name: data.name || '解析出的世界观',
        summary: data.summary || '',
        source: 'parsed',
        originNote: `解析自${src}（${text.length} 字）`,
        originBookId: parseSource === 'book' ? bookId : undefined,
        fields: data.fields ?? {},
        custom: (data.sections ?? []) as WorldviewSection[],
        artStyle: data.artStyle || ART_STYLES[0],
        images: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      setViewMode('edit')
      setForceParse(false)
      flash('✅ 已解析出世界观（每个维度都能改，改完记得保存）')
    } catch (e) {
      flash(`❌ 解析失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  /* ---------- 配图 ---------- */
  const genImage = async (slot: string, label: string, body: string) => {
    if (!editing) return
    setBusy(`img:${slot}`)
    setMsg('')
    try {
      const { data } = await genWorldImage({
        prompt: imagePromptFor(editing, label, body),
        imageEngine: imagePaid ? 'paid' : 'free',
      })
      const { data: got } = await getWorldImage(data.key)
      const wv: Worldview = {
        ...editing,
        images: { ...editing.images, [slot]: data.key },
        updatedAt: nowIso(),
      }
      saveWorldview(wv)
      setEditing(wv)
      setImgs(prev => ({ ...prev, [slot]: `data:image/png;base64,${got.b64}` }))
      flash(
        `已用${imagePaid ? '付费（即梦）' : '免费'}通道生成「${label}」配图` +
          (imagePaid ? '（这张已扣你的火山余额）' : ''),
      )
    } catch (e) {
      flash(`❌ 配图失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  const removeImage = (slot: string) => {
    if (!editing) return
    const images = { ...editing.images }
    delete images[slot]
    const wv = { ...editing, images, updatedAt: nowIso() }
    saveWorldview(wv)
    setEditing(wv)
    setImgs(prev => {
      const next = { ...prev }
      delete next[slot]
      return next
    })
  }

  /* ---------- 合集 ---------- */
  const createCollection = () => {
    const n = colName.trim()
    if (!n) {
      flash('⚠️ 给合集起个名字')
      return
    }
    saveCollection({
      id: newId('col'),
      name: n,
      note: colNote.trim(),
      worldviewIds: [],
      bookIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    setColName('')
    setColNote('')
    flash(`✅ 已创建合集「${n}」`)
  }

  const addCurrentToCollection = (colId: string) => {
    const col = collections.find(c => c.id === colId)
    if (!col || !editing) return
    if (col.worldviewIds.includes(editing.id)) {
      flash('⚠️ 这个世界观已经在这个合集里了')
      return
    }
    saveCollection({ ...col, worldviewIds: [...col.worldviewIds, editing.id] })
    flash(`✅ 已把「${editing.name}」收进合集「${col.name}」`)
  }

  /** v10.36 这本作品是否已经解析过 → 返回已有的那个世界观（不重复解析） */
  const parsedFrom = (bid: string) => {
    const b = library.find(x => x.id === bid)
    if (!b) return undefined
    return (
      worldviews.find(w => w.originBookId === bid) ??
      // 兼容 v10.35 之前的数据（那时只存了一段文字来源说明）
      worldviews.find(w => w.source === 'parsed' && (w.originNote || '').includes(`《${b.title}》`))
    )
  }
  const doneWv = parseSource === 'book' && bookId ? parsedFrom(bookId) : undefined

  /** v10.37 把作品库里已有的书收进合集 */
  const addBookToCollection = (colId: string) => {
    const col = collections.find(c => c.id === colId)
    const bid = bookPick[colId]
    if (!col || !bid) {
      flash('⚠️ 先在上面选一本已有作品')
      return
    }
    if (col.bookIds.includes(bid)) {
      flash('⚠️ 这本已经在合集里了')
      return
    }
    saveCollection({ ...col, bookIds: [...col.bookIds, bid] })
    setBookPick(p => ({ ...p, [colId]: '' }))
    flash(`✅ 已把《${bookName(bid)}》收进合集「${col.name}」`)
  }

  /** v10.37 从合集里移出成员（只解除归属，不删作品/世界观本身） */
  const removeFromCollection = (colId: string, kind: 'wv' | 'book', id: string) => {
    const col = collections.find(c => c.id === colId)
    if (!col) return
    if (kind === 'wv') {
      saveCollection({ ...col, worldviewIds: col.worldviewIds.filter(x => x !== id) })
      flash(`已把「${wvName(id)}」移出合集「${col.name}」（世界观本身还在）`)
    } else {
      saveCollection({ ...col, bookIds: col.bookIds.filter(x => x !== id) })
      flash(`已把《${bookName(id)}》移出合集「${col.name}」（作品本身还在）`)
    }
  }

  const wvName = (id: string) => worldviews.find(w => w.id === id)?.name ?? '（已删除）'
  const bookName = (id: string) => library.find(b => b.id === id)?.title ?? '（已删除）'
  const filledCount = (w: Worldview) =>
    WORLDVIEW_FIELDS.filter(f => (w.fields[f.key] || '').trim()).length

  /* ---------- 渲染 ---------- */
  return (
    <div className="wv">
      <div className="wv-head">
        <div>
          <h2 className="wv-title">世界观 · 设定主干</h2>
          <p className="wv-sub">
            按固定维度把世界搭细（房子、城市规模、政治制度、基础设施…），每个维度都能配画风图；
            也可以从自己的文本里让 AI 解析出来。存好之后拿它当主干写小说，还能收进合集。
          </p>
        </div>
        <div className="wv-head-actions">
          <button
            className="ghost-btn"
            onClick={() => {
              setEditing(emptyWorldview())
              setParseOpen(false)
              setViewMode('edit')
            }}
          >
            ＋ 空白世界观
          </button>
          <button
            className={`ghost-btn ${parseOpen ? 'open' : ''}`}
            onClick={() => {
              setParseOpen(o => !o)
              setEditing(null)
            }}
          >
            从文本解析
          </button>
        </div>
      </div>

      {msg && <p className={msg.startsWith('❌') || msg.startsWith('⚠️') ? 'wb-warn' : 'wb-ok'}>{msg}</p>}

      {/* ===== 入口 B：从文本解析 ===== */}
      {parseOpen && (
        <div className="wv-parse">
          <div className="wv-parse-tabs">
            <button
              type="button"
              className={`brain-variant ${parseSource === 'book' ? 'active' : ''}`}
              onClick={() => setParseSource('book')}
            >
              从作品库选
            </button>
            <button
              type="button"
              className={`brain-variant ${parseSource === 'paste' ? 'active' : ''}`}
              onClick={() => setParseSource('paste')}
            >
              粘贴一段文本
            </button>
          </div>
          {parseSource === 'book' ? (
            <label className="wv-field">
              <span>选择作品（会用它的书名 + 简介 + 章纲 + 已写正文）</span>
              <select value={bookId} onChange={e => setBookId(e.target.value)}>
                <option value="">— 选一本书 —</option>
                {library.map(b => (
                  <option key={b.id} value={b.id}>
                    《{b.title}》 · {b.createdAt}
                    {parsedFrom(b.id) ? ' · 已解析 ✓' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="wv-field">
              <span>把你要解析的文本贴进来（最多取前 2 万字）</span>
              <textarea
                rows={6}
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                placeholder="例如：你以前写过的开篇、设定说明、喜欢的世界观段落…"
              />
            </label>
          )}
          {/* v10.36 已经解析过的作品不再重复解析，直接把已有结果给你 */}
          {doneWv && (
            <div className="wv-parsed-note">
              <span>
                这本已经解析过了，不重复解析 —— 已有结果：
                <b>「{doneWv.name}」</b>
              </span>
              <button
                className="primary-btn sm"
                onClick={() => {
                  setEditing(doneWv)
                  setParseOpen(false)
                  setViewMode('map')
                  flash(`已打开「${doneWv.name}」，要改就切到「✎ 编辑」`)
                }}
              >
                打开已有世界观 →
              </button>
              {/* v10.44 WORLD-01：默认复用上次结果（省钱省时间）；想重来要显式点这里 */}
              <button
                className="ghost-btn sm"
                onClick={() => {
                  setForceParse(true)
                  flash('已开启重新解析 —— 再点一次下面的按钮，会覆盖上次的结果新建一份。')
                }}
                title="同一本书默认不重复解析；点这里可以强制重新解析一份"
              >
                重新解析
              </button>
            </div>
          )}
          <button
            className="primary-btn"
            onClick={() => void runParse()}
            disabled={busy === 'parse' || (Boolean(doneWv) && !forceParse)}
            title={
              doneWv && !forceParse
                ? '这本已经解析过了，不会重复解析'
                : forceParse
                  ? '会重新调 AI 解析一份新的（上次的结果还在）'
                  : '按 10 个维度解析出世界观'
            }
          >
            {busy === 'parse'
              ? 'AI 正在解析…'
              : doneWv && !forceParse
                ? '✓ 已解析过，不重复解析'
                : forceParse
                  ? '强制重新解析出世界观'
                  : '让 AI 按维度解析出世界观'}
          </button>
          {parseSource === 'book' && !doneWv && (
            <span className="wb-hint">已解析过的作品在列表里会标「已解析 ✓」，选中它不会重复解析。</span>
          )}
        </div>
      )}

      {/* ===== 已保存的世界观列表 ===== */}
      {worldviews.length > 0 && (
        <div className="wv-list">
          {worldviews.map(w => (
            <button
              key={w.id}
              type="button"
              className={`wv-card ${editing?.id === w.id ? 'active' : ''}`}
              onClick={() => {
                setEditing(w)
                setParseOpen(false)
              }}
            >
              <span className="wv-card-name">{w.name}</span>
              <span className={`wv-card-src ${w.source === 'parsed' ? 'parsed' : ''}`}>
                {w.source === 'parsed' ? '解析' : '自由创作'}
              </span>
              <span className="wv-card-meta">
                已填 {filledCount(w)}/{WORLDVIEW_FIELDS.length} 个维度 · 配图{' '}
                {Object.keys(w.images ?? {}).length} 张
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ===== 视图切换（v10.35 地图浏览 / 编辑）===== */}
      {editing && (
        <div className="wv-modebar">
          <button
            className={`wv-modebtn ${viewMode === 'map' ? 'active' : ''}`}
            onClick={() => setViewMode('map')}
            title="像看世界地图一样看这个世界（排版参考地区浏览页）"
          >
            地图浏览
          </button>
          <button
            className={`wv-modebtn ${viewMode === 'edit' ? 'active' : ''}`}
            onClick={() => setViewMode('edit')}
          >
            ✎ 编辑
          </button>
          <span className="wv-modebar-hint">
            {viewMode === 'map'
              ? '点地图上的光点或下面的区域卡片查看；要改内容就切到「编辑」'
              : '每个维度都能单独配图；标题没写也一样能存'}
          </span>
        </div>
      )}

      {/* ===== 地图浏览 ===== */}
      {editing && viewMode === 'map' && (
        <>
          <WorldviewMap wv={editing} imgs={imgs} onEditSection={() => setViewMode('edit')} />
          <div className="wv-editor-actions">
            <button className="primary-btn" onClick={commit}>
              保存世界观
            </button>
            <button className="ghost-btn" onClick={startNovel}>
              以这个世界观开始创作
            </button>
          </div>
        </>
      )}

      {/* ===== 编辑器 ===== */}
      {editing && viewMode === 'edit' && (
        <div className="wv-editor">
          <div className="wv-editor-row">
            <label className="wv-field wv-field-grow">
              <span>世界观名称</span>
              <input
                value={editing.name}
                onChange={e => patch({ name: e.target.value })}
                placeholder="例如：蒸汽之城 维多利亚"
              />
            </label>
            <span className="wv-src-tag">
              {editing.source === 'parsed' ? '来源：从文本解析' : '来源：自由创作'}
            </span>
          </div>

          <label className="wv-field">
            <span>总纲（一句话说清这是个什么样的世界）</span>
            <textarea
              rows={2}
              value={editing.summary}
              onChange={e => patch({ summary: e.target.value })}
              placeholder="例：蒸汽朋克都市，蒸汽机驱动一切，贵族垄断蒸汽核心，底层住在铁锈区。"
            />
          </label>

          {/* 画风 + 封面 */}
          <div className="wv-style">
            <div className="wv-style-head">
              <span>画风（配图会按这个风格来）</span>
              <span className="wv-engine-note">
                配图通道：<b>{imagePaid ? '付费 · 即梦 Seedream（按张扣费）' : '免费（Workers AI 额度）'}</b>
                ，在顶栏引擎按钮切换
              </span>
            </div>
            <div className="wv-style-chips">
              {ART_STYLES.map(s => (
                <button
                  key={s}
                  type="button"
                  className={`wv-chip ${editing.artStyle === s ? 'active' : ''}`}
                  onClick={() => patch({ artStyle: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            <input
              className="wv-save-input"
              value={editing.artStyle}
              onChange={e => patch({ artStyle: e.target.value })}
              placeholder="也可以自己写画风，例如：蒸汽朋克 · 铜色写实 + 广角"
            />
            <div className="wv-cover">
              <button
                className="ghost-btn sm"
                onClick={() =>
                  void genImage(
                    'cover',
                    `${editing.name || '这个世界'} 的整体风貌`,
                    `${editing.summary} ${editing.fields.tone ?? ''} ${editing.fields.geo ?? ''}`,
                  )
                }
                disabled={busy.startsWith('img:')}
              >
                生成封面图
              </button>
              {imgs.cover && (
                <div className="wv-img-wrap">
                  <img src={imgs.cover} alt="封面" />
                  <button className="ghost-btn sm" onClick={() => removeImage('cover')}>
                    移除这张图
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 固定细分维度 */}
          <div className="wv-fields">
            {WORLDVIEW_FIELDS.map(f => {
              const slot = f.key
              const img = imgs[slot]
              return (
                <div key={f.key} className="wv-field-block">
                  <div className="wv-field-block-head">
                    <span className="wv-field-title">{f.title}</span>
                    <span className="wv-field-hint">{f.hint}</span>
                    <button
                      className="ghost-btn sm"
                      onClick={() => void genImage(slot, f.title, editing.fields[f.key] ?? '')}
                      disabled={busy.startsWith('img:') || !(editing.fields[f.key] || '').trim()}
                      title={
                        (editing.fields[f.key] || '').trim()
                          ? `用${imagePaid ? '付费（即梦）' : '免费'}通道生成这一维度的配图`
                          : '先写点内容再配图'
                      }
                    >
                      {busy === `img:${slot}` ? '生成中…' : '配图'}
                    </button>
                  </div>
                  <textarea
                    rows={3}
                    value={editing.fields[f.key] ?? ''}
                    onChange={e => setField(f.key, e.target.value)}
                    placeholder={f.hint}
                  />
                  {img && (
                    <div className="wv-img-wrap">
                      <img src={img} alt={f.title} />
                      <button className="ghost-btn sm" onClick={() => removeImage(slot)}>
                        移除这张图
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* 自定义块 */}
          <div className="wv-sections">
            <div className="wv-sections-head">
              <span>自定义块（可选）</span>
              <button
                className="ghost-btn sm"
                onClick={() => patch({ custom: [...editing.custom, { title: '', content: '' }] })}
              >
                ＋ 加一块
              </button>
            </div>
            <p className="wb-hint">
              标题如果写成 <b>设定 / 人物 / 文笔 / 结构 / 篇幅 / 情节 / 节奏</b>
              ，开始创作时会直接写进对应的画布；其他标题会汇总进【设定】画布。
            </p>
            {editing.custom.map((s, i) => (
              <div key={i} className="wv-section">
                <div className="wv-section-head">
                  <input
                    className="wv-section-title"
                    value={s.title}
                    placeholder="块标题，如：人物"
                    onChange={e => {
                      const custom = editing.custom.map((x, j) =>
                        j === i ? { ...x, title: e.target.value } : x,
                      )
                      patch({ custom })
                    }}
                  />
                  <button
                    className="ghost-btn sm danger"
                    onClick={() => patch({ custom: editing.custom.filter((_, j) => j !== i) })}
                  >
                    删除
                  </button>
                </div>
                <textarea
                  rows={3}
                  value={s.content}
                  onChange={e => {
                    const custom = editing.custom.map((x, j) =>
                      j === i ? { ...x, content: e.target.value } : x,
                    )
                    patch({ custom })
                  }}
                  placeholder="这一块的内容"
                />
              </div>
            ))}
          </div>

          {editing.originNote && <p className="wb-hint">来源：{editing.originNote}</p>}

          <div className="wv-editor-actions">
            <button className="primary-btn" onClick={commit}>
              保存世界观
            </button>
            <button className="ghost-btn" onClick={() => setViewMode('map')}>
              看看地图
            </button>
            <button className="ghost-btn" onClick={startNovel}>
              以这个世界观开始创作
            </button>
            <button
              className="ghost-btn"
              onClick={() => {
                deleteWorldview(editing.id)
                setEditing(null)
                flash('已删除这个世界观')
              }}
            >
              删除
            </button>
          </div>
        </div>
      )}

      {/* ===== 空状态 ===== */}
      {!editing && !parseOpen && worldviews.length === 0 && (
        <div className="wv-empty">
          <p className="wv-empty-title">两条路，随便挑一条：</p>
          <p className="wv-empty-hint">
            <b>① 自由创作</b> —— 点「＋ 空白世界观」，按 10 个细分维度把世界搭细：
            地理与城市规模、建筑与居住、政治制度、基础设施、科技与能源、阶层与经济、交通、
            服饰与日常、禁忌与冲突。<br />
            <b>② 从文本解析</b> —— 点「从文本解析」，选作品库的一本书或贴一段文本，
            AI 按同样的维度拆出来，你再改。<br />
            每个维度都能配一张画风图（默认免费通道，可切到即梦）。存好之后点
            「以这个世界观开始创作」，它就是主干，直接拿去生成小说。
          </p>
        </div>
      )}

      {/* ===== 系列作品（v10.44 WORLD-01）=====
          原方案里「合集」是个独立概念，用户搞不清它和世界观什么关系。
          现在按「一个世界观下挂多本作品」来做 —— 合集就是世界观本身，
          所以这里直接列出「基于这个世界观写的书」。 */}
      {editing && (
        <div className="wv-series">
          <div className="wv-series-head">
            <span>系列作品</span>
            <span className="wb-hint">
              基于这个世界观写的书都挂在这里 —— 下次基于它写新书时，这些作品的设定可以当原料
            </span>
          </div>

          <div className="wv-series-chips">
            {(editing.bookIds ?? []).length ? (
              (editing.bookIds ?? []).map(id => (
                <span key={id} className="wv-mem-chip book">
                  《{bookName(id)}》
                  <button
                    className="wv-mem-x"
                    title="移出这个世界观（作品本身还在作品库）"
                    onClick={() =>
                      patch({
                        bookIds: (editing.bookIds ?? []).filter(x => x !== id),
                      })
                    }
                  >
                    ✕
                  </button>
                </span>
              ))
            ) : (
              <span className="wv-col-meta">（还没挂作品）</span>
            )}
          </div>

          <div className="wv-series-add">
            <select
              className="wv-col-bookpick"
              value={seriesPick}
              onChange={e => setSeriesPick(e.target.value)}
            >
              <option value="">— 选一本已有作品 —</option>
              {library
                .filter(b => !(editing.bookIds ?? []).includes(b.id))
                .map(b => (
                  <option key={b.id} value={b.id}>
                    《{b.title}》
                  </option>
                ))}
            </select>
            <button
              className="ghost-btn sm"
              disabled={!seriesPick}
              onClick={() => {
                if (!seriesPick) return
                const nextIds = [ ...(editing.bookIds ?? []), seriesPick ]
                const wv = { ...editing, bookIds: nextIds, updatedAt: nowIso() }
                saveWorldview(wv)
                setEditing(wv)
                setSeriesPick('')
                flash(`✅ 已把《${bookName(seriesPick)}》挂进「${editing.name}」`)
              }}
            >
              ＋ 挂入这个世界观
            </button>
            <button
              className="ghost-btn sm"
              onClick={() => {
                // 把当前画布/作品库里的书导出为「新世界观」是另一条路；
                // 这里给的是「写完了，回头把这本书归到这个世界观下」
                flash('提示：也可以先在「作品库」打开某本书，用「以这个世界观开始创作」反向关联。')
              }}
              title="关于反向关联的说明"
            >
              ?
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
