import type { TraceEvent, AgentName } from './types.ts';

/** Single sink for everything observable about a run: the trace, token
 *  accounting and tool-call counters that the evaluation harness reads. */
export class Telemetry {
  readonly events: TraceEvent[] = [];
  private seq = 0;
  readonly startedAt = Date.now();

  toolCalls = 0;
  toolFailures = 0;
  toolRetries = 0;
  llmCalls = 0;
  tokensIn = 0;
  tokensOut = 0;

  constructor(private readonly verbose = false) {}

  emit(
    kind: TraceEvent['kind'],
    message: string,
    opts: { agent?: AgentName | 'system'; data?: Record<string, unknown> } = {},
  ): void {
    const ev: TraceEvent = {
      t: Date.now() - this.startedAt,
      seq: this.seq++,
      kind,
      message,
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.data ? { data: opts.data } : {}),
    };
    this.events.push(ev);
    if (this.verbose) {
      const who = ev.agent ? `[${ev.agent}]` : '';
      // eslint-disable-next-line no-console
      console.error(`  ${String(ev.t).padStart(6)}ms ${kind.padEnd(12)} ${who} ${message}`);
    }
  }

  countTokens(inTok: number, outTok: number): void {
    this.llmCalls += 1;
    this.tokensIn += inTok;
    this.tokensOut += outTok;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}
