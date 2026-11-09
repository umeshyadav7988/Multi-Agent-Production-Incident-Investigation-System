import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/core/scheduler.ts';
import { Blackboard } from '../src/core/blackboard.ts';
import { Budget } from '../src/core/budget.ts';
import { Telemetry } from '../src/core/telemetry.ts';
import { getScenario, toIncidentReport } from '../src/data/scenarios/index.ts';
import type { Task, AgentResult } from '../src/core/types.ts';
import { AgentError } from '../src/core/errors.ts';

const incident = toIncidentReport(getScenario('INC-5001'));

function task(id: string, dependsOn: string[] = [], maxAttempts = 2): Task {
  return {
    id, kind: 'scan_logs', agent: 'observability', description: id, params: {},
    dependsOn, status: 'pending', attempts: 0, maxAttempts, round: 0, priority: 5,
    error: null, startedAt: null, endedAt: null,
  };
}

function ok(t: Task): AgentResult {
  return { taskId: t.id, agent: 'observability', ok: true, evidence: [], hypotheses: [], contradictions: [], notes: [], requests: [], degraded: false, error: null };
}

function build(exec: (t: Task) => Promise<AgentResult>, limits = {}) {
  const bb = new Blackboard(incident, new Telemetry());
  const budget = new Budget({ tasks: 50, rounds: 5, wallClockMs: 10_000, ...limits });
  const scheduler = new Scheduler(bb, budget, (t) => exec(t), () => {}, 6);
  return { bb, budget, scheduler };
}

describe('Scheduler', () => {
  it('runs independent tasks concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const { scheduler } = build(async (t) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return ok(t);
    });
    scheduler.addTasks([task('A'), task('B'), task('C'), task('D')]);
    await scheduler.drain();
    expect(peak).toBe(4);
    expect(scheduler.waves).toHaveLength(1);
  });

  it('honours dependencies, running dependants only after their deps finish', async () => {
    const order: string[] = [];
    const { scheduler } = build(async (t) => { order.push(t.id); return ok(t); });
    scheduler.addTasks([task('C', ['B']), task('B', ['A']), task('A')]);
    await scheduler.drain();
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('retries a retryable task failure up to maxAttempts', async () => {
    let calls = 0;
    const { bb, scheduler } = build(async (t) => {
      calls++;
      if (calls < 2) throw new AgentError('transient', 'observability', true);
      return ok(t);
    });
    scheduler.addTasks([task('A', [], 3)]);
    await scheduler.drain();
    expect(calls).toBe(2);
    expect(bb.getTask('A')?.status).toBe('done');
  });

  it('stops retrying a non-retryable failure and marks the task failed', async () => {
    let calls = 0;
    const { bb, scheduler } = build(async () => {
      calls++;
      throw new AgentError('permanent', 'observability', false);
    });
    scheduler.addTasks([task('A', [], 3)]);
    await scheduler.drain();
    expect(calls).toBe(1);
    expect(bb.getTask('A')?.status).toBe('failed');
  });

  it('still runs a dependant whose dependency failed, flagged as degraded', async () => {
    const seen: Record<string, unknown> = {};
    const { bb, scheduler } = build(async (t) => {
      if (t.id === 'A') throw new AgentError('dead', 'observability', false);
      seen[t.id] = t.params.__degradedDeps;
      return ok(t);
    });
    scheduler.addTasks([task('A', [], 1), task('B', ['A'])]);
    await scheduler.drain();
    expect(bb.getTask('A')?.status).toBe('failed');
    expect(bb.getTask('B')?.status).toBe('done');
    expect(seen.B).toEqual(['A']);
    expect(bb.allDegradations().join(' ')).toMatch(/task A/);
  });

  it('terminates and cancels pending work when the task budget runs out', async () => {
    const { bb, scheduler } = build(async (t) => ok(t), { tasks: 2 });
    scheduler.addTasks([task('A'), task('B'), task('C'), task('D')]);
    const res = await scheduler.drain();
    expect(res.stopped).toBe('budget');
    expect(res.resource).toBe('tasks');
    expect(bb.allTasks().filter((t) => t.status === 'cancelled').length).toBeGreaterThan(0);
  });

  it('terminates rather than hanging when the wall clock is exhausted', async () => {
    const { scheduler } = build(async (t) => ok(t), { wallClockMs: 0 });
    scheduler.addTasks([task('A')]);
    const res = await scheduler.drain();
    expect(res.stopped).toBe('budget');
    expect(res.resource).toBe('wallClockMs');
  });

  it('treats a dependency on a task that does not exist as satisfied', async () => {
    const { bb, scheduler } = build(async (t) => ok(t));
    scheduler.addTasks([task('A', ['does-not-exist'])]);
    await scheduler.drain();
    expect(bb.getTask('A')?.status).toBe('done');
  });
});
