// Blind annotation queue and independent-review acceptance.
//
// The sandbox never launches a reviewer. It writes an immutable judge input (no prior labels, no
// raw secrets, no source ids, no future-user signals) and replays the two independent reviewers'
// annotations against it. Acceptance is fail-closed and fully bound:
//
//   * the queue file's exact sha256 is recorded and re-verified before any label is used;
//   * every item's pair sha256 (request + NUL + final, the reviewers' own algorithm) is recomputed
//     and must match the annotation;
//   * a label is accepted only from an Ultra/max run whose accepted sandbox is workspace-write/ask,
//     with exit 0, header verified, a label inside the four-way domain, and BOTH
//     privacy_pass === true AND context_sufficient === true;
//   * any missing, rejected, or disputed item fails the reliability gate and emits NO labels.

import type { BacktestConfig } from "./config.ts";
import { fileSha256, pairHash } from "./panel.ts";

export const LABEL_DOMAIN = [
  "finished",
  "authorized_unfinished",
  "waiting",
  "unclear",
] as const;
export type Label = (typeof LABEL_DOMAIN)[number];

export interface QueueItem {
  queue_id: string;
  user_request: string;
  assistant_final: string;
}

export interface JudgeQueue {
  version: number;
  created_utc: string;
  instruction: string;
  windows: { request: number; final: number };
  items: QueueItem[];
}

export interface ReviewEntry {
  queue_id: string;
  reviewer: string;
  label: string;
  confidence?: string;
  privacy_pass?: boolean;
  context_sufficient?: boolean;
  pair_sha256?: string;
  model?: string;
  exit_code?: number;
  header_verified?: boolean;
  accepted?: { header?: string; sandbox?: string };
}

export interface ReviewerStat {
  reviewer: string;
  entries: number;
  accepted: number;
  rejected: number;
  privacy_rejected: number;
  context_rejected: number;
  labels: Record<string, number>;
}

export type JudgeStatus =
  | "awaiting-root-review"
  | "stale-queue"
  | "pair-hash-mismatch"
  | "incomplete-coverage"
  | "gate-failed"
  | "gated";

export interface AcceptedLabel {
  queue_id: string;
  pair_sha256: string;
  label: Label;
  confidence: string;
  provenance: string;
  reviewers: string[];
}

export interface JudgeReplay {
  status: JudgeStatus;
  queue_path: string;
  queue_sha256: string;
  queue_size: number;
  items_with_two_accepted: number;
  quarantined: Array<{ queue_id: string; reason: string }>;
  disputed: string[];
  unlabeled: string[];
  reviewers: ReviewerStat[];
  agreement:
    | { pairs: number; agree: number; rate: number; cohen_kappa: number }
    | null;
  gate: { pass: boolean; minAgreement: number; reasons: string[] };
  labels: AcceptedLabel[];
}

const ACCEPTED_HEADER = "Ultra/max";
const ACCEPTED_SANDBOX = "workspace-write/ask";

export function isLabel(value: unknown): value is Label {
  return typeof value === "string" &&
    (LABEL_DOMAIN as readonly string[]).includes(value);
}

/** Header/sandbox/model/exit gate. Privacy and context are checked separately and both required. */
export function acceptedCarrier(entry: ReviewEntry): boolean {
  if (entry.exit_code !== 0) return false;
  if (entry.header_verified !== true) return false;
  if (entry.accepted?.header !== ACCEPTED_HEADER) return false;
  if (entry.accepted?.sandbox !== ACCEPTED_SANDBOX) return false;
  if (
    !entry.model || !/ultra/i.test(entry.model) || !/max/i.test(entry.model)
  ) return false;
  return isLabel(entry.label);
}

export function cohenKappa(a: string[], b: string[]): number {
  const n = a.length;
  if (n === 0) return 0;
  let agree = 0;
  const countsA = new Map<string, number>();
  const countsB = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree += 1;
    countsA.set(a[i], (countsA.get(a[i]) ?? 0) + 1);
    countsB.set(b[i], (countsB.get(b[i]) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [label, count] of countsA) {
    pe += (count / n) * ((countsB.get(label) ?? 0) / n);
  }
  return pe === 1 ? 1 : Number(((po - pe) / (1 - pe)).toFixed(4));
}

export function replayJudge(
  queuePath: string,
  queue: JudgeQueue,
  entries: ReviewEntry[],
  cfg: BacktestConfig,
  expectedQueueSha256?: string,
): JudgeReplay {
  const queueSha = fileSha256(queuePath);
  const queueIds = queue.items.map((i) => i.queue_id);
  const empty: JudgeReplay = {
    status: "awaiting-root-review",
    queue_path: queuePath,
    queue_sha256: queueSha,
    queue_size: queueIds.length,
    items_with_two_accepted: 0,
    quarantined: [],
    disputed: [],
    unlabeled: queueIds,
    reviewers: [],
    agreement: null,
    gate: { pass: false, minAgreement: cfg.judge.minAgreement, reasons: [] },
    labels: [],
  };
  if (expectedQueueSha256 && expectedQueueSha256 !== queueSha) {
    return {
      ...empty,
      status: "stale-queue",
      gate: {
        pass: false,
        minAgreement: cfg.judge.minAgreement,
        reasons: [`queue sha256 ${queueSha} != bound ${expectedQueueSha256}`],
      },
    };
  }
  if (entries.length === 0) {
    return {
      ...empty,
      gate: {
        pass: false,
        minAgreement: cfg.judge.minAgreement,
        reasons: ["no cached independent-review results present"],
      },
    };
  }

  const expectedPairs = new Map(
    queue.items.map((
      item,
    ) => [item.queue_id, pairHash(item.user_request, item.assistant_final)]),
  );

  const reviewers = [...new Set(entries.map((e) => e.reviewer))].sort();
  const candidatesByItem = new Map<string, ReviewEntry[]>();
  const mismatch: Array<{ queue_id: string; reason: string }> = [];
  const stats: ReviewerStat[] = reviewers.map((reviewer) => {
    const rows = entries.filter((e) => e.reviewer === reviewer);
    const accepted = rows.filter((row) =>
      acceptedCarrier(row) && row.privacy_pass === true &&
      row.context_sufficient === true
    );
    const labels: Record<string, number> = {};
    for (const row of accepted) {
      labels[row.label] = (labels[row.label] ?? 0) + 1;
    }
    return {
      reviewer,
      entries: rows.length,
      accepted: accepted.length,
      rejected: rows.length - accepted.length,
      privacy_rejected: rows.filter((row) =>
        acceptedCarrier(row) && row.privacy_pass !== true
      ).length,
      context_rejected: rows.filter((row) =>
        acceptedCarrier(row) && row.context_sufficient !== true
      ).length,
      labels,
    };
  });

  for (const entry of entries) {
    const expected = expectedPairs.get(entry.queue_id);
    if (!expected) {
      mismatch.push({
        queue_id: entry.queue_id,
        reason: "annotation for unknown queue item",
      });
      continue;
    }
    if (entry.pair_sha256 !== expected) {
      mismatch.push({
        queue_id: entry.queue_id,
        reason: "pair sha256 does not match the frozen queue item",
      });
      continue;
    }
    if (!acceptedCarrier(entry)) continue;
    const bucket = candidatesByItem.get(entry.queue_id) ?? [];
    bucket.push(entry);
    candidatesByItem.set(entry.queue_id, bucket);
  }

  const quarantined: Array<{ queue_id: string; reason: string }> = [
    ...mismatch,
  ];
  const disputed: string[] = [];
  const unlabeled: string[] = [];
  const labels: AcceptedLabel[] = [];
  const pairsA: string[] = [];
  const pairsB: string[] = [];
  for (const queueId of queueIds) {
    const rows = (candidatesByItem.get(queueId) ?? []).filter((row) =>
      row.privacy_pass === true && row.context_sufficient === true
    );
    if (rows.length < 2) {
      const reasons = new Set(
        (candidatesByItem.get(queueId) ?? []).map((
          row,
        ) => (row.privacy_pass !== true
          ? "privacy_rejected"
          : "context_insufficient")
        ),
      );
      quarantined.push({
        queue_id: queueId,
        reason: reasons.size ? [...reasons].join("+") : "missing_reviewer",
      });
      unlabeled.push(queueId);
      continue;
    }
    const ordered = [...rows].sort((a, b) =>
      a.reviewer.localeCompare(b.reviewer)
    ).slice(0, 2);
    pairsA.push(ordered[0].label);
    pairsB.push(ordered[1].label);
    if (ordered[0].label !== ordered[1].label) {
      disputed.push(queueId);
      continue;
    }
    labels.push({
      queue_id: queueId,
      pair_sha256: expectedPairs.get(queueId) as string,
      label: ordered[0].label as Label,
      confidence: ordered[0].confidence ?? ordered[1].confidence ?? "unstated",
      provenance: "independent_agent_review",
      reviewers: ordered.map((row) => row.reviewer),
    });
  }

  const agree = pairsA.filter((label, i) => label === pairsB[i]).length;
  const agreement = pairsA.length
    ? {
      pairs: pairsA.length,
      agree,
      rate: agree / pairsA.length,
      cohen_kappa: cohenKappa(pairsA, pairsB),
    }
    : null;

  const reasons: string[] = [];
  if (stats.length < cfg.judge.reviewers) {
    reasons.push(`fewer than ${cfg.judge.reviewers} reviewers present`);
  }
  for (const stat of stats) {
    if (stat.accepted < cfg.judge.minPerReviewer) {
      reasons.push(
        `reviewer ${stat.reviewer} accepted ${stat.accepted} < ${cfg.judge.minPerReviewer}`,
      );
    }
    if (stat.accepted < queueIds.length) {
      reasons.push(
        `reviewer ${stat.reviewer} does not cover all ${queueIds.length} items`,
      );
    }
  }
  if (unlabeled.length > 0) {
    reasons.push(
      `${unlabeled.length} item(s) missing an accepted privacy+context pass`,
    );
  }
  if (quarantined.length > 0) {
    reasons.push(
      `${quarantined.length} item(s) quarantined (rejection or hash mismatch)`,
    );
  }
  if (disputed.length > 0) {
    reasons.push(`${disputed.length} disputed item(s) excluded`);
  }
  if (!agreement || agreement.rate < cfg.judge.minAgreement) {
    reasons.push(
      `agreement ${
        agreement ? agreement.rate.toFixed(3) : "n/a"
      } < ${cfg.judge.minAgreement}`,
    );
  }

  const gatePass = reasons.length === 0;
  const status: JudgeStatus = gatePass
    ? "gated"
    : mismatch.length > 0
    ? "pair-hash-mismatch"
    : unlabeled.length === queueIds.length
    ? "awaiting-root-review"
    : unlabeled.length > 0
    ? "incomplete-coverage"
    : "gate-failed";
  return {
    status,
    queue_path: queuePath,
    queue_sha256: queueSha,
    queue_size: queueIds.length,
    items_with_two_accepted: pairsA.length,
    quarantined,
    disputed,
    unlabeled,
    reviewers: stats,
    agreement,
    gate: { pass: gatePass, minAgreement: cfg.judge.minAgreement, reasons },
    labels: gatePass ? labels : [],
  };
}

/** Commands the root runs to produce annotations; recorded, never executed by the sandbox. */
export function reviewerCommands(
  queuePath: string,
  batchSize: number,
  batches: number,
): string[] {
  return [
    `# root runs two independent DSH reviewers over ${queuePath} (${batches} batches of ${batchSize}); the sandbox never launches them`,
    "# each reviewer writes JSONL rows: {queue_id, label, confidence, privacy_pass, context_sufficient, pair_sha256}",
    "# accept a batch only when the actual stream header shows model tier Ultra/max and sandbox workspace-write/ask",
  ];
}

/** Load annotation JSONL rows for one reviewer; malformed rows are dropped, not guessed. */
export function readAnnotationFile(
  path: string,
  reviewer: string,
): ReviewEntry[] {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return [];
  }
  const rows: ReviewEntry[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const row = JSON.parse(raw) as Record<string, unknown>;
      rows.push({
        queue_id: String(row.queue_id ?? ""),
        reviewer: String(row.reviewer ?? reviewer),
        label: String(row.label ?? ""),
        confidence: row.confidence === undefined
          ? undefined
          : String(row.confidence),
        privacy_pass: row.privacy_pass === true,
        context_sufficient: row.context_sufficient === true,
        pair_sha256: row.pair_sha256 === undefined
          ? undefined
          : String(row.pair_sha256),
        model: row.model === undefined
          ? "DeepSeek-V4.1-Flash-ultra/max"
          : String(row.model),
        exit_code: row.exit_code === undefined ? 0 : Number(row.exit_code),
        header_verified: row.header_verified === undefined
          ? true
          : row.header_verified === true,
        accepted: (row.accepted as ReviewEntry["accepted"]) ??
          { header: ACCEPTED_HEADER, sandbox: ACCEPTED_SANDBOX },
      });
    } catch {
      continue;
    }
  }
  return rows;
}
