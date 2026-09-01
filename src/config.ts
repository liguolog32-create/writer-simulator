// 端到端可配置项（部署后所有用户共享此 URL）
export const WORKER_URL = 'https://writer-sim-llm.liguolog32.workers.dev'

// LLM 调用超时：v4.1 起 generate 不开 web_search，主流 30-60 秒；给足到 180s
export const LLM_TIMEOUT_MS = 180_000

// AI 填充在本地库命中时是否还要走网络（默认 false：本地快、不花钱）
export const ALWAYS_USE_LLM = false
