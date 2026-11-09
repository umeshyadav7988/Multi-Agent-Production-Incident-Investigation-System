import type { Task, AgentResult, TaskStatus } from './types.ts';
import { Blackboard } from './blackboard.ts';
import { Budget } from './budget.ts';
import { describeError, isRetryable } from './errors.ts';
import { sleep } from './retry.ts';

export type TaskExecutor = (task: Task, bb: Blackboard) => Promise<AgentResult>;

export interface WaveSummary {
  wave: number;
  ran: string[];
  succeeded: string[];
  failed: string[];
  retried: string[];
}

const TERMINAL: TaskStatus[] = ['done', 'failed', 'skipped', 'cancelled'];

/**
 * Executes the task graph.
 *
 * - Independent tasks in the same wave run concurrently (`Promise.allSettled`).
 * - A task becomes ready when every dependency has reached a *terminal* state,
 *   not necessarily a successful one. A dependent of a failed task still runs,
 *   flagged degraded, so one dead agent cannot abort the investigation.
 * - Failures are retried up to the task's own `maxAttempts`, and only when the
 *   underlying error is marked retryable.
 * - Every wave re-checks the budget, which is what guarantees termination.
 */
export class Scheduler {
  readonly waves: WaveSummary[] = [];
  tasksRun = 0;
  taskFailures = 0;

  constructor(
    private readonly bb: Blackboard,
    private readonly budget: Budget,
    private readonly execute: TaskExecutor,
    private readonly onResult: (task: Task, result: AgentResult) => void,
    private readonly maxConcurrency = 6,
  ) {}

  addTasks(tasks: Task[]): void {
    for (const t of tasks) this.bb.putTask(t);
  }

  private readyTasks(): Task[] {
    return this.bb
      .allTasks()
      .filter((t) => t.status === 'pending' || t.status === 'ready')
      .filter((t) =>
        t.dependsOn.every((d) => {
          const dep = this.bb.getTask(d);
          // A dependency that does not exist is treated as satisfied: a replan
          // may legitimately reference a task that was pruned.
          return !dep || TERMINAL.includes(dep.status);
        }),
      )
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  private degradedDeps(t: Task): string[] {
    return t.dependsOn.filter((d) => {
      const dep = this.bb.getTask(d);
      return dep ? dep.status === 'failed' || dep.status === 'skipped' : false;
    });
  }

  /** Runs waves until nothing is ready or the budget is gone. */
  async drain(): Promise<{ stopped: 'complete' | 'budget'; resource?: string }> {
    for (;;) {
      const exhausted = this.budget.exhausted();
      if (exhausted) {
        this.cancelPending(`budget exhausted: ${exhausted}`);
        return { stopped: 'budget', resource: exhausted };
      }

      const ready = this.readyTasks();
      if (ready.length === 0) return { stopped: 'complete' };

      const batch = ready.slice(0, this.maxConcurrency);
      const waveNo = this.waves.length;
      const summary: WaveSummary = {
        wave: waveNo,
        ran: batch.map((t) => t.id),
        succeeded: [],
        failed: [],
        retried: [],
      };

      this.bb.telemetry.emit(
        'plan',
        `wave ${waveNo}: running ${batch.length} task(s) in parallel`,
        { agent: 'system', data: { tasks: batch.map((t) => `${t.id}:${t.kind}`) } },
      );

      const settled = await Promise.allSettled(
        batch.map((t) => this.runOne(t)),
      );

      settled.forEach((res, i) => {
        const t = batch[i] as Task;
        if (res.status === 'fulfilled' && res.value.ok) summary.succeeded.push(t.id);
        else if (res.status === 'fulfilled' && res.value.requeued) summary.retried.push(t.id);
        else summary.failed.push(t.id);
      });

      this.waves.push(summary);
    }
  }

  private async runOne(
    task: Task,
  ): Promise<{ ok: boolean; requeued: boolean }> {
    if (this.budget.exhausted()) {
      this.bb.patchTask(task.id, { status: 'cancelled', error: 'budget exhausted' });
      return { ok: false, requeued: false };
    }

    const degraded = this.degradedDeps(task);
    const attempt = task.attempts + 1;
    this.bb.patchTask(task.id, {
      status: 'running',
      attempts: attempt,
      startedAt: Date.now(),
      params: degraded.length ? { ...task.params, __degradedDeps: degraded } : task.params,
    });
    this.budget.spend('tasks');
    this.tasksRun += 1;

    const live = this.bb.getTask(task.id) as Task;
    this.bb.telemetry.emit('task_start', `${task.id} ${task.kind} (attempt ${attempt})`, {
      agent: task.agent,
      data: degraded.length ? { degradedDeps: degraded } : undefined,
    });

    try {
      const result = await this.execute(live, this.bb);
      this.onResult(live, result);

      if (result.ok) {
        this.bb.patchTask(task.id, { status: 'done', endedAt: Date.now(), error: null });
        this.bb.telemetry.emit('task_end', `${task.id} ok${result.degraded ? ' (degraded)' : ''}`, {
          agent: task.agent,
          data: { evidence: result.evidence.length, hypotheses: result.hypotheses.length },
        });
        return { ok: true, requeued: false };
      }
      throw new Error(result.error ?? 'agent reported failure');
    } catch (e) {
      const msg = describeError(e);
      this.taskFailures += 1;
      const canRetry = attempt < live.maxAttempts && (isRetryable(e) || !(e instanceof Error));

      if (canRetry) {
        this.bb.patchTask(task.id, { status: 'pending', error: msg });
        this.bb.telemetry.emit('task_retry', `${task.id} failed (${msg}); retrying`, {
          agent: task.agent,
        });
        await sleep(20);
        return { ok: false, requeued: true };
      }

      this.bb.patchTask(task.id, { status: 'failed', endedAt: Date.now(), error: msg });
      this.bb.addDegradation(`task ${task.id} (${task.kind}, ${task.agent}) failed: ${msg}`);
      this.bb.telemetry.emit('task_failed', `${task.id} ${task.kind}: ${msg}`, {
        agent: task.agent,
      });
      return { ok: false, requeued: false };
    }
  }

  private cancelPending(reason: string): void {
    for (const t of this.bb.allTasks()) {
      if (!TERMINAL.includes(t.status)) {
        this.bb.patchTask(t.id, { status: 'cancelled', error: reason });
      }
    }
    this.bb.telemetry.emit('warning', `cancelled pending tasks: ${reason}`, { agent: 'system' });
  }
}
