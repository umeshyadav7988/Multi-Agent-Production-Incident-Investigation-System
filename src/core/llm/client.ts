import type { z } from 'zod';

export type Provider = 'groq' | 'anthropic' | 'gateway';

export interface ModelConfig {
  provider: Provider;
  modelId: string;
  apiKey?: string | undefined;
}

export interface StructuredResult<T> {
  object: T;
  inputTokens: number;
  outputTokens: number;
}

/** Default model per provider, used when MODEL_ID is unset. */
const DEFAULT_MODEL: Record<Provider, string> = {
  groq: 'openai/gpt-oss-120b',
  anthropic: 'claude-sonnet-5-5',
  gateway: 'anthropic/claude-sonnet-5-5',
};

/**
 * Picks a provider from whatever credentials exist.
 *
 * Precedence is explicit rather than clever: an operator who sets two keys gets
 * the first one listed, and the choice is reported in the trace so a run is
 * never ambiguous about what answered it.
 */
export function resolveModelConfig(modelIdOverride?: string): ModelConfig | null {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase() as Provider | undefined;
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const modelId = modelIdOverride ?? process.env.MODEL_ID?.trim();

  const pick = (provider: Provider, apiKey?: string): ModelConfig => ({
    provider,
    apiKey,
    modelId: modelId || DEFAULT_MODEL[provider],
  });

  if (explicit === 'groq' && groqKey) return pick('groq', groqKey);
  if (explicit === 'anthropic' && anthropicKey) return pick('anthropic', anthropicKey);
  if (explicit === 'gateway' && gatewayKey) return pick('gateway', gatewayKey);

  if (groqKey) return pick('groq', groqKey);
  if (gatewayKey) return pick('gateway', gatewayKey);
  if (anthropicKey) return pick('anthropic', anthropicKey);
  return null;
}

/** Resolves a model handle. Providers are imported lazily so a deterministic
 *  run never loads an SDK it will not use. */
export async function resolveModel(cfg: ModelConfig): Promise<unknown> {
  switch (cfg.provider) {
    case 'gateway':
      // The gateway routes plain "provider/model" strings itself.
      return cfg.modelId.includes('/') ? cfg.modelId : `anthropic/${cfg.modelId}`;
    case 'groq': {
      if (!cfg.apiKey) throw new Error('GROQ_API_KEY is not set');
      const mod = await import('@ai-sdk/groq');
      const create = (mod as unknown as { createGroq: (o: { apiKey: string }) => (id: string) => unknown }).createGroq;
      return create({ apiKey: cfg.apiKey })(cfg.modelId);
    }
    case 'anthropic': {
      if (!cfg.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      const mod = await import('@ai-sdk/anthropic');
      const create = (mod as unknown as { createAnthropic: (o: { apiKey: string }) => (id: string) => unknown }).createAnthropic;
      return create({ apiKey: cfg.apiKey })(cfg.modelId);
    }
  }
}

/**
 * One schema-constrained model call.
 *
 * Wrapped in a single place so both the multi-agent system and the baseline are
 * measured against the same call shape, and so the AI SDK surface is touched in
 * exactly one file.
 */
export async function generateStructured<T>(args: {
  model: unknown;
  schema: z.ZodTypeAny;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  maxRetries?: number;
}): Promise<StructuredResult<T>> {
  const { generateText, Output } = await import('ai');
  const res = await (generateText as unknown as (o: Record<string, unknown>) => Promise<{
    output: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>)({
    model: args.model,
    system: args.system,
    prompt: args.prompt,
    temperature: args.temperature ?? 0.2,
    maxOutputTokens: args.maxOutputTokens ?? 4000,
    // The caller owns retrying. The SDK's own retry loop would nest inside
    // ours, multiplying attempts (2 x 3 = 6) and, on a 429 carrying a 60s
    // retry-after, turning one logical call into minutes of blocked waiting.
    maxRetries: args.maxRetries ?? 0,
    output: Output.object({ schema: args.schema }),
  });

  return {
    object: res.output as T,
    inputTokens: res.usage?.inputTokens ?? 0,
    outputTokens: res.usage?.outputTokens ?? 0,
  };
}
