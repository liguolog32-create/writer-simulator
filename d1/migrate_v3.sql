-- ============================================================
-- 作家模拟器 · D1 迁移 v3 —— 管理员角色与权限
--
-- 背景：v2 的 users 表只有账号/密码，后端无法区分「谁是管理员」。
-- 前端的「管理后台」只是一个本地开关，任何人点一下就能改数据。
-- 本次把角色变成服务端事实：role 存在 D1，由 Worker 判定，
-- 前端拿到的只是展示用的副本，伪造请求一律被 403 拦下。
--
-- 执行：wrangler d1 execute ai_writer_d1_db --remote --file d1/migrate_v3.sql
-- 注意：SQLite 没有 ADD COLUMN IF NOT EXISTS，
--       重复执行会报 duplicate column name —— 属预期，忽略即可。
-- ============================================================

-- role  : 'user' | 'admin' —— 默认普通用户，只有被显式提升才是管理员
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
-- status: 'active' | 'disabled' —— 停用后登录与所有业务接口一律拒绝
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
-- 管理员备注（谁、为什么、什么时候建的号）
ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT '';
-- 账号最后一次被管理员改动的时间
ALTER TABLE users ADD COLUMN update_at TEXT;

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ------------------------------------------------------------
-- 管理员操作审计：所有管理类写操作都留痕，事后可追溯
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  create_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit(create_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit(actor_id);
