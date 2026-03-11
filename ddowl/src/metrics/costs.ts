// LLM provider pricing (USD per 1M tokens)
// Prices as of January 2026
export const PROVIDER_PRICING = {
  deepseek: {
    input: 0.14,   // $0.14 per 1M input tokens
    output: 0.28,  // $0.28 per 1M output tokens
  },
  kimi: {
    input: 0.70,   // ¥5 per 1M ≈ $0.70
    output: 1.40,  // ¥10 per 1M ≈ $1.40
  },
  gemini: {
    input: 0.075,  // $0.075 per 1M input tokens (Flash)
    output: 0.30,  // $0.30 per 1M output tokens (Flash)
  },
} as const;

export const SERPER_COST_PER_QUERY = 0.001; // ~$0.001 per search credit

export type Provider = keyof typeof PROVIDER_PRICING;

export function estimateCost(
  provider: Provider,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = PROVIDER_PRICING[provider];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

// Estimate tokens from string length (rough approximation)
// Chinese: ~1.5 chars per token, English: ~4 chars per token
export function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}
