/** 全站中文化映射（角色/节点/状态等） */

/** 工作流节点名 */
export const NODE_LABEL: Record<string, string> = {
  clarify: '需求澄清',
  devdoc_confirm: '文档确认',
  plan: '任务拆解',
  execute: '执行',
  review: '审查',
  integrate: '整合',
  qa: '质检',
  acceptance: '用户验收',
  manual: '手动',
};

/** Agent 运行状态 */
export const RUN_STATUS: Record<string, string> = {
  PENDING: '等待中',
  RUNNING: '运行中',
  WAITING_HUMAN: '等待人工',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  FALLBACK: '已切换线路',
};

/** 子任务状态 */
export const SUBTASK_STATUS: Record<string, string> = {
  PENDING: '等待中',
  RUNNING: '执行中',
  REVIEWING: '审查中',
  FIXING: '返工中',
  PASSED: '已通过',
  FAILED: '失败',
  NEEDS_HUMAN: '需要人工',
};

/** 用量按阶段 */
export const stageLabel = (stage: string): string => NODE_LABEL[stage] ?? stage;

/** 角色（补充映射，防数据库未同步时兜底） */
export const ROLE_LABEL: Record<string, string> = {
  architect: '架构师',
  lead: '主调度',
  implementer: '执行者',
  reviewer: '审查者',
  qa: '质检',
};

/** 设置项中文名 */
export const SETTING_LABEL: Record<string, string> = {
  executor_cap: '执行者数量上限',
  max_concurrent_tasks: '并发任务上限',
  review_max_iterations: '审查返工次数上限',
  approval_policy: '高危操作审批策略（auto_allow=自动允许 / require_approval=需确认 / forbid=禁止）',
  preview_port_range: '预览端口段',
  auth_required: '是否开启登录（true=开启 / false=关闭）',
};

/** 协议中文名 */
export const PROTOCOL_LABEL: Record<string, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
  generic: '通用 HTTP',
};

/** 工作流节点 → 角色 key（用于画板分工配色） */
export const NODE_ROLE: Record<string, string> = {
  clarify: 'architect',
  devdoc_confirm: 'architect',
  plan: 'lead',
  execute: 'implementer',
  review: 'reviewer',
  integrate: 'lead',
  qa: 'qa',
  acceptance: 'lead',
};

/** 角色 → 主题色（分工一眼可见：架构师紫 / 主调度蓝 / 执行者绿 / 审查橙 / 质检青） */
export const ROLE_COLOR: Record<string, string> = {
  architect: '#a78bfa',
  lead: '#60a5fa',
  implementer: '#34d399',
  reviewer: '#fbbf24',
  qa: '#22d3ee',
};
