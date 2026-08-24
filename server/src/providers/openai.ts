/** OpenAI 兼容协议客户端（开发文档 §8 / §9.11） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  tools?: any[];
}

export interface ChatCompletionResult {
  content: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

export class OpenAICompatibleError extends Error {
  constructor(
    message: string,
    public stage: 'dns' | 'connect' | 'auth' | 'model' | 'protocol' | 'rate_limit' | 'timeout',
    public status?: number,
    public hint?: string,
  ) {
    super(message);
  }
}

function classifyError(err: unknown, status?: number): OpenAICompatibleError {
  if (err instanceof OpenAICompatibleError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return new OpenAICompatibleError(msg, 'dns', status, '域名无法解析，请检查 Base URL');
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) {
    return new OpenAICompatibleError(msg, 'connect', status, '无法连接服务器，请检查地址与网络');
  }
  if (/aborted|timeout/i.test(msg)) {
    return new OpenAICompatibleError(msg, 'timeout', status, '请求超时');
  }
  return new OpenAICompatibleError(msg, 'protocol', status, '未知网络错误');
}

function classifyHttp(status: number, body: string): OpenAICompatibleError {
  const hint = (body || '').slice(0, 200);
  if (status === 401 || status === 403) {
    return new OpenAICompatibleError(hint, 'auth', status, 'API Key 无效、过期或无权限');
  }
  if (status === 404) {
    return new OpenAICompatibleError(hint, 'model', status, '接口路径或模型不存在');
  }
  if (status === 429) {
    return new OpenAICompatibleError(hint, 'rate_limit', status, '触发限流，请稍后重试或降低并发');
  }
  if (status === 400) {
    return new OpenAICompatibleError(hint, 'protocol', status, '请求参数不被接受（模型名/协议不匹配）');
  }
  if (status >= 500) {
    return new OpenAICompatibleError(hint, 'connect', status, '中转服务端错误');
  }
  return new OpenAICompatibleError(hint, 'protocol', status, '未知 HTTP 错误');
}

export async function chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const url = opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 256,
        temperature: opts.temperature ?? 0.2,
        stream: false,
        ...(opts.tools ? { tools: opts.tools } : {}),
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    throw classifyError(err);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw classifyHttp(res.status, bodyText);
  }

  let json: any;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new OpenAICompatibleError('响应不是合法 JSON', 'protocol', res.status, '协议不兼容（非 OpenAI 兼容接口）');
  }

  const usage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const message = json.choices?.[0]?.message;
  return {
    content: message?.content ?? null,
    tool_calls: message?.tool_calls,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    },
    model: json.model ?? opts.model,
  };
}

export async function listModels(baseUrl: string, apiKey: string, timeoutMs = 15_000): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    // 完整返回模型列表（不截断：大中转如 DMX 有 500+ 模型，截断会漏掉排序靠后的模型）
    return (json.data ?? []).map((m: any) => m.id).slice(0, 2000);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
