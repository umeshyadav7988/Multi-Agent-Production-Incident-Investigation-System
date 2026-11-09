import { ToolError } from '../core/errors.ts';
import type { Rng } from '../core/rng.ts';
import type { ScenarioSpec } from '../data/world.ts';

export type FaultMode = 'timeout' | 'partial_result' | 'unavailable' | 'corrupt_data' | 'rate_limited';

export interface FaultDecision {
  mode: FaultMode | null;
  forced: boolean;
}

/**
 * Decides whether a given tool call misbehaves.
 *
 * Two sources: a scenario may force specific faults (so a test incident can
 * reliably exercise a recovery path), and a background rate applies to every
 * call (so the system is never tuned to a fault-free world). Both draw from the
 * seeded RNG, so a run is reproducible.
 */
export class FaultInjector {
  private forcedUsed = new Map<string, number>();
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly rng: Rng,
    private readonly backgroundRate: number,
    private readonly forced: NonNullable<ScenarioSpec['forcedToolFaults']> = [],
  ) {}

  decide(tool: string): FaultDecision {
    this.counters.set(tool, (this.counters.get(tool) ?? 0) + 1);

    for (const f of this.forced) {
      if (f.tool !== tool) continue;
      const used = this.forcedUsed.get(tool) ?? 0;
      if (f.maxOccurrences !== undefined && used >= f.maxOccurrences) continue;
      if (this.rng.next() < f.probability) {
        this.forcedUsed.set(tool, used + 1);
        return { mode: f.mode, forced: true };
      }
    }

    if (this.backgroundRate > 0 && this.rng.next() < this.backgroundRate) {
      const mode = this.rng.pick<FaultMode>([
        'timeout',
        'partial_result',
        'rate_limited',
        'unavailable',
        'partial_result',
      ]);
      return { mode, forced: false };
    }

    return { mode: null, forced: false };
  }

  static toError(mode: FaultMode, tool: string): ToolError {
    switch (mode) {
      case 'timeout':
        return new ToolError(`upstream did not respond within deadline`, 'timeout', true, tool);
      case 'unavailable':
        return new ToolError(`backend unavailable (503)`, 'unavailable', true, tool);
      case 'rate_limited':
        return new ToolError(`query quota exceeded, retry later`, 'rate_limited', true, tool);
      case 'corrupt_data':
        return new ToolError(`response failed checksum validation`, 'corrupt_data', false, tool);
      default:
        return new ToolError(`unknown fault`, 'internal', false, tool);
    }
  }
}
