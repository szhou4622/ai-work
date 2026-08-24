import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';
import { chatCompletion } from '../../providers/openai.js';
import { anthropicMessages } from '../../providers/anthropic.js';
import { TOOL_SPECS, executeTool } from './tools.js';
import type { Agent } from '@workbench/shared';
import type { SecretStore } from '../../secrets/store.js';
import { getDb } from '../../db/index.js';

export interface ApiRunRequest {
  agent: Agent;
  provider: any;
  apiKey: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  input: string;
  workdir: string;
  permissions: Record<string, boolean>;
  maxSteps?: number;
}

export interface ApiRunResult {
  run_id: string;
  status: 'completed' | 'failed' | 'step_limit';
  output: string;
  report?: string;
  usage: { requests: number; prompt_tokens: number; completion_tokens: number };
}

/** 工具执行公共逻辑（权限校验 + 路径限制在工作目录内） */
async function runTool(name: string, args: any, ctx: { workdir: string; permissions: Record<string, boolean> }, log: (l: string) => void): Promise<{ ok: boolean; output: string }> {
  log(`[tool] ${name} ${JSON.stringify(args).slice(0, 800)}`);
  const result = await executeTool(name, args, ctx);
  log(`[tool-result] ${result.output.slice(0, 1500)}`);
  return result;
}

/**
 * API Runtime 工具调用循环（开发文档 §9.2）
 * 按中转配置的协议分发：OpenAI 兼容（tools/tool_calls）或 Anthropic 原生（tool_use/tool_result）。
 */
export async function runApiAgent(req: ApiRunRequest, onEvent?: (chunk: string) => void): Promise<ApiRunResult> {
  if (req.protocol === 'anthropic') {
    return runAnthropicLoop(req, onEvent);
  }
  return runOpenaiLoop(req, onEvent);
}

async function runOpenaiLoop(req: ApiRunRequest, onEvent?: (chunk: string) => void): Promise<ApiRunResult> {
  const runId = randomUUID();
  const runsDir = path.join(DATA_DIR, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const logFile = path.join(runsDir, `${runId}.log`);
  const log = (line: string) => {
    appendFileSync(logFile, line + '\n');
    onEvent?.(line + '\n');
  };

  log(`[run] ${runId} agent=${req.agent.name} model=${req.model} protocol=openai workdir=${req.workdir}`);
  log(`[input] ${req.input.slice(0, 2000)}`);

  const messages: any[] = [
    { role: 'system', content: '你是 AI 多 Agent 开发工作台中的执行 Agent。你拥有工具可以读写文件、执行命令、操作 git。请完成任务并在最后调用 report 工具输出结构化结果。所有路径均相对于工作目录。' },
    { role: 'user', content: req.input },
  ];
  const tools = TOOL_SPECS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const maxSteps = req.maxSteps ?? 100; // 增加到100以支持复杂审查任务
  const usage = { requests: 0, prompt_tokens: 0, completion_tokens: 0 };
  let lastOutput = '';

  // 上下文裁剪：防止工具结果无限累积导致上下文窗口溢出（模型返回空）
  const MAX_HISTORY_CHARS = 120000; // 约 3 万 token，覆盖绝大多数模型窗口
  const trimHistory = () => {
    let total = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
    while (total > MAX_HISTORY_CHARS && messages.length > 3) {
      let idx = -1;
      for (let i = 2; i < messages.length; i++) {
        if (messages[i].role === 'tool') { idx = i; break; }
      }
      if (idx === -1) break;
      const removed = messages.splice(idx, 1)[0];
      total -= (typeof removed.content === 'string' ? removed.content.length : 0);
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    trimHistory();
    let resp;
    try {
      resp = await chatCompletion({
        baseUrl: req.provider.base_url,
        apiKey: req.apiKey,
        model: req.model,
        messages,
        tools,
        maxTokens: 2048,
        timeoutMs: req.provider.timeout_ms || 120_000,
        headers: req.provider.default_headers,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[error] ${msg}`);
      return { run_id: runId, status: 'failed', output: lastOutput, report: undefined, usage };
    }

    usage.requests += 1;
    usage.prompt_tokens += resp.usage.prompt_tokens;
    usage.completion_tokens += resp.usage.completion_tokens;
    const content = resp.content ?? '';
    if (content) lastOutput += content;

    let toolCalls = resp.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const m = content.match(/__TOOL__\s*(\w+)\s*(\{[\s\S]*?\})/);
      if (m) toolCalls = [{ id: `call_${step}`, type: 'function', function: { name: m[1], arguments: m[2] } }];
    }

    if (toolCalls.length === 0) {
      log(`[assistant] ${content.slice(0, 2000)}`);
      if (!content.trim()) {
        log('[end] 模型无输出');
        return { run_id: runId, status: 'failed', output: lastOutput, report: undefined, usage };
      }
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: '请继续：若任务已完成请调用 report 工具汇总；否则请继续使用工具完成任务。' });
      continue;
    }

    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const name = tc.function?.name ?? '';
      // arguments 兼容字符串与对象两种格式（部分中转返回对象）
      let args: any = {};
      const raw = tc.function?.arguments;
      if (typeof raw === 'string' && raw.trim()) {
        try { args = JSON.parse(raw); } catch { args = {}; }
      } else if (raw && typeof raw === 'object') {
        args = raw;
      }
      const result = await runTool(name, args, { workdir: req.workdir, permissions: req.permissions }, log);
      if (name === 'report') {
        return { run_id: runId, status: 'completed', output: lastOutput, report: result.output, usage };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ ok: result.ok, output: result.output.slice(0, 6000) }),
      });
    }
  }

  log('[end] 达到步数上限');
  return { run_id: runId, status: 'step_limit', output: lastOutput, report: undefined, usage };
}

/** Anthropic 原生协议循环（/v1/messages + tool_use/tool_result） */
async function runAnthropicLoop(req: ApiRunRequest, onEvent?: (chunk: string) => void): Promise<ApiRunResult> {
  const runId = randomUUID();
  const runsDir = path.join(DATA_DIR, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const logFile = path.join(runsDir, `${runId}.log`);
  const log = (line: string) => {
    appendFileSync(logFile, line + '\n');
    onEvent?.(line + '\n');
  };

  log(`[run] ${runId} agent=${req.agent.name} model=${req.model} protocol=anthropic workdir=${req.workdir}`);
  log(`[input] ${req.input.slice(0, 2000)}`);

  const messages: any[] = [{ role: 'user', content: req.input }];
  const tools = TOOL_SPECS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const maxSteps = req.maxSteps ?? 100; // 增加到100以支持复杂审查任务
  const usage = { requests: 0, prompt_tokens: 0, completion_tokens: 0 };
  let lastOutput = '';

  // 上下文裁剪：防止工具结果无限累积导致上下文窗口溢出（模型返回空）
  const MAX_HISTORY_CHARS = 120000;
  const trimHistory = () => {
    let total = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
    while (total > MAX_HISTORY_CHARS && messages.length > 2) {
      let idx = -1;
      for (let i = 1; i < messages.length; i++) {
        // anthropic 的 tool_result 是 content 为数组的 user 消息
        if (messages[i].role === 'user' && Array.isArray(messages[i].content)) { idx = i; break; }
      }
      if (idx === -1) break;
      const removed = messages.splice(idx, 1)[0];
      total -= JSON.stringify(removed.content ?? '').length;
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    trimHistory();
    let resp;
    try {
      resp = await anthropicMessages({
        baseUrl: req.provider.base_url,
        apiKey: req.apiKey,
        model: req.model,
        messages,
        tools,
        maxTokens: 2048,
        timeoutMs: req.provider.timeout_ms || 120_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[error] ${msg}`);
      return { run_id: runId, status: 'failed', output: lastOutput, report: undefined, usage };
    }

    usage.requests += 1;
    usage.prompt_tokens += resp.usage.input_tokens;
    usage.completion_tokens += resp.usage.output_tokens;

    const blocks = resp.content ?? [];
    const textBlocks = blocks.filter((b) => b.type === 'text' && b.text);
    for (const b of textBlocks) {
      lastOutput += b.text ?? '';
      log(`[assistant] ${(b.text ?? '').slice(0, 2000)}`);
    }
    const toolUses = blocks.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      if (textBlocks.length === 0) {
        log('[end] 模型无输出');
        return { run_id: runId, status: 'failed', output: lastOutput, report: undefined, usage };
      }
      if (resp.stopReason === 'end_turn') {
        log('[end] 对话结束（模型未调用 report）');
        return { run_id: runId, status: 'failed', output: lastOutput, report: undefined, usage };
      }
      messages.push({ role: 'assistant', content: blocks });
      messages.push({ role: 'user', content: '请继续：若任务已完成请调用 report 工具汇总；否则请继续使用工具完成任务。' });
      continue;
    }

    messages.push({ role: 'assistant', content: blocks });

    const toolResults: any[] = [];
    for (const tu of toolUses) {
      const result = await runTool(tu.name ?? '', tu.input ?? {}, { workdir: req.workdir, permissions: req.permissions }, log);
      if (tu.name === 'report') {
        return { run_id: runId, status: 'completed', output: lastOutput, report: result.output, usage };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify({ ok: result.ok, output: result.output.slice(0, 6000) }),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  log('[end] 达到步数上限');
  return { run_id: runId, status: 'step_limit', output: lastOutput, report: undefined, usage };
}

/** 从 Agent 配置解析出可运行的 ApiRunRequest（provider/key/secret/model/协议解析） */
export function resolveApiRun(
  db: ReturnType<typeof getDb>,
  agent: Agent,
  secrets: SecretStore,
  input: string,
  workdir: string,
): ApiRunRequest {
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(agent.provider_id) as any;
  if (!provider) throw new Error(`Agent ${agent.name} 的 Provider 不存在`);

  // 优先使用 Agent 指定的密钥（provider_key_id），否则用 Provider 默认密钥
  let secretRef = provider.secret_ref;
  let protocol: 'openai' | 'anthropic' = provider.protocol === 'anthropic' ? 'anthropic' : 'openai';
  let modelMapping: Record<string, string> = JSON.parse(provider.model_mapping || '{}');
  if (agent.provider_key_id) {
    const key = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(agent.provider_key_id) as any;
    if (key) {
      secretRef = key.secret_ref;
      protocol = key.protocol === 'anthropic' ? 'anthropic' : 'openai';
      modelMapping = JSON.parse(key.model_mapping || '{}');
    }
  }

  const apiKey = secrets.get(secretRef);
  if (!apiKey) throw new Error(`Provider ${provider.name} 的 API Key 未配置`);
  const model = agent.model_id || Object.keys(modelMapping)[0];
  if (!model) throw new Error('未指定模型（agent.model_id 或模型映射）');

  return {
    agent,
    provider: {
      ...provider,
      default_headers: JSON.parse(provider.default_headers || '{}'),
      model_mapping: modelMapping,
    },
    apiKey,
    model,
    protocol,
    input,
    workdir,
    permissions: (() => {
      const p = JSON.parse(String(agent.permissions ?? '{}'));
      return Object.values(p).some(Boolean) ? p : { read: true, write: true, shell: true, test: true };
    })(),
  };
}
