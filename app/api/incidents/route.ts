import { SCENARIOS, toIncidentReport } from '@/data/scenarios/index.ts';

export const runtime = 'nodejs';

/** The dataset as the system sees it: ground truth is deliberately omitted. */
export function GET(): Response {
  return Response.json({
    count: SCENARIOS.length,
    incidents: SCENARIOS.map((s) => ({
      ...toIncidentReport(s),
      traits: s.traits,
    })),
  });
}
