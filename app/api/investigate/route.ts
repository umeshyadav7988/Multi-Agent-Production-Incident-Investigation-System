import { z } from 'zod';
import { runMultiAgent, runSingleAgent } from '@/run.ts';
import { SCENARIOS } from '@/data/scenarios/index.ts';
import type { EngineMode } from '@/core/llm/index.ts';
import { resolveModelConfig } from '@/core/llm/client.ts';

export const runtime = 'nodejs';
// Fluid Compute default; a full LLM investigation can take a couple of minutes.
export const maxDuration = 300;

const Body = z.object({
  incidentId: z.string(),
  approach: z.enum(['multi-agent', 'single-agent']).default('multi-agent'),
  engine: z.enum(['heuristic', 'llm']).optional(),
  seed: z.string().optional(),
  faultRate: z.number().min(0).max(1).optional(),
  includeTrace: z.boolean().default(false),
  includeEvidence: z.boolean().default(true),
});

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid request', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (!SCENARIOS.some((s) => s.id.toLowerCase() === body.incidentId.toLowerCase())) {
    return Response.json(
      { error: `unknown incident "${body.incidentId}"`, known: SCENARIOS.map((s) => s.id) },
      { status: 404 },
    );
  }

  // An LLM run with no credentials degrades to the deterministic engine and
  // says so, rather than returning a 500 the caller has to interpret.
  const model = resolveModelConfig();
  const requested: EngineMode = body.engine ?? (process.env.ENGINE === 'llm' ? 'llm' : 'heuristic');
  const engine: EngineMode = requested === 'llm' && model ? 'llm' : 'heuristic';

  try {
    const run = body.approach === 'single-agent' ? runSingleAgent : runMultiAgent;
    const outcome = await run({
      scenarioId: body.incidentId,
      engine,
      seed: body.seed,
      faultRate: body.faultRate,
      fastTools: true,
    });

    return Response.json({
      approach: body.approach,
      engine,
      provider: engine === 'llm' ? model?.provider ?? null : null,
      modelId: engine === 'llm' ? model?.modelId ?? null : null,
      engineDowngraded: requested === 'llm' && !model,
      report: outcome.report,
      metrics: outcome.metrics,
      ...(body.includeEvidence ? { evidence: outcome.evidence } : {}),
      ...(body.includeTrace ? { trace: outcome.trace } : {}),
    });
  } catch (e) {
    return Response.json(
      { error: 'investigation failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
