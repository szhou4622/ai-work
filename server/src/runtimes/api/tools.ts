import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** API Runtime 工具定义（开发文档 §9.2） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 需要的权限位（开发文档 §9.2 权限） */
  permission: 'read' | 'write' | 'shell' | 'test';
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: '读取文件内容（UTF-8 文本）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的文件路径' }, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['path'],
    },
    permission: 'read',
  },
  {
    name: 'write_file',
    description: '创建或覆盖写入文件；append=true 时在文件末尾追加（长文档可分批续写）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean', description: '为 true 时追加而非覆盖，默认 false' },
      },
      required: ['path', 'content'],
    },
    permission: 'write',
  },
  {
    name: 'edit_file',
    description: '在文件中精确替换一段文本（old 必须唯一匹配）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
      required: ['path', 'old', 'new'],
    },
    permission: 'write',
  },
  {
    name: 'list_dir',
    description: '列出目录内容',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径，默认 .' } },
      required: [],
    },
    permission: 'read',
  },
  {
    name: 'search',
    description: '在文件内容中搜索关键词（返回匹配行）',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: '搜索关键词或正则' }, glob: { type: 'string', description: '文件通配，默认 **' } },
      required: ['pattern'],
    },
    permission: 'read',
  },
  {
    name: 'run_command',
    description: '执行 shell 命令（如 npm test、python3 x.py），cwd 固定为工作目录',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string', description: '命令字符串' }, timeout_ms: { type: 'number', description: '超时毫秒，默认 120000' } },
      required: ['cmd'],
    },
    permission: 'shell',
  },
  {
    name: 'git_diff',
    description: '查看当前工作树未提交的改动',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'read',
  },
  {
    name: 'git_log',
    description: '查看最近提交记录',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: [],
    },
    permission: 'read',
  },
  {
    name: 'git_commit',
    description: '提交所有改动（message 必填）',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    permission: 'write',
  },
  {
    name: 'report',
    description: '完成任务并输出结构化结果（Handoff/报告）；调用后循环结束',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: '完成内容摘要' }, files_changed: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
      required: ['summary'],
    },
    permission: 'read',
  },
];

export interface ToolContext {
  workdir: string;
  permissions: Record<string, boolean>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** 路径必须落在工作目录内 */
function resolveIn(workdir: string, p: string): string {
  const abs = path.resolve(workdir, p || '.');
  const root = path.resolve(workdir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越界（不允许访问工作目录之外）: ${p}`);
  }
  return abs;
}

export async function executeTool(name: string, args: any, ctx: ToolContext): Promise<ToolResult> {
  const spec = TOOL_SPECS.find((t) => t.name === name);
  if (!spec) return { ok: false, output: `未知工具: ${name}` };
  if (!ctx.permissions[spec.permission]) {
    return { ok: false, output: `权限不足：该 Agent 未授予 ${spec.permission} 权限` };
  }

  try {
    let output: string;
    switch (name) {
      case 'read_file': {
        const p = resolveIn(ctx.workdir, args.path);
        const content = readFileSync(p, 'utf-8');
        const lines = content.split('\n');
        const offset = Math.max(0, Number(args.offset ?? 0));
        const limit = Number(args.limit ?? lines.length);
        const slice = lines.slice(offset, offset + limit);
        output = slice.map((l, i) => `${offset + i + 1}: ${l}`).join('\n');
        if (slice.length < lines.length) output += `\n... (共 ${lines.length} 行，已显示 ${slice.length} 行)`;
        break;
      }
      case 'write_file': {
        if (!args.path) return { ok: false, output: '参数错误：write_file 必须提供 path（相对工作目录的文件路径）与 content' };
        const p = resolveIn(ctx.workdir, args.path);
        mkdirSync(path.dirname(p), { recursive: true });
        const body = String(args.content ?? '');
        // append 让被输出长度限制截断的长文档可以分批续写，而不必从头重写
        if (args.append) {
          appendFileSync(p, body, 'utf-8');
          const total = statSync(p).size;
          output = `已追加 ${args.path} (+${Buffer.byteLength(body, 'utf-8')} bytes，共 ${total} bytes)`;
        } else {
          writeFileSync(p, body, 'utf-8');
          output = `已写入 ${args.path} (${Buffer.byteLength(body, 'utf-8')} bytes)`;
        }
        break;
      }
      case 'edit_file': {
        if (!args.path) return { ok: false, output: '参数错误：edit_file 必须提供 path' };
        const p = resolveIn(ctx.workdir, args.path);
        const content = readFileSync(p, 'utf-8');
        const idx = content.indexOf(args.old);
        if (idx < 0) return { ok: false, output: '未找到要替换的文本（old 不匹配）' };
        const next = content.indexOf(args.old, idx + 1);
        if (next >= 0) return { ok: false, output: 'old 文本出现多次，请提供更长的唯一片段' };
        writeFileSync(p, content.slice(0, idx) + args.new + content.slice(idx + args.old.length), 'utf-8');
        output = `已替换 ${args.path}`;
        break;
      }
      case 'list_dir': {
        const p = resolveIn(ctx.workdir, args.path ?? '.');
        const entries = readdirSync(p).map((e) => {
          let kind = 'file';
          try { if (statSync(path.join(p, e)).isDirectory()) kind = 'dir'; } catch { /* ignore */ }
          return `${kind === 'dir' ? '[d]' : '   '} ${e}`;
        });
        output = entries.join('\n') || '(空目录)';
        break;
      }
      case 'search': {
        const { execSync } = await import('node:child_process');
        const pattern = String(args.pattern).replace(/'/g, "'\\''");
        const glob = String(args.glob ?? '**');
        const cmd = `grep -rn --include="${glob}" -E "${pattern}" "${ctx.workdir}" 2>/dev/null | head -100`;
        try {
          output = execSync(cmd, { maxBuffer: 4 * 1024 * 1024 }).toString('utf-8').slice(0, 8000) || '(无匹配)';
        } catch {
          output = '(无匹配)';
        }
        break;
      }
      case 'run_command': {
        const timeout = Number(args.timeout_ms ?? 120000);
        output = await runCommand(ctx.workdir, String(args.cmd), timeout);
        break;
      }
      case 'git_diff':
        output = await runCommand(ctx.workdir, 'git diff --stat && echo ---- && git diff', 30000);
        break;
      case 'git_log': {
        const count = Number(args.count ?? 10);
        output = await runCommand(ctx.workdir, `git log --oneline -${count}`, 15000);
        break;
      }
      case 'git_commit':
        output = await runCommand(ctx.workdir, `git add -A && git commit -m "${String(args.message).replace(/"/g, '\\"')}"`, 30000);
        break;
      case 'report':
        output = `REPORT_OK: ${args.summary}`;
        break;
      default:
        return { ok: false, output: `未知工具: ${name}` };
    }
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

function runCommand(cwd: string, cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile('/bin/bash', ['-c', cmd], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, 12000);
      if (err) {
        resolve(`(退出码 ${(err as any).code ?? '?'})\n${out || err.message}`);
      } else {
        resolve(out || '(无输出)');
      }
    });
    // 保留子进程句柄避免悬空
    child.on('error', () => {});
  });
}

export { renameSync };
