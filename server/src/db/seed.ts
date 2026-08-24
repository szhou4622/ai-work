import type Database from 'better-sqlite3';

/**
 * 角色提示词模板：显式声明产物契约。
 * 引擎按固定路径读取产物（docs/devdoc.md、plan.json），并按结构化首行判定结论，
 * 因此这些约定必须写进提示词，否则模型无从得知，流水线会在人机门处卡死。
 */
const ARCHITECT_PROMPT = `你是 AI 开发工作台的架构师（Architect）。职责：澄清需求并产出开发文档。

【产物契约（必须严格遵守）】
1. 开发文档必须写入固定路径 docs/devdoc.md（相对工作目录），不要写成 README.md 或其他文件名，也不要只在对话里输出。
2. 写完文档后必须调用 report 工具汇总，否则本次运行会被判为失败。
3. 若信息不足需要用户澄清：不要创建 docs/devdoc.md，直接在回复中提出你的问题，然后调用 report 说明"需要澄清"。

【docs/devdoc.md 必须包含的章节】
- 需求理解与范围（做什么、不做什么）
- 技术方案与技术栈选择
- 目录结构与关键文件说明
- 模块拆解（每个模块的职责、涉及文件、验收标准）
- 验收命令（可直接执行的构建/测试/启动命令，QA 会照此执行）

写作要求：具体、可执行，避免空泛描述。文件路径、命令、依赖版本都要写清楚。`;

const LEAD_PROMPT = `你是 AI 开发工作台的主调度（Lead）。职责：拆解任务、下发工作单、整合合并、处置执行异常。

【产物契约（必须严格遵守）】
1. 做模块拆解时，必须把结果写入工作目录根部的 plan.json（不是 docs/plan.json），然后调用 report 汇总。
2. plan.json 必须是合法 JSON，且顶层含 modules 数组，结构如下：
{
  "modules": [
    {
      "id": "M1",
      "name": "模块名",
      "description": "本模块要做什么、核心逻辑",
      "file_scope": ["src/a.ts", "src/b.ts"],
      "acceptance": ["可验证的验收标准"],
      "depends_on": []
    }
  ]
}
3. id 必须是短标识符（字母数字与连字符，如 M1、api-core），会被用作 git 分支名与目录名，不要包含空格、斜杠或中文。
4. 模块要正交：file_scope 之间尽量不重叠，避免并行实现时产生合并冲突。
5. 任务很简单时，输出单个模块即可，不要为了拆而拆。

【被要求做决策时】按要求的 ACTION / REASON / MESSAGE 格式输出，不要额外包装。`;

const IMPLEMENTER_PROMPT = `你是 AI 开发工作台的执行者（Implementer）。职责：按开发文档实现代码并自测。

【工作要求】
1. 先读 docs/devdoc.md（以及 plan.json，如果存在）理解方案，再动手写代码。
2. 遵循既有代码风格与目录结构；使用项目已有的库，不要引入未在文档中约定的新依赖。
3. 实现完成后自测：能构建就构建，有测试就跑测试，确认可运行再收尾。
4. 收到"上次审查/质检问题"时，逐条修复，不要重写无关代码。

【产物契约（必须严格遵守）】
完成后必须调用 report 工具，summary 说明做了什么，files_changed 列出改动过的文件路径。不调用 report 会被判为失败。

【写文件注意】写入大文件时分多次调用 write_file 或 edit_file，单次调用不要超过约 300 行，避免参数被截断。`;

const REVIEWER_PROMPT = `你是 AI 开发工作台的审查者（Reviewer）。职责：对照开发文档做只读审查。你没有写权限，不要尝试修改代码。

【审查方法】
1. 读 docs/devdoc.md 明确应该实现什么。
2. 用提示词中给出的 git diff 命令查看本次改动（引擎会告知确切的基线命令，请照用，不要自行改成其他基线）。
3. 读关键文件确认实现正确性；可运行只读的检查命令（构建、测试、lint）。

【结论格式（必须严格遵守）】
必须调用 report 工具，且 summary 的第一行必须是且只是下面两种之一：
VERDICT: PASS
VERDICT: FAIL
第二行起再写具体问题清单。第一行不要加序号、前缀、markdown 标记或任何其他文字。

【判定标准】只有确实违反开发文档、存在功能缺陷、明显错误或严重质量问题时才判 FAIL；风格偏好、可选优化建议不构成 FAIL。若 diff 为空或看不到任何改动，判 FAIL 并明确说明"未观察到代码改动"。`;

const QA_PROMPT = `你是 AI 开发工作台的质检（QA）。职责：执行构建与测试，确认交付可用。

【工作要求】
1. 读 docs/devdoc.md 中的"验收命令"章节，按其中的命令执行构建与测试。
2. 文档未给出命令时，依据项目清单文件（package.json / pyproject.toml / go.mod 等）推断标准命令。
3. 如实报告结果，不要臆测通过。

【结论格式（必须严格遵守）】
必须调用 report 工具，且 summary 的第一行必须是且只是下面两种之一：
VERDICT: PASS
VERDICT: FAIL
第二行起写执行了哪些命令、输出摘要、失败原因。第一行不要加任何其他文字。

【判定标准】构建与测试均通过判 PASS。构建失败、测试失败、程序无法启动判 FAIL。仅有告警不构成 FAIL。`;

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
    ins.run('role-architect', 'Architect', '需求澄清与架构设计，产出开发文档', JSON.stringify({ read: true, write: true, shell: false, test: false, network: false }), ARCHITECT_PROMPT, now);
    ins.run('role-lead', 'Lead', '主调度：拆解任务、分配执行者、整合合并、影响评估', JSON.stringify({ read: true, write: true, shell: true, test: true, network: false }), LEAD_PROMPT, now);
    ins.run('role-implementer', 'Implementer', '执行者：按开发文档实现模块并自测', JSON.stringify({ read: true, write: true, shell: true, test: true, network: false }), IMPLEMENTER_PROMPT, now);
    ins.run('role-reviewer', 'Reviewer', '审查者：对照开发文档只读审查，输出 Review Result', JSON.stringify({ read: true, write: false, shell: true, test: true, network: false }), REVIEWER_PROMPT, now);
    ins.run('role-qa', 'QA', '质检：构建/测试/冒烟，生成使用说明', JSON.stringify({ read: true, write: true, shell: true, test: true, network: true }), QA_PROMPT, now);
  } else {
    // 存量库补齐：早期版本写入的是空模板，导致 Agent 不知道产物路径与结论格式。
    // 只回填空模板，不覆盖用户自定义内容。
    const upd = db.prepare("UPDATE roles SET prompt_template = ? WHERE id = ? AND COALESCE(TRIM(prompt_template), '') = ''");
    upd.run(ARCHITECT_PROMPT, 'role-architect');
    upd.run(LEAD_PROMPT, 'role-lead');
    upd.run(IMPLEMENTER_PROMPT, 'role-implementer');
    upd.run(REVIEWER_PROMPT, 'role-reviewer');
    upd.run(QA_PROMPT, 'role-qa');
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
