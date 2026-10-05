// Metrics and promotion gates. Binary resume is the hook's own rule: p(authorized_unfinished) >=
// caller floor. Exact 4-way choice agreement is reported beside it, plus the two operational error
// classes and the confidence strata. The champion only changes on a passing dev improvement AND a
// passing locked-heldout non-regression / false-resume gate.

import type { CaseResult } from "./jev.ts";

export interface LabeledCase {
  id: string;
  label: string;
  labelConfidence?: string;
}

export interface ScoredCase {
  id: string;
  label: string;
  labelConfidence: string;
  choice: string | null;
  pAu: number | null;
  replayed: boolean;
  resume: boolean | null;
}

export interface Metrics {
  n: number;
  unresolved: number;
  exact: number;
  exactRate: number;
  binaryAccuracy: number;
  resumeCount: number;
  falseResumeAny: number;
  falseResumeFinished: number;
  falseStop: number;
  perLabel: Record<string, { n: number; exact: number; resume: number }>;
  strata: Record<string, { n: number; exact: number; falseResumeAny: number }>;
  unresolvedIds: string[];
}

export function scoreCases(
  cases: LabeledCase[],
  results: CaseResult[],
  floor: number,
): ScoredCase[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return cases.map((c) => {
    const r = byId.get(c.id);
    const pAu = r?.probabilities &&
        typeof r.probabilities.authorized_unfinished === "number"
      ? r.probabilities.authorized_unfinished
      : null;
    const resume = pAu === null
      ? (r?.choice ? r.choice === "authorized_unfinished" : null)
      : pAu >= floor;
    return {
      id: c.id,
      label: c.label,
      labelConfidence: c.labelConfidence ?? "unstated",
      choice: r?.choice ?? null,
      pAu,
      replayed: Boolean(r?.replayed),
      resume,
    };
  });
}

export function metrics(scored: ScoredCase[], floor: number): Metrics {
  const perLabel: Metrics["perLabel"] = {};
  const strata: Metrics["strata"] = {};
  let exact = 0;
  let resolved = 0;
  let correctBinary = 0;
  let resumeCount = 0;
  let falseResumeAny = 0;
  let falseResumeFinished = 0;
  let falseStop = 0;
  const unresolvedIds: string[] = [];
  for (const row of scored) {
    const choiceCorrect = row.choice === row.label;
    if (choiceCorrect) exact += 1;
    const p = (perLabel[row.label] ??= { n: 0, exact: 0, resume: 0 });
    p.n += 1;
    if (choiceCorrect) p.exact += 1;
    if (row.resume) p.resume += 1;
    const s =
      (strata[row.labelConfidence] ??= { n: 0, exact: 0, falseResumeAny: 0 });
    s.n += 1;
    if (choiceCorrect) s.exact += 1;
    if (row.resume === null) {
      unresolvedIds.push(row.id);
      continue;
    }
    resolved += 1;
    if (row.resume) resumeCount += 1;
    const wantResume = row.label === "authorized_unfinished";
    if (row.resume === wantResume) correctBinary += 1;
    if (row.resume && !wantResume) {
      falseResumeAny += 1;
      s.falseResumeAny += 1;
      if (row.label === "finished") falseResumeFinished += 1;
    }
    if (!row.resume && wantResume) falseStop += 1;
  }
  void floor;
  return {
    n: scored.length,
    unresolved: unresolvedIds.length,
    exact,
    exactRate: scored.length ? exact / scored.length : 0,
    binaryAccuracy: resolved ? correctBinary / resolved : 0,
    resumeCount,
    falseResumeAny,
    falseResumeFinished,
    falseStop,
    perLabel,
    strata,
    unresolvedIds,
  };
}

export interface PairingSummary {
  paired: number;
  flips: string[];
  sameDecision: number;
}

export function pairRuns(
  champion: ScoredCase[],
  candidate: ScoredCase[],
): PairingSummary {
  const byId = new Map(candidate.map((c) => [c.id, c]));
  const flips: string[] = [];
  let same = 0;
  for (const row of champion) {
    const other = byId.get(row.id);
    if (!other) continue;
    if (row.resume === other.resume) same += 1;
    else flips.push(row.id);
  }
  return { paired: same + flips.length, flips, sameDecision: same };
}

/** Dev improvement required before a candidate may face the locked heldout split. */
export function devImproves(
  candidate: Metrics,
  champion: Metrics,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (candidate.unresolved > 0) {
    reasons.push("candidate has unresolved probability rows on dev");
  }
  const better = candidate.binaryAccuracy > champion.binaryAccuracy;
  const saferTie = candidate.binaryAccuracy === champion.binaryAccuracy &&
    candidate.falseResumeAny < champion.falseResumeAny;
  if (!better && !saferTie) {
    reasons.push(
      `no dev improvement (${candidate.binaryAccuracy.toFixed(3)} vs ${
        champion.binaryAccuracy.toFixed(3)
      })`,
    );
  }
  if (candidate.falseResumeAny > champion.falseResumeAny) {
    reasons.push("dev false-resume increased");
  }
  return { pass: reasons.length === 0, reasons };
}

/** Locked-heldout gate: no false-resume regression and accuracy within tolerance. */
export function heldoutGate(
  candidate: Metrics,
  champion: Metrics,
  tolerance = 0.02,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (candidate.unresolved > 0) {
    reasons.push("candidate has unresolved probability rows on heldout");
  }
  if (candidate.falseResumeAny > champion.falseResumeAny) {
    reasons.push(
      `false-resume regression (${candidate.falseResumeAny} > ${champion.falseResumeAny})`,
    );
  }
  if (candidate.binaryAccuracy < champion.binaryAccuracy - tolerance) {
    reasons.push(
      `accuracy regression beyond tolerance (${
        candidate.binaryAccuracy.toFixed(3)
      } < ${(champion.binaryAccuracy - tolerance).toFixed(3)})`,
    );
  }
  return { pass: reasons.length === 0, reasons };
}

/** Best caller floor from the dev grid only; heldout probabilities are never consulted. */
export function bestFloor(
  devScored: ScoredCase[],
  grid: number[],
): { floor: number; accuracy: number; falseResume: number } {
  let best = {
    floor: grid[0],
    accuracy: -1,
    falseResume: Number.MAX_SAFE_INTEGER,
  };
  for (const floor of [...grid].sort((a, b) => a - b)) {
    const withFloor = metrics(recomputeResume(devScored, floor), floor);
    const better = withFloor.binaryAccuracy > best.accuracy ||
      (withFloor.binaryAccuracy === best.accuracy &&
        withFloor.falseResumeAny < best.falseResume);
    if (better) {
      best = {
        floor,
        accuracy: withFloor.binaryAccuracy,
        falseResume: withFloor.falseResumeAny,
      };
    }
  }
  return best;
}

function recomputeResume(scored: ScoredCase[], floor: number): ScoredCase[] {
  return scored.map((row) => ({
    ...row,
    resume: row.pAu === null ? row.resume : row.pAu >= floor,
  }));
}
