-- ============================================================
-- 作家模拟器 · D1 迁移 v5 —— 免费模型每日额度（v10.25）
--
-- 背景：免费引擎跑的是站方自己的 Cloudflare Workers AI 免费额度。
-- 为了让免费通道「够用但不被无限刷」，给**每个用户**每天 15 次
-- 「免费模型」点击；用完以后只能切「💳 付费模型」。
--
-- 计数粒度：一次「实际跑过免费模型」的请求算 1 次点击。
--   （generate 在免费通道里会连打 2 次模型 —— 大纲 + 样章 —— 但只算 1 次点击，
--     因为用户只点了一下。）
-- 「一天」按**北京时间**算（与积分流水的展示口径一致）。
--
-- 执行：wrangler d1 execute ai_writer_d1_db --remote --file d1/migrate_v5.sql
-- 幂等：CREATE ... IF NOT EXISTS，可重复执行。
-- ============================================================

-- scope = 用户 id；未登录（仅本机模式）统一记到 'anon'
-- day   = 北京日期 YYYY-MM-DD
CREATE TABLE IF NOT EXISTS free_usage (
  scope TEXT    NOT NULL,
  day   TEXT    NOT NULL,
  used  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);

-- 清理旧日期的行时用得上
CREATE INDEX IF NOT EXISTS idx_free_usage_day ON free_usage(day);
