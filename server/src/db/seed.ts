import type Database from 'better-sqlite3';

const DEFAULTS: Record<string, string> = {
  executor_cap: '2',
  max_concurrent_tasks: '2',
  review_max_iterations: '3',
  approval_policy: '"require_approval"',
  preview_port_range: '"45000-45019"',
  auth_required: 'false',
};

export function ensureSettings(db: Database.Database): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULTS)) stmt.run(k, v);
}

/** 内置工作流（开发文档 §8.1）：标准开发 / 快速修改 / Bug 修复 */
export function ensureBuiltinWorkflows(db: Database.Database): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM workflows WHERE builtin = 1').get() as { c: number }).c;
  if (count > 0) return;

  const now = Date.now();
  const standard = {
    nodes: [
      { id: 'clarify', role: 'architect', kind: 'clarify' },
      { id: 'devdoc_confirm', kind: 'human_gate', gate: 'devdoc' },
      { id: 'plan', role: 'lead', kind: 'plan' },
      { id: 'execute', kind: 'fanout', role: 'implementer' },
      { id: 'review', role: 'reviewer', kind: 'review_each', max_iterations: 3, on_exhaust: 'needs_human' },
      { id: 'integrate', role: 'lead', kind: 'integrate' },
      { id: 'qa', role: 'qa', kind: 'qa' },
      { id: 'acceptance', kind: 'human_gate', gate: 'acceptance' },
    ],
    edges: [
      ['clarify', 'devdoc_confirm'], ['devdoc_confirm', 'plan'], ['plan', 'execute'],
      ['execute', 'review'], ['review', 'integrate'], ['integrate', 'qa'], ['qa', 'acceptance'],
    ],
    policy: { implementer_neq_reviewer: true, executor_cap: 2 },
  };
  const quickFix = {
    nodes: [
      { id: 'clarify', role: 'architect', kind: 'clarify' },
      { id: 'devdoc_confirm', kind: 'human_gate', gate: 'devdoc' },
      { id: 'execute', kind: 'single_exec', role: 'implementer' },
      { id: 'review', role: 'reviewer', kind: 'review_each', max_iterations: 3, on_exhaust: 'needs_human' },
      { id: 'qa', role: 'qa', kind: 'qa' },
      { id: 'acceptance', kind: 'human_gate', gate: 'acceptance' },
    ],
    edges: [
      ['clarify', 'devdoc_confirm'], ['devdoc_confirm', 'execute'], ['execute', 'review'],
      ['review', 'qa'], ['qa', 'acceptance'],
    ],
    policy: { implementer_neq_reviewer: true, executor_cap: 1 },
  };
  const bugFix = JSON.parse(JSON.stringify(quickFix));
  bugFix.nodes[0] = { id: 'clarify', role: 'architect', kind: 'clarify' };

  const ins = db.prepare(
    'INSERT INTO workflows (id, name, version, kind, builtin, definition, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
  );
  ins.run('wf-standard', '标准开发', '1', 'standard', JSON.stringify(standard), now);
  ins.run('wf-quick-fix', '快速修改', '1', 'quick_fix', JSON.stringify(quickFix), now);
  ins.run('wf-bug-fix', 'Bug 修复', '1', 'bug_fix', JSON.stringify(bugFix), now);
}

/** 出厂默认角色与 Runtime（开发文档 附录 A 的 Role/Runtime 部分） */
export function ensureDefaultRolesAndRuntimes(db: Database.Database): void {
  const roleCount = (db.prepare('SELECT COUNT(*) AS c FROM roles').get() as { c: number }).c;
  if (roleCount === 0) {
    const ins = db.prepare('INSERT INTO roles (id, name, description, permission_defaults, prompt_template, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    ins.run('role-architect', 'Architect', '需求澄清与架构设计，产出开发文档', JSON.stringify({ read: true, write: true, shell: false, test: false, network: false }), '', now);
    ins.run('role-lead', 'Lead', '主调度：拆解任务、分配执行者、整合合并、影响评估', JSON.stringify({ read: true, write: true, shell: true, test: true, network: false }), '', now);
    ins.run('role-implementer', 'Implementer', '执行者：按开发文档实现模块并自测', JSON.stringify({ read: true, write: true, shell: true, test: true, network: false }), '', now);
    ins.run('role-reviewer', 'Reviewer', '审查者：对照开发文档只读审查，输出 Review Result', JSON.stringify({ read: true, write: false, shell: true, test: true, network: false }), '', now);
    ins.run('role-qa', 'QA', '质检：构建/测试/冒烟，生成使用说明', JSON.stringify({ read: true, write: true, shell: true, test: true, network: true }), '', now);
  }
  const rtCount = (db.prepare('SELECT COUNT(*) AS c FROM runtimes').get() as { c: number }).c;
  if (rtCount === 0) {
    const ins = db.prepare('INSERT INTO runtimes (id, type, name, executable, detect_cmd, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
    const now = Date.now();
    ins.run('rt-codex', 'cli', 'Codex CLI', 'codex', 'codex --version', JSON.stringify({}), now);
    ins.run('rt-claude', 'cli', 'Claude Code CLI', 'claude', 'claude --version', JSON.stringify({ env: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] }), now);
    ins.run('rt-api', 'api', 'API Runtime (OpenAI Compatible)', null, null, JSON.stringify({}), now);
  }
}
