-- 作家模拟器 · D1 迁移 v2（多用户）
-- 1) 新增 users / sessions 表
-- 2) 各业务表补 user_id 列（多租户隔离）
-- 注意：project_info 在 init.sql 里已有 user_id，无需再加。
-- ALTER TABLE 重复执行会报 duplicate column，属幂等失败，可忽略。

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  create_at TIMESTAMP,
  last_login_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  create_at TIMESTAMP,
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

ALTER TABLE weight_log ADD COLUMN user_id TEXT;
ALTER TABLE project_case_library ADD COLUMN user_id TEXT;
ALTER TABLE chapter_index ADD COLUMN user_id TEXT;
ALTER TABLE backup_exec_log ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_project_user ON project_info(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_user ON weight_log(user_id);
CREATE INDEX IF NOT EXISTS idx_case_user ON project_case_library(user_id);
CREATE INDEX IF NOT EXISTS idx_chapter_user ON chapter_index(user_id);
