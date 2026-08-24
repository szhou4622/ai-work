import type {
  TaskStatus, RuntimeType, ProviderProtocol, BillingRouteType, WorkflowKind,
  MessagePhase, ReviewVerdict, AgentRunStatus, SubtaskStatus, DeliveryKind, ApprovalPolicy,
} from './enums.js';

/** 核心实体（开发文档 §7.1） */
export interface Project {
  id: string;
  name: string;
  repo_path: string;
  default_branch: string;
  source: 'new' | 'upload' | 'git' | 'path';
  git_url?: string;
  context_config: Record<string, unknown>;
  created_at: number;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  objective: string;
  workflow_id: string;
  preset_id?: string;
  status: TaskStatus;
  queue_order?: number;
  budget_config: Record<string, unknown>;
  created_at: number;
  completed_at?: number;
}

export interface TaskTransition {
  id: string;
  task_id: string;
  from_status: TaskStatus;
  to_status: TaskStatus;
  node_id?: string;
  agent_run_id?: string;
  reason?: string;
  artifact_ref?: string;
  ts: number;
}

export interface Workflow {
  id: string;
  name: string;
  version: string;
  kind: WorkflowKind;
  builtin: number;
  definition: WorkflowDefinition;
  created_at: number;
}

export interface WorkflowNode {
  id: string;
  role: string;
  kind: 'clarify' | 'human_gate' | 'plan' | 'fanout' | 'review_each' | 'integrate' | 'qa' | 'single_exec';
  gate?: 'devdoc' | 'acceptance' | 'approval';
  max_iterations?: number;
  on_exhaust?: string;
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: [string, string][];
  policy: { implementer_neq_reviewer: boolean; executor_cap: number };
}

export interface Role {
  id: string;
  name: string;
  description: string;
  permission_defaults: Record<string, boolean>;
  prompt_template: string;
  created_at: number;
}

export interface Agent {
  id: string;
  name: string;
  role_id: string;
  runtime_id: string;
  model_id: string;
  provider_id: string;
  billing_route_id: string;
  provider_key_id?: string;
  prompt_override?: string;
  workspace_policy: string;
  permissions: Record<string, boolean>;
  tools: string[];
  timeout_ms: number;
  retry_policy: Record<string, unknown>;
  review_policy: Record<string, unknown>;
  created_at: number;
}

export interface Runtime {
  id: string;
  type: RuntimeType;
  name: string;
  executable?: string;
  detect_cmd?: string;
  config: Record<string, unknown>;
  enabled: number;
  created_at: number;
}

export interface Model {
  id: string;
  canonical_name: string;
  family: string;
  capabilities: string[];
  aliases: string[];
  created_at: number;
}

export interface Provider {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  base_url: string;
  secret_ref: string;
  default_headers: Record<string, string>;
  model_mapping: Record<string, string>;
  timeout_ms: number;
  max_retries: number;
  rate_limit_hint?: string;
  enabled: number;
  created_at: number;
}

export interface BillingRoute {
  id: string;
  type: BillingRouteType;
  provider_id?: string;
  account_ref?: string;
  price_table: Record<string, unknown>;
  policy: Record<string, unknown>;
  created_at: number;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  role_agent_map: Record<string, string>;
  created_at: number;
}

/** 运行与产物实体（开发文档 §7.2） */
export interface Message {
  id: string;
  task_id: string;
  phase: MessagePhase;
  role: 'user' | 'agent';
  content: string;
  agent_run_id?: string;
  created_at: number;
}

export interface DevDoc {
  id: string;
  task_id: string;
  version: number;
  content_path: string;
  status: 'draft' | 'confirmed' | 'superseded';
  confirmed_at?: number;
}

export interface Subtask {
  id: string;
  task_id: string;
  devdoc_version: number;
  module: string;
  description: string;
  file_scope: string[];
  acceptance: string[];
  executor_agent_id?: string;
  agent_run_id?: string;
  status: SubtaskStatus;
}

export interface AgentRun {
  id: string;
  task_id: string;
  node_id: string;
  agent_id: string;
  subtask_id?: string;
  worktree_ref?: string;
  status: AgentRunStatus;
  started_at?: number;
  ended_at?: number;
  exit_info?: Record<string, unknown>;
  output_path?: string;
  session_ref?: string;
}

export interface Handoff {
  id: string;
  agent_run_id: string;
  summary: string;
  files_changed: string[];
  decisions: string[];
  risks: string[];
  next_context: string;
}

export interface ReviewIssue {
  issue_id: string;
  severity: 'info' | 'warning' | 'blocking';
  description: string;
  evidence?: string;
  file?: string;
  expected_fix?: string;
  blocking: boolean;
}

export interface Review {
  id: string;
  task_id: string;
  reviewer_run_id: string;
  target_agent_run_id: string;
  verdict: ReviewVerdict;
  issues: ReviewIssue[];
  iteration: number;
}

export interface Workspace {
  id: string;
  project_id: string;
  task_id: string;
  agent_id: string;
  path: string;
  branch: string;
  worktree_ref?: string;
  status: string;
}

export interface ProjectMemory {
  id: string;
  project_id: string;
  task_id?: string;
  kind: 'architecture' | 'decision' | 'task_summary';
  content: string;
  created_at: number;
}

export interface Delivery {
  id: string;
  task_id: string;
  kind: DeliveryKind;
  url_or_path: string;
  port?: number;
  pid?: number;
  status: string;
  created_at: number;
}

export interface UsageRecord {
  id: string;
  task_id: string;
  agent_run_id: string;
  billing_route_id: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  duration_ms: number;
  cost_est: number;
  currency: string;
  available: number;
  note?: string;
}

export interface AuditLog {
  id: string;
  ts: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

/** 主调度拆解输出（开发文档 §7.3） */
export interface TaskDecomposition {
  modules: {
    id: string;
    name: string;
    description: string;
    file_scope: string[];
    acceptance: string[];
    suggested_executor_count?: number;
    depends_on: string[];
  }[];
  integration_notes: string;
}

/** 影响评估输出（中途插话） */
export interface ImpactAssessment {
  impact: 'none' | 'minor' | 'major';
  affected_modules: string[];
  devdoc_changes: string;
  plan_changes: string;
}

/** Provider 连通性测试结果 */
export interface TestConnectionResult {
  ok: boolean;
  stage: 'dns' | 'connect' | 'auth' | 'model' | 'protocol' | 'rate_limit' | 'timeout' | 'ok';
  error?: string;
  hint?: string;
  latency_ms: number;
  models?: string[];
}

/** WS 事件（开发文档 §7.2） */
export type WsServerEvent =
  | { type: 'task.status'; task_id: string; status: TaskStatus; ts: number }
  | { type: 'node.status'; task_id: string; node_id: string; status: string }
  | { type: 'agent.run.status'; task_id: string; run_id: string; status: AgentRunStatus }
  | { type: 'agent.output'; task_id: string; run_id: string; chunk: string }
  | { type: 'usage.update'; task_id: string; usage: UsageRecord }
  | { type: 'clarification.question'; task_id: string; content: string }
  | { type: 'task.interject'; task_id: string; content: string; created_at: number }
  | { type: 'devdoc.confirm.request'; task_id: string; version: number }
  | { type: 'approval.request'; task_id: string; req_id: string; action: string; detail: string }
  | { type: 'acceptance.request'; task_id: string; summary: string }
  | { type: 'preview.ready'; task_id: string; url: string }
  | { type: 'queue.update'; task_id: string; position: number }
  | { type: 'task.error'; task_id: string; message: string };

export type WsClientEvent = { type: 'subscribe'; task_id: string } | { type: 'ping' };
