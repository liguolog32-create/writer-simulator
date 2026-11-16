-- 作家模拟器 · D1 初始化脚本
-- 对应 PRD《AI作家模拟器 · Cloudflare自动化部署版本》第 5 节
-- 幂等：全部 IF NOT EXISTS，重复执行不会破坏已有业务数据

-- 项目基础信息
CREATE TABLE IF NOT EXISTS project_info (
  project_id TEXT PRIMARY KEY,
  user_id TEXT,
  project_name TEXT,
  create_at TIMESTAMP,
  update_at TIMESTAMP
);

-- 权重变更审计表（自优化算法日志）
CREATE TABLE IF NOT EXISTS weight_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  dimension TEXT,
  old_val REAL,
  new_val REAL,
  trigger_reason TEXT,
  create_at TIMESTAMP
);

-- 项目案例库（失败/成功场景案例）
CREATE TABLE IF NOT EXISTS project_case_library (
  case_id TEXT PRIMARY KEY,
  project_id TEXT,
  scene_tags TEXT,
  related_atomic_ids TEXT,
  case_type TEXT,
  fail_reason TEXT,
  best_fix_strategy TEXT,
  success_rate REAL,
  create_at TIMESTAMP
);

-- 章节索引
CREATE TABLE IF NOT EXISTS chapter_index (
  chapter_id TEXT PRIMARY KEY,
  project_id TEXT,
  chapter_no INTEGER,
  chapter_title TEXT,
  node_id TEXT,
  create_at TIMESTAMP
);

-- 备份执行日志表
CREATE TABLE IF NOT EXISTS backup_exec_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_type TEXT,
  r2_object_path TEXT,
  file_size_bytes INTEGER,
  status TEXT,
  error_msg TEXT,
  execute_at TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_case_project ON project_case_library(project_id);
CREATE INDEX IF NOT EXISTS idx_weight_project ON weight_log(project_id);
CREATE INDEX IF NOT EXISTS idx_chapter_project ON chapter_index(project_id);
CREATE INDEX IF NOT EXISTS idx_backup_time ON backup_exec_log(execute_at);
