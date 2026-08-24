/** Anthropic 原生协议客户端（Messages API + tool_use/tool_result），开发文档 §6 / §9.2 */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: any;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: any; // string 或块数组
}

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AnthropicResult {
  content: AnthropicContentBlock[];
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number };
}

export class AnthropicError extends Error {
  constructor(
    message: string,
    public stage: 'auth' | 'model' | 'rate_limit' | 'timeout' | 'connect' | 'protocol',
    public status?: number,
    public hint?: string,
  ) {
    super(message);
  }
}

export async function anthropicMessages(opts: AnthropicOptions): Promise<AnthropicResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 2048,
        messages: opts.messages,
        ...(opts.tools ? { tools: opts.tools } : {}),
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (/aborted|timeout/i.test(msg)) throw new AnthropicError(msg, 'timeout', undefined, '请求超时');
    throw new AnthropicError(msg, 'connect', undefined, '网络错误');
  } finally {
    clearTimeout(timer);
  }

  const txt = await res.text();
  if (!res.ok) {
    let hint = txt.slice(0, 200);
    if (res.status === 401 || res.status === 403) hint = 'API Key 无效或无权限';
    if (res.status === 404) hint = '模型不存在或协议不被中转支持';
    if (res.status === 429) hint = '触发限流';
    throw new AnthropicError(txt.slice(0, 300), res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'auth' : 'model', res.status, hint);
  }

  let d: any;
  try { d = JSON.parse(txt); } catch {
    throw new AnthropicError('响应不是合法 JSON', 'protocol', res.status, '该中转可能不支持 Anthropic 原生协议');
  }

  return {
    content: (d.content ?? []) as AnthropicContentBlock[],
    stopReason: d.stop_reason ?? '',
    usage: {
      input_tokens: d.usage?.input_tokens ?? 0,
      output_tokens: d.usage?.output_tokens ?? 0,
      cache_read_tokens: d.usage?.cache_read_input_tokens ?? 0,
    },
  };
}
