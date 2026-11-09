import type {
  Evidence,
  Hypothesis,
  Contradiction,
  Task,
  IncidentReport,
  AgentName,
  EvidenceLink,
  CriticVerdict,
} from './types.ts';
import { Telemetry } from './telemetry.ts';

export interface CoverageKey {
  tool: string;
  signature: string;
}

/**
 * The shared investigation state — a blackboard that every agent reads from and
 * writes to. It is the reason the agents collaborate rather than merely run in
 * sequence: the Reasoning agent scores evidence it never gathered, the Critic
 * inspects coverage it never queried, and the Reporting agent cites provenance
 * recorded by whoever retrieved it.
 *
 * All mutations are deduplicating and append-only, so concurrent agents writing
 * in the same wave cannot clobber one another.
 */
export class Blackboard {
  readonly incident: IncidentReport;
  readonly telemetry: Telemetry;

  private readonly evidenceById = new Map<string, Evidence>();
  private readonly evidenceFingerprints = new Set<string>();
  private readonly hypothesesById = new Map<string, Hypothesis>();
  private readonly contradictionsById = new Map<string, Contradiction>();
  private readonly tasksById = new Map<string, Task>();
  /** tool+query signatures already executed, so the critic can tell a genuine
   *  gap from something already covered, and agents avoid duplicate spend. */
  private readonly coverage = new Map<string, { complete: boolean; count: number }>();
  private readonly notes: { agent: AgentName; note: string }[] = [];
  private readonly degradations: string[] = [];

  /** Bumped on every mutation; agents use it to detect staleness. */
  revision = 0;
  round = 0;

  /** The most recent critic ruling, read by the orchestrator to decide whether
   *  to open another investigation round and by the reporting agent for tone. */
  lastVerdict: CriticVerdict | null = null;

  /** Every service name in the environment, so agents can recognise one
   *  mentioned inside a log line without hardcoding a list. */
  knownServices: string[] = [];

  /** Best estimate of when the incident began, set by signal correlation. */
  onsetEstimate: string | null = null;

  private evSeq = 0;
  private hypSeq = 0;
  private conSeq = 0;

  constructor(incident: IncidentReport, telemetry: Telemetry) {
    this.incident = incident;
    this.telemetry = telemetry;
  }

  /* ---------------------------------------------------------------- evidence */

  private fingerprint(e: Evidence): string {
    return [e.source.tool, e.claim, e.observedAt ?? '', e.services.join(',')].join('|');
  }

  nextEvidenceId(): string {
    return `E${String(++this.evSeq).padStart(3, '0')}`;
  }

  /** Returns the stored evidence (existing one if a duplicate claim arrives). */
  addEvidence(e: Evidence): Evidence {
    const fp = this.fingerprint(e);
    if (this.evidenceFingerprints.has(fp)) {
      const existing = [...this.evidenceById.values()].find((x) => this.fingerprint(x) === fp);
      if (existing) return existing;
    }
    const stored: Evidence = { ...e, id: e.id || this.nextEvidenceId() };
    this.evidenceById.set(stored.id, stored);
    this.evidenceFingerprints.add(fp);
    this.revision++;
    this.telemetry.emit('evidence', `${stored.id} ${stored.claim}`, {
      agent: stored.source.agent,
      data: { tags: stored.tags, type: stored.type, reliability: stored.reliability },
    });
    return stored;
  }

  getEvidence(id: string): Evidence | undefined {
    return this.evidenceById.get(id);
  }

  allEvidence(): Evidence[] {
    return [...this.evidenceById.values()];
  }

  evidenceByTag(...tags: string[]): Evidence[] {
    return this.allEvidence().filter((e) => tags.some((t) => e.tags.includes(t)));
  }

  evidenceForService(service: string): Evidence[] {
    return this.allEvidence().filter((e) => e.services.includes(service));
  }

  factCount(): number {
    return this.allEvidence().filter((e) => e.type === 'fact').length;
  }

  /* -------------------------------------------------------------- hypotheses */

  nextHypothesisId(): string {
    return `H${String(++this.hypSeq).padStart(2, '0')}`;
  }

  /**
   * Merge-on-write: two agents proposing the same (category, suspectService)
   * contribute to one hypothesis instead of creating near-duplicates that would
   * split the evidence and depress both confidences.
   */
  upsertHypothesis(h: Hypothesis): Hypothesis {
    const match = [...this.hypothesesById.values()].find(
      (x) => x.category === h.category && (x.suspectService ?? '') === (h.suspectService ?? ''),
    );
    if (match) {
      const merged: Hypothesis = {
        ...match,
        supporting: mergeLinks(match.supporting, h.supporting),
        contradicting: mergeLinks(match.contradicting, h.contradicting),
        testablePredictions: unique([...match.testablePredictions, ...h.testablePredictions]),
        statement: match.statement.length >= h.statement.length ? match.statement : h.statement,
        confidence: Math.max(match.confidence, h.confidence),
      };
      this.hypothesesById.set(match.id, merged);
      this.revision++;
      return merged;
    }
    const stored: Hypothesis = { ...h, id: h.id || this.nextHypothesisId() };
    this.hypothesesById.set(stored.id, stored);
    this.revision++;
    this.telemetry.emit('hypothesis', `${stored.id} ${stored.title}`, {
      agent: stored.proposedBy,
      data: { category: stored.category, suspect: stored.suspectService },
    });
    return stored;
  }

  updateHypothesis(id: string, patch: Partial<Hypothesis>): void {
    const h = this.hypothesesById.get(id);
    if (!h) return;
    this.hypothesesById.set(id, { ...h, ...patch });
    this.revision++;
  }

  getHypothesis(id: string): Hypothesis | undefined {
    return this.hypothesesById.get(id);
  }

  allHypotheses(): Hypothesis[] {
    return [...this.hypothesesById.values()];
  }

  /**
   * Ranked best-first.
   *
   * Ties are broken towards the more parsimonious explanation — fewer
   * contradictions first, then fewer supporting links. Breaking ties towards
   * *more* evidence rewards a hypothesis for sweeping up every loosely-related
   * observation, which systematically favours "something was deployed" over the
   * specific mechanism that actually explains the failure.
   */
  rankedHypotheses(): Hypothesis[] {
    return this.allHypotheses()
      .filter((h) => h.status !== 'refuted')
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          a.contradicting.length - b.contradicting.length ||
          a.supporting.length - b.supporting.length ||
          a.id.localeCompare(b.id),
      );
  }

  /* ----------------------------------------------------------- contradictions */

  addContradiction(c: Omit<Contradiction, 'id'> & { id?: string }): Contradiction {
    const dupe = [...this.contradictionsById.values()].find(
      (x) => x.description === c.description,
    );
    if (dupe) return dupe;
    const stored: Contradiction = {
      ...c,
      resolved: c.resolved ?? false,
      resolution: c.resolution ?? null,
      id: c.id || `C${String(++this.conSeq).padStart(2, '0')}`,
    };
    this.contradictionsById.set(stored.id, stored);
    this.revision++;
    this.telemetry.emit('contradiction', stored.description, {
      data: { evidenceIds: stored.evidenceIds },
    });
    return stored;
  }

  resolveContradiction(id: string, resolution: string): void {
    const c = this.contradictionsById.get(id);
    if (!c) return;
    this.contradictionsById.set(id, { ...c, resolved: true, resolution });
    this.revision++;
  }

  allContradictions(): Contradiction[] {
    return [...this.contradictionsById.values()];
  }

  openContradictions(): Contradiction[] {
    return this.allContradictions().filter((c) => !c.resolved);
  }

  /* -------------------------------------------------------------------- tasks */

  putTask(t: Task): void {
    this.tasksById.set(t.id, t);
    this.revision++;
  }

  patchTask(id: string, patch: Partial<Task>): void {
    const t = this.tasksById.get(id);
    if (!t) return;
    this.tasksById.set(id, { ...t, ...patch });
    this.revision++;
  }

  getTask(id: string): Task | undefined {
    return this.tasksById.get(id);
  }

  allTasks(): Task[] {
    return [...this.tasksById.values()];
  }

  hasTaskLike(kind: string, signature: string): boolean {
    return this.allTasks().some(
      (t) => t.kind === kind && JSON.stringify(t.params) === signature,
    );
  }

  /* ----------------------------------------------------------------- coverage */

  recordCoverage(tool: string, signature: string, complete: boolean): void {
    const key = `${tool}::${signature}`;
    const prev = this.coverage.get(key);
    this.coverage.set(key, {
      complete: complete || (prev?.complete ?? false),
      count: (prev?.count ?? 0) + 1,
    });
  }

  toolsQueried(): string[] {
    return unique([...this.coverage.keys()].map((k) => k.split('::')[0] as string));
  }

  /** Tools that were attempted but never returned a complete result. */
  incompleteTools(): string[] {
    const bad = new Set<string>();
    for (const [k, v] of this.coverage) if (!v.complete) bad.add(k.split('::')[0] as string);
    for (const t of this.toolsQueried()) {
      const entries = [...this.coverage.entries()].filter(([k]) => k.startsWith(`${t}::`));
      if (entries.some(([, v]) => v.complete)) bad.delete(t);
    }
    return [...bad];
  }

  /* -------------------------------------------------------- notes/degradation */

  addNote(agent: AgentName, note: string): void {
    this.notes.push({ agent, note });
  }

  allNotes(): { agent: AgentName; note: string }[] {
    return [...this.notes];
  }

  addDegradation(d: string): void {
    if (!this.degradations.includes(d)) this.degradations.push(d);
  }

  allDegradations(): string[] {
    return [...this.degradations];
  }

  /** Compact view handed to agents and to the LLM so prompts stay bounded. */
  digest(): {
    incident: IncidentReport;
    round: number;
    evidence: Evidence[];
    hypotheses: Hypothesis[];
    contradictions: Contradiction[];
    toolsQueried: string[];
    degradations: string[];
  } {
    return {
      incident: this.incident,
      round: this.round,
      evidence: this.allEvidence(),
      hypotheses: this.rankedHypotheses(),
      contradictions: this.allContradictions(),
      toolsQueried: this.toolsQueried(),
      degradations: this.allDegradations(),
    };
  }
}

function mergeLinks(a: EvidenceLink[], b: EvidenceLink[]): EvidenceLink[] {
  const byId = new Map<string, EvidenceLink>();
  for (const l of [...a, ...b]) {
    const prev = byId.get(l.evidenceId);
    if (!prev || l.weight > prev.weight) byId.set(l.evidenceId, l);
  }
  return [...byId.values()];
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
