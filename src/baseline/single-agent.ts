import { z } from 'zod';
import type { RunContext } from '../run.ts';
import type { ReasoningEngine } from '../core/llm/engine.ts';
import { LlmEngine } from '../core/llm/llm.ts';
import { Blackboard } from '../core/blackboard.ts';
import { ObservabilityAgent } from '../agents/observability.ts';
import { DependencyAgent } from '../agents/dependency.ts';
import { ReportingAgent } from '../agents/reporting.ts';
import type { AgentDeps } from '../agents/base.ts';
import { makeEvidence } from '../agents/base.ts';
import type { Task, InvestigationOutcome, RunMetrics, AgentResult } from '../core/types.ts';
import { withRetry } from '../core/retry.ts';
import { generateStructured, resolveModel, resolveModelConfig } from '../core/llm/client.ts';
import { TokenRateLimiter, estimateTokens } from '../core/llm/throttle.ts';

/** The baseline is throttled identically to the multi-agent system, so the
 *  comparison is not distorted by one side absorbing rate-limit failures the
 *  other avoids. */
let baselineLimiter: TokenRateLimiter | null = null;
function limiter(onWait: (ms: number, why: string) => void): TokenRateLimiter {
  baselineLimiter ??= new TokenRateLimiter(Number(process.env.LLM_TOKENS_PER_MINUTE ?? 0), onWait);
  return baselineLimiter;
}

/**
 * Single-agent baseline.
 *
 * Same world, same tools, same reasoning engine, same evidence extraction. The
 * differences are exactly the orchestration features under test:
 *
 *   - one sequential pass; no parallel fan-out
 *   - no dedicated correlation step, so no topology-aware upstream/downstream
 *     cross-referencing of symptoms
 *   - no critic, so no challenge to the conclusion and no second round
 *   - no cross-source contradiction detection
 *   - no targeted follow-up probes
 *
 * Holding everything else constant is what makes the A/B meaningful: any
 * difference in accuracy or grounding is attributable to coordination, not to
 * a better prompt or a better model.
 */
export async function runSingleAgentBaseline(
  ctx: RunContext,
  engine: ReasoningEngine,
): Promise<InvestigationOutcome> {
  const { telemetry, budget, tools } = ctx;
  telemetry.emit('run_start', `single-agent baseline on ${ctx.incident.id}`, {
    agent: 'orchestrator',
    data: { engine: engine.name },
  });

  const bb = new Blackboard(ctx.incident, telemetry);
  bb.knownServices = ctx.knownServices;
  const deps: AgentDeps = { tools, engine, budget, telemetry, maxRounds: 1 };

  if (engine instanceof LlmEngine) {
    await gatherViaReactLoop(ctx, bb, deps);
  } else {
    await gatherSequentially(bb, deps);
  }

  // Onset estimate without the dedicated correlation step: the single agent
  // takes the earliest timestamp it happens to have, with no topology check.
  const times = bb
    .allEvidence()
    .map((e) => (e.observedAt ? Date.parse(e.observedAt) : NaN))
    .filter((t) => !Number.isNaN(t));
  bb.onsetEstimate = times.length ? new Date(Math.min(...times)).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;

  // One reasoning pass: hypothesise, score, report. No critique, no revision.
  const topology = bb
    .evidenceByTag('dependency_edge')
    .map((e) => e.raw as { service: string; dependencies: string[]; dependents: string[]; critical: string[] })
    .filter((t) => !!t && typeof t === 'object' && 'service' in t);

  const hyp = await engine.hypothesise({
    incident: bb.incident,
    evidence: bb.allEvidence(),
    existing: [],
    topology,
    onsetEstimate: bb.onsetEstimate,
  });
  for (const h of hyp.hypotheses) {
    bb.upsertHypothesis({
      id: '', title: h.title, category: h.category, suspectService: h.suspectService,
      statement: h.statement, supporting: h.supporting, contradicting: h.contradicting,
      testablePredictions: h.testablePredictions, confidence: 0, status: 'open',
      proposedBy: 'reasoning',
    });
  }

  const scored = await engine.score({
    incident: bb.incident,
    evidence: bb.allEvidence(),
    hypotheses: bb.allHypotheses(),
    onsetEstimate: bb.onsetEstimate,
    degraded: bb.allDegradations().length > 0,
  });
  for (const s of scored.scores) {
    bb.updateHypothesis(s.hypothesisId, { confidence: s.confidence, status: s.status });
  }

  const terminationReason = 'completed: single-agent baseline makes exactly one pass with no review';
  const report = await new ReportingAgent().compose(bb, deps, terminationReason);

  telemetry.emit('terminate', terminationReason, { agent: 'orchestrator' });
  telemetry.emit('run_end', `verdict=${report.verdict}`, { agent: 'orchestrator' });

  const metrics: RunMetrics = {
    approach: 'single-agent',
    incidentId: bb.incident.id,
    wallClockMs: telemetry.elapsedMs(),
    toolCalls: telemetry.toolCalls,
    toolFailures: telemetry.toolFailures,
    toolRetries: telemetry.toolRetries,
    tokensIn: telemetry.tokensIn,
    tokensOut: telemetry.tokensOut,
    llmCalls: telemetry.llmCalls,
    agentTasksRun: bb.allTasks().length,
    agentTaskFailures: bb.allTasks().filter((t) => t.status === 'failed').length,
    rounds: 1,
    evidenceCount: bb.allEvidence().length,
    hypothesesConsidered: bb.allHypotheses().length,
    terminationReason,
  };

  return { report, metrics, trace: telemetry.events, evidence: bb.allEvidence() };
}

/* ========================================================================= */
/* Deterministic mode: one sequential pass through the same extractors        */
/* ========================================================================= */

async function gatherSequentially(bb: Blackboard, deps: AgentDeps): Promise<void> {
  const obs = new ObservabilityAgent();
  const dep = new DependencyAgent();

  const steps: { agent: { run: (t: Task, bb: Blackboard, d: AgentDeps) => Promise<AgentResult> }; task: Task }[] = [
    { agent: obs, task: mkTask('S1', 'scan_logs', 'observability', { services: bb.incident.affectedServices }) },
    { agent: obs, task: mkTask('S2', 'scan_metrics', 'observability', { services: bb.incident.affectedServices }) },
    { agent: dep, task: mkTask('S3', 'scan_deployments', 'dependency', { lookbackMinutes: 240 }) },
    { agent: dep, task: mkTask('S4', 'scan_config', 'dependency', { lookbackMinutes: 240 }) },
    { agent: dep, task: mkTask('S5', 'map_dependencies', 'dependency', { services: bb.incident.affectedServices }) },
    { agent: dep, task: mkTask('S6', 'scan_historical', 'dependency', {}) },
  ];

  // Strictly sequential: this is the latency and recovery cost of no fan-out.
  for (const { agent, task } of steps) {
    if (deps.budget.exhausted()) break;
    bb.putTask({ ...task, status: 'running', startedAt: Date.now() });
    deps.telemetry.emit('task_start', `${task.id} ${task.kind}`, { agent: task.agent });
    const outcome = await withRetry(() => agent.run(task, bb, deps), { policy: { maxAttempts: 1 } });
    const result = outcome.value;
    if (!result || !result.ok) {
      bb.patchTask(task.id, { status: 'failed', endedAt: Date.now(), error: result?.error ?? 'failed' });
      bb.addDegradation(`${task.id} (${task.kind}) failed with no retry path`);
      deps.telemetry.emit('task_failed', `${task.id} ${task.kind}`, { agent: task.agent });
      continue;
    }
    for (const e of result.evidence) bb.addEvidence(e);
    for (const n of result.notes) bb.addNote(result.agent, n);
    if (result.degraded) bb.addDegradation(`${task.id} (${task.kind}) produced degraded output`);
    // Agent requests are discarded: there is no orchestrator to act on them.
    bb.patchTask(task.id, { status: 'done', endedAt: Date.now() });
    deps.telemetry.emit('task_end', `${task.id} ok`, { agent: task.agent });
  }
}

function mkTask(id: string, kind: Task['kind'], agent: Task['agent'], params: Record<string, unknown>): Task {
  return {
    id, kind, agent, description: `${kind} (single-agent baseline)`, params,
    dependsOn: [], status: 'pending', attempts: 0, maxAttempts: 1, round: 0,
    priority: 5, error: null, startedAt: null, endedAt: null,
  };
}

/* ========================================================================= */
/* LLM mode: a genuine single ReAct agent with the same tool set              */
/* ========================================================================= */

/* See the note in src/core/llm/llm.ts: these schemas target the strict
 * JSON-schema subset, so every field is required and genuinely free-form data
 * travels as a JSON string. */
const ObservationSchema = z.object({
  findings: z.array(z.object({
    claim: z.string().describe('One self-contained factual statement drawn from tool output'),
    type: z.enum(['fact', 'inference', 'assumption']),
    services: z.array(z.string()),
    observedAt: z.string().nullable(),
    tags: z.array(z.string()),
    sourceTool: z.string(),
  })).max(30),
});

async function gatherViaReactLoop(ctx: RunContext, bb: Blackboard, deps: AgentDeps): Promise<void> {
  const { telemetry, budget, tools } = ctx;
  let transcript = '';
  const callLog: { tool: string; input: Record<string, unknown>; ok: boolean; summary: string }[] = [];

  // A fixed-breadth agent loop: the model chooses each next call, bounded by
  // the same tool budget the multi-agent system gets.
  const maxSteps = 8;
  // Tool arguments vary per tool, so they travel as JSON text and are validated
  // by the registry against that tool's own schema — the same gate the
  // multi-agent system goes through.
  const DecideSchema = z.object({
    done: z.boolean(),
    tool: z.string().nullable(),
    inputJson: z.string().describe('Arguments for the tool as a JSON object literal, e.g. {"services":["api-gateway"]}'),
    why: z.string(),
  });

  for (let step = 0; step < maxSteps; step++) {
    if (budget.exhausted()) break;
    const decision = await decideNextCall(ctx, DecideSchema, transcript, callLog);
    if (!decision || decision.done || !decision.tool) break;

    const input = parseToolInput(decision.inputJson);
    const env = await tools.call(decision.tool, input, 'observability');
    bb.recordCoverage(decision.tool, JSON.stringify(input), env.complete);
    const summary = env.ok
      ? `${truncateJson(env.data, 1100)}${env.complete ? '' : '\n[PARTIAL RESULT]'}`
      : `ERROR ${env.error?.code}: ${env.error?.message}`;
    callLog.push({ tool: decision.tool, input, ok: env.ok, summary });
    transcript += `\n\n## Call ${step + 1}: ${decision.tool}(${JSON.stringify(input)})\nWhy: ${decision.why}\nResult:\n${summary}`;
    if (!env.ok) bb.addDegradation(`${decision.tool} failed: ${env.error?.message}`);
  }

  // One extraction pass turning the whole transcript into evidence records.
  const extracted = await extractEvidence(ctx, ObservationSchema, transcript);
  if (!extracted) {
    telemetry.emit('warning', 'baseline evidence extraction failed; falling back to deterministic gathering', { agent: 'system' });
    await gatherSequentially(bb, deps);
    return;
  }
  for (const f of extracted.findings) {
    bb.addEvidence(
      makeEvidence(
        {
          claim: f.claim, type: f.type, services: f.services,
          observedAt: f.observedAt, tags: f.tags,
        },
        { tool: f.sourceTool, query: {}, agent: 'observability', complete: true },
      ),
    );
  }
}

async function decideNextCall(
  ctx: RunContext,
  schema: z.ZodTypeAny,
  transcript: string,
  callLog: { tool: string }[],
): Promise<{ done: boolean; tool: string | null; inputJson: string; why: string } | null> {
  const prompt = `You are a single on-call engineer investigating this incident alone.

Incident: ${ctx.incident.id} [${ctx.incident.severity}] ${ctx.incident.title}
window ${ctx.incident.window.start} to ${ctx.incident.window.end}
services named by the reporter (may be wrong): ${ctx.incident.affectedServices.join(', ')}
symptoms: ${ctx.incident.symptoms.join('; ')}

Tools:
${ctx.tools.describe().map((t) => `- ${t.name}${t.inputSchema}: ${t.description.split('.')[0]}`).join('\n')}

Calls made so far: ${callLog.map((c) => c.tool).join(', ') || 'none'}
${transcript ? `\nTranscript so far:${transcript.slice(-4500)}` : ''}

Choose the single most useful next tool call, or set done=true if you have enough to conclude.`;
  return callLlm(ctx, 'baseline_decide', schema, 'You investigate production incidents. Be efficient; do not repeat an identical call.', prompt);
}

async function extractEvidence(
  ctx: RunContext,
  schema: z.ZodTypeAny,
  transcript: string,
): Promise<{ findings: { claim: string; type: 'fact' | 'inference' | 'assumption'; services: string[]; observedAt: string | null; tags: string[]; sourceTool: string }[] } | null> {
  const prompt = `Extract every finding worth reasoning over from this investigation transcript. Do not invent numbers or timestamps.

${transcript.slice(-9000)}`;
  return callLlm(ctx, 'baseline_extract', schema, 'You turn raw tool output into precise, citable findings.', prompt);
}

/** Minimal direct model call for the baseline, accounted against the same budget. */
async function callLlm<T>(
  ctx: RunContext,
  label: string,
  schema: z.ZodTypeAny,
  system: string,
  prompt: string,
): Promise<T | null> {
  if (ctx.budget.remaining('llmCalls') <= 0 || ctx.budget.remaining('tokens') <= 0) return null;
  const cfg = resolveModelConfig(ctx.modelId);
  if (!cfg) return null;

  const outcome = await withRetry(
    async () => {
      const model = await resolveModel(cfg);
      const lim = limiter((ms, why) =>
        ctx.telemetry.emit('warning', `pausing ${Math.round(ms / 1000)}s for the provider token budget (${why})`, { agent: 'system' }));
      await lim.acquire(estimateTokens(system, prompt) + 1800);
      ctx.budget.spend('llmCalls');
      ctx.telemetry.emit('llm_call', `${label} -> ${cfg.provider}/${cfg.modelId}`, { agent: 'system' });
      const res = await generateStructured<T>({ model, schema, system, prompt, maxOutputTokens: 1800 });
      lim.record(res.inputTokens + res.outputTokens);
      ctx.telemetry.countTokens(res.inputTokens, res.outputTokens);
      ctx.budget.spend('tokens', res.inputTokens + res.outputTokens);
      return res.object;
    },
    { policy: { maxAttempts: 2 } },
  );
  return outcome.value;
}

/** A model may return `{}`, prose, or fenced JSON. An unparsable argument list
 *  becomes an empty object, which the tool's own schema then rejects or
 *  defaults — the failure stays inside the normal validation path. */
function parseToolInput(raw: string): Record<string, unknown> {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export { parseToolInput };

function truncateJson(data: unknown, max: number): string {
  const s = JSON.stringify(data, null, 1) ?? 'null';
  return s.length > max ? `${s.slice(0, max)}\n...[truncated]` : s;
}
