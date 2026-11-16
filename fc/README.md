# 变体A · Function Calling 联网搜索安全网关（已落地到本仓库）

> 对应文档：`writer-simulator-变体A工程实现.md`
> 目标：让 AI 写作助手支持「联网搜索」，但把**是否执行、怎么执行**的控制权全部收到后端。
> 形态：Cloudflare Workers + KV，全 Serverless —— 本机关机不影响线上。

## 一、已经部署了什么

| 组件 | 线上地址 | 版本 | 作用 |
|---|---|---|---|
| `fc-gateway` | https://fc-gateway.liguolog32.workers.dev | `521da8f9` | 安全网关：验签 → Schema → PII → 限流 → 搜索 → 清洗 → 审计 |
| `llm-bridge` | https://llm-bridge.liguolog32.workers.dev | `876f7472` | 中转层：对话循环主控 / 工具调度 / HMAC 签名 / 失败缓存 |

- KV Namespace：
  - `FC_SESSION_COUNTER` = `3c7106186bd54ef79f88bf4de67f3753`（会话计数 + 失败缓存）
  - `FC_AUDIT_LOG` = `83d9e60063fb4c08afcbb53dd0a09927`（脱敏审计）
- 前端入口：`/fc`（`functions/fc/[[path]].js` 同源反代到 llm-bridge）
- 客户端：`src/lib/fcSearch.ts`（`fcChat()` / `fcAskWithSearch()`）

## 二、密钥现状：**一个都不需要**（默认全免费）

用户 2026-10-31 明确要求：不要"用完免费额度就要付费"的 API。所以整条链改成 **0 付费、0 搜索账号**：

| 环节 | 用的是 | 要密钥吗 | 费用 |
|---|---|---|---|
| 搜索 | **维基百科官方 API**（首选）+ **DuckDuckGo**（兜底） | ❌ 不要 | 免费 |
| 模型 | **Cloudflare Workers AI · glm-4.7-flash**（`env.AI` 绑定） | ❌ 不要 | 每天 10,000 神经元免费额度 |
| Worker 间鉴权 | `INTERNAL_SECRET` | ✅ 已生成并写入两端 | — |

```bash
# 想切到付费通道（质量更高）时再开，默认不走：
# 1) 把 llm-bridge.toml 改成 LLM_PROVIDER="openai" + LLM_MODEL="deepseek-chat"
# 2) 写入你自己的 DeepSeek key
echo "<你的 DeepSeek key>" | env -u HTTPS_PROXY -u HTTP_PROXY $WR secret put LLM_API_KEY --config llm-bridge.toml
# 3) 想用商业搜索（Tavily/Bing）时：SEARCH_PROVIDER 改成 tavily/bing 并写入对应 key
```

自检（都该是 `configured: true`）：

```bash
curl https://staging.writer-simulator.pages.dev/fc/
# {"ok":true,"service":"llm-bridge","version":3,"provider":"workers-ai","model":"@cf/zai-org/glm-4.7-flash","configured":true}
```

### 二手实测（2026-10-31，全免费链路）

```bash
curl -X POST https://staging.writer-simulator.pages.dev/fc/cot \
  -H 'Content-Type: application/json' \
  -d '{"task":"用三句话介绍韩江，必须提到她获得诺贝尔文学奖的年份","constraints":["不超过 120 字"],"format":"三句话"}'
```

实测结果：`searchCount: 1`（维基百科真检索，证据含条目链接）→ 五阶段跑完 → 正文三句、2024 年正确、120 字内。
**代价**：全免费链路较慢（约 150 秒，因为免费模型要顺序跑 5 次；付费通道会快很多）。

### 免费路径的边界（要如实知道）

- **维基百科只覆盖百科类事实**（人名/年份/作品/事件），查不到时效性新闻、冷门数据。
- **DuckDuckGo HTML 版是"尽力而为"**：可能被限流或改版；失败就返回空，**会让模型说"未查到"，绝不编造**。
- 免费模型是 7B～30B 级别，`plan`/`verify` 这类要求输出严格 JSON 的阶段偶尔会失败 →
  已加"严格重试 → 本地兜底计划"两级保护，兜底时会**强制把事实类任务送去检索**，不静默跳过。
- 需要稳定高质量时，把 `LLM_PROVIDER` 切到 `openai`（你自己的 DeepSeek）。

### ⚠️ 部署时踩的一个硬坑：同域 Worker 不能互相 fetch（错误 1042）

`llm-bridge` 和 `fc-gateway` 都在 `*.liguolog32.workers.dev` 同一个域下，
用全局 `fetch` 互调会被 Cloudflare 直接拒绝（返回 `error code: 1042`，且是纯文本不是 JSON）。

**正解：Service Binding**（已配在 `llm-bridge.toml`）：

```toml
[[services]]
binding = "GATEWAY"
service = "fc-gateway"
```

代码里优先用 `env.GATEWAY.fetch()`，本地测试没有绑定时自动回落全局 `fetch`。
好处不只是能通：**不经过公网、延迟更低、网关也不必对外暴露**。

## 三、相对文档做的四处适配（都是必要的，理由在此）

| # | 位置 | 文档写法 | 实际实现 | 为什么 |
|---|---|---|---|---|
| 1 | 网关 Step 1 | 用 `Joi` 校验 | **文档附录 B 的手写校验** | 文档第 13 节自己也推荐；网关零依赖，部署包 10KB（gzip 3.8KB），冷启动更快，校验强度等价 |
| 2 | 网关 Step 0 / 中转层签名 | 只签 body | 签名 `timestamp + "." + body`，网关校验 **±300s** 防重放 | 纯 HMAC 可被重放；抓包者 5 分钟后即失效。窗口用 `REPLAY_WINDOW_SEC` 可调，设 0 关闭 |
| 3 | 中转层 `dispatchTool` | `fc.arguments.query` | 先把 `arguments` **JSON.parse** 再签发送网关 | OpenAI 兼容接口的 `tool_calls[].function.arguments` 是**字符串**，照文档写会永远拿不到 query |
| 4 | 中转层消息 | 原样转发 messages | `sanitizeMessages()` 把 `system` 降级为 `user`、丢弃 `tool` 角色、截断 8000 字 | 防客户端塞 system 覆盖工具规则；同时控制 token 与注入面 |

另外两处小增强：健康检查 `/` 返回 `configured`（区分"没配密钥"与"服务故障"）；搜索密钥缺失时返回 **503 + 明确文案**，而不是伪装成 502 故障。

## 四、测试发现并修掉的两个真实漏洞

1. **邮箱 PII 漏检**（会真的把用户邮箱发给搜索服务商）
   原因：`normalizeForPII()` 会去掉 `.`，`zhangsan@example.com` 变成 `zhangsan@examplecom`，
   邮箱正则要求 `@` 后有点，于是不匹配。→ 邮箱改为在**原始串**上判。

2. **注入清洗漏掉首字母大写**
   原因：清洗前用 `content.includes(marker)` 做预检查（区分大小写），
   而替换用 `gi`；`Ignore previous instructions` 因此被跳过。
   → 去掉预检查，直接 replace（无匹配是空操作）。

## 五、怎么跑测试

```bash
cd /Users/apple/.workbuddy/binaries/node/workspace
node test-fc-variant-a.mjs
```

覆盖 13 组、端到端（把**部署的同一份代码** import 进 Node，配假 KV + mock 上游，
走"中转层 → 真 HMAC → 真网关 → mock 搜索 → 清洗 → 审计"整条链）：

- 签名：无签名 / 错签名 / 错密钥 / 超窗重放 → 全 403
- Schema：非 search 工具、额外字段、超长、缺字段 → 全 400
- PII：手机号、身份证（含空格写法）、银行卡、邮箱（含连字符手机号）→ 全 403，且审计已脱敏
- 正常搜索：结果清洗（`[filtered]`）+ 截断 800 字 + 审计不存全文
- 限流：同会话第 4 次 429；中转层单轮 ≤3 次；失败缓存不重复转发
- 修正验证：`arguments` 字符串可解析；`system` 消息被降级

## 六、前端怎么用

```ts
import { fcAskWithSearch } from './lib/fcSearch'

const { content, searchCount } = await fcAskWithSearch('2024 年诺贝尔文学奖得主是谁？')
// searchCount = 0 表示模型判断不需要搜；>0 表示真的走了网关
```

红线（前端永远不做）：把 LLM/搜索 Key 写进前端、前端直连搜索 API、前端定义工具 schema、
把稿件发给中转层以外的第三方。

## 七、本机环境的两个坑（部署时踩过）

1. **`npx wrangler` 会被 SIGTERM**（npx 解析阶段就被杀）。改用缓存里的二进制：
   `node /Users/apple/.npm/_npx/32026684e21afda6/node_modules/wrangler/bin/wrangler.js`
2. **环境代理会让 wrangler 卡死**：`api.cloudflare.com` **直连可用**，但默认 `HTTPS_PROXY`
   会让它挂住。所有 wrangler 命令前面加 `env -u HTTPS_PROXY -u HTTP_PROXY`。
3. `*.workers.dev` 在本机**不可直连**（既有限制），所以线上验证靠"本地加载同一份代码 + 假 KV"，
   以及 Cloudflare 控制台/`wrangler tail`。

## 八、尚未做（按文档第 12 节，等你要）

- `web_fetch(url)` 工具（附录 A 的 SSRF 防护已备好思路，当前未开放，所以无 SSRF 面）
- IP 维度限流、用户套餐计费（放宽 MAX_SEARCH_ROUNDS）、R2 归档审计、敏感词内容审核
- **把 `/fc` 接进写作流程的 UI**（现在只有客户端 API，未改动现有写作页面）
