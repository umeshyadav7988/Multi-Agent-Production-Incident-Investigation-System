import { SCENARIOS } from '@/data/scenarios/index.ts';
import { resolveModelConfig } from '@/core/llm/client.ts';

export const runtime = 'nodejs';
export const maxDuration = 60;

export function GET(): Response {
  const model = resolveModelConfig();
  return Response.json({
    ok: true,
    service: 'incident-investigator',
    engine: process.env.ENGINE ?? 'heuristic',
    // Reports which provider would answer, never the credential itself.
    provider: model?.provider ?? null,
    modelId: model?.modelId ?? null,
    modelConfigured: model !== null,
    incidents: SCENARIOS.length,
    time: new Date().toISOString(),
  });
}
