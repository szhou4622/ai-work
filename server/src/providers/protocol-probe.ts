/** 协议自动探测：检测中转支持 OpenAI 兼容（/chat/completions）还是 Anthropic 兼容（/messages）端点 */
export interface ProtocolProbe {
  openai: boolean;
  anthropic: boolean;
}

async function probeEndpoint(url: string, body: any, headers: Record<string, string>): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    // 200/401/403/400 均说明端点存在（只是 key/模型问题）；404 说明端点不存在
    return res.status !== 404;
  } catch {
    return false;
  }
}

export async function probeProtocols(baseUrl: string, apiKey: string): Promise<ProtocolProbe> {
  const base = baseUrl.replace(/\/+$/, '');
  const openai = await probeEndpoint(
    `${base}/chat/completions`,
    { model: 'probe-model-check', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
    { Authorization: `Bearer ${apiKey}` },
  );
  const anthropic = await probeEndpoint(
    `${base}/messages`,
    { model: 'probe-model-check', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
    { Authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' },
  );
  return { openai, anthropic };
}

/** 根据探测结果 + 模型名推荐协议 */
export function recommendProtocol(probe: ProtocolProbe, model: string): 'openai' | 'anthropic' {
  if (probe.anthropic && !probe.openai) return 'anthropic';
  if (probe.openai && !probe.anthropic) return 'openai';
  // 两者都支持：Claude 系模型优先 Anthropic 原生（工具调用参数完整）
  if (/claude/i.test(model)) return 'anthropic';
  return 'openai';
}
