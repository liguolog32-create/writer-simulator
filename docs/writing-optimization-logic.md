# 观澜书房 · 写作优化逻辑设计（v1.0）

> 目标：把「单次生成」升级为「可度量、可诊断、可迭代」的写作优化系统。优化逻辑不依赖模型换代，而是围绕 7 画布、章节精修、用户反馈三套数据源持续打磨产出质量。

---

## 1. 设计目标

1. **可解释**：每次优化必须告诉用户「改了什么、为什么改、依据哪条规则」。
2. **可控**：用户可锁定任意画布/章节/设定，优化逻辑不得触碰锁定区。
3. **可累积**：用户的「点赞/踩/手动改」要反向训练平台级偏好模型与个人权重。
4. **可嵌入**：优化逻辑必须能插入现有 7 画布 → 生成大纲 → 精修章节 → 续写 的任意节点。

---

## 2. 整体架构：三层一循环

```
输入层 (Input Parser)
    ↓
评估层 (Scoring Engine) ──→ 七维评分 + 综合健康度
    ↓
诊断层 (Diagnosis Engine) ──→ 问题定位 + 优先级排序
    ↓
优化层 (Rewrite Engine) ──→ 精修 / 扩写 / 删繁 / 重排
    ↓
训练层 (Feedback Loop) ──→ 用户反馈 → weight_log / case_library → 下一次评估校准
```

---

## 3. 输入层：把离散素材压成结构化上下文

### 3.1 输入来源

| 来源 | 数据形态 | 作用 |
|---|---|---|
| 7 画布 | `Record<dimension, Canvas>` | 设定、人物、文笔、结构、篇幅、情节、节奏 |
| 作品库 | `SavedBook[]` | 已生成的大纲、样章、精修章节 |
| 项目资产 | `AssetBundle` | 原子设定、剧情分支、版本快照 |
| 平台语料 | `BookMeta` | 平台提供的风格参照与成功案例 |
| 用户反馈 | weight_log / 点赞 / 手动改写 | 训练信号 |

### 3.2 向量化摘要（给模型看的 prompt 块）

把任意长文本按「功能块」切片，每块生成 3 元组：

```ts
interface TextChunk {
  role: 'setting' | 'character' | 'plot' | 'style' | 'rhythm' | 'scene'
  span: { start: number; end: number }  // 字符区间
  summary: string                        // 30 字以内
  entities: string[]                     // 本段出现的人/地/物/势力
}
```

实现函数 `segmentStory(text: string): TextChunk[]`，规则：
- 按空行 + 章节标题 + 对话/叙述切换点切分。
- 每段用轻量正则识别「谁在做什么」，提取实体。
- 输出按叙事时间线排序。

### 3.3 上下文打包 prompt

```
【世界观锚点】{setting.content}
【人物锚点】{character.content}
【当前章节目标】{outline[index].summary}
【前文摘要】{TextChunk.summary 前 5 段}
【锁定区】{locked.join('、')}
【优化指令】{instruction}
```

---

## 4. 评估层：七维评分模型

把一篇文字或大纲按 7 个维度打分，每维 0–100。综合健康度 = 加权平均。

### 4.1 维度定义与算法

| 维度 | 评估对象 | 核心指标 | 轻量算法（不调用 LLM） |
|---|---|---|---|
| 设定一致性 | 正文 vs 设定画布 | 设定覆盖度、冲突实体数 | 用设定画布关键词做实体集合，计算正文命中率和冲突率 |
| 人物一致性 | 人物行为/语言 vs 人物画布 | 人物出场偏离度 | 提取人物画布中的性格标签，检测正文中该人物行为/台词是否违背 |
| 情节推进 | 章节与大纲 | 大纲完成度、信息增量 | 对比大纲摘要与正文，计算「关键事件」是否出现 |
| 节奏感 | 段落长度/对话/场景切换 | 节奏熵、过长叙述占比 | 段落长度标准差、对话密度、场景切换频次 |
| 文笔匹配 | 正文 vs 文笔画布 | 风格关键词命中率 | 文笔画布标签（古风/白描/华丽…）与正文用词分布的余弦相似 |
| 结构完整 | 开头/推进/高潮/收束 | 四段分布比例 | 按章节 tag 统计，检查起承转合比例 |
| 可读性 | 语言本身 | 平均句长、生僻词密度 | 标点切分句长、与目标读者词表比对 |

### 4.2 综合健康度

```ts
function healthScore(scores: DimensionScores, weights: DimensionWeights): number {
  const dims: CanvasDimension[] = ['设定', '人物', '文笔', '结构', '篇幅', '情节', '节奏']
  const total = dims.reduce((sum, d) => sum + weights[d] * scores[d], 0)
  const weightSum = dims.reduce((sum, d) => sum + weights[d], 0)
  return Math.round(total / weightSum)
}
```

默认权重 `weights` 来自平台语料 + 用户历史 weight_log 的加权平均。

---

## 5. 诊断层：问题定位与优先级

### 5.1 问题模板库

每个维度预设 5–8 条常见问题：

```ts
interface ProblemPattern {
  id: string
  dimension: CanvasDimension
  name: string
  condition: (scores: DimensionScores, text: TextChunk[]) => boolean
  severity: 'high' | 'medium' | 'low'
  suggestedFix: string
}
```

示例：
- `PLOT-01`：开局 500 字内未出现核心冲突 → high → 建议重写开头。
- `CHAR-02`：人物台词与性格标签冲突 ≥2 次 → medium → 建议校准对话。
- `RHY-03`：连续 3 段每段 >200 字且无对话 → medium → 建议拆段或插入动作/对话。

### 5.2 诊断流程

```
1. 跑七维评分
2. 对每维低于阈值（默认 60）的维度，触发该维度问题模板
3. 按 severity 排序，同 severity 按「用户锁定区外」优先
4. 输出 Top-3 问题 + 修复建议
```

---

## 6. 优化层：四种改写策略

所有优化动作都基于 prompt 模板，不改动业务代码即可迭代。

### 6.1 策略矩阵

| 问题类型 | 策略 | 模型调用 | 输出 |
|---|---|---|---|
| 局部冲突/冗余 | 精修 (polish) | Responses API | 替换段落 |
| 信息不足/节奏拖沓 | 扩写/删繁 (expand/condense) | Responses API | 新段落或压缩版 |
| 结构偏移 | 重排 (reorder) | Responses API | 段落新顺序 + 过渡句 |
| 整体风格不一致 | 风格校准 (calibrate) | Responses API | 全文润色版 |

### 6.2 精修 prompt 模板（calibrate）

```
你是小说精修师。请基于下方的「锁定区」和「诊断问题」改写正文，
要求：
1. 保留所有锁定区文字原样不动。
2. 解决诊断出的 Top-3 问题。
3. 保持原文情节不变，只改表达、节奏、一致性。
4. 输出格式：先给一段 100 字以内的「改动说明」，再给改写后的正文。
```

### 6.3 扩写/删繁 prompt 模板

```
请对以下段落按目标字数调整：
- 若目标 > 当前：扩写，补充环境、心理、动作细节，但不得新增未在设定中的人/势力。
- 若目标 < 当前：删繁，保留情节骨架与关键对白，压缩描写。
```

### 6.4 与现有 7 画布的集成

在 `AppContext` 中新增 action：

```ts
{ type: 'OPTIMIZE_CANVAS'; dimension: CanvasDimension; instruction: string }
```

触发流程：
1. 取当前维度 content + 锁定状态。
2. 调用 `optimizeText(content, dimension, locked)`。
3. 返回新 content，若该维度 locked 则拒绝并提示。

---

## 7. 训练层：反馈闭环

### 7.1 反馈类型

| 行为 | 数据落点 | 影响 |
|---|---|---|
| 用户「采纳」优化结果 | `weight_log` | 该维度权重 +0.5% |
| 用户「撤销」优化结果 | `weight_log` | 该维度权重 -1%，并记录为失败案例 |
| 用户手动修改后保存 | `project_case_library` | 提取修改前后对，作为成功案例 |
| 用户点赞/踩某章 | `SavedBook.meta` | 影响该用户个人偏好权重 |

### 7.2 weight_log 表扩展

```sql
ALTER TABLE weight_log ADD COLUMN feedback_type TEXT;
ALTER TABLE weight_log ADD COLUMN dimension TEXT;
ALTER TABLE weight_log ADD COLUMN delta REAL;
```

每行记录一次权重调整：

```ts
{
  project_id: 'book-id',
  dimension: '文笔',
  old_val: 0.15,
  new_val: 0.16,
  delta: 0.01,
  trigger_reason: '用户采纳 calibrate 结果',
  feedback_type: 'accept',
  create_at: '...'
}
```

### 7.3 个人偏好模型

每个用户维护一份 `DimensionWeights`，初始值 = 平台默认值。每次反馈后：

```ts
function updateWeight(weights, dimension, feedback, strength = 0.01) {
  const delta = feedback === 'accept' ? strength : -strength * 1.5
  weights[dimension] = clamp(weights[dimension] + delta, 0.05, 0.30)
  normalize(weights) // 七维之和保持 1.0
}
```

### 7.4 平台级学习

平台语料 + 全站成功案例定期聚类：
1. 抽取高采纳率的优化前后文本对。
2. 按维度生成「优质改写模板」。
3. 管理员可在「平台语料 / 设置」中审核并合入平台默认语料。

---

## 8. 与现有功能的集成点

| 现有功能 | 集成方式 |
|---|---|
| 7 画布 | 每个画布旁加「优化此画布」按钮；锁定画布不可优化 |
| 生成文本 | 生成后自动跑一遍七维评分，低分维度给出「一键优化」 |
| 章节精修 | 精修前先做诊断，按诊断结果选择 polish/expand/condense |
| 续写 | 续写时把前文摘要 + 节奏指标喂给模型，避免节奏断裂 |
| 作品库 | 每本书存 `optimizationLog: OptimizationRecord[]` |
| 管理后台 | 新增「优化模板 / 平台权重」子 Tab，站主可调整默认权重 |

---

## 9. 数据结构扩展

### 9.1 新增类型

```ts
interface DimensionScores {
  设定: number
  人物: number
  文笔: number
  结构: number
  篇幅: number
  情节: number
  节奏: number
}

interface OptimizationRecord {
  id: string
  createdAt: string
  targetType: 'canvas' | 'chapter' | 'book' | 'paragraph'
  targetId: string
  scoresBefore: DimensionScores
  scoresAfter: DimensionScores
  issuesFound: string[]
  strategy: 'polish' | 'expand' | 'condense' | 'reorder' | 'calibrate'
  userFeedback?: 'accept' | 'reject' | 'manual'
}

interface TextChunk {
  role: 'setting' | 'character' | 'plot' | 'style' | 'rhythm' | 'scene'
  span: { start: number; end: number }
  summary: string
  entities: string[]
}
```

### 9.2 落点

- `OptimizationRecord` 存在 `SavedBook.optimizationLog` 中（作品级）和 `Canvas.optimizationLog` 中（画布级）。
- 平台默认权重存 KV `app:platform:writingWeights`（管理员可写）。
- 个人权重随 state blob 一起存 KV `user:{uid}:app:state:v1`。

---

## 10. 实现路线图

### Phase 1：评估与诊断（1 周）
- [ ] 实现 `segmentStory` 与轻量七维评分。
- [ ] 在「生成文本」完成后自动展示评分卡。
- [ ] 问题模板库初版（每维 3 条）。

### Phase 2：精修策略（1 周）
- [ ] 实现 `polish` / `expand` / `condense` 三个 prompt 模板。
- [ ] 在章节精修页增加「智能诊断 → 一键精修」。
- [ ] 记录 `OptimizationRecord`。

### Phase 3：反馈闭环（1 周）
- [ ] 扩展 `weight_log` 表。
- [ ] 用户采纳/撤销时写 weight_log。
- [ ] 个人权重影响下一次评分。

### Phase 4：平台级优化（可选）
- [ ] 管理后台新增「写作权重 / 优化模板」Tab。
- [ ] 全站成功案例聚类生成平台模板。

---

## 11. 关键设计原则

1. **优化是建议，不是覆盖**：所有优化结果先展示 diff，用户确认后才替换原文。
2. **锁定区神圣不可侵犯**：无论模型多「自信」， locked canvas / locked atomic 的文字必须原样保留。
3. **评分可解释**：每个分数必须能指出「依据哪段文本、哪个设定」计算得来。
4. **用户数据优先**：weight_log 和 optimizationLog 随用户 state 一起备份，不单独丢失。

---

## 12. 示例：一次完整的优化闭环

1. 用户写完「设定」画布，点击「优化此画布」。
2. 系统评分：设定 78、人物 45（人物画布为空导致）。
3. 诊断：`CHAR-01` 人物维度缺失 → 建议先补人物画布。
4. 用户选择「仅优化设定表达」，系统调用 `polish`。
5. 返回改写后的设定 + 改动说明。
6. 用户点「采纳」→ `weight_log` 中 `设定` 权重 +0.5%。
7. 用户继续补人物画布，下次评分人物维度不再拉低。
