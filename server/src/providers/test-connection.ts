import type { TestConnectionResult } from '@workbench/shared';
import { SecretStore } from '../secrets/store.js';
import { chatCompletion, listModels, OpenAICompatibleError } from './openai.js';
import { anthropicMessages, AnthropicError } from './anthropic.js';
import type { Provider } from '@workbench/shared';

/** 常见探测模型候选（按优先级逐个尝试） */
const PROBE_CANDIDATES = [
  'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner',
  'gpt-4o-mini', 'gpt-4o', 'gpt-4', 'gpt-3.5-turbo',
  'claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022',
  'qwen-plus', 'glm-4-flash', 'kimi-latest', 'moonshot-v1-8k',
];

/**
 * Provider 连通性测试（开发文档 §8.1）：可诊断错误分级
 * 策略：优先 model_mapping 中的模型 → 列出中转可用模型取前几个 → 常见模型名兜底，
 * 逐个尝试直到成功或全部失败；返回最后错误并附带已尝试模型清单。
 */
export async function testConnection(provider: Provider, secrets: SecretStore): Promise<TestConnectionResult> {
  const started = Date.now();
  const apiKey = secrets.get(provider.secret_ref);
  if (!apiKey) {
    return { ok: false, stage: 'auth', error: 'Secret 缺失', hint: '请重新保存该 Provider 的 API Key', latency_ms: 0 };
  }

  // 候选模型：mapping 值 → 中转可用模型列表 → 常见模型名
  const candidates: string[] = [];
  for (const v of Object.values(provider.model_mapping ?? {})) {
    if (typeof v === 'string' && v) candidates.push(v);
  }
  const models = await listModels(provider.base_url, apiKey, Math.min(15_000, provider.timeout_ms || 30_000)).catch(() => []);
  if (models.length > 0) candidates.push(...models.slice(0, 8));
  candidates.push(...PROBE_CANDIDATES);

  const seen = new Set<string>();
  const uniq = candidates.filter((c): c is string => !!c && !seen.has(c) && (seen.add(c), true));

  let lastErr: any = null;
  let lastModel = '';
  const isAnthropic = provider.protocol === 'anthropic';
  for (const model of uniq.slice(0, 12)) {
    try {
      if (isAnthropic) {
        await anthropicMessages({
          baseUrl: provider.base_url,
          apiKey,
          model,
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 16,
          timeoutMs: provider.timeout_ms || 30_000,
        });
      } else {
        await chatCompletion({
          baseUrl: provider.base_url,
          apiKey,
          model,
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 16,
          timeoutMs: provider.timeout_ms || 30_000,
          headers: provider.default_headers,
        });
      }
      return {
        ok: true,
        stage: 'ok',
        latency_ms: Date.now() - started,
        models: models.length > 0 ? models : undefined,
        error: `模型 ${model} 探测成功`,
      };
    } catch (err) {
      lastErr = err;
      lastModel = model;
    }
  }

  if (lastErr) {
    const tried = uniq.slice(0, 12).join(', ');
    let hint = lastErr.hint || '';
    const stageOf = lastErr.stage ?? (lastErr instanceof OpenAICompatibleError || lastErr instanceof AnthropicError ? lastErr.stage : 'protocol');
    // 响应非 JSON（可能是网页）：提示 Base URL 检查
    if (stageOf === 'protocol' && /不是合法 JSON|HTML|DOCTYPE/.test(lastErr.message)) {
      hint = '返回的不是 API JSON（可能是网页），请检查 Base URL 是否完整（OpenAI 兼容接口通常以 /v1 结尾，如 https://域名/v1）';
    }
    // Cloudflare 等风控拦截
    if (/Cloudflare|Attention Required|cf-[a-z]|challenge/i.test(lastErr.message)) {
      hint = '该站点对服务器直连有 Cloudflare 风控拦截（页面提示 Attention Required）。工作台部署在云服务器上，通常无法绕过；建议换用其他中转，或联系该中转确认是否有服务器可直连的接入点';
    }
    if (stageOf === 'model') {
      hint = `中转返回模型名错误：${lastErr.message.slice(0, 120)}。请在「模型映射」中把要用的模型名映射为该中转实际支持的模型（可用模型：${models.slice(0, 8).join(', ') || '未知，见错误信息'}）`;
    }
    // 探测失败但拿到可用模型列表：提示配置映射
    const modelSuggest = models.length > 0
      ? `。该中转实际可用模型：${models.slice(0, 8).join(', ')}——请在 Provider 的「模型映射」中把模型名配置为这些（例如 {"deepseek-v4-flash":"${models[0]}"}）`
      : '';
    return {
      ok: false,
      stage: stageOf,
      error: `${lastErr.message.slice(0, 200)}（最后尝试模型：${lastModel}）`,
      hint: `${hint}${modelSuggest}。已尝试模型：${tried}`,
      latency_ms: Date.now() - started,
      models: models.length > 0 ? models : undefined,
    };
  }

  return {
    ok: false,
    stage: 'protocol',
    error: '所有探测均未成功',
    hint: '无法连通该中转',
    latency_ms: Date.now() - started,
  };
}
