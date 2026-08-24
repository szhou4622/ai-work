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
  /** 单次回复的最大输出 token；长文档节点（架构/开发文档）应调大 */
  maxTokens?: number;
}

export interface ApiRunResult {
  run_id: string;
  status: 'completed' | 'failed' | 'step_limit';
  output: string;
  report?: string;
  usage: { requests: number; prompt_tokens: number; completion_tokens: number };
}

/**
 * 两种协议共用的系统提示词。
 * 之前只有 OpenAI 分支有系统提示，Anthropic 分支完全没有，导致同一任务在
 * 两种中转下行为不一致（尤其是不知道必须调用 report 收尾）。
 */
const SYSTEM_PROMPT = [
  '你是 AI 多 Agent 开发工作台中的执行 Agent。你拥有工具可以读写文件、执行命令、操作 git。所有路径均相对于工作目录。',
  '硬性要求：任务完成后必须调用 report 工具输出结构化结果，否则本次运行视为失败。',
  '写长文档（架构文档、开发文档等）时不要把内容写在回复正文里，一定要用 write_file 落盘；内容较长时分批写入：第一段默认覆盖，后续每段用 append: true 追加到同一文件。',
].join('\n');

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
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: req.input },
  ];
  const tools = TOOL_SPECS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const maxSteps = req.maxSteps ?? 100; // 增加到100以支持复杂审查任务
  const usage = { requests: 0, prompt_tokens: 0, completion_tokens: 0 };
  let lastOutput = '';
  let emptyRetries = 0;

  /**
   * 上下文裁剪：防止工具结果无限累积导致上下文窗口溢出（模型返回空）。
   *
   * 必须成对删除 assistant(tool_calls) 与其全部 tool 回复：OpenAI 兼容接口要求
   * 每个 tool_calls 后面紧跟对应 tool_call_id 的结果，只删 tool 消息会留下
   * 孤儿 tool_calls，导致整个请求被 400 拒绝，长任务必然中断。
   */
  const MAX_HISTORY_CHARS = 120000; // 约 3 万 token，覆盖绝大多数模型窗口
  const sizeOf = (m: any) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length)
    + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  const trimHistory = () => {
    let total = messages.reduce((s, m) => s + sizeOf(m), 0);
    let trimmed = 0;
    // 保留 system + 首个 user 任务描述（前 2 条）
    while (total > MAX_HISTORY_CHARS) {
      const idx = messages.findIndex((m, i) => i >= 2 && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
      if (idx === -1) break;
      let end = idx + 1;
      while (end < messages.length && messages[end].role === 'tool') end++;
      if (end >= messages.length) break; // 最近一轮未闭合，保留
      const removed = messages.splice(idx, end - idx);
      total -= removed.reduce((s, m) => s + sizeOf(m), 0);
      trimmed++;
    }
    if (trimmed > 0) log(`[trim] 已省略 ${trimmed} 轮早期工具调用记录以节省上下文`);
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
        // 开发文档等长产物需要充足输出预算；2048 会把架构师的文档截断在半句话，
        // 后续 devdoc 校验必然失败并触发无意义返工。
        maxTokens: req.maxTokens ?? 8192,
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
        // 空输出常见于上下文超限或中转异常，重试一次并提示压缩输出
        if (emptyRetries < 1) {
          emptyRetries++;
          log('[warn] 模型返回空内容，裁剪历史后重试一次');
          messages.push({ role: 'user', content: '上一次回复为空。请直接调用工具推进任务，不要输出空回复。' });
          continue;
        }
        log('[end] 模型无输出');
        return { run_id: runId, status: 'failed', output: lastOutput, report: undefined, usage };
      }
      emptyRetries = 0;
      messages.push({ role: 'assistant', content });
      // 输出被 max_tokens 截断时，提示模型分批写入而不是重头再来
      messages.push({
        role: 'user',
        content: resp.finish_reason === 'length'
          ? '你的输出被长度限制截断了。不要在回复里直接写长文档：请用 write_file 分批写入（第一段用默认覆盖模式，后续每段用 append: true 追加到同一文件），全部写完后调用 report 工具汇总。'
          : '请继续：若任务已完成请调用 report 工具汇总；否则请继续使用工具完成任务。',
      });
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
  let nudges = 0;

  /**
   * 上下文裁剪：assistant(tool_use) 与随后的 user(tool_result) 必须成对删除，
   * 否则 Anthropic 会因 tool_use 缺少对应 tool_result 直接 400。
   *
   * 这里整轮删除且不插入占位消息：Anthropic 要求 user/assistant 严格交替，
   * 每轮插一条 assistant 占位会产生连续同角色消息，同样会被 400 拒绝。
   * 整轮删除后剩下的仍是 user → assistant → user 的合法交替序列。
   */
  const MAX_HISTORY_CHARS = 120000;
  const sizeOf = (m: any) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length);
  const trimHistory = () => {
    let total = messages.reduce((s, m) => s + sizeOf(m), 0);
    let trimmed = 0;
    while (total > MAX_HISTORY_CHARS) {
      const idx = messages.findIndex((m, i) =>
        i >= 1 && m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use'));
      if (idx === -1) break;
      let end = idx + 1;
      while (end < messages.length && messages[end].role === 'user' && Array.isArray(messages[end].content)) end++;
      if (end >= messages.length) break; // 最近一轮未闭合，保留
      const removed = messages.splice(idx, end - idx);
      total -= removed.reduce((s, m) => s + sizeOf(m), 0);
      trimmed++;
    }
    if (trimmed > 0) log(`[trim] 已省略 ${trimmed} 轮早期工具调用记录以节省上下文`);
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
        system: SYSTEM_PROMPT,
        // 与 OpenAI 分支保持一致：长文档产物需要足够输出预算
        maxTokens: req.maxTokens ?? 8192,
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
      // end_turn 只代表这一轮说完了。直接判失败会让"干完活但忘记调用 report"
      // 的任务整条流水线报废，这里先催办两次再放弃。
      if (nudges >= 2) {
        log('[end] 多次提示后模型仍未调用 report');
        return { run_id: runId, status: 'failed', output: lastOutput, report: undefined, usage };
      }
      nudges++;
      messages.push({ role: 'assistant', content: blocks });
      messages.push({
        role: 'user',
        content: resp.stopReason === 'max_tokens'
          ? '你的输出被长度限制截断了。不要在回复里直接写长文档：请用 write_file 分批写入（第一段用默认覆盖模式，后续每段用 append: true 追加到同一文件），全部写完后调用 report 工具汇总。'
          : '你还没有调用 report 工具。若任务已完成，请立即调用 report 工具输出结构化结果；否则请继续使用工具完成任务。',
      });
      continue;
    }
    nudges = 0;

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
