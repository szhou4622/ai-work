/** 费用估算：按模型匹配价格表（USD / 百万 tokens）。开发文档 §9.9 / FR-25 */
const PRICE_TABLE: { match: RegExp; input: number; output: number }[] = [
  { match: /deepseek-v4-pro/i, input: 0.28, output: 0.42 },
  { match: /deepseek-v4-flash/i, input: 0.07, output: 0.07 },
  { match: /deepseek-reasoner/i, input: 0.55, output: 2.19 },
  { match: /claude-opus/i, input: 3, output: 15 },
  { match: /claude-fable/i, input: 3, output: 15 },
  { match: /claude-sonnet/i, input: 1.25, output: 7.5 },
  { match: /claude-haiku/i, input: 0.25, output: 1.25 },
  { match: /gpt-5\.6/i, input: 1.25, output: 10 },
  { match: /gpt-5\.5/i, input: 1.25, output: 10 },
  { match: /gpt-5\.4/i, input: 1.25, output: 10 },
  { match: /gpt-5\.1|gpt-5\.2|gpt-5\.3/i, input: 1.25, output: 10 },
  { match: /gpt-5/i, input: 1.25, output: 10 },
  { match: /gpt-4o/i, input: 2.5, output: 10 },
  { match: /gpt-4\.1/i, input: 2, output: 8 },
  { match: /gpt-4/i, input: 30, output: 60 },
  { match: /qwen/i, input: 0.5, output: 2 },
  { match: /glm/i, input: 0.5, output: 2 },
];
const DEFAULT_PRICE: PriceInfo = { inputPer1m: 0.5, outputPer1m: 1.5 };

export interface PriceInfo {
  inputPer1m: number;
  outputPer1m: number;
}

export function priceFor(model: string): PriceInfo {
  for (const p of PRICE_TABLE) {
    if (p.match.test(model)) return { inputPer1m: p.input, outputPer1m: p.output };
  }
  return DEFAULT_PRICE;
}

/** 估算一次调用的费用（USD） */
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model);
  return (promptTokens / 1_000_000) * p.inputPer1m + (completionTokens / 1_000_000) * p.outputPer1m;
}
