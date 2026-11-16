-- ============================================================
-- 作家模拟器 · D1 迁移 v4 —— 按用户的 token 计费与积分体系（v10.23）
--
-- 背景：平台用自己的 DeepSeek API Key 给所有用户供货，但此前
-- 「谁用了多少」完全没记账。本次把每次**云端（付费）调用**的
-- token 用量落库，并按官方分时单价折算成真金白银，再乘 140%
-- 作为用户侧的积分消耗；积分余额 = 累计发放 − 累计消耗。
--
-- 计价口径（改价只改 worker.js 里的 PRICE_CNY_PER_M / CREDIT_MARKUP）：
--   · 单价：deepseek-v4-flash 官方分时价（CNY/百万 tokens，2026-09-10 调价后）
--       计费项            空闲时段   高峰时段(=2×)
--       输入·缓存未命中    ¥1.00     ¥2.00
--       输入·缓存命中      ¥0.02     ¥0.04
--       输出              ¥4.00     ¥8.00
--     高峰 = 周一至周五 09:00–12:00、14:00–18:00（北京时间）
--   · 用户侧计价 = 真实成本 × 140%（含 40% 溢价）
--   · 1 积分 = ¥0.001（1000 积分 = 1 元）
--   · 免费引擎（Cloudflare Workers AI）不计积分
--
-- 执行：wrangler d1 execute ai_writer_d1_db --remote --file d1/migrate_v4.sql
-- 幂等：全部是 CREATE ... IF NOT EXISTS，可重复执行。
-- ============================================================

-- ------------------------------------------------------------
-- 每次云端调用的用量流水（一次请求可能含多次模型调用，合并成一行）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,               -- 用户 id；未登录调用记 'anon'
  action      TEXT NOT NULL DEFAULT '',    -- 触发的 action（generate / dissect / analyze …）
  model       TEXT NOT NULL DEFAULT '',    -- 实际计费的模型
  tokens_miss INTEGER NOT NULL DEFAULT 0,  -- 输入·缓存未命中
  tokens_hit  INTEGER NOT NULL DEFAULT 0,  -- 输入·缓存命中
  tokens_out  INTEGER NOT NULL DEFAULT 0,  -- 输出
  cost_cny    REAL    NOT NULL DEFAULT 0,  -- 真实成本（元）＝后台真金白银付给 DeepSeek 的
  credits     REAL    NOT NULL DEFAULT 0,  -- 用户侧消耗积分 ＝ cost_cny × 140% ÷ 0.001
  peak        INTEGER NOT NULL DEFAULT 0,  -- 是否高峰时段计费（1/0）
  created_at  TEXT NOT NULL                -- UTC ISO 串（展示时转北京时间）
);

CREATE INDEX IF NOT EXISTS idx_credit_usage_user  ON credit_usage(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_credit_usage_time  ON credit_usage(created_at);

-- ------------------------------------------------------------
-- 每个账号的积分账户：granted = 累计发放，used = 累计消耗
-- 余额 balance = granted − used（不单独存，避免两份数据打架）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_account (
  user_id    TEXT PRIMARY KEY,
  granted    REAL NOT NULL DEFAULT 0,      -- 累计发放积分（管理员发放 / 校正）
  used       REAL NOT NULL DEFAULT 0,      -- 累计消耗积分（由流水累加）
  note       TEXT NOT NULL DEFAULT '',     -- 最近一次发放备注
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_credit_account_used ON credit_account(used);
