import { spawn } from 'node:child_process';

export interface SpawnOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onChunk?: (chunk: string) => void;
}

export interface SpawnResult {
  code: number | null;
  output: string;
}

/** 流式执行子进程：逐块回调 + 汇总输出（开发文档 §19 CLI Runtime） */
export function spawnStream(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, output });
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output += text;
      opts.onChunk?.(text);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      output += `\n[spawn error] ${err.message}`;
      opts.onChunk?.(`\n[spawn error] ${err.message}`);
      done(null);
    });
    child.on('close', (code) => done(code));

    if (opts.timeoutMs) {
      setTimeout(() => {
        if (!settled) {
          output += '\n[timeout]';
          child.kill('SIGKILL');
          done(-1);
        }
      }, opts.timeoutMs).unref();
    }
  });
}

/** 同步探测命令是否存在（返回 stdout 首行） */
export function detectCommand(cmd: string): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', () => resolve({ installed: false }));
    child.on('close', (code) => resolve({ installed: code === 0, version: out.trim().split('\n')[0] }));
  });
}
