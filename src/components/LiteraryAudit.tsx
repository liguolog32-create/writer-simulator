import { useMemo, useState } from 'react'
import { useApp } from '../store/AppContext'

/* ============================================================
   文学审读 · 评判流程模板 v1.0
   源自《后台（全本）》575 页全书审读沉淀：
   01 版本契约 → 02 R1 因果结构 → 03 R2 读者体验 → 04 R3 表达诊断 → 05 综合判定
   本组件自带样式，不依赖全局 CSS 改动。
   ============================================================ */

type StageKey = 'r0' | 'r1' | 'r2' | 'r3' | 'other'
type Level = '阻断' | '重大' | '一般'
type Verdict = '通过' | '有条件通过' | '不通过'

const FLOW_STEPS: Array<{ no: string; name: string; sub: string; desc: string; color: string }> = [
  {
    no: '01',
    name: '版本与阅读契约',
    sub: '先说清「评的是哪一版」',
    desc: '版本来源 · 字数范围 · 完结状态 · 体裁预期 · 判定口径',
    color: '#b3a8f5',
  },
  {
    no: '02',
    name: 'R0 叙事构成与节奏',
    sub: '文本长什么样',
    desc: '对白占比 · 段落结构 · 场景实感 · 动作密度 · 推进率 · 节奏变化',
    color: '#f0a3c8',
  },
  {
    no: '03',
    name: 'R1 因果与结构',
    sub: '故事能不能立住',
    desc: '目标 → 压力 → 选择 → 代价 → 后果；时间线 / 履历 / 账目 / 伏笔',
    color: '#f09595',
  },
  {
    no: '04',
    name: 'R2 读者体验模拟',
    sub: '读者会不会往下读',
    desc: '续读点 · 跳读点 · 困惑点 · 不信点 · 情绪兑现',
    color: '#8ab4f8',
  },
  {
    no: '05',
    name: 'R3 表达诊断',
    sub: '文字会不会劝退',
    desc: '声纹塌缩 · 重复问答 · 格言化对白 · 解释旁白 · 意象系统',
    color: '#5dcaa5',
  },
  {
    no: '06',
    name: '综合判定与修订顺序',
    sub: '给结论，不给空话',
    desc: '通过 / 有条件通过 / 不通过 · 问题分级 · 保护原稿清单',
    color: '#e8c878',
  },
]

const CHECK_GROUPS: Array<{ key: StageKey; title: string; hint: string; items: string[] }> = [
  {
    key: 'r0',
    title: 'R0 · 叙事构成与节奏',
    hint: '先测「文本长什么样」——这是小说还是对话速记。第 1–2 项可脚本量化，其余回到原文读。',
    items: [
      '对白占比：对白字数 ÷ 总字数。<45% 偏叙述，45–60% 均衡，>60% 只剩对话在动',
      '短段占比：≤25 字段落 ÷ 总段落。>85% 意味着全书没有长段落，读感像聊天记录',
      '连续短段串：连续 5 段以上全是单行对白 / 单句，是流水账高发区，需用动作 / 场景 / 心理打断',
      '场景实感：每章至少一处「空间-时间-感官」落点（房间什么样、几点、什么味道）',
      '动作密度：人物不能只「说」，还要有「做」（起身、停顿、转头、摸东西）',
      '事件推进率：每章结尾人物处境 / 关系 / 目标有不可逆变化；没有的是「过场章」',
      '节奏变化：长段与短段交替出现；连续快节奏后有没有「慢下来」的章',
    ],
  },
  {
    key: 'r1',
    title: 'R1 · 因果与结构',
    hint: '逐章追问「谁要什么、谁在拦、选了什么、付了什么代价」，再做全书账目复核。',
    items: [
      '每章是否能回答：人物目标 / 外部压力 / 关键选择 / 代价 / 后果',
      '时间线：季节、时长、日期、事件先后是否自洽（含关键行动的时间锚点）',
      '人物履历：职业经历、婚姻状态、家庭关系在全书是否前后一致',
      '财务与经营账目：金额、比例、对赌条款、债务、销量是否唯一且可追溯',
      '伏笔兑现：关键道具是否埋得下、收得回，不在后文被悄悄重置',
      '场景因果：危机是否由前文行为引出，而非作者强行安排',
    ],
  },
  {
    key: 'r2',
    title: 'R2 · 读者体验模拟',
    hint: '用「第一遍读」的状态走一遍，记录身体反应，不替作者辩护。',
    items: [
      '续读点：每章结尾是否有明确悬念或情绪钩',
      '跳读点：哪些段落会被略过（解释性旁白、重复复盘、过细流程）',
      '困惑点：动机 / 身份 / 关系是否要二次回想才明白',
      '不信点：哪些桥段超出人物能力或行业常识，令人出戏',
      '情绪兑现：铺垫的情绪是否在关键场景释放，还是被解释掉',
    ],
  },
  {
    key: 'r3',
    title: 'R3 · 表达诊断',
    hint: '抽样统计高频句式，再回到具体段落判断「这句话只属于这个人吗」。',
    items: [
      '声纹：主要人物对白能否盲辨；是否存在互换也成立的「通用腔」',
      '重复问答：以「为什么 / 嗯 / 我知道 / 没有说话 / 看了很久」起句的模板频率',
      '格言化：人物是否都在说金句而不是说人话',
      '解释旁白：是否用叙述替代了动作与场景',
      '意象系统：核心意象是否贯穿全书并在结尾收束',
    ],
  },
]

const LEVEL_ORDER: Level[] = ['阻断', '重大', '一般']

interface Issue {
  id: string
  stage: StageKey
  level: Level
  place: string
  problem: string
  evidence: string
  fix: string
}

const emptyIssue = (): Issue => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  stage: 'r1',
  level: '重大',
  place: '',
  problem: '',
  evidence: '',
  fix: '',
})

const SAMPLE: {
  work: string
  version: string
  contract: string
  r0: string
  r1: string
  r2: string
  r3: string
  issues: Issue[]
  verdict: Verdict
  protect: string
  priority: string
} = {
  work: '后台（全本）',
  version: '全本四卷 100 章 · PDF 575 页 · 含后记（终审稿）',
  contract:
    '体裁：直播电商行业现实主义 + 婚姻伦理。判定口径：全书级连续性与账目硬伤为零方可通过；仅作文本编辑判断，不涉及出版/市场价值。',
  r0:
    '实测：对白占比 52.8%（卷一 49.7% → 卷四 61.1%，越往后越靠对话推进）；短段（≤25 字）占比 91.0%，全书平均段长 11.7 字，每章约 182 段。诊断：问题不在「对话太多」（52.8% 在网文里属正常区间），而在「段落碎」——几乎没有长段落承载场景与动作，读感像聊天记录。修法不是删对话，而是把连续短段串合并、在长段落里补回空间 / 时间 / 物件与身体动作。',
  r1:
    '主线「起号—登顶—退位—结账」完整，人物目标与代价链清楚。终审不通过的根因是全书级连续性：补量时间与总量冲突、江野履历重置、离婚状态冲突、对赌与和解金额（2000 万 / 2400 万）冲突、核心经营数字冲突、监控与电梯细节矛盾。',
  r2:
    '开篇机房与首次补量是强续读点；女儿的画、听证会「不后悔做，后悔留了记录」是情绪兑现点。中后段多次危机同构复现，读者会跳读；解释性旁白提前说破动机，削弱结尾余味。',
  r3:
    '高度模板化：抽样统计「没有说话」约 234 处、「嗯。」约 466 处、「我知道。」约 201 处、「为什么」起句约 207 处、「看了很久」约 57 处。主要人物声纹互相置换仍成立，需做声纹精修。',
  issues: [
    {
      id: 's0',
      stage: 'r0',
      level: '重大',
      place: '全书，卷四最集中',
      problem: '段落碎、无长段落承载场景与动作，读感像对话速记',
      evidence: '短段（≤25 字）占比 91.0%，平均段长 11.7 字，每章约 182 段；卷四对白占比 61.1%',
      fix: '把连续 5 段以上的单行对白合并、穿插身体动作与环境落点；为每章补一处「空间-时间-感官」场景锚点',
    },
    {
      id: 's1',
      stage: 'r1',
      level: '阻断',
      place: '全书 · 补量相关章节',
      problem: '补量发生时间与累计总量互相冲突',
      evidence: '同一指标在不同卷出现两套时间锚点与总量口径',
      fix: '建立唯一时间线表与口径表，全文按表回改',
    },
    {
      id: 's2',
      stage: 'r1',
      level: '阻断',
      place: '江野出场章节',
      problem: '人物履历被重置',
      evidence: '前后卷对同一人物职业经历叙述不一致',
      fix: '建唯一人物年表，锁定后不再改动',
    },
    {
      id: 's3',
      stage: 'r1',
      level: '阻断',
      place: '婚姻线',
      problem: '离婚状态冲突',
      evidence: '同一时间段既写已离婚又写未离婚',
      fix: '建关系状态表，标出生效时间点',
    },
    {
      id: 's4',
      stage: 'r1',
      level: '重大',
      place: '对赌 / 和解段落',
      problem: '金额 2000 万与 2400 万冲突',
      evidence: '同一笔款项在不同章节用两个数字',
      fix: '建财务总账，金额、比例、条款唯一化',
    },
    {
      id: 's5',
      stage: 'r3',
      level: '重大',
      place: '全书对白',
      problem: '极简问答与解释旁白高频重复',
      evidence: '「嗯」「我知道」「没有说话」等句式数百处',
      fix: '按人物重写声纹卡，删解释旁白，保留必要停顿',
    },
  ],
  verdict: '不通过',
  protect:
    '开篇机房；首次补量；听证中「不后悔做，后悔留了记录」；女儿的画；结尾「三十公分」露脸与前后台换位；U 盘白痕与手部意象。以上场景只做连续性对齐，不重写。',
  priority:
    'P0 建唯一年表 / 时间线 / 关系状态表 / 财务总账 / 场景道具表 → P1 合并重复危机、清理解释旁白 → P2 声纹精修与结尾余味回收。',
}

function stageLabel(k: StageKey) {
  return k === 'r0'
    ? 'R0 叙事构成'
    : k === 'r1'
      ? 'R1 因果结构'
      : k === 'r2'
        ? 'R2 读者体验'
        : k === 'r3'
          ? 'R3 表达诊断'
          : '其他'
}

export function LiteraryAudit() {
  const { state } = useApp()
  /** 账号作品库：审读对象优先从这里选，避免手输书名和实际作品对不上 */
  const books = state.library ?? []
  const [work, setWork] = useState('')
  const [version, setVersion] = useState('')
  const [contract, setContract] = useState('')
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [r0, setR0] = useState('')
  const [r1, setR1] = useState('')
  const [r2, setR2] = useState('')
  const [r3, setR3] = useState('')
  const [issues, setIssues] = useState<Issue[]>([])
  const [verdict, setVerdict] = useState<Verdict>('不通过')
  const [protect, setProtect] = useState('')
  const [priority, setPriority] = useState('')
  const [report, setReport] = useState('')
  const [copied, setCopied] = useState(false)

  const checkedCount = useMemo(
    () => Object.values(checks).filter(Boolean).length,
    [checks],
  )
  const totalChecks = CHECK_GROUPS.reduce((n, g) => n + g.items.length, 0)

  const toggle = (k: string) => setChecks(prev => ({ ...prev, [k]: !prev[k] }))

  /** 从作品库选一本：自动带出书名，并按书的实际章数/字数把「版本范围」填好 */
  const pickBook = (id: string) => {
    const b = books.find(x => x.id === id)
    if (!b) return
    setWork(b.title)
    const chapters = b.outline?.length || b.stats?.chapters || 0
    const words = b.stats?.totalWords || 0
    const written = Object.keys(b.chapterWritings ?? {}).length
    const seg: string[] = []
    if (chapters) seg.push(`共 ${chapters} 章`)
    if (words) seg.push(`约 ${(words / 10000).toFixed(1)} 万字`)
    if (written) seg.push(`已写正文 ${written} 章`)
    if (seg.length) setVersion(seg.join(' · '))
    setReport('')
  }

  const loadSample = () => {
    setWork(SAMPLE.work)
    setVersion(SAMPLE.version)
    setContract(SAMPLE.contract)
    setR0(SAMPLE.r0)
    setR1(SAMPLE.r1)
    setR2(SAMPLE.r2)
    setR3(SAMPLE.r3)
    setIssues(SAMPLE.issues.map(i => ({ ...i })))
    setVerdict(SAMPLE.verdict)
    setProtect(SAMPLE.protect)
    setPriority(SAMPLE.priority)
    setChecks({})
    setReport('')
  }

  const clearAll = () => {
    setWork('')
    setVersion('')
    setContract('')
    setChecks({})
    setR0('')
    setR1('')
    setR2('')
    setR3('')
    setIssues([])
    setVerdict('不通过')
    setProtect('')
    setPriority('')
    setReport('')
  }

  const updateIssue = (id: string, patch: Partial<Issue>) =>
    setIssues(prev => prev.map(i => (i.id === id ? { ...i, ...patch } : i)))

  const generate = () => {
    const lines: string[] = []
    lines.push(`# 文学审读报告 · ${work.trim() || '未命名作品'}`)
    lines.push('')
    lines.push('## 01 版本与阅读契约')
    lines.push(`- 版本范围：${version.trim() || '（未填写）'}`)
    lines.push(`- 阅读契约：${contract.trim() || '（未填写）'}`)
    lines.push(`- 检查项完成：${checkedCount} / ${totalChecks}`)
    lines.push('')
    lines.push('## 02 R0 · 叙事构成与节奏')
    lines.push(r0.trim() || '（未填写）')
    lines.push('')
    lines.push('## 03 R1 · 因果与结构')
    lines.push(r1.trim() || '（未填写）')
    lines.push('')
    lines.push('## 04 R2 · 读者体验模拟')
    lines.push(r2.trim() || '（未填写）')
    lines.push('')
    lines.push('## 05 R3 · 表达诊断')
    lines.push(r3.trim() || '（未填写）')
    lines.push('')
    lines.push('## 06 问题清单（按级别排序）')
    if (!issues.length) {
      lines.push('（暂无记录）')
    } else {
      const sorted = [...issues].sort(
        (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level),
      )
      sorted.forEach((it, idx) => {
        lines.push('')
        lines.push(`### ${idx + 1}. [${it.level}] ${it.problem || '（未命名问题）'}`)
        lines.push(`- 环节：${stageLabel(it.stage)}`)
        lines.push(`- 位置：${it.place || '（未填写）'}`)
        lines.push(`- 证据：${it.evidence || '（未填写）'}`)
        lines.push(`- 建议：${it.fix || '（未填写）'}`)
      })
    }
    lines.push('')
    lines.push('## 综合判定')
    lines.push(`**${verdict}**`)
    lines.push('')
    lines.push('## 保护原稿清单')
    lines.push(protect.trim() || '（未填写）')
    lines.push('')
    lines.push('## 修订顺序')
    lines.push(priority.trim() || '（未填写）')
    setReport(lines.join('\n'))
  }

  const copyReport = async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      const ta = document.getElementById('la-report-text') as HTMLTextAreaElement | null
      ta?.select()
    }
  }

  return (
    <div className="la-root">
      <style>{LA_CSS}</style>

      <header className="la-hero">
        <p className="la-eyebrow">观澜书房 · 文学审读</p>
        <h1 className="la-title">把「好小说」拆成可复核的六步</h1>
        <p className="la-sub">
          这不是打分表，是一条审读流水线：先锁定版本契约，再测文本长什么样（叙事构成与节奏），然后依次过因果、读者体验、表达三层，最后给判定和修订顺序。每一条结论都要能回到原文证据。
        </p>
        <div className="la-hero-actions">
          <button className="la-btn primary" onClick={loadSample}>
            载入《后台》审读示例
          </button>
          <button className="la-btn ghost" onClick={clearAll}>
            清空
          </button>
        </div>
      </header>

      <section className="la-section">
        <h2 className="la-h2"><span className="la-h2-no">流程</span>评判流程图</h2>
        <div className="la-flow">
          {FLOW_STEPS.map((s, i) => (
            <div className="la-flow-wrap" key={s.no}>
              <div className="la-flow-card" style={{ borderTopColor: s.color }}>
                <span className="la-flow-no" style={{ color: s.color }}>{s.no}</span>
                <h3>{s.name}</h3>
                <p className="la-flow-sub">{s.sub}</p>
                <p className="la-flow-desc">{s.desc}</p>
              </div>
              {i < FLOW_STEPS.length - 1 && (
                <span className="la-flow-arrow" aria-hidden="true">→</span>
              )}
            </div>
          ))}
        </div>
        <p className="la-note">
          判定规则：R0 失衡（段落碎到没有长段落 / 对白占比超 60%）→ 至少「有条件通过」，先补场景与动作；R1 不过（存在全书级连续性硬伤）→ 直接「不通过」，先修账目与时间线；R1 过而 R0/R2/R3 有局部问题 → 「有条件通过」；四层均无明显硬伤 → 「通过」。
        </p>
      </section>

      <section className="la-section">
        <h2 className="la-h2">
          <span className="la-h2-no">01</span>版本与阅读契约
        </h2>
        <div className="la-grid3">
          <div className="la-field">
            <span>作品名</span>
            <input
              value={work}
              onChange={e => setWork(e.target.value)}
              placeholder="例：后台（全本）"
              aria-label="作品名"
            />
            {books.length > 0 ? (
              <select
                className="la-bookpick"
                value=""
                onChange={e => pickBook(e.target.value)}
                title="从账号作品库选择审读对象，会自动带出章数与字数"
                aria-label="从作品库选择作品"
              >
                <option value="">从作品库选择（{books.length} 本）</option>
                {books.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            ) : (
              <span className="la-hint-sm">作品库暂无作品，可直接手输书名</span>
            )}
          </div>
          <label className="la-field">
            <span>版本范围</span>
            <input value={version} onChange={e => setVersion(e.target.value)} placeholder="例：四卷 100 章 / PDF 575 页" />
          </label>
          <label className="la-field">
            <span>判定结论</span>
            <select value={verdict} onChange={e => setVerdict(e.target.value as Verdict)}>
              <option>通过</option>
              <option>有条件通过</option>
              <option>不通过</option>
            </select>
          </label>
        </div>
        <label className="la-field">
          <span>阅读契约（体裁预期 + 判定口径）</span>
          <textarea rows={3} value={contract} onChange={e => setContract(e.target.value)} placeholder="这次评审按什么标准、什么版本、什么范围；哪些不在评价范围内" />
        </label>
      </section>

      <section className="la-section">
        <h2 className="la-h2">
          <span className="la-h2-no">02–05</span>四层检查清单
          <span className="la-progress">{checkedCount} / {totalChecks}</span>
        </h2>
        <div className="la-check-grid">
          {CHECK_GROUPS.map(g => (
            <div className="la-check-card" key={g.key}>
              <h3>{g.title}</h3>
              <p className="la-check-hint">{g.hint}</p>
              <ul>
                {g.items.map((item, i) => {
                  const k = `${g.key}-${i}`
                  return (
                    <li key={k}>
                      <label>
                        <input type="checkbox" checked={Boolean(checks[k])} onChange={() => toggle(k)} />
                        <span>{item}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="la-grid2 la-findings">
          <label className="la-field">
            <span>R0 结论</span>
            <textarea rows={5} value={r0} onChange={e => setR0(e.target.value)} placeholder="对白占比 / 段落结构 / 连续短段串 / 场景实感 / 动作密度 / 推进率 / 节奏变化" />
          </label>
          <label className="la-field">
            <span>R1 结论</span>
            <textarea rows={5} value={r1} onChange={e => setR1(e.target.value)} placeholder="因果链是否成立；时间线 / 履历 / 账目 / 伏笔的具体冲突" />
          </label>
          <label className="la-field">
            <span>R2 结论</span>
            <textarea rows={5} value={r2} onChange={e => setR2(e.target.value)} placeholder="续读点 / 跳读点 / 困惑点 / 不信点 / 情绪兑现" />
          </label>
          <label className="la-field">
            <span>R3 结论</span>
            <textarea rows={5} value={r3} onChange={e => setR3(e.target.value)} placeholder="声纹 / 重复句式 / 格言化 / 解释旁白 / 意象系统" />
          </label>
        </div>
      </section>

      <section className="la-section">
        <h2 className="la-h2"><span className="la-h2-no">06</span>问题清单</h2>
        <p className="la-section-note">每条问题必须落到「位置 + 证据 + 建议」，否则不算审读结论。</p>
        <div className="la-issues">
          {issues.map((it, idx) => (
            <div className="la-issue" key={it.id}>
              <div className="la-issue-head">
                <span className="la-issue-no">{String(idx + 1).padStart(2, '0')}</span>
                <select value={it.level} onChange={e => updateIssue(it.id, { level: e.target.value as Level })}>
                  {LEVEL_ORDER.map(l => <option key={l}>{l}</option>)}
                </select>
                <select value={it.stage} onChange={e => updateIssue(it.id, { stage: e.target.value as StageKey })}>
                  <option value="r0">R0 叙事构成</option>
                  <option value="r1">R1 因果结构</option>
                  <option value="r2">R2 读者体验</option>
                  <option value="r3">R3 表达诊断</option>
                  <option value="other">其他</option>
                </select>
                <input
                  className="la-issue-title"
                  value={it.problem}
                  onChange={e => updateIssue(it.id, { problem: e.target.value })}
                  placeholder="一句话说清问题"
                />
                <button className="la-btn tiny" onClick={() => setIssues(prev => prev.filter(x => x.id !== it.id))}>删</button>
              </div>
              <div className="la-issue-body">
                <input value={it.place} onChange={e => updateIssue(it.id, { place: e.target.value })} placeholder="位置（章节 / 页码）" />
                <input value={it.evidence} onChange={e => updateIssue(it.id, { evidence: e.target.value })} placeholder="原文证据" />
                <input value={it.fix} onChange={e => updateIssue(it.id, { fix: e.target.value })} placeholder="修订建议" />
              </div>
            </div>
          ))}
          <button className="la-btn ghost la-add" onClick={() => setIssues(prev => [...prev, emptyIssue()])}>
            + 添加一条问题
          </button>
        </div>
      </section>

      <section className="la-section">
        <h2 className="la-h2"><span className="la-h2-no">终</span>保护原稿与修订顺序</h2>
        <div className="la-grid2">
          <label className="la-field">
            <span>保护原稿清单（只对齐连续性，不重写）</span>
            <textarea rows={5} value={protect} onChange={e => setProtect(e.target.value)} placeholder="开篇、关键场景、结尾意象……" />
          </label>
          <label className="la-field">
            <span>修订顺序（P0 / P1 / P2）</span>
            <textarea rows={5} value={priority} onChange={e => setPriority(e.target.value)} placeholder="先建唯一年表 / 账目表，再合并重复危机，最后做声纹精修" />
          </label>
        </div>
      </section>

      <section className="la-section la-report-section">
        <div className="la-report-head">
          <h2 className="la-h2"><span className="la-h2-no">出</span>审读报告</h2>
          <div className="la-report-actions">
            <button className="la-btn primary" onClick={generate}>生成 Markdown 报告</button>
            <button className="la-btn ghost" onClick={copyReport} disabled={!report}>
              {copied ? '已复制' : '复制报告'}
            </button>
          </div>
        </div>
        <textarea id="la-report-text" className="la-report" rows={18} value={report} readOnly placeholder="填完上面的内容后点「生成 Markdown 报告」，结果会出现在这里，可直接复制。" />
      </section>
    </div>
  )
}

const LA_CSS = `
.la-root{--la-accent:#f09595;--la-accent-2:#afa9ec;--la-line:rgba(255,255,255,.10);--la-ink:#d3d1c7;--la-mute:#9a9892;
  background:#1a1a1a;color:var(--la-ink);padding:28px clamp(16px,4vw,56px) 80px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7}
.la-root *{box-sizing:border-box}
.la-hero{border-bottom:1px solid var(--la-line);padding-bottom:26px;margin-bottom:30px}
.la-eyebrow{margin:0 0 10px;font-size:12px;letter-spacing:.22em;color:var(--la-accent);font-weight:700}
.la-title{margin:0 0 12px;font-family:Georgia,"Songti SC",serif;font-size:clamp(26px,3.4vw,40px);font-weight:600;letter-spacing:.01em;color:#e8e6dc}
.la-sub{margin:0;max-width:820px;color:var(--la-mute);font-size:15px}
.la-hero-actions{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
.la-section{margin:0 0 38px}
.la-h2{display:flex;align-items:center;gap:12px;margin:0 0 16px;font-size:18px;font-weight:600;font-family:Georgia,"Songti SC",serif;color:#e8e6dc}
.la-h2-no{font-family:Georgia,serif;font-size:12px;letter-spacing:.12em;color:#1a1a1a;background:var(--la-accent);padding:3px 9px;border-radius:2px;font-weight:700}
.la-progress{margin-left:auto;font-family:Georgia,serif;font-size:13px;color:var(--la-mute);font-weight:400}
.la-section-note{margin:-8px 0 16px;color:var(--la-mute);font-size:13px}
.la-flow{display:flex;align-items:stretch;gap:0;overflow-x:auto;padding:4px 2px 12px}
.la-flow-wrap{display:flex;align-items:center;flex:1;min-width:190px}
.la-flow-card{background:#232220;border:1px solid var(--la-line);border-top:3px solid var(--la-accent);border-radius:6px;padding:14px 14px 16px;height:100%;flex:1}
.la-flow-no{font-family:Georgia,serif;font-size:13px;font-weight:700;letter-spacing:.1em}
.la-flow-card h3{margin:6px 0 4px;font-size:15px;font-weight:600;color:#e8e6dc}
.la-flow-sub{margin:0 0 10px;font-size:12px;color:var(--la-accent)}
.la-flow-desc{margin:0;font-size:12px;color:var(--la-mute);line-height:1.6}
.la-flow-arrow{flex:0 0 24px;text-align:center;color:#5f5e5a;font-size:18px}
.la-note{margin:12px 0 0;padding:12px 16px;background:#232220;border-left:3px solid var(--la-accent);font-size:13px;color:var(--la-ink)}
.la-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px;align-items:start}
.la-bookpick{margin-top:2px;cursor:pointer}
.la-hint-sm{font-size:11.5px;color:var(--la-mute);line-height:1.5}
.la-grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.la-field{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--la-mute)}
.la-field>span{font-weight:600;color:var(--la-ink)}
.la-root input,.la-root textarea,.la-root select{width:100%;border:1px solid var(--border,rgba(255,255,255,.10));background:#232220;border-radius:6px;padding:9px 11px;color:var(--la-ink);font-family:inherit;font-size:13px;outline:none}
.la-root input:focus,.la-root textarea:focus,.la-root select:focus{border-color:var(--la-accent);box-shadow:0 0 0 2px rgba(240,149,149,.10)}
.la-root textarea{resize:vertical;line-height:1.65}
.la-check-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:16px}
.la-check-card{background:#232220;border:1px solid var(--la-line);border-radius:6px;padding:16px}
.la-check-card h3{margin:0 0 6px;font-size:15px;color:#e8e6dc}
.la-check-hint{margin:0 0 12px;font-size:12px;color:var(--la-mute);line-height:1.6}
.la-check-card ul{margin:0;padding:0;list-style:none}
.la-check-card li{margin-bottom:8px}
.la-check-card label{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--la-ink);cursor:pointer}
.la-check-card input[type=checkbox]{width:15px;height:15px;flex:0 0 15px;margin:2px 0 0;accent-color:var(--la-accent)}
.la-issues{display:flex;flex-direction:column;gap:10px}
.la-issue{background:#232220;border:1px solid var(--la-line);border-radius:6px;padding:12px 14px}
.la-issue-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.la-issue-no{font-family:Georgia,serif;color:var(--la-accent);font-weight:700;font-size:13px}
.la-issue-head select{width:100px}
.la-issue-title{flex:1;min-width:180px}
.la-issue-body{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}
.la-btn{border-radius:6px;padding:8px 15px;font-size:13px;cursor:pointer;font-family:inherit;border:1px solid transparent;transition:.15s}
.la-btn.primary{background:var(--la-accent);color:#1a1a1a;font-weight:600}
.la-btn.primary:hover{background:#ffaaaa}
.la-btn.ghost{background:#232220;border-color:var(--border,rgba(255,255,255,.10));color:var(--la-ink)}
.la-btn.ghost:hover{border-color:var(--la-accent);color:var(--la-accent)}
.la-btn.tiny{padding:5px 10px;font-size:12px;background:#232220;border-color:var(--border,rgba(255,255,255,.10));color:var(--la-mute)}
.la-btn.tiny:hover{border-color:var(--la-accent);color:var(--la-accent)}
.la-btn:disabled{opacity:.45;cursor:not-allowed}
.la-add{align-self:flex-start}
.la-report-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.la-report-actions{display:flex;gap:8px}
.la-report{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:12.5px;background:#232220}
@media(max-width:900px){.la-grid3,.la-check-grid,.la-grid2,.la-issue-body{grid-template-columns:1fr}}
`
