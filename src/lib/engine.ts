/* ============================================================
   写作引擎偏好 · 本机持久化（v10.17）
   ------------------------------------------------------------
   这是「这台设备」的选择，不跟账号走、也不同步到云端：
   - 同一台电脑上所有浏览器标签页共享（localStorage）
   - 换设备 / 换浏览器会各自回到默认值（免费优先）
   之所以不做云端同步：引擎选择是「我想不想花自己的 DeepSeek 余额」
   这种本地决策，同步到云端反而会让 A 设备的切换影响到 B 设备。
   ============================================================ */

import { useSyncExternalStore } from 'react'
import {
  DEFAULT_ENGINE,
  DEFAULT_FREE_MODEL,
  FREE_ENGINE_MODELS,
  type FreeEngineModelKey,
  type LLMEngine,
} from '../config'

const STORAGE_KEY = 'writer-simulator-engine-v1'

export interface EnginePref {
  engine: LLMEngine
  /** 仅 engine==='free' 时有意义 */
  freeModel: FreeEngineModelKey
}

function isModelKey(v: unknown): v is FreeEngineModelKey {
  return FREE_ENGINE_MODELS.some(m => m.key === v)
}

function isEngine(v: unknown): v is LLMEngine {
  return v === 'cloud' || v === 'free'
}

function read(): EnginePref {
  const fallback: EnginePref = { engine: DEFAULT_ENGINE, freeModel: DEFAULT_FREE_MODEL }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const j = JSON.parse(raw) as Partial<EnginePref>
    return {
      // 存进来的值可能是老版本/手改的，一律校验后再用，垃圾值直接回默认
      engine: isEngine(j.engine) ? j.engine : fallback.engine,
      freeModel: isModelKey(j.freeModel) ? j.freeModel : fallback.freeModel,
    }
  } catch {
    return fallback
  }
}

let cache: EnginePref | null = null
const listeners = new Set<() => void>()

/** 读当前引擎偏好（带内存缓存，保证 useSyncExternalStore 的 getSnapshot 稳定） */
export function getEnginePref(): EnginePref {
  if (!cache) cache = read()
  return cache
}

/** 改引擎偏好：写 localStorage + 通知所有订阅者 */
export function setEnginePref(patch: Partial<EnginePref>): void {
  const next: EnginePref = { ...getEnginePref(), ...patch }
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式 / 存储配额满：降级为「本次会话内有效」，不阻断写作
  }
  listeners.forEach(fn => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** React 侧读取引擎偏好 */
export function useEnginePref(): EnginePref {
  return useSyncExternalStore(subscribe, getEnginePref, getEnginePref)
}

/**
 * 打给 Worker 的引擎参数。
 * 云端引擎刻意把 freeModel 传空：省一点请求体积，
 * 也让 worker 那侧「非免费模式不解析模型」的意图更明确。
 *
 * v10.22：支持 `override` —— 某些入口（如「一键生成整本书」的
 * 「免费 / 付费」两颗按钮）要在**点按钮那一次**指定引擎，
 * 而不改用户顶栏的全局偏好。
 */
export function enginePayload(override?: LLMEngine): { engine: LLMEngine; freeModel: string } {
  // v10.71：**免费模型已取消** —— AI 生成统一走站方 DeepSeek。
  // 这里强制返回 cloud，是为了兜住"旧缓存偏好仍是 free"和"旧调用点仍传 free"两种情况，
  // 避免请求里带上 free 让服务端多做一次判断。worker 侧同样强制 cloud（双保险）。
  void override
  return { engine: 'cloud', freeModel: '' }
}

/** 当前引擎的中文名，用于状态提示 */
export function engineLabel(engine: LLMEngine): string {
  return engine === 'free' ? '免费引擎' : '云端 优质模型生产'
}
