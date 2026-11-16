/* ============================================================
   测试版 → 正式版 发布请求（v10.18）
   ------------------------------------------------------------
   Cloudflare Pages 的 Direct Upload 项目**不支持**把 preview 部署
   promote 到 production（实测 POST /deployments/{id}/promote 恒返回
   405 method_not_allowed），Worker 里也没有 wrangler 可以调用。
   所以「发布」拆成两段：
     ① 测试版网页上的按钮 → 调 promoteRequest 登记一条待发布请求
        （带 BUILD_HASH，锁定就是当前这份产物）
     ② 助手用 wrangler 把同一份 dist 部署到 main 分支，完成后调
        promoteResolve 把状态改成 done
   这样保留了「在测试版点按钮发起发布」的入口，又不用为了自动化去走
   脆弱的上传协议 —— functions bundle 一旦传丢，/api 反代会全挂。
   ============================================================ */

import { postWorkerData } from './api'

export type PromoteStatus = 'pending' | 'done' | 'cancelled'

export interface PromoteRequest {
  status: PromoteStatus
  buildHash?: string
  buildTag?: string
  note?: string
  requestedAt?: string
  requestedBy?: string
  prodBuildHash?: string
  resolvedAt?: string
  resolvedBy?: string
  resolveNote?: string
}

/** 提交发布请求（admin）。已有 pending 时不会覆盖，返回 alreadyPending */
export function requestPromote(buildHash: string, note = '') {
  return postWorkerData<{ request: PromoteRequest; alreadyPending?: boolean; hint?: string }>(
    { action: 'promoteRequest', buildHash, note },
    20_000,
    { requireAuth: true },
  )
}

/** 查询当前发布请求状态（admin） */
export function fetchPromoteStatus() {
  return postWorkerData<{ request: PromoteRequest | null }>(
    { action: 'promoteStatus' },
    20_000,
    { requireAuth: true },
  )
}

/** 标记请求已完成 / 撤销（admin） */
export function resolvePromote(
  outcome: 'done' | 'cancelled',
  prodBuildHash = '',
  resolveNote = '',
) {
  return postWorkerData<{ request: PromoteRequest }>(
    { action: 'promoteResolve', outcome, prodBuildHash, resolveNote },
    20_000,
    { requireAuth: true },
  )
}
