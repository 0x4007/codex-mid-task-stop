// Bounded, deterministic candidate generation. The only mechanism is the one the original teaching
// commits used: a small text edit to `work.instructions.question` or a `work.criteria.*.what`
// sentence, plus the caller-side resume floor. No weights, no fine-tuning, no new examples, no
// primitive/id/model/option changes, and no live hook or config installation.
//
// Candidate selection sees dev rows only. The function signature cannot reach the locked heldout
// split, and the run driver never passes it.

import type { BacktestConfig } from "./config.ts";
import type { Metrics, ScoredCase } from "./gate.ts";
import { hash16 } from "./panel.ts";

export interface Candidate {
  id: string;
  trial: number;
  kind: ErrorKind;
  editPath: string;
  sentence: string;
  floor: number;
  questions: Record<string, unknown>;
  hashes: { base: string; candidate: string; content: string };
}

export type ErrorKind =
  | "false_resume_finished"
  | "false_resume_waiting"
  | "false_resume_unclear"
  | "false_stop"
  | "unresolved"
  | "floor_only";

interface Template {
  path: string;
  sentence: string;
}

// Fixed templates: one bounded sentence, addressed to the observed dev error class. Selection among
// them is deterministic (count desc, then this order).
const TEMPLATES: Record<
  Exclude<ErrorKind, "unresolved" | "floor_only">,
  Template
> = {
  false_resume_finished: {
    path: "work.criteria.finished.what",
    sentence:
      "Also choose finished when the reply reports the requested work complete and then summarizes results, artifacts, or unrelated follow-ups; a long or detailed completion report is not remaining work.",
  },
  false_resume_waiting: {
    path: "work.instructions.question",
    sentence:
      "If the reply is blocked on something it started and must wait for (a sub-agent or background task, a test, or a build it launched) before it can continue, choose waiting rather than authorized_unfinished.",
  },
  false_resume_unclear: {
    path: "work.instructions.question",
    sentence:
      "Choose unclear only when the available text cannot support any of the other three options; do not use authorized_unfinished as a default for an ambiguous ending.",
  },
  false_stop: {
    path: "work.criteria.authorized_unfinished.what",
    sentence:
      "Also choose authorized_unfinished when the reply reports only part of the requested work, says it has not started or did not do part of what was asked, or ends by describing what it will do next.",
  },
};

const PRIORITY: ErrorKind[] = [
  "false_resume_finished",
  "false_resume_waiting",
  "false_resume_unclear",
  "false_stop",
  "unresolved",
];

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getPath(doc: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, doc);
}

function setPath(
  doc: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  const last = keys.pop() as string;
  let cursor = doc;
  for (const key of keys) cursor = cursor[key] as Record<string, unknown>;
  cursor[last] = value;
}

export function countErrorKinds(scored: ScoredCase[]): Map<ErrorKind, number> {
  const counts = new Map<ErrorKind, number>();
  for (const row of scored) {
    if (row.resume === null) {
      counts.set("unresolved", (counts.get("unresolved") ?? 0) + 1);
      continue;
    }
    const wantResume = row.label === "authorized_unfinished";
    if (row.resume && !wantResume) {
      const kind: ErrorKind = row.label === "finished"
        ? "false_resume_finished"
        : row.label === "waiting"
        ? "false_resume_waiting"
        : "false_resume_unclear";
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    } else if (!row.resume && wantResume) {
      counts.set("false_stop", (counts.get("false_stop") ?? 0) + 1);
    }
  }
  return counts;
}

export function questionContentHash(
  questions: Record<string, unknown>,
): string {
  return hash16(questions);
}

export function caseInputHash(caseIds: string[]): string {
  return hash16([...caseIds].sort());
}

/** At most `maxTrials` dev-derived edits; deterministic order, one sentence, one path each. */
export function proposeCandidates(
  baseQuestions: Record<string, unknown>,
  devScored: ScoredCase[],
  cfg: BacktestConfig,
): Candidate[] {
  const counts = countErrorKinds(devScored);
  const ranked = [...counts.entries()]
    .filter(([kind, count]) => kind !== "unresolved" && count > 0)
    .sort((a, b) =>
      b[1] - a[1] || PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0])
    );
  const candidates: Candidate[] = [];
  for (const [kind, count] of ranked.slice(0, cfg.limits.maxTrials)) {
    const template =
      TEMPLATES[kind as Exclude<ErrorKind, "unresolved" | "floor_only">];
    const questions = deepClone(baseQuestions);
    const current = getPath(questions, template.path);
    if (typeof current !== "string") continue;
    setPath(
      questions,
      template.path,
      `${current.trimEnd()} ${template.sentence}`,
    );
    const candidate: Candidate = {
      id: `trial-${candidates.length + 1}-${kind}`,
      trial: candidates.length + 1,
      kind,
      editPath: template.path,
      sentence: template.sentence,
      floor: cfg.floor,
      questions,
      hashes: {
        base: questionContentHash(baseQuestions),
        candidate: questionContentHash(questions),
        content: hash16({
          kind,
          count,
          path: template.path,
          sentence: template.sentence,
        }),
      },
    };
    assertCandidateImmutable(baseQuestions, candidate);
    candidates.push(candidate);
  }
  return candidates;
}

const ALLOWED_PATHS = new Set([
  "work.criteria.authorized_unfinished.what",
  "work.criteria.finished.what",
  "work.instructions.question",
  "work.instructions.focus",
]);

/** Fails closed when anything other than the allowed text paths changed. */
export function assertCandidateImmutable(
  base: Record<string, unknown>,
  candidate: Candidate,
): void {
  const before = deepClone(base);
  const after = deepClone(candidate.questions);
  if (!ALLOWED_PATHS.has(candidate.editPath)) {
    throw new Error(`candidate edit path not allowed: ${candidate.editPath}`);
  }
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (typeof a === "string" && typeof b === "string") {
      if (a !== b && !ALLOWED_PATHS.has(path)) {
        throw new Error(`candidate changed a non-editable text field: ${path}`);
      }
      if (a !== b && path !== candidate.editPath) {
        throw new Error(`candidate changed an unexpected path: ${path}`);
      }
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`candidate changed an array at ${path}`);
      }
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = new Set([
        ...Object.keys(a as object),
        ...Object.keys(b as object),
      ]);
      for (const key of keys) {
        if (!(key in (a as object)) || !(key in (b as object))) {
          throw new Error(`candidate changed the key set at ${path}.${key}`);
        }
        walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
      }
      return;
    }
    if (a !== b) {
      throw new Error(`candidate changed a non-text field at ${path}`);
    }
  };
  walk(before, after, "");
  const workBefore = (before as { work?: Record<string, unknown> }).work;
  const workAfter = (after as { work?: Record<string, unknown> }).work;
  if (
    !workBefore || !workAfter || workBefore.type !== "choice" ||
    workAfter.type !== "choice"
  ) {
    throw new Error("candidate changed the primitive or question id");
  }
  if (
    JSON.stringify(Object.keys(workBefore).sort()) !==
      JSON.stringify(Object.keys(workAfter).sort())
  ) {
    throw new Error("candidate changed the question key set");
  }
  if (JSON.stringify(after).includes('"examples"')) {
    throw new Error("candidate introduced examples");
  }
}

/** Fold the dev-selected caller floor into a candidate without touching question content. */
export function withFloor(
  candidate: Candidate,
  floor: number,
  cfg: BacktestConfig,
): Candidate {
  if (!cfg.floorGrid.includes(floor)) {
    throw new Error(`floor ${floor} not in the fixed grid`);
  }
  return { ...candidate, floor, hashes: { ...candidate.hashes } };
}

export function candidateSummary(
  candidate: Candidate,
  dev: { before: Metrics; after: Metrics },
) {
  return {
    id: candidate.id,
    kind: candidate.kind,
    edit_path: candidate.editPath,
    sentence: candidate.sentence,
    floor: candidate.floor,
    hashes: candidate.hashes,
    dev_before: dev.before,
    dev_after: dev.after,
  };
}
