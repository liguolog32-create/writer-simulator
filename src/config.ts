// 端到端可配置项（部署后所有用户共享此 URL）
export const WORKER_URL = 'https://writer-sim-llm.liguolog32.workers.dev'

// LLM 调用超时：v3 开启真联网搜索 + 推理模式，实测 30-90 秒，给足余量
export const LLM_TIMEOUT_MS = 120_000

// AI 填充在本地库命中时是否还要走网络（默认 false：本地快、不花钱）
export const ALWAYS_USE_LLM = false
