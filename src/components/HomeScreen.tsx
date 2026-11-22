import { useApp } from '../store/AppContext'
import type { EntryMode } from '../types'

/* ============================================================
   v10.49 UI-02：首页重设计（编辑感 / 索引式入口，参考 hoverstat.es）
   —— 大字标题 + 眉标分组 + 编号索引行 + hover 微交互；全程不用 emoji
   ============================================================ */

export function HomeScreen({
  onPick,
  onOpenAudit,
}: {
  onPick: (mode: EntryMode) => void
  onOpenAudit: () => void
}) {
  const { state, setRememberMode, platformSettings } = useApp()

  const pick = (mode: EntryMode) => {
    // 「始终默认上次打开模式」：勾了就记下来，下次直接进
    if (state.rememberMode) onPick(mode)
    else onPick(mode)
  }

  const rows: Array<{
    no: string
    name: string
    desc: string
    meta: string
    mode: EntryMode
    tone: string
  }> = [
    {
      no: '01',
      name: '帮我从一句话搭起架子',
      desc: '输入一个脑洞，AI 帮你拆出人物、冲突、章节，自动填好 7 块画布',
      meta: '写脑洞 · 点选择 · 自动长框架 · 开始写',
      mode: 'brain',
      tone: 'violet',
    },
    {
      no: '02',
      name: '直接拆解我的旧稿 / 大纲',
      desc: '粘贴已有文本或思维导图，AI 按 7 个维度拆好，直接进工作台',
      meta: '粘贴文本 · AI 拆解 · 填充画布 · 开始写',
      mode: 'pro',
      tone: 'teal',
    },
    {
      no: '03',
      name: '搭建故事世界的底层设定',
      desc: '先定世界观总纲、力量体系、势力地图，做好系列合集，再写回画布开书',
      meta: '搭世界观 · 写回画布 · 开始创作',
      mode: 'worldview',
      tone: 'gold',
    },
  ]

  return (
    <div className="hp">
      <header className="hp-hero">
        <p className="hp-eyebrow">观澜书房 · Guanlan Study</p>
        <h1 className="hp-title">
          把一个念头，
          <br />
          <em>写成一本书。</em>
        </h1>
        <p className="hp-sub">你想怎么开始？挑一个入口就好。</p>
      </header>

      {/* 站点公告：管理员在「管理后台 → 平台语料 / 设置」里维护，留空则不显示 */}
      {platformSettings?.announcement?.trim() && (
        <p className="hp-notice">{platformSettings.announcement.trim()}</p>
      )}

      <nav className="hp-index">
        <section className="hp-group">
          <p className="hp-label">
            书籍创作<span className="hp-label-line" aria-hidden="true" />
          </p>
          <Row row={rows[0]} onPick={pick} />
          <Row row={rows[1]} onPick={pick} />
        </section>

        <section className="hp-group">
          <p className="hp-label">
            世界观创作<span className="hp-label-line" aria-hidden="true" />
          </p>
          <Row row={rows[2]} onPick={pick} />
        </section>

        <section className="hp-group">
          <p className="hp-label">
            稿件审读<span className="hp-label-line" aria-hidden="true" />
          </p>
          <button className="hp-row tone-gold" onClick={onOpenAudit}>
            <span className="hp-no">04</span>
            <span className="hp-main">
              <span className="hp-name">用评判流程审读整本小说</span>
              <span className="hp-desc">按版本契约 → R0 叙事构成 → R1 因果 → R2 读者 → R3 表达 → 综合判定，逐条落到原文证据</span>
              <span className="hp-meta">六步流程 · 四层诊断 · 对白与段落可量化 · 问题分级 · 一键生成报告</span>
            </span>
            <span className="hp-arrow" aria-hidden="true">→</span>
          </button>
        </section>
      </nav>

      <div className="hp-remember">
        <label className="hp-remember-label">
          <input
            type="checkbox"
            checked={Boolean(state.rememberMode)}
            onChange={e => setRememberMode(e.target.checked)}
          />
          记住我的选择，下次打开直接开始
        </label>
        {state.rememberMode && state.lastMode && (
          <p className="hp-remember-note">
            已记住：
            {state.lastMode === 'brain'
              ? '从一句话搭起架子'
              : state.lastMode === 'worldview'
                ? '搭建世界观'
                : '拆解旧稿'}
            ，下次打开会自动进入。想换回来，点工作台左上角的「首页」。
          </p>
        )}
      </div>
    </div>
  )
}

/* 索引行：编号 / 主体（名·述·径）/ 箭头 */
function Row({
  row,
  onPick,
}: {
  row: { no: string; name: string; desc: string; meta: string; mode: EntryMode; tone: string }
  onPick: (m: EntryMode) => void
}) {
  return (
    <button className={`hp-row tone-${row.tone}`} onClick={() => onPick(row.mode)}>
      <span className="hp-no">{row.no}</span>
      <span className="hp-main">
        <span className="hp-name">{row.name}</span>
        <span className="hp-desc">{row.desc}</span>
        <span className="hp-meta">{row.meta}</span>
      </span>
      <span className="hp-arrow" aria-hidden="true">
        →
      </span>
    </button>
  )
}
