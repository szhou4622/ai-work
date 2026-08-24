/**
 * 日志/Prompt 脱敏器（开发文档 §9.10 / §18）
 * - 已知 Secret 值全部替换为 [REDACTED]
 * - 通用模式：Authorization 头、URL query 中的 token/key/secret
 */
export function redactText(text: string, secretValues: string[]): string {
  let out = text;
  for (const v of secretValues) {
    if (v && v.length >= 4) {
      out = out.split(v).join('[REDACTED]');
    }
  }
  // Authorization: Bearer xxx
  out = out.replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,]+/gi, '$1[REDACTED]');
  // URL query 中的敏感参数
  out = out.replace(/([?&](?:api[_-]?key|token|secret|key|password|signature)=)[^&\s]+/gi, '$1[REDACTED]');
  // x-api-key 头
  out = out.replace(/(x-api-key\s*:\s*)[^\s]+/gi, '$1[REDACTED]');
  return out;
}
