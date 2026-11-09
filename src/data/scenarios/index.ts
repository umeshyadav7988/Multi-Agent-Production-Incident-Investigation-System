import type { ScenarioSpec } from '../world.ts';
import { INC_5001, INC_5002, INC_5003, INC_5004 } from './part1.ts';
import { INC_5005, INC_5006, INC_5007, INC_5008 } from './part2.ts';
import { INC_5009, INC_5010, INC_5011, INC_5012 } from './part3.ts';

export const SCENARIOS: ScenarioSpec[] = [
  INC_5001, INC_5002, INC_5003, INC_5004,
  INC_5005, INC_5006, INC_5007, INC_5008,
  INC_5009, INC_5010, INC_5011, INC_5012,
];

export function getScenario(id: string): ScenarioSpec {
  const s = SCENARIOS.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (!s) {
    throw new Error(
      `Unknown scenario "${id}". Known: ${SCENARIOS.map((x) => x.id).join(', ')}`,
    );
  }
  return s;
}

/** The incident report handed to the system. Deliberately excludes `truth`. */
export function toIncidentReport(spec: ScenarioSpec) {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    severity: spec.severity,
    reportedAt: spec.reportedAt,
    window: {
      start: new Date(Date.parse(spec.reportedAt) - spec.windowBeforeMin * 60_000)
        .toISOString().replace(/\.\d{3}Z$/, 'Z'),
      end: new Date(Date.parse(spec.reportedAt) + spec.windowAfterMin * 60_000)
        .toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
    affectedServices: spec.affectedServices,
    symptoms: spec.symptoms,
    reporter: 'oncall',
  };
}
