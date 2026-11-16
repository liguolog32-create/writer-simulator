import { useState } from 'react'
import { WORLDVIEW_FIELDS } from '../types'
import type { Worldview } from '../types'

/* ============================================================
   世界观 · 地图浏览模式 —— v10.35
   ------------------------------------------------------------
   排版参考英雄联盟「符文之地」地区浏览页的思路（全幅地图 + 区域光点 +
   「大标题 + 一句话定位」+ 点开看详情），但**素材全部是自己生成的**：
   背景用这个世界观的封面图（没生成就用氛围渐变），文字全部来自用户自己填的内容。
   —— 只借鉴版式，不搬任何外部素材。

   10 个维度 = 地图上的 10 个区域：
     · 实心光点 = 已经写了内容
     · 空心光点 = 还没写
   点光点 → 下方详情（大标题 + 定位语 + 正文 + 配图）。
   ============================================================ */

/** 光点在地图上的位置（百分比），刻意排得错落一点，像地图上的据点 */
const PIN_POS: Record<string, { x: number; y: number }> = {
  // v10.37 这里的百分比是相对**光点区**（头部文案之下的那一块），不是整张地图 ——
  // 这样无论世界名/总纲多长，光点都不可能压到标题上（之前就是压着了）。
  tone: { x: 52, y: 11 },
  geo: { x: 19, y: 17 },
  building: { x: 79, y: 13 },
  politics: { x: 37, y: 30 },
  infra: { x: 67, y: 38 },
  tech: { x: 12, y: 45 },
  class: { x: 48, y: 56 },
  traffic: { x: 85, y: 63 },
  daily: { x: 26, y: 75 },
  taboo: { x: 61, y: 88 },
}

/** 从正文里提炼一句「定位语」：取第一句、去掉条目符号，截到 18 字 */
export function taglineOf(text: string, fallback: string) {
  const t = (text || '').replace(/\s+/g, ' ').replace(/^[-·•*\d.、)）\s]+/, '').trim()
  if (!t) return fallback
  const first = t.split(/[。！？；;.!?\n]/)[0].trim() || t
  return first.length > 18 ? `${first.slice(0, 18)}…` : first
}

export function WorldviewMap({
  wv,
  imgs,
  onEditSection,
}: {
  wv: Worldview
  /** 已取回的图片：维度 key / 'cover' → data URL */
  imgs: Record<string, string>
  onEditSection: (key: string) => void
}) {
  const [active, setActive] = useState<string>(() => {
    const firstFilled = WORLDVIEW_FIELDS.find(f => (wv.fields[f.key] || '').trim())
    return firstFilled?.key ?? WORLDVIEW_FIELDS[0].key
  })

  const filled = (k: string) => Boolean((wv.fields[k] || '').trim())
  const activeDef = WORLDVIEW_FIELDS.find(f => f.key === active) ?? WORLDVIEW_FIELDS[0]
  const activeText = (wv.fields[active] || '').trim()
  const activeImg = imgs[active]
  const filledCount = WORLDVIEW_FIELDS.filter(f => filled(f.key)).length

  return (
    <div className="wvm">
      {/* ===== 全幅地图 ===== */}
      <div
        className="wvm-map"
        style={
          imgs.cover
            ? { backgroundImage: `url(${imgs.cover})` }
            : undefined
        }
      >
        <div className="wvm-map-shade" />
        <div className="wvm-map-head">
          <span className="wvm-kicker">世界</span>
          <h3 className="wvm-world-name">{wv.name || '未命名世界'}</h3>
          {wv.summary && <p className="wvm-world-sub">{wv.summary}</p>}
          <div className="wvm-meta-row">
            {wv.artStyle && <span className="wvm-tag">{wv.artStyle}</span>}
            <span className="wvm-tag ghost">
              已铺开 {filledCount}/{WORLDVIEW_FIELDS.length} 个区域
            </span>
            {(wv.bookIds ?? []).length > 0 && (
              <span className="wvm-tag ghost">系列 {(wv.bookIds ?? []).length} 本</span>
            )}
            {Object.keys(wv.images ?? {}).length > 0 && (
              <span className="wvm-tag ghost">配图 {Object.keys(wv.images).length} 张</span>
            )}
          </div>
        </div>

        {/* 区域光点：独立一层，和头部文案互不干涉 */}
        <div className="wvm-pinfield">
        {WORLDVIEW_FIELDS.map(f => {
          const p = PIN_POS[f.key] ?? { x: 50, y: 50 }
          const on = filled(f.key)
          return (
            <button
              key={f.key}
              type="button"
              className={`wvm-pin ${on ? 'on' : 'off'} ${active === f.key ? 'active' : ''} ${
                p.y > 64 ? 'label-above' : ''
              }`}
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
              onClick={() => setActive(f.key)}
              title={on ? f.title : `${f.title}（还没写）`}
            >
              <span className="wvm-pin-dot" />
              <span className="wvm-pin-label">{f.title}</span>
            </button>
          )
        })}

          <div className="wvm-map-hint">点地图上的光点，或下面的区域卡片</div>
        </div>
      </div>

      {/* ===== 区域卡片横排（LoL 那种列表）===== */}
      <div className="wvm-regions">
        {WORLDVIEW_FIELDS.map(f => (
          <button
            key={f.key}
            type="button"
            className={`wvm-region ${active === f.key ? 'active' : ''} ${filled(f.key) ? '' : 'empty'}`}
            onClick={() => setActive(f.key)}
          >
            <span className="wvm-region-name">{f.title}</span>
            <span className="wvm-region-tag">{taglineOf(wv.fields[f.key] || '', f.hint)}</span>
          </button>
        ))}
        {wv.custom.map((c, i) => (
          <div key={`c${i}`} className="wvm-region custom">
            <span className="wvm-region-name">{c.title || '自定义块'}</span>
            <span className="wvm-region-tag">{taglineOf(c.content, '（自定义）')}</span>
          </div>
        ))}
      </div>

      {/* ===== 选中区域的详情 ===== */}
      <div className="wvm-detail">
        <div className="wvm-detail-main">
          <span className="wvm-kicker">区域</span>
          <h3 className="wvm-detail-title">{activeDef.title}</h3>
          <p className="wvm-detail-tag">{taglineOf(activeText, activeDef.hint)}</p>
          {activeText ? (
            <div className="wvm-detail-body">
              {activeText.split('\n').map((line, i) => (
                <p key={i}>{line || '\u00A0'}</p>
              ))}
            </div>
          ) : (
            <p className="wvm-empty-line">
              这个区域还没写。点下面的「去写这一块」，或者让 AI 从你的文本里解析出来。
            </p>
          )}
        </div>
        <div className="wvm-detail-side">
          {activeImg ? (
            <img className="wvm-detail-img" src={activeImg} alt={activeDef.title} />
          ) : (
            <div className="wvm-detail-img placeholder">
              <span>还没有配图</span>
              <span className="wvm-ph-hint">在编辑模式里点「配图」</span>
            </div>
          )}
          <button className="ghost-btn sm" onClick={() => onEditSection(active)}>
            去写这一块
          </button>
        </div>
      </div>
    </div>
  )
}
