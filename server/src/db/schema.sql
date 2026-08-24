-- AI 多 Agent 开发工作台 · V1 数据库模式（开发文档 §6）

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT,
  default_branch TEXT DEFAULT 'main',
  source TEXT DEFAULT 'new',
  git_url TEXT,
  context_config TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  preset_id TEXT,
  agent_overrides TEXT DEFAULT '{}',
  auto_mode INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'CREATED',
  queue_order INTEGER,
  budget_config TEXT DEFAULT '{}',
  runtime_context TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  node_id TEXT,
  agent_run_id TEXT,
  reason TEXT,
  artifact_ref TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT DEFAULT '1',
  kind TEXT DEFAULT 'custom',
  builtin INTEGER DEFAULT 0,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  permission_defaults TEXT DEFAULT '{}',
  prompt_template TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  billing_route_id TEXT NOT NULL,
  provider_key_id TEXT,
  prompt_override TEXT,
  workspace_policy TEXT DEFAULT 'isolated',
  permissions TEXT DEFAULT '{}',
  tools TEXT DEFAULT '[]',
  timeout_ms INTEGER DEFAULT 600000,
  retry_policy TEXT DEFAULT '{}',
  review_policy TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  executable TEXT,
  detect_cmd TEXT,
  config TEXT DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  family TEXT DEFAULT '',
  capabilities TEXT DEFAULT '[]',
  aliases TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  protocol TEXT DEFAULT 'openai',
  model_mapping TEXT DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  default_headers TEXT DEFAULT '{}',
  model_mapping TEXT DEFAULT '{}',
  timeout_ms INTEGER DEFAULT 60000,
  max_retries INTEGER DEFAULT 2,
  rate_limit_hint TEXT,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_routes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  provider_id TEXT,
  account_ref TEXT,
  price_table TEXT DEFAULT '{}',
  policy TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  role_agent_map TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  phase TEXT DEFAULT 'clarify',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  agent_run_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devdocs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  content_path TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  confirmed_at INTEGER
);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  devdoc_version INTEGER DEFAULT 1,
  module TEXT NOT NULL,
  description TEXT,
  file_scope TEXT DEFAULT '[]',
  acceptance TEXT DEFAULT '[]',
  executor_agent_id TEXT,
  agent_run_id TEXT,
  status TEXT DEFAULT 'PENDING'
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  subtask_id TEXT,
  worktree_ref TEXT,
  status TEXT DEFAULT 'PENDING',
  started_at INTEGER,
  ended_at INTEGER,
  exit_info TEXT,
  output_path TEXT,
  session_ref TEXT
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  summary TEXT,
  files_changed TEXT DEFAULT '[]',
  decisions TEXT DEFAULT '[]',
  risks TEXT DEFAULT '[]',
  next_context TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  reviewer_run_id TEXT NOT NULL,
  target_agent_run_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  issues TEXT DEFAULT '[]',
  iteration INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT DEFAULT 'main',
  worktree_ref TEXT,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS project_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  url_or_path TEXT NOT NULL,
  port INTEGER,
  pid INTEGER,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  billing_route_id TEXT NOT NULL,
  requests INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  cost_est REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  available INTEGER DEFAULT 1,
  note TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_transitions_task ON task_transitions(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_runs_task ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_usage_task ON usage_records(task_id);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_project ON project_memories(project_id, created_at);
