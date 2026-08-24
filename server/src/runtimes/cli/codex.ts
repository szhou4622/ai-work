import { detectCommand, spawnStream } from './spawn.js';

export interface CliRunOptions {
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
  sessionRef?: string;
  timeoutMs?: number;
  onChunk?: (chunk: string) => void;
}

export interface CliRunResult {
  code: number | null;
  output: string;
  sessionRef?: string;
}

/** Codex CLI 适配器（订阅登录态，开发文档 §9.3） */
export async function codexDetect(): Promise<{ installed: boolean; version?: string }> {
  return detectCommand('codex');
}

export async function codexRun(opts: CliRunOptions): Promise<CliRunResult> {
  const args = ['exec', '--json'];
  if (opts.sessionRef) {
    args.push('resume', opts.sessionRef);
  }
  args.push(opts.prompt);
  const res = await spawnStream({
    cmd: 'codex',
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
    onChunk: opts.onChunk,
  });
  return { code: res.code, output: res.output };
}

/** 从 codex --json 输出中尽力解析用量（订阅线路拿不到精确金额，只记 token） */
export function parseCodexUsage(output: string): { prompt_tokens: number; completion_tokens: number } | null {
  // codex exec --json 输出的最后一条 result 消息含 usage 字段
  const lines = output.split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      const u = obj?.usage ?? obj?.result?.usage;
      if (u && (u.input_tokens !== undefined || u.prompt_tokens !== undefined)) {
        return {
          prompt_tokens: Number(u.input_tokens ?? u.prompt_tokens ?? 0),
          completion_tokens: Number(u.output_tokens ?? u.completion_tokens ?? 0),
        };
      }
    } catch { /* 跳过非 JSON 行 */ }
  }
  // 兜底：正则找 token 数字
  const m = output.match(/(?:input_tokens|prompt_tokens)[":\s]+(\d+)/i);
  const m2 = output.match(/(?:output_tokens|completion_tokens)[":\s]+(\d+)/i);
  if (m || m2) {
    return {
      prompt_tokens: m ? Number(m[1]) : 0,
      completion_tokens: m2 ? Number(m2[1]) : 0,
    };
  }
  return null;
}
