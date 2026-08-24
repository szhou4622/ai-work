import { detectCommand, spawnStream } from './spawn.js';
import type { CliRunOptions, CliRunResult } from './codex.js';

/**
 * Claude Code CLI 适配器（开发文档 §9.3）
 * 线路注入：经 Provider+Secret 解析出 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
 * （用户的中转即通过此方式接入 Claude Code CLI）
 */
export async function claudeDetect(): Promise<{ installed: boolean; version?: string }> {
  return detectCommand('claude');
}

export async function claudeRun(opts: CliRunOptions): Promise<CliRunResult> {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json'];
  if (opts.sessionRef) {
    args.push('--resume', opts.sessionRef);
  }
  const res = await spawnStream({
    cmd: 'claude',
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
    onChunk: opts.onChunk,
  });
  return { code: res.code, output: res.output };
}
