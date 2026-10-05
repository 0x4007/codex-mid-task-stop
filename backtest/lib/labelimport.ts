// Join gated independent-review labels to frozen local source cases.
//
// A label is usable only when the queue it came from is hash-bound, both reviewers passed privacy
// AND context, the pair hash matches the frozen queue text, and the queue text is byte-identical to
// the frozen local snapshot row it maps to. The join is idempotent and never mutates v1 evidence:
// callers write versioned outputs (writer-v2/...).

import type { BacktestConfig } from "./config.ts";
import type { AcceptedLabel, JudgeQueue, JudgeReplay } from "./judge.ts";
import { readAnnotationFile, replayJudge } from "./judge.ts";
import { fileSha256, pairHash } from "./panel.ts";

export interface LocalSnapshotRow {
  id: string;
  group_id: string;
  tier: string;
  user_request: string;
  assistant_final: string;
  hash: string;
  source_path: string;
}

export interface GatedLabelRow {
  queue_id: string;
  case_id: string;
  /** Provider binding: pair hash of the exact approved queue text sent to the model. */
  pair_sha256: string;
  queue_pair_sha256: string;
  /** Provenance binding: pair hash of the original immutable source-case text. */
  source_case_pair_sha256: string;
  /** Exact approved queue text; the provider input, never a raw-source fallback. */
  provider_request: string;
  provider_final: string;
  group_id: string;
  split: string;
  tier: string;
  label: string;
  confidence: string;
  label_authority: string;
  reviewers: string[];
  queue_sha256: string;
}

export interface LabelImportResult {
  status: JudgeReplay["status"];
  queue_path: string;
  queue_sha256: string;
  labels: GatedLabelRow[];
  quarantined: Array<{ queue_id: string; reason: string }>;
  label_counts: Record<string, number>;
  splits: Record<string, number>;
  reviewer_stats: JudgeReplay["reviewers"];
  agreement: JudgeReplay["agreement"];
  gate: JudgeReplay["gate"];
  coverage: { queue_items: number; joined: number; quarantined: number };
}

export function readJsonl<T>(path: string): T[] {
  const rows: T[] = [];
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return rows;
  }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      rows.push(JSON.parse(raw) as T);
    } catch {
      continue;
    }
  }
  return rows;
}

export interface ImportOptions {
  queuePath: string;
  mapPath: string;
  splitPath: string;
  snapshotPaths: string[];
  annotationPaths: Array<{ reviewer: string; path: string }>;
  expectedQueueSha256: string;
  cfg: BacktestConfig;
}

/** Replay the reviewers and produce gated, source-joined labels (empty unless the gate passes). */
export function importGatedLabels(opts: ImportOptions): LabelImportResult {
  const queue = JSON.parse(Deno.readTextFileSync(opts.queuePath)) as JudgeQueue;
  const mapDoc = JSON.parse(Deno.readTextFileSync(opts.mapPath)) as {
    map: Record<string, {
      case_id: string;
      group_id: string;
      tier: string;
      hash: string;
      source_hash?: string;
      split?: string;
      pair_sha256?: string;
      source_pair_sha256?: string;
      original_source_pair_sha256?: string;
    }>;
  };
  const splitDoc = JSON.parse(Deno.readTextFileSync(opts.splitPath)) as {
    assignments?: Record<string, string>;
    dev_ids?: string[];
    locked_heldout_ids?: string[];
  };
  const devIds = new Set(splitDoc.dev_ids ?? []);
  const heldoutIds = new Set(splitDoc.locked_heldout_ids ?? []);
  const snapshot = new Map<string, LocalSnapshotRow>();
  for (const path of opts.snapshotPaths) {
    for (const row of readJsonl<LocalSnapshotRow>(path)) {
      snapshot.set(row.id, row);
    }
  }
  const entries = opts.annotationPaths.flatMap(({ reviewer, path }) =>
    readAnnotationFile(path, reviewer)
  );
  const replay = replayJudge(
    opts.queuePath,
    queue,
    entries,
    opts.cfg,
    opts.expectedQueueSha256,
  );

  const quarantined = [...replay.quarantined];
  const labels: GatedLabelRow[] = [];
  if (replay.gate.pass) {
    for (const label of replay.labels as AcceptedLabel[]) {
      const mapped = mapDoc.map[label.queue_id];
      const item = queue.items.find((i) => i.queue_id === label.queue_id);
      const source = mapped ? snapshot.get(mapped.case_id) : undefined;
      if (!mapped || !item || !source) {
        quarantined.push({
          queue_id: label.queue_id,
          reason: "queue item has no frozen source case",
        });
        continue;
      }
      // Provider binding: the approved queue text must match the map and both annotations.
      const queuePair = pairHash(item.user_request, item.assistant_final);
      if (
        (typeof mapped.pair_sha256 === "string" && mapped.pair_sha256 !== queuePair) ||
        label.pair_sha256 !== queuePair
      ) {
        quarantined.push({
          queue_id: label.queue_id,
          reason: "queue pair hash does not match the map and annotations",
        });
        continue;
      }
      // Provenance binding: the frozen source case keeps its own original pair hash. Redaction
      // changes the provider text, so the two bindings are validated separately and never swapped.
      const sourcePair = pairHash(source.user_request, source.assistant_final);
      const expectedSourcePair = typeof mapped.original_source_pair_sha256 === "string"
        ? mapped.original_source_pair_sha256
        : typeof mapped.source_pair_sha256 === "string"
        ? mapped.source_pair_sha256
        : null;
      const sourceBound = expectedSourcePair !== null
        ? sourcePair === expectedSourcePair
        : source.user_request === item.user_request && source.assistant_final === item.assistant_final;
      if (!sourceBound) {
        quarantined.push({
          queue_id: label.queue_id,
          reason: "source provenance pair hash mismatch against the frozen source case",
        });
        continue;
      }
      if (
        typeof mapped.source_hash === "string" &&
        typeof source.hash === "string" &&
        mapped.source_hash !== source.hash
      ) {
        quarantined.push({
          queue_id: label.queue_id,
          reason: "source case hash mismatch against the private map",
        });
        continue;
      }
      // The frozen queue map owns the split (including db-pointer groups the v1 split file never
      // covered); the v1 split lists remain a fallback for older queues.
      const split = typeof mapped.split === "string"
        ? mapped.split
        : devIds.has(mapped.case_id)
        ? "dev"
        : heldoutIds.has(mapped.case_id)
        ? "locked-heldout"
        : "train";
      labels.push({
        queue_id: label.queue_id,
        case_id: mapped.case_id,
        pair_sha256: label.pair_sha256,
        queue_pair_sha256: queuePair,
        source_case_pair_sha256: sourcePair,
        provider_request: item.user_request,
        provider_final: item.assistant_final,
        group_id: mapped.group_id,
        split,
        tier: mapped.tier,
        label: label.label,
        confidence: label.confidence,
        label_authority: "independent_agent_review",
        reviewers: label.reviewers,
        queue_sha256: replay.queue_sha256,
      });
    }
  }

  const labelCounts: Record<string, number> = {};
  const splitCounts: Record<string, number> = {};
  // A join-time mismatch means the queue/map/snapshot freeze is inconsistent: fail the whole import
  // closed rather than emitting a partial label set that silently dropped a case.
  const joinMismatch = quarantined.length > replay.quarantined.length;
  const emitted = joinMismatch ? [] : labels;
  for (const row of emitted) {
    labelCounts[row.label] = (labelCounts[row.label] ?? 0) + 1;
    splitCounts[row.split] = (splitCounts[row.split] ?? 0) + 1;
  }
  return {
    status: joinMismatch ? "pair-hash-mismatch" : replay.status,
    queue_path: opts.queuePath,
    queue_sha256: replay.queue_sha256,
    labels: emitted,
    quarantined,
    label_counts: labelCounts,
    splits: splitCounts,
    reviewer_stats: replay.reviewers,
    agreement: replay.agreement,
    gate: joinMismatch
      ? {
        ...replay.gate,
        pass: false,
        reasons: [
          ...replay.gate.reasons,
          "source binding mismatch; import failed closed",
        ],
      }
      : replay.gate,
    coverage: {
      queue_items: queue.items.length,
      joined: emitted.length,
      quarantined: quarantined.length,
    },
  };
}

export function boundQueueSha(path: string): string {
  return fileSha256(path);
}
