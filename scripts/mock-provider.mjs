#!/usr/bin/env node
// Mock OpenAI 兼容 Provider（集成测试用，开发文档 §12）
// 按系统提示中的角色标记返回确定性工具调用序列：
//   ARCHITECT → 写 docs/devdoc.md → report
//   LEAD     → 写 plan.json → report
//   REVIEWER → git diff → report PASS
//   QA       → 跑检查命令 → report PASS
//   默认(执行者) → 写 hello.txt → ls → report
import http from 'node:http';

const PORT = Number(process.env.PORT || 19999);

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function modeOf(messages) {
  const all = (messages || []).map((m) => (m.content || '')).join('\n').toUpperCase();
  if (all.includes('架构师')) return 'architect';
  if (all.includes('主调度')) return 'lead';
  if (all.includes('审查者')) return 'reviewer';
  if (all.includes('质检')) return 'qa';
  return 'implementer';
}

function stepOf(messages) {
  return messages.filter((m) => m.role === 'tool').length;
}

function buildMessage(mode, n, messages) {
  if (mode === 'architect') {
    if (n === 0) {
      return {
        role: 'assistant', content: '我将生成开发文档。',
        tool_calls: [{ id: 'a1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({
          path: 'docs/devdoc.md',
          content: '# 开发文档\n\n## 目标\n实现用户需求描述的功能。\n\n## 技术选型\nNode.js（示例）。\n\n## 模块拆分\n- 核心模块：入口、业务逻辑\n\n## 验收要点\n- 能运行、能测试\n\n## 构建与测试命令\n- 构建: npm run build\n- 测试: npm test',
        }) } }],
      };
    }
    return { role: 'assistant', content: '开发文档已生成，汇报。', tool_calls: [{ id: 'a2', type: 'function', function: { name: 'report', arguments: JSON.stringify({ summary: '开发文档已生成：docs/devdoc.md', files_changed: ['docs/devdoc.md'] }) } }] };
  }
  if (mode === 'lead') {
    if (n === 0) {
      return {
        role: 'assistant', content: '我将生成执行计划。',
        tool_calls: [{ id: 'l1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({
          path: 'plan.json',
          content: JSON.stringify({
            modules: [
              { id: 'm1', name: '模块一', description: '实现模块一', file_scope: ['m1.txt'], acceptance: ['文件存在'], depends_on: [] },
              { id: 'm2', name: '模块二', description: '实现模块二', file_scope: ['m2.txt'], acceptance: ['文件存在'], depends_on: [] },
            ],
            integration_notes: '两个独立模块，可并行',
          }),
        }) } }],
      };
    }
    return { role: 'assistant', content: '计划已生成。', tool_calls: [{ id: 'l2', type: 'function', function: { name: 'report', arguments: JSON.stringify({ summary: '执行计划已生成：plan.json（2 个并行模块）', files_changed: ['plan.json'] }) } }] };
  }
  if (mode === 'reviewer') {
    if (n === 0) {
      return { role: 'assistant', content: '查看变更。', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'git diff --stat' }) } }] };
    }
    return { role: 'assistant', content: '审查通过。', tool_calls: [{ id: 'r2', type: 'function', function: { name: 'report', arguments: JSON.stringify({ summary: 'REPORT_OK: PASS：实现符合开发文档' }) } }] };
  }
  if (mode === 'qa') {
    if (n === 0) {
      return { role: 'assistant', content: '运行检查。', tool_calls: [{ id: 'q1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'echo QA-CHECK-OK && ls' }) } }] };
    }
    return { role: 'assistant', content: '质检通过。', tool_calls: [{ id: 'q2', type: 'function', function: { name: 'report', arguments: JSON.stringify({ summary: 'REPORT_OK: PASS：构建与测试通过' }) } }] };
  }
  // implementer：按模块写入独立文件（验证 Worktree 隔离）
  const all = (messages || []).map((m) => (m.content || '')).join('\n');
  const modMatch = all.match(/负责模块\s*([\w-]+)/);
  const fileName = modMatch ? `module-${modMatch[1]}.txt` : 'hello.txt';
  const fileContent = modMatch ? `Hello from module ${modMatch[1]}` : 'Hello from AI Workbench';
  if (n === 0) {
    return { role: 'assistant', content: `创建文件 ${fileName}。`, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: fileName, content: fileContent }) } }] };
  }
  if (n === 1) {
    return { role: 'assistant', content: '列出目录。', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'ls -la' }) } }] };
  }
  return { role: 'assistant', content: '任务完成。', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'report', arguments: JSON.stringify({ summary: `任务完成：已创建 ${fileName} 并列出目录`, files_changed: [fileName] }) } }] };
}

const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (req.method === 'GET' && url.startsWith('/v1/models')) {
    return json(res, 200, { data: [{ id: 'mock-model', object: 'model' }] });
  }
  if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const messages = parsed.messages || [];
        const mode = modeOf(messages);
        const n = stepOf(messages);
        const message = buildMessage(mode, n, messages);
        return json(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: parsed.model || 'mock-model',
          choices: [{ index: 0, message, finish_reason: n >= 1 ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 100 + n * 50, completion_tokens: 40, total_tokens: 140 + n * 50 },
        });
      } catch (err) {
        return json(res, 400, { error: { message: 'bad request: ' + err.message } });
      }
    });
    return;
  }
  json(res, 404, { error: { message: 'not found: ' + url } });
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock provider listening on ${PORT}`));
