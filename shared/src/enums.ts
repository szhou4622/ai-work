/** 任务状态机（开发文档 §3.3） */
export const TaskStatus = {
  CREATED: 'CREATED',
  QUEUED: 'QUEUED',
  WAITING_CLARIFICATION: 'WAITING_CLARIFICATION',
  ARCHITECTURE: 'ARCHITECTURE',
  WAITING_DEVDOC_CONFIRM: 'WAITING_DEVDOC_CONFIRM',
  PLANNING: 'PLANNING',
  EXECUTING: 'EXECUTING',
  REVIEWING: 'REVIEWING',
  FIXING: 'FIXING',
  INTEGRATING: 'INTEGRATING',
  TESTING: 'TESTING',
  WAITING_ACCEPTANCE: 'WAITING_ACCEPTANCE',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const RuntimeType = { CLI: 'cli', API: 'api' } as const;
export type RuntimeType = (typeof RuntimeType)[keyof typeof RuntimeType];

export const ProviderProtocol = { OPENAI: 'openai', ANTHROPIC: 'anthropic', GENERIC: 'generic' } as const;
export type ProviderProtocol = (typeof ProviderProtocol)[keyof typeof ProviderProtocol];

export const BillingRouteType = {
  SUBSCRIPTION: 'subscription',
  OFFICIAL_API: 'official_api',
  THIRD_PARTY_RELAY: 'third_party_relay',
  AGGREGATOR: 'aggregator',
  SELF_HOSTED: 'self_hosted',
  LOCAL: 'local',
} as const;
export type BillingRouteType = (typeof BillingRouteType)[keyof typeof BillingRouteType];

export const WorkflowKind = { STANDARD: 'standard', QUICK_FIX: 'quick_fix', BUG_FIX: 'bug_fix', CUSTOM: 'custom' } as const;
export type WorkflowKind = (typeof WorkflowKind)[keyof typeof WorkflowKind];

export const MessagePhase = { CLARIFY: 'clarify', INTERJECT: 'interject', ACCEPTANCE: 'acceptance' } as const;
export type MessagePhase = (typeof MessagePhase)[keyof typeof MessagePhase];

export const ReviewVerdict = { PASS: 'PASS', FAIL: 'FAIL' } as const;
export type ReviewVerdict = (typeof ReviewVerdict)[keyof typeof ReviewVerdict];

export const AgentRunStatus = {
  PENDING: 'PENDING', RUNNING: 'RUNNING', WAITING_HUMAN: 'WAITING_HUMAN',
  COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED', FALLBACK: 'FALLBACK',
} as const;
export type AgentRunStatus = (typeof AgentRunStatus)[keyof typeof AgentRunStatus];

export const SubtaskStatus = {
  PENDING: 'PENDING', RUNNING: 'RUNNING', REVIEWING: 'REVIEWING', FIXING: 'FIXING',
  PASSED: 'PASSED', FAILED: 'FAILED', NEEDS_HUMAN: 'NEEDS_HUMAN',
} as const;
export type SubtaskStatus = (typeof SubtaskStatus)[keyof typeof SubtaskStatus];

export const DeliveryKind = { PREVIEW: 'preview', PACKAGE: 'package' } as const;
export type DeliveryKind = (typeof DeliveryKind)[keyof typeof DeliveryKind];

/** 权限位（开发文档 9.2 工具权限） */
export const Permission = { READ: 'read', WRITE: 'write', SHELL: 'shell', TEST: 'test', NETWORK: 'network' } as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ApprovalPolicy = { AUTO_ALLOW: 'auto_allow', REQUIRE_APPROVAL: 'require_approval', FORBID: 'forbid' } as const;
export type ApprovalPolicy = (typeof ApprovalPolicy)[keyof typeof ApprovalPolicy];
