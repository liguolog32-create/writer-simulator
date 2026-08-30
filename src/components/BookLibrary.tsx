import { useState } from 'react'

const MALE = [
  '偏执病娇', '斯文败类', '闷骚爱吃醋', '病娇深情', '强大深情',
  '痞帅深情', '偏执占有欲', '偏执腹黑', '霸气腹黑', '忠犬痴汉',
  '高岭之花', '傲娇口嫌体正直', '温柔深情', '禁欲医生', '糙汉',
  '将军', '帝王权臣', '有权谋有手段', '超会撩', '爱吃醋',
]
const TOPIC = [
  '破镜重圆甜宠', '先婚后爱', '先婚后爱甜', '相爱相杀', '相爱相杀日久生情',
  '双初恋久别重逢', '伪兄妹', '互宠互撩', '前期不爱后期打脸', '古言婚后甜',
  '军旅', '仙侠', '重生救赎', '妖女女主 vs 正道男主',
]
const FEMALE = ['美艳心机', '人美路子野', '古言软萌', '清冷男主 × 活泼女主', '美艳女主 × 忠犬男主']
const AUTHOR = [
  '墨宝非宝', '尾鱼', '这碗粥', '蓬莱客', '凝陇', '明月像饼',
  '金丙', '耳东兔子', '六盲星', '青青绿萝裙', '北倾', '宝珠鬼话',
]

export function BookLibrary() {
  const [q, setQ] = useState('')
  const match = (s: string) => !q.trim() || s.includes(q.trim())
  return (
    <section className="library">
      <header className="library-head">
        <div>
          <h2>书库类型</h2>
          <p>当前素材库已覆盖的题材、人设与作者</p>
        </div>
        <div className="library-stats">
          <div>
            <span className="stat-num">51</span>
            <span className="stat-label">分类</span>
          </div>
          <div>
            <span className="stat-num">262</span>
            <span className="stat-label">本数(估)</span>
          </div>
          <div>
            <span className="stat-num">183</span>
            <span className="stat-label">MB</span>
          </div>
        </div>
        <input
          className="library-search"
          placeholder="筛选类型…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </header>
      <div className="library-body">
        <Group title="男主人设" items={MALE} match={match} />
        <Group title="题材剧情" items={TOPIC} match={match} />
        <Group title="女主人设" items={FEMALE} match={match} />
        <Group title="作者作品集" items={AUTHOR} match={match} />
      </div>
    </section>
  )
}

function Group({
  title,
  items,
  match,
}: {
  title: string
  items: string[]
  match: (s: string) => boolean
}) {
  const visible = items.filter(match)
  return (
    <div className="library-group">
      <h3>
        {title} <span className="group-count">{visible.length}</span>
      </h3>
      <div className="chip-row">
        {visible.map(s => (
          <span key={s} className="chip">
            {s}
          </span>
        ))}
        {visible.length === 0 && <span className="chip-empty">无匹配</span>}
      </div>
    </div>
  )
}
