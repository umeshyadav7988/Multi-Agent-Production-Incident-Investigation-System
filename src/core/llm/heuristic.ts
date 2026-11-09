import type {
  ReasoningEngine, PlanInput, PlanOutput, HypothesisInput, HypothesisOutput,
  ScoreInput, ScoreOutput, CritiqueInput, CritiqueOutput, ReportInput, ReportOutput, TaskSpec,
} from './engine.ts';
import type { Evidence, Hypothesis, RootCauseCategory, RemediationAction } from '../types.ts';
import { TAG, SYMPTOM_TAGS, CHANGE_TAGS } from '../tags.ts';
import { MECHANISM_TAGS, TAG_SPECIFICITY, MECHANISM_BONUS_CAP, NON_CHANGE_CATEGORIES, REMEDIATION } from './heuristic-rules.ts';

const MIN = 60_000;

/**
 * Deterministic reasoning engine.
 *
 * It applies generic diagnostic rules over the tagged evidence graph: nothing
 * here keys off an incident id, a scenario name or any ground truth. The same
 * rules run against every incident, which is what makes an offline evaluation
 * meaningful rather than a lookup.
 */
export class HeuristicEngine implements ReasoningEngine {
  readonly name = 'heuristic' as const;

  /* ------------------------------------------------------------------ plan */

  async plan(input: PlanInput): Promise<PlanOutput> {
    if (input.round === 0) {
      const svc = input.incident.affectedServices;
      const tasks: TaskSpec[] = [
        { id: 'T1', kind: 'scan_logs', agent: 'observability', priority: 1,
          description: 'Find error and fatal log patterns across the affected services and the whole fleet',
          params: { services: svc } },
        { id: 'T2', kind: 'scan_metrics', agent: 'observability', priority: 1,
          description: 'Detect level shifts in latency, error rate, throughput and resource metrics',
          params: { services: svc } },
        { id: 'T3', kind: 'scan_deployments', agent: 'dependency', priority: 1,
          description: 'List deployments in and around the incident window',
          params: { lookbackMinutes: 240 } },
        { id: 'T4', kind: 'scan_config', agent: 'dependency', priority: 1,
          description: 'List configuration, flag, limit and schema changes',
          params: { lookbackMinutes: 240 } },
        { id: 'T5', kind: 'map_dependencies', agent: 'dependency', priority: 2,
          description: 'Map upstream and downstream topology for the affected services',
          params: { services: svc } },
        { id: 'T6', kind: 'scan_historical', agent: 'dependency', priority: 3,
          description: 'Find prior incidents with similar symptoms as a prior, not as proof',
          params: {} },
        { id: 'T7', kind: 'correlate_signals', agent: 'observability', priority: 4,
          description: 'Correlate symptom onset across services and widen the blast radius if needed',
          params: {}, dependsOn: ['T1', 'T2', 'T3', 'T4', 'T5'] },
        { id: 'T8', kind: 'generate_hypotheses', agent: 'reasoning', priority: 5,
          description: 'Build competing root-cause hypotheses from all gathered evidence',
          params: {}, dependsOn: ['T7', 'T3', 'T4', 'T6'] },
        { id: 'T9', kind: 'score_hypotheses', agent: 'reasoning', priority: 6,
          description: 'Weigh supporting against contradicting evidence and rank the hypotheses',
          params: {}, dependsOn: ['T8'] },
        { id: 'T10', kind: 'critique', agent: 'critic', priority: 7,
          description: 'Challenge the leading conclusion and decide whether the evidence suffices',
          params: {}, dependsOn: ['T9'] },
      ];
      return {
        rationale:
          'Fan out independent observability and change-management queries in parallel, converge on correlation, then reason, score and critique.',
        tasks,
      };
    }

    // Replan: turn stated gaps into concrete probes.
    const tasks: TaskSpec[] = [];
    for (const [i, gap] of (input.gaps ?? []).entries()) {
      const g = gap.toLowerCase();
      const services = extractServices(gap, input.evidence ?? []);
      if (g.includes('deploy') || g.includes('release')) {
        tasks.push({ id: `R${input.round}G${i}`, kind: 'scan_deployments', agent: 'dependency', priority: 1,
          description: `Widened deployment search: ${gap}`, params: { lookbackMinutes: 2880, services } });
      } else if (g.includes('config') || g.includes('flag')) {
        tasks.push({ id: `R${input.round}G${i}`, kind: 'scan_config', agent: 'dependency', priority: 1,
          description: `Widened change search: ${gap}`, params: { lookbackMinutes: 2880, services } });
      } else if (g.includes('log')) {
        tasks.push({ id: `R${input.round}G${i}`, kind: 'scan_logs', agent: 'observability', priority: 1,
          description: `Re-query logs: ${gap}`, params: { services } });
      } else {
        tasks.push({ id: `R${input.round}G${i}`, kind: 'targeted_probe', agent: 'observability', priority: 1,
          description: `Probe: ${gap}`, params: { services, reason: gap } });
      }
    }
    return { rationale: `Round ${input.round}: close ${tasks.length} evidence gap(s) named by the critic.`, tasks };
  }

  /* ----------------------------------------------------------- hypothesise */

  async hypothesise(input: HypothesisInput): Promise<HypothesisOutput> {
    const { evidence, topology } = input;
    const onset = input.onsetEstimate ? Date.parse(input.onsetEstimate) : estimateOnset(evidence);
    const out: HypothesisOutput = { hypotheses: [], contradictions: [], notes: [] };

    // A change record often carries incidental symptom-ish keywords ("maxmemory",
    // "evict"). It is still a change, and counting it as a symptom lets a
    // deployment hypothesis cite the config change that actually caused the
    // outage as evidence for itself.
    const symptomEvidence = evidence.filter(
      (e) => e.tags.some((t) => SYMPTOM_TAGS.includes(t)) && !e.tags.some((t) => CHANGE_TAGS.includes(t)),
    );
    const symptomServices = new Set(symptomEvidence.flatMap((e) => e.services));
    const changeEvidence = evidence.filter((e) => e.tags.some((t) => CHANGE_TAGS.includes(t)));
    const upstreamOf = buildUpstreamIndex(topology);

    /* --- Rule A: a human change shortly before onset ----------------------- */
    for (const c of changeEvidence) {
      const at = c.observedAt ? Date.parse(c.observedAt) : NaN;
      if (Number.isNaN(at)) continue;
      const leadMin = (onset - at) / MIN;
      // Accept changes from 5 minutes after onset (clock skew) to 48h before.
      if (leadMin < -5 || leadMin > 2880) continue;

      const category = changeCategory(c);
      const suspect = c.services[0] ?? null;
      if (!suspect) continue;

      const proximity = proximityWeight(leadMin);
      const supporting = [{
        evidenceId: c.id,
        weight: proximity,
        rationale: `Change on ${suspect} ${fmtLead(leadMin)} the estimated onset`,
      }];
      const contradicting: HypothesisOutput['hypotheses'][number]['contradicting'] = [];

      // The decisive question is whether the *changed* service is itself unwell.
      // A healthy service cannot transmit a fault it is not experiencing, however
      // close its release landed to the onset.
      const suspectSymptoms = symptomEvidence.filter((e) => e.services.includes(suspect));
      const callers = [...symptomServices].filter((s) => s !== suspect && (upstreamOf.get(s)?.has(suspect) ?? false));

      // A symptom only implicates a change to the degree the change is
      // temporally plausible. A release five hours old does not get to claim
      // every error in the window just because it touched the same service.
      const linkCeiling = Math.min(0.9, 0.1 + 0.9 * proximity);

      if (suspectSymptoms.length > 0) {
        for (const e of suspectSymptoms) {
          supporting.push({
            evidenceId: e.id,
            weight: linkCeiling,
            rationale: `Symptom on ${suspect}, the service that changed ${fmtLead(leadMin)} onset`,
          });
        }
        for (const e of symptomEvidence) {
          if (e.services.includes(suspect)) continue;
          if (!e.services.some((s) => callers.includes(s))) continue;
          supporting.push({
            evidenceId: e.id,
            weight: linkCeiling * 0.6,
            rationale: `Symptom on ${e.services.join('/')}, which calls the changed service ${suspect}`,
          });
        }
      } else {
        // Changed, close in time, and provably not degraded: the classic decoy.
        const healthy = evidence.filter(
          (e) => e.services.includes(suspect) &&
            (e.tags.includes(TAG.RESOURCE_NORMAL) || e.tags.includes(TAG.NO_SIGNAL)),
        );
        for (const h of healthy) {
          contradicting.push({
            evidenceId: h.id,
            weight: 0.9,
            rationale: `${suspect} changed but shows no degradation of its own, so it is not the source of the fault`,
          });
        }
        // Downstream pain is only weak support when the changed service is fine.
        for (const e of symptomEvidence) {
          if (!e.services.some((s) => callers.includes(s))) continue;
          supporting.push({
            evidenceId: e.id,
            weight: Math.min(0.2, linkCeiling * 0.25),
            rationale: `Symptom on ${e.services.join('/')}, a caller of ${suspect}, though ${suspect} itself looks healthy`,
          });
        }
        if (healthy.length === 0 && callers.length === 0) {
          out.notes.push(`${suspect} changed near onset but no symptom evidence links to it`);
        }
      }

      // A changelog entry whose text matches an observed error is strong.
      const textual = evidence.filter(
        (e) => e.tags.includes(TAG.ERROR_LOG) && sharesDistinctiveTerm(c.claim, e.claim),
      );
      for (const t of textual) {
        supporting.push({ evidenceId: t.id, weight: 0.95, rationale: `Observed failure text matches the change description` });
      }

      // The failures themselves may name a culprit. If the errors on the changed
      // service blame an upstream that is independently unhealthy, the change is
      // not what broke it, however well the timing lines up.
      const blamesUpstream = evidence.filter((e) => {
        if (!e.services.includes(suspect)) return false;
        if (!e.tags.includes(TAG.ERROR_LOG)) return false;
        const ref = referencedService(e);
        if (!ref || ref === suspect) return false;
        return evidence.some(
          (x) => x.services.includes(ref) &&
            (x.tags.includes(TAG.EXTERNAL_DEGRADED) || x.tags.includes(TAG.UPSTREAM_UNHEALTHY) ||
             x.tags.includes(TAG.ERROR_SPIKE) || x.tags.includes(TAG.RATE_LIMITED)),
        );
      });
      for (const b of blamesUpstream) {
        contradicting.push({
          evidenceId: b.id,
          weight: 0.85,
          rationale: `The failures on ${suspect} name ${referencedService(b)} as the source, and that upstream is independently unhealthy`,
        });
      }

      out.hypotheses.push({
        title: `${titleFor(category)} in ${suspect}`,
        category,
        suspectService: suspect,
        statement: `${c.claim} This change ${fmtLead(leadMin)} onset and is a candidate trigger for the observed symptoms.`,
        supporting,
        contradicting,
        testablePredictions: [
          `Reverting the change on ${suspect} returns the affected metrics to baseline`,
          `The symptom timeline begins no earlier than the change timestamp`,
          suspectSymptoms.length === 0
            ? `${suspect} should show its own degradation if it is the cause; it currently does not`
            : `Requests not touching ${suspect} should be unaffected`,
        ],
      });
    }

    /* --- Rule B: mechanism signatures in the symptoms ---------------------- */
    for (const [category, spec] of Object.entries(MECHANISM_SIGNATURES)) {
      const hits = evidence.filter((e) => spec.trigger.some((t) => e.tags.includes(t)));
      if (hits.length === 0) continue;

      // Group by the service the signature points at.
      const byService = new Map<string, Evidence[]>();
      for (const h of hits) {
        const svc = spec.suspect === 'referenced' ? referencedService(h) ?? h.services[0] : h.services[0];
        if (!svc) continue;
        byService.set(svc, [...(byService.get(svc) ?? []), h]);
      }

      // For a fault in a shared resource, the suspect is the provider of that
      // resource, not every client that noticed. Clients all report the same
      // cache going cold; only one of them is the cache.
      if (spec.suspect === 'provider' && byService.size > 1) {
        const candidates = [...byService.keys()];
        const provider = candidates
          .map((c) => ({
            svc: c,
            dependedOnBy: candidates.filter((other) => other !== c && (upstreamOf.get(other)?.has(c) ?? false)).length,
          }))
          .sort((a, b) => b.dependedOnBy - a.dependedOnBy || a.svc.localeCompare(b.svc))[0];
        if (provider && provider.dependedOnBy > 0) {
          const merged = [...new Set([...byService.values()].flat())];
          byService.clear();
          byService.set(provider.svc, merged);
        }
      }

      for (const [suspect, hitEvidenceForService] of byService) {
        if (spec.requireAll && !spec.trigger.every((t) => evidence.some((e) => e.tags.includes(t)))) continue;

        // A signature that spans services (a cold cache hammering a database)
        // must be allowed to cite the far end of itself, not just the near end.
        const hitEvidence = spec.requireAll
          ? [...new Set([...hitEvidenceForService, ...hits])]
          : hitEvidenceForService;

        const supporting = hitEvidence.map((e) => ({
          evidenceId: e.id,
          weight: 0.9,
          rationale: `Signature of ${category.replace(/_/g, ' ')} observed on ${e.services.join('/') || suspect}`,
        }));

        // Corroborating evidence about the suspect — including first-hand
        // observations recorded elsewhere that name it. A caller's log saying
        // "stripe returned 503" is direct evidence about Stripe, even though the
        // log line lives on the caller.
        for (const e of evidence) {
          if (supporting.some((s) => s.evidenceId === e.id)) continue;
          const aboutSuspect = e.services.includes(suspect) || e.tags.includes(`ref:${suspect}`);
          if (!aboutSuspect) continue;
          if (!e.tags.some((t) => (MECHANISM_TAGS[category as RootCauseCategory] ?? []).includes(t))) continue;
          supporting.push({
            evidenceId: e.id,
            weight: e.services.includes(suspect) ? 0.55 : 0.7,
            rationale: e.services.includes(suspect)
              ? `Corroborating signal on ${suspect}`
              : `First-hand observation naming ${suspect} as the source, recorded on ${e.services.join('/')}`,
          });
        }

        const contradicting: HypothesisOutput['hypotheses'][number]['contradicting'] = [];
        for (const e of evidence) {
          if (!e.services.includes(suspect)) continue;
          if (e.tags.includes(TAG.RESOURCE_NORMAL) && spec.trigger.includes(TAG.SATURATION)) {
            contradicting.push({ evidenceId: e.id, weight: 0.7, rationale: `${suspect} resources are within normal range` });
          }
        }

        out.hypotheses.push({
          title: `${titleFor(category as RootCauseCategory)} in ${suspect}`,
          category: category as RootCauseCategory,
          suspectService: suspect,
          statement: `${spec.statement.replace('{service}', suspect)} Evidence: ${hitEvidence.map((e) => e.claim).slice(0, 2).join(' ')}`,
          supporting,
          contradicting,
          testablePredictions: spec.predictions.map((p) => p.replace('{service}', suspect)),
        });
      }
    }

    /* --- Rule C: an empty change log makes non-change causes more likely --- */
    const noChange = evidence.filter((e) => e.tags.includes(TAG.NO_CHANGE_FOUND));
    if (noChange.length > 0) {
      for (const h of out.hypotheses) {
        if (!NON_CHANGE_CATEGORIES.includes(h.category)) continue;
        for (const n of noChange) {
          h.supporting.push({ evidenceId: n.id, weight: 0.4, rationale: 'No deployment or configuration change can explain the timing' });
        }
      }
    }

    /* --- Rule D: historical postmortems as a weak prior -------------------- */
    for (const e of evidence.filter((x) => x.tags.includes(TAG.HISTORICAL_MATCH))) {
      const cat = e.tags.find((t) => t.startsWith('category:'))?.slice('category:'.length);
      if (!cat) continue;
      for (const h of out.hypotheses) {
        if (h.category !== cat) continue;
        h.supporting.push({ evidenceId: e.id, weight: 0.3, rationale: 'A resolved incident with these symptoms had this cause' });
      }
    }

    /* --- Contradiction detection across sources ---------------------------- */
    out.contradictions.push(...detectContradictions(evidence, topology));

    // Keep the field manageable; scoring will separate them anyway.
    out.hypotheses = dedupe(out.hypotheses).slice(0, 10);
    return out;
  }

  /* ----------------------------------------------------------------- score */

  async score(input: ScoreInput): Promise<ScoreOutput> {
    const { evidence, hypotheses } = input;
    const byId = new Map(evidence.map((e) => [e.id, e]));
    const onset = input.onsetEstimate ? Date.parse(input.onsetEstimate) : estimateOnset(evidence);
    const symptomServices = new Set(
      evidence
        .filter((e) => e.tags.some((t) => SYMPTOM_TAGS.includes(t)) && !e.tags.some((t) => CHANGE_TAGS.includes(t)))
        .flatMap((e) => e.services),
    );

    const scores = hypotheses.map((h) => {
      const reasons: string[] = [];

      let rawSupport = 0;
      const tools = new Set<string>();
      for (const link of h.supporting) {
        const e = byId.get(link.evidenceId);
        if (!e) continue;
        tools.add(e.source.tool);
        rawSupport += link.weight * typeFactor(e.type) * relFactor(e.reliability) * (e.source.complete ? 1 : 0.7);
      }

      let rawContra = 0;
      for (const link of h.contradicting) {
        const e = byId.get(link.evidenceId);
        if (!e) continue;
        rawContra += link.weight * typeFactor(e.type) * relFactor(e.reliability) * 1.1;
      }

      // Support saturates early and deliberately. Past a handful of links it
      // answers only "is this hypothesis evidenced at all?", and the ranking is
      // then decided by the structural terms below — mechanism specificity,
      // blast radius, temporal coherence. Without this, the hypothesis that
      // sweeps up the most loosely-related evidence always wins, which is how a
      // diagnostic system ends up blaming the most recent deploy every time.
      const support = saturate(rawSupport, 2.0);
      const contra = saturate(rawContra, 2.2);

      let bonus = 0;

      // Corroboration across independent tools beats volume from one tool.
      if (tools.size > 1) {
        const b = Math.min(0.75, (tools.size - 1) * 0.3);
        bonus += b;
        reasons.push(`corroborated by ${tools.size} independent tools (+${b.toFixed(2)})`);
      }

      // Mechanism match, weighted by how diagnostic each signal is. A raised
      // error rate is compatible with every cause; an x509 failure is not.
      const expected = MECHANISM_TAGS[h.category] ?? [];
      const presentTags = new Set(
        h.supporting.flatMap((l) => byId.get(l.evidenceId)?.tags ?? []),
      );
      const matchedTags = expected.filter((t) => presentTags.has(t));
      const mechanismScore = matchedTags.reduce((a, t) => a + (TAG_SPECIFICITY[t] ?? 0.2), 0);
      if (mechanismScore > 0) {
        const b = Math.min(MECHANISM_BONUS_CAP, mechanismScore);
        bonus += b;
        reasons.push(`mechanism signals [${matchedTags.join(', ')}] for ${h.category} (+${b.toFixed(2)})`);
      } else {
        bonus -= 0.5;
        reasons.push('no mechanism-specific evidence, only timing (-0.50)');
      }

      // Blast radius. The test is whether the *suspect itself* is unwell, not
      // whether anything near it is: a healthy service is not a fault source,
      // no matter how many of its neighbours are suffering.
      const suspect = h.suspectService;
      if (suspect) {
        if (symptomServices.has(suspect)) {
          bonus += 0.4;
          reasons.push('the suspect service itself shows the fault (+0.40)');
        } else {
          bonus -= 0.9;
          reasons.push('the suspect service shows no fault of its own (-0.90)');
        }
      }

      // An explicitly inert change is close to disqualifying.
      if (h.contradicting.some((l) => byId.get(l.evidenceId)?.tags.includes('inert_change'))) {
        bonus -= 0.6;
        reasons.push('the implicated change left no trace on the service it was applied to (-0.60)');
      }

      // Temporal coherence: the cause must precede the effect.
      const changeLinks = h.supporting
        .map((l) => byId.get(l.evidenceId))
        .filter((e): e is Evidence => !!e && e.tags.some((t) => CHANGE_TAGS.includes(t)) && !!e.observedAt);
      if (changeLinks.length > 0) {
        const lead = Math.min(...changeLinks.map((e) => (onset - Date.parse(e.observedAt as string)) / MIN));
        if (lead < -5) {
          bonus -= 1.0;
          reasons.push('the implicated change happened after the symptoms began (-1.00)');
        } else {
          const b = proximityWeight(lead) * 0.5;
          bonus += b;
          reasons.push(`change precedes onset by ${Math.round(lead)}min (+${b.toFixed(2)})`);
        }
      }

      // Facts outweigh inference; a hypothesis resting on nothing factual is weak.
      const facts = h.supporting.filter((l) => byId.get(l.evidenceId)?.type === 'fact').length;
      if (facts === 0) {
        bonus -= 0.8;
        reasons.push('no first-hand factual evidence (-0.80)');
      }

      if (input.degraded) {
        bonus -= 0.25;
        reasons.push('evidence set is known to be incomplete (-0.25)');
      }

      const raw = support - contra + bonus;
      // Capped at 0.95: no amount of evidence justifies certainty.
      const confidence = Math.min(0.95, clamp01(logistic(raw, 2.6, 0.6)));
      const status: Hypothesis['status'] =
        contra > support * 1.5 && contra > 1 ? 'refuted'
          : confidence >= 0.6 ? 'supported'
            : confidence < 0.3 ? 'weakened' : 'open';

      return {
        hypothesisId: h.id,
        confidence: Math.round(confidence * 1000) / 1000,
        status,
        reasoning: `support ${support.toFixed(2)} (from ${h.supporting.length} link(s), raw ${rawSupport.toFixed(2)}) − contradiction ${contra.toFixed(2)} (${h.contradicting.length} link(s)) + structure ${bonus.toFixed(2)} = ${raw.toFixed(2)}; ${reasons.join('; ')}`,
      };
    });

    return { scores };
  }

  /* --------------------------------------------------------------- critique */

  async critique(input: CritiqueInput): Promise<CritiqueOutput> {
    const ranked = [...input.hypotheses].sort((a, b) => b.confidence - a.confidence);
    const top = ranked[0];
    const second = ranked[1];
    const byId = new Map(input.evidence.map((e) => [e.id, e]));

    const challenges: CritiqueOutput['verdict']['challenges'] = [];
    const gaps: string[] = [];
    const requests: CritiqueOutput['requests'] = [];
    const lastRound = input.round >= input.maxRounds - 1;

    if (!top) {
      return {
        verdict: {
          decision: lastRound ? 'inconclusive' : 'revise',
          reasoning: 'No hypothesis survived generation; there is nothing to evaluate.',
          challenges: [{ hypothesisId: null, issue: 'No candidate root cause was produced', severity: 'blocking' }],
          evidenceGaps: ['any usable signal from logs or metrics'],
          confidenceInTop: 0,
        },
        requests: lastRound ? [] : [{
          kind: 'scan_logs', agent: 'observability',
          description: 'Re-query logs across the whole fleet, not only the reported services',
          params: {}, rationale: 'No hypothesis could be formed from the current evidence',
        }],
      };
    }

    // 1. Is anything factual holding this up?
    const topFacts = top.supporting.filter((l) => byId.get(l.evidenceId)?.type === 'fact');
    if (topFacts.length === 0) {
      challenges.push({ hypothesisId: top.id, issue: 'The leading hypothesis rests entirely on inference; no first-hand observation supports it', severity: 'blocking' });
      gaps.push(`first-hand log or metric evidence for ${top.suspectService ?? 'the suspect service'}`);
    }

    // 2. Can the top two actually be told apart?
    if (second && top.confidence - second.confidence < 0.12 && second.confidence > 0.25) {
      challenges.push({
        hypothesisId: top.id,
        issue: `"${top.title}" (${top.confidence.toFixed(2)}) and "${second.title}" (${second.confidence.toFixed(2)}) are not separated by the current evidence`,
        severity: 'major',
      });
      for (const h of [top, second]) {
        if (!h.suspectService) continue;
        gaps.push(`a signal that distinguishes ${h.title} from its rival`);
        requests.push({
          kind: 'targeted_probe', agent: 'observability',
          description: `Probe ${h.suspectService} for evidence that would discriminate "${h.title}"`,
          params: { services: [h.suspectService], predictions: h.testablePredictions, hypothesisId: h.id },
          rationale: 'The two leading hypotheses are within the noise of each other',
        });
      }
    }

    // 3. Does the cited evidence actually point at the cause being claimed?
    //    A hypothesis that rests on a signature belonging to a different
    //    category has established *when* something happened, not *what*.
    const topTags = new Set(top.supporting.flatMap((l) => byId.get(l.evidenceId)?.tags ?? []));
    const ownMechanism = new Set(MECHANISM_TAGS[top.category] ?? []);
    const misattributed = new Map<string, string[]>();
    for (const t of topTags) {
      if ((TAG_SPECIFICITY[t] ?? 0) < 0.5) continue;
      if (ownMechanism.has(t)) continue;
      const elsewhere = Object.entries(MECHANISM_TAGS)
        .filter(([cat, tags]) => cat !== top.category && (tags ?? []).includes(t))
        .map(([cat]) => cat);
      if (elsewhere.length) misattributed.set(t, elsewhere);
    }
    if (misattributed.size > 0) {
      const described = [...misattributed.entries()]
        .map(([t, cats]) => `"${t}" (a signature of ${cats.slice(0, 2).join(' or ')})`)
        .join(', ');
      challenges.push({
        hypothesisId: top.id,
        issue: `"${top.title}" cites ${described}, which points at a different cause than the one concluded. The evidence may establish the timing without establishing the mechanism.`,
        severity: 'major',
      });
      gaps.push(`evidence that distinguishes ${top.category.replace(/_/g, ' ')} from ${[...misattributed.values()].flat()[0]?.replace(/_/g, ' ')}`);
      if (top.suspectService) {
        requests.push({
          kind: 'targeted_probe', agent: 'observability',
          description: `Probe ${top.suspectService} and its dependents for the mechanism behind ${[...misattributed.keys()].join(', ')}`,
          params: { services: [top.suspectService], reason: `cited evidence suggests ${[...misattributed.values()].flat()[0]} rather than ${top.category}` },
          rationale: 'The leading hypothesis is supported by a signature belonging to another cause',
        });
        requests.push({
          kind: 'scan_metrics', agent: 'observability',
          description: `Re-collect metrics around ${top.suspectService} to test the competing mechanism`,
          params: { services: [top.suspectService] },
          rationale: 'A competing mechanism needs its own metric evidence before it can be ruled in or out',
        });
      }
    }

    // 4. Did we actually look everywhere?
    const unqueried = input.coverage.allTools.filter((t) => !input.coverage.toolsQueried.includes(t));
    if (unqueried.length > 0) {
      challenges.push({ hypothesisId: null, issue: `Evidence sources never consulted: ${unqueried.join(', ')}`, severity: unqueried.length > 1 ? 'major' : 'minor' });
      for (const t of unqueried) {
        gaps.push(`results from ${t}`);
        requests.push({
          kind: toolToTaskKind(t), agent: toolToAgent(t),
          description: `Query ${t}, which the investigation has not yet consulted`,
          params: {}, rationale: 'An unconsulted source could overturn the current ranking',
        });
      }
    }

    // 5. Did anything come back truncated?
    for (const t of input.coverage.incompleteTools) {
      challenges.push({ hypothesisId: null, issue: `${t} only ever returned partial data; conclusions drawn from it may be an artefact of truncation`, severity: 'major' });
      gaps.push(`a complete result from ${t}`);
      requests.push({
        kind: toolToTaskKind(t), agent: toolToAgent(t),
        description: `Re-query ${t}; every prior attempt returned a partial result`,
        params: { retryOfPartial: true }, rationale: 'Partial data can manufacture or hide a signal',
      });
    }

    // 6. Nothing in the change log, and we only looked at the window.
    const sawNoChange = input.evidence.some((e) => e.tags.includes(TAG.NO_CHANGE_FOUND));
    const widened = input.evidence.some((e) => Number(e.source.query?.lookbackMinutes ?? 0) > 1000);
    if (sawNoChange && !widened) {
      challenges.push({ hypothesisId: null, issue: 'No change was found inside the incident window, but slow-burn failures are usually triggered by an older release', severity: 'major' });
      gaps.push('deployments and config changes from the previous 48 hours');
      requests.push({
        kind: 'scan_deployments', agent: 'dependency',
        description: 'Widen the deployment and config search to 48 hours',
        params: { lookbackMinutes: 2880 }, rationale: 'A leak or drift can begin long after the release that caused it',
      });
    }

    // 7. Unresolved contradictions.
    for (const c of input.contradictions.filter((x) => !x.resolved)) {
      challenges.push({ hypothesisId: null, issue: `Unresolved contradiction: ${c.description}`, severity: 'major' });
      gaps.push(`resolution of: ${c.description}`);
    }

    // 8. Single-source conclusion.
    const topTools = new Set(top.supporting.map((l) => byId.get(l.evidenceId)?.source.tool).filter(Boolean));
    if (topTools.size === 1 && topFacts.length > 0) {
      challenges.push({ hypothesisId: top.id, issue: `The leading hypothesis is supported only by ${[...topTools][0]}; no independent source corroborates it`, severity: 'major' });
      gaps.push(`independent corroboration for ${top.title}`);
    }

    const blocking = challenges.filter((c) => c.severity === 'blocking').length;
    const major = challenges.filter((c) => c.severity === 'major').length;

    // A single serious objection is enough to justify another look when the
    // conclusion is only moderately held. Requiring two lets a half-convinced
    // answer through unchallenged, which is the failure mode the critic exists
    // to prevent.
    const seriousEnough = blocking > 0 || major >= 2 || (major >= 1 && top.confidence < 0.7);

    let decision: CritiqueOutput['verdict']['decision'];
    if (top.confidence < 0.35) {
      decision = lastRound ? 'inconclusive' : 'revise';
    } else if (seriousEnough && !lastRound && requests.length > 0) {
      decision = 'revise';
    } else if (blocking > 0 && lastRound && top.confidence < 0.5) {
      decision = 'inconclusive';
    } else {
      decision = 'accept';
    }

    const reasoning =
      decision === 'accept'
        ? `"${top.title}" is supported by ${topFacts.length} factual observation(s) across ${topTools.size} source(s) at confidence ${top.confidence.toFixed(2)}${second ? `, ahead of "${second.title}" at ${second.confidence.toFixed(2)}` : ''}. ${challenges.length === 0 ? 'No material objection remains.' : `${describeSeverities(challenges)} remain unresolved and are recorded in the report.`}`
        : decision === 'revise'
          ? `Confidence in "${top.title}" is ${top.confidence.toFixed(2)} with ${blocking} blocking and ${major} major objection(s). Requesting ${requests.length} further investigation step(s) before accepting any conclusion.`
          : `Evidence is insufficient to name a root cause. The leading candidate "${top.title}" reaches only ${top.confidence.toFixed(2)}, with ${challenges.length} unresolved objection(s). Reporting an inconclusive outcome rather than guessing.`;

    return {
      verdict: {
        decision,
        reasoning,
        challenges,
        evidenceGaps: [...new Set(gaps)],
        confidenceInTop: top.confidence,
      },
      requests: decision === 'revise' ? dedupeRequests(requests).slice(0, 4) : [],
    };
  }

  /* ---------------------------------------------------------------- report */

  async report(input: ReportInput): Promise<ReportOutput> {
    const ranked = [...input.hypotheses].sort((a, b) => b.confidence - a.confidence);
    const top = ranked[0];
    const byId = new Map(input.evidence.map((e) => [e.id, e]));
    const inconclusive = !top || input.verdict?.decision === 'inconclusive' || top.confidence < 0.35;

    const verdict: ReportOutput['verdict'] = inconclusive
      ? 'inconclusive'
      : (top as Hypothesis).confidence >= 0.7
        ? 'root_cause_identified'
        : 'probable_cause';

    const citedFacts = top
      ? top.supporting.map((l) => byId.get(l.evidenceId)).filter((e): e is Evidence => !!e && e.type === 'fact')
      : [];
    const citedSoft = top
      ? top.supporting.map((l) => byId.get(l.evidenceId)).filter((e): e is Evidence => !!e && e.type !== 'fact')
      : [];

    const facts = [
      ...new Set([
        ...citedFacts.map((e) => `${e.claim} [${e.id}, ${e.source.tool}]`),
        ...input.evidence.filter((e) => e.type === 'fact' && e.tags.includes(TAG.NO_CHANGE_FOUND)).map((e) => `${e.claim} [${e.id}]`),
      ]),
    ].slice(0, 12);

    const assumptions = [
      ...new Set([
        ...citedSoft.map((e) => `${e.claim} [${e.id}, ${e.type}]`),
        ...(input.degradations.length
          ? ['Evidence is incomplete: ' + input.degradations.join('; ')]
          : []),
        ...(top && top.contradicting.length
          ? [`Contradicting evidence against the leading hypothesis has not been fully explained (${top.contradicting.length} item(s))`]
          : []),
      ]),
    ].slice(0, 10);

    const summary = inconclusive
      ? buildInconclusiveSummary(input, top)
      : buildSummary(input, top as Hypothesis, citedFacts, ranked[1]);

    const actions = buildActions(
      inconclusive ? 'unknown' : (top as Hypothesis).category,
      (top?.suspectService ?? input.incident.affectedServices[0] ?? 'the affected service'),
      top?.id ?? null,
      inconclusive,
    );

    return {
      verdict,
      summary,
      facts,
      assumptions,
      evidenceGaps: input.verdict?.evidenceGaps ?? [],
      recommendedActions: actions,
    };
  }
}

/* ========================================================================== */
/* Mechanism signature table                                                   */
/* ========================================================================== */

interface MechSpec {
  trigger: string[];
  statement: string;
  predictions: string[];
  /** 'self'       = the service carrying the tag
   *  'referenced' = the service named inside the claim (upstream faults)
   *  'provider'   = among all services carrying the tag, the one the others
   *                 depend on (shared-resource faults such as a cold cache) */
  suspect: 'self' | 'referenced' | 'provider';
  requireAll?: boolean;
}

const MECHANISM_SIGNATURES: Record<string, MechSpec> = {
  memory_leak: {
    trigger: [TAG.OOM],
    suspect: 'self',
    statement: '{service} is exhausting its heap and being killed, then restarting, in a repeating cycle.',
    predictions: ['Heap usage on {service} grows monotonically between restarts', 'A heap dump shows one dominant retained object graph', 'Latency climbs as the heap fills and resets on restart'],
  },
  connection_pool_exhaustion: {
    trigger: [TAG.POOL_SATURATION],
    suspect: 'self',
    statement: '{service} cannot obtain a database connection; requests queue behind an exhausted client-side pool.',
    predictions: ['Pool wait time on {service} tracks request latency', 'The database itself shows normal or reduced load', 'Raising the pool size relieves the symptom'],
  },
  schema_migration: {
    trigger: [TAG.LOCK_WAIT],
    suspect: 'self',
    statement: 'A long-held lock on {service} is blocking writers until they time out.',
    predictions: ['Write paths fail while read paths succeed', 'Lock wait time matches the client timeout', 'Cancelling the lock holder releases the writers immediately'],
  },
  cache_failure: {
    trigger: [TAG.CACHE_MISS],
    suspect: 'provider',
    statement: 'The cache tier at {service} stopped serving, pushing load onto the backing store.',
    predictions: ['Hit rate on {service} and dependent latency move together', 'The backing store sees a proportional load increase', 'Restoring the cache restores latency'],
  },
  certificate_expiry: {
    trigger: [TAG.CERT_ERROR],
    suspect: 'self',
    statement: 'TLS verification is failing at {service}; a certificate in the chain is no longer valid.',
    predictions: ['Failure began exactly on a timestamp boundary', 'No deployment or config change coincides with onset', 'Failure is total rather than partial'],
  },
  dns_failure: {
    trigger: [TAG.DNS_ERROR],
    suspect: 'self',
    statement: 'Name resolution is failing at {service}, so calls never leave the host.',
    predictions: ['The target reports zero inbound traffic and healthy status', 'Resolving the hostname from the pod fails', 'Only destinations needing public DNS are affected'],
  },
  rate_limit: {
    trigger: [TAG.RATE_LIMITED],
    suspect: 'referenced',
    statement: 'Calls to {service} are being rejected for exceeding a published quota.',
    predictions: ['Rejections are 429 rather than 5xx', 'Rejection rate tracks request volume against a fixed ceiling', 'Reducing request rate immediately stops the rejections'],
  },
  third_party_outage: {
    trigger: [TAG.EXTERNAL_DEGRADED],
    suspect: 'self',
    statement: 'The external provider {service} is returning errors or responding slowly.',
    predictions: ['Local CPU, memory and throughput are unchanged', 'Errors carry the provider’s own status codes', 'Other callers of the same provider see the same failure'],
  },
  thundering_herd: {
    trigger: [TAG.CACHE_MISS, TAG.THROUGHPUT_SPIKE],
    suspect: 'provider',
    statement: 'A cold cache at {service} sent a synchronised burst of reads to the backing store.',
    predictions: ['Backing-store QPS rises far more than inbound user traffic', 'The spike decays as the cache refills', 'Inbound request volume is roughly unchanged'],
    requireAll: true,
  },
  dependency_failure: {
    trigger: [TAG.UPSTREAM_UNHEALTHY],
    suspect: 'referenced',
    statement: 'A dependency, {service}, is unhealthy and its callers are inheriting the failure.',
    predictions: ['The dependency degrades before its callers do', 'Callers that avoid the dependency are unaffected', 'The dependency shows the fault independently of any caller'],
  },
  resource_exhaustion: {
    trigger: [TAG.SATURATION],
    suspect: 'self',
    statement: '{service} is saturating a resource and queueing work as a result.',
    predictions: ['Utilisation on {service} correlates with latency', 'Adding capacity relieves the symptom', 'The saturation precedes the latency increase'],
  },
  traffic_surge: {
    trigger: [TAG.THROUGHPUT_SPIKE],
    suspect: 'self',
    statement: 'Inbound volume to {service} rose beyond what the current capacity absorbs.',
    predictions: ['Request volume rises before latency does', 'Per-request cost is unchanged', 'Scaling out restores latency'],
  },
  database_degradation: {
    trigger: [TAG.REPLICA_LAG],
    suspect: 'provider',
    statement: 'The data tier at {service} is degraded and slow or stale for its clients.',
    predictions: ['Query latency rises independently of client behaviour', 'Multiple unrelated clients degrade together', 'Client-side resources stay normal'],
  },
};

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

function changeCategory(e: Evidence): RootCauseCategory {
  if (e.tags.includes(TAG.FEATURE_FLAG)) return 'feature_flag';
  if (e.tags.includes(TAG.SCHEMA_CHANGE)) return 'schema_migration';
  if (e.tags.includes(TAG.DEPLOY)) return 'deployment_regression';
  return 'config_change';
}

function titleFor(c: RootCauseCategory): string {
  return c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
}

/**
 * 1.0 for a change immediately before onset, decaying with lead time.
 *
 * The floor is deliberately near zero. A release that landed ten hours before
 * onset is not weak evidence that it caused the incident — it is close to no
 * evidence at all, unless something independently connects its contents to the
 * observed failure. A generous floor lets any stale deploy accumulate enough
 * weight from unrelated symptoms to outrank the real mechanism, which is the
 * single most common way this kind of system goes wrong.
 */
function proximityWeight(leadMin: number): number {
  if (leadMin < -5) return 0.02;
  const l = Math.max(0, leadMin);
  return Math.max(0.02, Math.exp(-l / 45));
}

function fmtLead(leadMin: number): string {
  const m = Math.round(leadMin);
  if (m < 0) return `${Math.abs(m)}min after`;
  if (m < 90) return `${m}min before`;
  return `${(m / 60).toFixed(1)}h before`;
}

function typeFactor(t: Evidence['type']): number {
  return t === 'fact' ? 1 : t === 'inference' ? 0.65 : 0.35;
}
function relFactor(r: Evidence['reliability']): number {
  return r === 'high' ? 1 : r === 'medium' ? 0.75 : 0.45;
}
function logistic(x: number, mid: number, scale: number): number {
  return 1 / (1 + Math.exp(-(x - mid) / scale));
}
/** Describes residual objections by their actual severity, so an accepted
 *  conclusion never understates what was raised against it. */
function describeSeverities(challenges: { severity: 'blocking' | 'major' | 'minor' }[]): string {
  const counts = { blocking: 0, major: 0, minor: 0 };
  for (const c of challenges) counts[c.severity]++;
  const parts = (['blocking', 'major', 'minor'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`);
  return `${parts.join(' and ')} objection(s)`;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Compresses an unbounded sum into [0, ceiling) with diminishing returns. */
function saturate(x: number, ceiling: number): number {
  return ceiling * (1 - Math.exp(-x / ceiling));
}

function estimateOnset(evidence: Evidence[]): number {
  const times = evidence
    .filter((e) => e.tags.some((t) => SYMPTOM_TAGS.includes(t)) && e.observedAt)
    .map((e) => Date.parse(e.observedAt as string))
    .filter((t) => !Number.isNaN(t));
  return times.length ? Math.min(...times) : Date.now();
}

function buildUpstreamIndex(
  topology: HypothesisInput['topology'],
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const t of topology) m.set(t.service, new Set(t.dependencies));
  return m;
}

/** The service named inside a claim, used when the fault is upstream. */
function referencedService(e: Evidence): string | null {
  const ref = e.tags.find((t) => t.startsWith('ref:'));
  return ref ? ref.slice('ref:'.length) : null;
}

function extractServices(text: string, evidence: Evidence[]): string[] {
  const all = new Set(evidence.flatMap((e) => e.services));
  return [...all].filter((s) => text.includes(s));
}

/** Shared uncommon terms between a change description and an error message. */
function sharesDistinctiveTerm(a: string, b: string): boolean {
  const norm = (s: string) =>
    new Set(
      s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 3 && !COMMON.has(t)),
    );
  const ta = norm(a);
  const tb = norm(b);
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}
const COMMON = new Set([
  'service', 'from', 'with', 'that', 'this', 'into', 'over', 'change', 'changes', 'error',
  'errors', 'request', 'requests', 'deployed', 'config', 'value', 'update', 'updated', 'time',
  'after', 'before', 'during', 'window', 'default', 'version', 'minutes', 'onset', 'added', 'adds',
]);

/** Metrics every service reports about itself; two services differing on one
 *  of these is normal, not contradictory. */
const SELF_METRICS = new Set([
  'latency_p99_ms', 'latency_p50_ms', 'error_rate_pct', 'cpu_pct', 'memory_pct',
  'requests_per_sec', 'heap_used_pct', 'gc_pause_ms',
]);

/** Edge kinds where both ends genuinely observe the same substrate, so a
 *  disagreement about a shared metric is a real conflict. */
const SHARED_SUBSTRATE_EDGES = new Set(['cache', 'database', 'async_queue', 'third_party']);

function detectContradictions(
  evidence: Evidence[],
  topology: HypothesisInput['topology'],
): { description: string; evidenceIds: string[] }[] {
  const out: { description: string; evidenceIds: string[] }[] = [];
  const dir = (e: Evidence) => e.tags.find((t) => t.startsWith('dir:'))?.slice(4) ?? null;
  const metricOf = (e: Evidence) => e.tags.find((t) => t.startsWith('metric:'))?.slice('metric:'.length) ?? null;

  const measured = evidence.filter((e) => metricOf(e) && dir(e));

  // --- 1. the same service, the same metric, two incompatible readings ------
  const bySvcMetric = new Map<string, Evidence[]>();
  for (const e of measured) {
    const key = `${e.services[0] ?? ''}|${metricOf(e)}`;
    bySvcMetric.set(key, [...(bySvcMetric.get(key) ?? []), e]);
  }
  for (const [key, items] of bySvcMetric) {
    const dirs = new Set(items.map(dir));
    if (dirs.size < 2) continue;
    const [svc, metric] = key.split('|');
    const a = items.find((e) => dir(e) !== dir(items[0] as Evidence)) as Evidence | undefined;
    if (!a) continue;
    out.push({
      description: `${metric} on ${svc} is reported both as "${dir(items[0] as Evidence)}" and as "${dir(a)}" by separate queries; one of the two readings must be wrong`,
      evidenceIds: [(items[0] as Evidence).id, a.id],
    });
  }

  // --- 2. both ends of a shared resource disagree about that resource -------
  const edgeKind = new Map<string, string>();
  for (const t of topology) {
    for (const d of t.dependencies) edgeKind.set(`${t.service}->${d}`, kindOfEdge(topology, t.service, d));
  }

  for (let i = 0; i < measured.length; i++) {
    for (let j = i + 1; j < measured.length; j++) {
      const a = measured[i] as Evidence;
      const b = measured[j] as Evidence;
      const ma = metricOf(a);
      if (ma !== metricOf(b) || !ma) continue;
      if (SELF_METRICS.has(ma)) continue;
      if (dir(a) === dir(b)) continue;
      const sa = a.services[0];
      const sb = b.services[0];
      if (!sa || !sb || sa === sb) continue;
      const kind = edgeKind.get(`${sa}->${sb}`) ?? edgeKind.get(`${sb}->${sa}`);
      if (!kind || !SHARED_SUBSTRATE_EDGES.has(kind)) continue;
      out.push({
        description: `${ma} describes the resource shared by ${sa} and ${sb}, yet it is reported as "${dir(a)}" on ${sa} and "${dir(b)}" on ${sb}; at most one reading describes the shared behaviour`,
        evidenceIds: [a.id, b.id],
      });
    }
  }

  return dedupeByDescription(out).slice(0, 4);
}

function kindOfEdge(topology: HypothesisInput['topology'], from: string, to: string): string {
  void topology;
  // Edge kinds are not carried on the topology slice the reasoning agent sees,
  // so infer from naming conventions in the fleet: this only ever widens or
  // narrows which pairs are eligible, never which direction is reported.
  if (/redis|cache|memcach/i.test(to)) return 'cache';
  if (/postgres|mysql|elastic|mongo|clickhouse/i.test(to)) return 'database';
  if (/kafka|rabbit|sqs|queue/i.test(to)) return 'async_queue';
  if (/-api$|stripe|twilio|auth0/i.test(to)) return 'third_party';
  void from;
  return 'sync';
}

function dedupeByDescription(xs: { description: string; evidenceIds: string[] }[]): { description: string; evidenceIds: string[] }[] {
  const seen = new Set<string>();
  const out: typeof xs = [];
  for (const x of xs) {
    if (seen.has(x.description)) continue;
    seen.add(x.description);
    out.push(x);
  }
  return out;
}

function dedupe(hs: HypothesisOutput['hypotheses']): HypothesisOutput['hypotheses'] {
  const seen = new Map<string, HypothesisOutput['hypotheses'][number]>();
  for (const h of hs) {
    const key = `${h.category}|${h.suspectService ?? ''}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, h);
      continue;
    }
    seen.set(key, {
      ...prev,
      supporting: mergeByEvidence([...prev.supporting, ...h.supporting]),
      contradicting: mergeByEvidence([...prev.contradicting, ...h.contradicting]),
      testablePredictions: [...new Set([...prev.testablePredictions, ...h.testablePredictions])],
    });
  }
  return [...seen.values()];
}

function mergeByEvidence<T extends { evidenceId: string; weight: number }>(links: T[]): T[] {
  const m = new Map<string, T>();
  for (const l of links) {
    const p = m.get(l.evidenceId);
    if (!p || l.weight > p.weight) m.set(l.evidenceId, l);
  }
  return [...m.values()];
}

function dedupeRequests(rs: CritiqueOutput['requests']): CritiqueOutput['requests'] {
  const seen = new Set<string>();
  const out: CritiqueOutput['requests'] = [];
  for (const r of rs) {
    const k = `${r.kind}|${JSON.stringify(r.params)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function toolToTaskKind(tool: string): CritiqueOutput['requests'][number]['kind'] {
  switch (tool) {
    case 'query_logs': return 'scan_logs';
    case 'query_metrics': return 'scan_metrics';
    case 'query_deployments': return 'scan_deployments';
    case 'query_config_changes': return 'scan_config';
    case 'query_dependencies': return 'map_dependencies';
    case 'query_historical_incidents': return 'scan_historical';
    default: return 'targeted_probe';
  }
}
function toolToAgent(tool: string): CritiqueOutput['requests'][number]['agent'] {
  return tool === 'query_logs' || tool === 'query_metrics' ? 'observability' : 'dependency';
}

function buildSummary(
  input: ReportInput,
  top: Hypothesis,
  facts: Evidence[],
  second: Hypothesis | undefined,
): string {
  const conf = top.confidence >= 0.7 ? 'high' : top.confidence >= 0.5 ? 'moderate' : 'low';
  const parts = [
    `${input.incident.id}: the most probable root cause is ${top.title.toLowerCase()} (${top.category.replace(/_/g, ' ')}), at ${conf} confidence (${top.confidence.toFixed(2)}).`,
    top.statement,
  ];
  if (facts.length) {
    parts.push(
      `This rests on ${facts.length} first-hand observation(s), notably: ${facts.slice(0, 2).map((f) => f.claim).join(' ')}`,
    );
  }
  if (second) {
    parts.push(
      `The strongest alternative considered was ${second.title.toLowerCase()} at ${second.confidence.toFixed(2)}; it was ranked lower because the evidence linking it to the observed symptoms is weaker.`,
    );
  }
  if (top.contradicting.length) {
    parts.push(`${top.contradicting.length} observation(s) argue against this conclusion and are listed with the hypothesis.`);
  }
  return parts.join(' ');
}

function buildInconclusiveSummary(input: ReportInput, top: Hypothesis | undefined): string {
  const parts = [
    `${input.incident.id}: the investigation did not reach a defensible root cause.`,
  ];
  if (top) {
    parts.push(
      `The leading candidate, ${top.title.toLowerCase()}, reached only ${top.confidence.toFixed(2)} confidence, which is below the threshold for naming a cause.`,
    );
  }
  if (input.degradations.length) {
    parts.push(`Evidence collection was degraded: ${input.degradations.slice(0, 3).join('; ')}.`);
  }
  if (input.verdict?.evidenceGaps.length) {
    parts.push(`The outstanding gaps are: ${input.verdict.evidenceGaps.slice(0, 4).join('; ')}.`);
  }
  parts.push('Rather than present a guess as a finding, the recommended next step is to restore the missing evidence and re-run the investigation.');
  return parts.join(' ');
}

function buildActions(
  category: string,
  service: string,
  hypothesisId: string | null,
  inconclusive: boolean,
): RemediationAction[] {
  const templates = REMEDIATION[category] ?? REMEDIATION.unknown!;
  return templates.map((t) => ({
    action: t.action.replace('{service}', service),
    type: t.type,
    targetService: service,
    rationale: inconclusive
      ? 'Recommended because the cause is unresolved; this step preserves or restores the evidence needed to resolve it.'
      : `Standard remediation for ${category.replace(/_/g, ' ')}, predicated on the leading hypothesis holding.`,
    predicatedOn: inconclusive ? null : hypothesisId,
    risk: t.risk,
  }));
}
