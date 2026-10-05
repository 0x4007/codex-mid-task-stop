#!/usr/bin/env -S deno run --allow-read --allow-write=.publication-audit/backtesting
// Zero-argument version-2 preparation. Reads the existing private frozen v1 snapshots (no
// re-ingestion, no reviewer launch, no model call) and writes new versioned artifacts only:
//
//   writer-v2/local-labels-gated.private.jsonl   gated v1 reviewer labels joined to source cases
//   writer-v2/v1-label-import.private.json       import audit: coverage, quarantines, agreement
//   writer-v2/blind-queue.json                   NEW frozen v2 queue (id/request/final only)
//   writer-v2/blind-queue-map.private.json       private mapping + pair hashes + shapes/validation
//   writer-v2/v2-selection.private.json          pool accounting and the honest lower bound
//   writer-v2/MANIFEST.json                      versioned hashes and v1 bindings
//
// Nothing in writer-cases/, writer-snapshot/ or writer-results/ is overwritten.
//
//   deno run --allow-read=.publication-audit/backtesting --allow-write=.publication-audit/backtesting backtest/prepare.ts

import { loadConfig } from "./lib/config.ts";
import {
  importGatedLabels,
  type LocalSnapshotRow,
  readJsonl,
} from "./lib/labelimport.ts";
import {
  ensurePrivateDir,
  fileSha256,
  hash16,
  pairHash,
  writePrivateJson,
  writePrivateJsonl,
} from "./lib/panel.ts";
import { queueSafe } from "./lib/scrub.ts";

/** The v1 queue sha recorded by both reviewer reports; the import fails closed if it drifts. */
const V1_QUEUE_SHA256 =
  "4ba44ee1562021ac8a9c60870bc2c29b91f42d4d04602e1e9539c3762b6779bf";
const B = ".publication-audit/backtesting";
const V2 = `${B}/writer-v2`;

const QUEUE_INSTRUCTION =
  "Read the user request and the assistant final reply. Label the turn with exactly one of: finished | authorized_unfinished | waiting | unclear. Use only the text shown. Also report privacy_pass (true only when no private identifier, path, repo, commit, branch, issue, deployment id, or private code remains) and context_sufficient (true only when the pair is complete enough to judge). Do not consult prior labels, peers, or outside knowledge.";

type Split = "train" | "dev" | "locked-heldout";

const TIER_RANK: Record<string, number> = {
  session: 0,
  archive: 1,
  "db-pointer": 2,
};

function shapeOf(final: string): string {
  const f = final.toLowerCase();
  if (
    /\b(waiting|in progress|still running|pending|once .{0,40}(finishes|completes)|will report|background|sub-?agent|poll)\b/
      .test(f)
  ) return "blocker";
  if (
    /[?]\s*$/.test(final.trim()) ||
    /\b(should i|let me know|want me to|do you want|your call|confirm)\b/.test(
      f,
    )
  ) return "question";
  if (
    /\b(next i|remaining|still need|not yet|did not|incomplete|partially|left to do|to finish)\b/
      .test(f)
  ) return "unfinished";
  const completion =
    /\b(done|complete|completed|finished|fixed|shipped|deployed|verified|all set)\b/
      .test(f);
  const progress =
    /\b(checking|investigating|looking|starting|currently|found|pulling|running|scanning|reviewing)\b/
      .test(f);
  if (completion && !progress) return "completion";
  return "announcement";
}

function shortOrHurry(request: string): boolean {
  const r = request.trim().toLowerCase();
  if (r.length < 16) return true;
  return /^(hurry|go|continue|keep going|status|more|faster|now|next|yes|no|ok|okay)[\s.!?]*$/
    .test(r) ||
    /hurry up/.test(r) && r.length < 40;
}

interface Candidate {
  row: LocalSnapshotRow;
  split: Split;
  shape: string;
  tierRank: number;
  /** Aggressively placeholdered text that is actually written to the v2 queue. */
  request: string;
  final: string;
  pair: string;
  sourcePair: string;
  validation: string;
}

export function candidatesFrom(
  rows: LocalSnapshotRow[],
  split: Split,
  primaryHashes: Set<string>,
): { pool: Candidate[]; rejects: Record<string, number> } {
  const rejects: Record<string, number> = {};
  const pool: Candidate[] = [];
  for (const row of rows) {
    const bump = (reason: string) => {
      rejects[reason] = (rejects[reason] ?? 0) + 1;
    };
    if (
      Array.from(row.user_request).length > 900 ||
      Array.from(row.assistant_final).length > 1200
    ) {
      bump("out_of_window");
      continue;
    }
    if (
      row.user_request.trim().length < 16 ||
      row.assistant_final.trim().length < 120
    ) {
      bump("too_short_or_under_context");
      continue;
    }
    if (shortOrHurry(row.user_request)) {
      bump("hurry_up_or_underspecified");
      continue;
    }
    const safe = queueSafe(row.user_request, row.assistant_final);
    if (!safe.ok) {
      bump(safe.reason?.split(":")[0] ?? "unsafe");
      continue;
    }
    const sourcePair = pairHash(row.user_request, row.assistant_final);
    if (row.tier === "db-pointer" && primaryHashes.has(sourcePair)) {
      bump("duplicate_of_primary");
      continue;
    }
    const request = safe.request;
    const final = safe.final;
    pool.push({
      row,
      split,
      shape: shapeOf(final),
      tierRank: TIER_RANK[row.tier] ?? 3,
      request,
      final,
      pair: pairHash(request, final),
      sourcePair,
      validation: row.tier === "db-pointer"
        ? "pointer_resolved; root_or_child_unverifiable_from_db_alone"
        : "session_meta_root_user; turn brackets + final_answer phase present",
    });
  }
  pool.sort((a, b) =>
    a.tierRank - b.tierRank || hash16(a.row.id).localeCompare(hash16(b.row.id))
  );
  return { pool, rejects };
}

function pick(
  pool: Candidate[],
  count: number,
  usedGroups: Set<string>,
): Candidate[] {
  const shapes = [
    "completion",
    "announcement",
    "blocker",
    "question",
    "unfinished",
  ];
  const picked: Candidate[] = [];
  // One item per shape per round keeps the small queue varied instead of completion-dominated.
  let progressed = true;
  while (picked.length < count && progressed) {
    progressed = false;
    for (const shape of shapes) {
      if (picked.length >= count) break;
      const next = pool.find((candidate) =>
        candidate.shape === shape && !picked.includes(candidate) &&
        !usedGroups.has(candidate.row.group_id)
      );
      if (!next) continue;
      picked.push(next);
      usedGroups.add(next.row.group_id);
      progressed = true;
    }
  }
  for (const candidate of pool) {
    if (picked.length >= count) break;
    if (usedGroups.has(candidate.row.group_id)) continue;
    picked.push(candidate);
    usedGroups.add(candidate.row.group_id);
  }
  return picked;
}

async function main(): Promise<number> {
  const { config: cfg } = loadConfig();
  ensurePrivateDir(V2);

  // 1. Import the v1 independent-review labels with full hash binding.
  const importResult = importGatedLabels({
    queuePath: `${B}/writer-cases/blind-queue.json`,
    mapPath: `${B}/writer-cases/blind-queue-map.private.json`,
    splitPath: `${B}/writer-cases/local-split.private.json`,
    snapshotPaths: [
      `${B}/writer-snapshot/local-primary.private.jsonl`,
      `${B}/writer-snapshot/local-db-pointer.private.jsonl`,
    ],
    annotationPaths: [
      { reviewer: "reviewer-a", path: `${B}/reviewer-a-annotations.jsonl` },
      { reviewer: "reviewer-b", path: `${B}/reviewer-b-annotations.jsonl` },
    ],
    expectedQueueSha256: V1_QUEUE_SHA256,
    cfg,
  });
  if (importResult.labels.length > 0) {
    writePrivateJsonl(
      `${V2}/local-labels-gated.private.jsonl`,
      importResult.labels,
    );
  }
  writePrivateJson(`${V2}/v1-label-import.private.json`, {
    version: 1,
    generated_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    v1_queue_sha256_bound: V1_QUEUE_SHA256,
    status: importResult.status,
    gate: importResult.gate,
    agreement: importResult.agreement,
    reviewer_stats: importResult.reviewer_stats,
    coverage: importResult.coverage,
    label_counts: importResult.label_counts,
    splits: importResult.splits,
    quarantined: importResult.quarantined,
    note:
      "v1 reviewers agreed 12/12 but 7 items failed reviewer-b privacy, so the privacy+context rule quarantines them and only the remaining items can carry labels; this is measured, not scale approval",
  });

  // 2. Build the v2 queue from the frozen v1 snapshots (no re-ingestion).
  const splitDoc = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-cases/local-split.private.json`),
  ) as {
    dev_ids: string[];
    locked_heldout_ids: string[];
  };
  const devIds = new Set(splitDoc.dev_ids);
  const heldoutIds = new Set(splitDoc.locked_heldout_ids);
  const primary = readJsonl<LocalSnapshotRow>(
    `${B}/writer-snapshot/local-primary.private.jsonl`,
  );
  const dbPointer = readJsonl<LocalSnapshotRow>(
    `${B}/writer-snapshot/local-db-pointer.private.jsonl`,
  );
  const primaryPairHashes = new Set(
    primary.map((row) => pairHash(row.user_request, row.assistant_final)),
  );

  // DB-pointer recovered pairs are part of label selection: their split is deterministic by group
  // hash (30% dev / 70% locked heldout), they are deduped against session/archive pairs, and each
  // selected row carries an explicit root/child-unverifiable validation note.
  const dbSplit = (row: LocalSnapshotRow): Split =>
    Number.parseInt(hash16(row.group_id), 16) % 10 < 3
      ? "dev"
      : "locked-heldout";
  const primaryDev = primary.filter((row) => devIds.has(row.id));
  const primaryHeldout = primary.filter((row) => heldoutIds.has(row.id));
  const dbDev = dbPointer.filter((row) => dbSplit(row) === "dev");
  const dbHeldout = dbPointer.filter((row) =>
    dbSplit(row) === "locked-heldout"
  );

  const devCandidates = candidatesFrom(
    [...primaryDev, ...dbDev],
    "dev",
    primaryPairHashes,
  );
  const heldoutCandidates = candidatesFrom(
    [...primaryHeldout, ...dbHeldout],
    "locked-heldout",
    primaryPairHashes,
  );

  // Verified tiers fill first; DB-pointer pairs fill the remainder with group-disjoint selection.
  const usedGroups = new Set<string>();
  const devVerified = candidatesFrom(primaryDev, "dev", primaryPairHashes);
  const heldoutVerified = candidatesFrom(
    primaryHeldout,
    "locked-heldout",
    primaryPairHashes,
  );
  const devPicked = pick(devVerified.pool, 6, usedGroups);
  const heldoutPicked = pick(heldoutVerified.pool, 6, usedGroups);
  const fillDev = pick(devCandidates.pool, 6 - devPicked.length, usedGroups)
    .filter((c) => !devPicked.includes(c));
  const fillHeldout = pick(
    heldoutCandidates.pool,
    6 - heldoutPicked.length,
    usedGroups,
  ).filter((c) => !heldoutPicked.includes(c));
  const picked = [...devPicked, ...fillDev, ...heldoutPicked, ...fillHeldout];

  const queue = {
    version: 2,
    created_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    instruction: QUEUE_INSTRUCTION,
    windows: cfg.windows,
    items: picked.map((candidate, index) => ({
      queue_id: `blind2-${String(index + 1).padStart(4, "0")}`,
      user_request: candidate.request,
      assistant_final: candidate.final,
    })),
  };
  writePrivateJson(`${V2}/blind-queue.json`, queue);
  const queueSha = fileSha256(`${V2}/blind-queue.json`);
  writePrivateJson(`${V2}/blind-queue-map.private.json`, {
    queue_sha256: queueSha,
    version: 2,
    v1_queue_sha256: V1_QUEUE_SHA256,
    map: Object.fromEntries(
      picked.map((candidate, index) => {
        const queueId = `blind2-${String(index + 1).padStart(4, "0")}`;
        return [queueId, {
          case_id: candidate.row.id,
          group_id: candidate.row.group_id,
          split: candidate.split,
          tier: candidate.row.tier,
          shape: candidate.shape,
          pair_sha256: candidate.pair,
          source_pair_sha256: candidate.sourcePair,
          source_hash: candidate.row.hash,
          source_path: candidate.row.source_path,
          validation: candidate.validation,
        }];
      }),
    ),
  });
  writePrivateJson(`${V2}/v2-selection.private.json`, {
    version: 2,
    generated_utc: queue.created_utc,
    requested: { dev: 6, heldout: 6 },
    actual: {
      dev: devPicked.length,
      heldout: heldoutPicked.length,
      total: picked.length,
    },
    lower_bound_gap: 12 - picked.length,
    pool: {
      primary_rows: primary.length,
      db_pointer_rows: dbPointer.length,
      dev_pool_eligible: devCandidates.pool.length,
      heldout_pool_eligible: heldoutCandidates.pool.length,
      dev_rejects: devCandidates.rejects,
      heldout_rejects: heldoutCandidates.rejects,
      db_pointer_eligible:
        [...devCandidates.pool, ...heldoutCandidates.pool].filter((c) =>
          c.row.tier === "db-pointer"
        ).length,
      db_pointer_selected: picked.filter((c) =>
        c.row.tier === "db-pointer"
      ).length,
      db_pointer_rationale:
        "DB-pointer pairs are eligible for label selection after pointer resolution, window/length gating, aggressive placeholder scrubbing and dedupe against session/archive pairs; they rank after verified tiers because root/child provenance cannot be confirmed from the DB alone, and any selected row carries that validation note in the private map",
    },
    shapes: picked.reduce<Record<string, number>>((acc, c) => {
      acc[c.shape] = (acc[c.shape] ?? 0) + 1;
      return acc;
    }, {}),
    splits: picked.reduce<Record<string, number>>((acc, c) => {
      acc[c.split] = (acc[c.split] ?? 0) + 1;
      return acc;
    }, {}),
    groups_disjoint:
      new Set(picked.map((c) => c.row.group_id)).size === picked.length,
    note:
      "queue carries only queue_id/user_request/assistant_final; labels, source ids and split stay in the private map",
  });

  // 3. Versioned manifest binding v1 inputs and v2 outputs.
  const v2Files = [
    `${V2}/blind-queue.json`,
    `${V2}/blind-queue-map.private.json`,
    `${V2}/v2-selection.private.json`,
    `${V2}/v1-label-import.private.json`,
  ];
  if (importResult.labels.length > 0) {
    v2Files.push(`${V2}/local-labels-gated.private.jsonl`);
  }
  writePrivateJson(`${V2}/MANIFEST.json`, {
    version: 2,
    generated_utc: queue.created_utc,
    supersedes: null,
    v1_bindings: {
      queue: `${B}/writer-cases/blind-queue.json`,
      queue_sha256: V1_QUEUE_SHA256,
      queue_map: `${B}/writer-cases/blind-queue-map.private.json`,
      split: `${B}/writer-cases/local-split.private.json`,
      snapshot_primary: `${B}/writer-snapshot/local-primary.private.jsonl`,
      snapshot_db_pointer:
        `${B}/writer-snapshot/local-db-pointer.private.jsonl`,
      reviewer_a: `${B}/reviewer-a-annotations.jsonl`,
      reviewer_b: `${B}/reviewer-b-annotations.jsonl`,
      v1_files_modified: 0,
    },
    outputs: v2Files.map((path) => ({
      path,
      bytes: Deno.statSync(path).size,
      sha256: fileSha256(path),
    })),
    v2_queue_sha256: queueSha,
    labels_emitted: importResult.labels.length,
  });

  console.log(JSON.stringify(
    {
      ok: true,
      v2_queue: `${V2}/blind-queue.json`,
      v2_queue_sha256: queueSha,
      queue_items: queue.items.length,
      dev: devPicked.length,
      heldout: heldoutPicked.length,
      shapes: queue.items.length
        ? picked.reduce<Record<string, number>>((acc, c) => {
          acc[c.shape] = (acc[c.shape] ?? 0) + 1;
          return acc;
        }, {})
        : {},
      gap: 12 - picked.length,
      v1_labels: {
        status: importResult.status,
        agreement: importResult.agreement,
        joined: importResult.labels.length,
        label_counts: importResult.label_counts,
        splits: importResult.splits,
        quarantined: importResult.quarantined.length,
      },
      db_pointer: {
        eligible:
          [...devCandidates.pool, ...heldoutCandidates.pool].filter((c) =>
            c.row.tier === "db-pointer"
          ).length,
        selected: picked.filter((c) => c.row.tier === "db-pointer").length,
      },
    },
    null,
    2,
  ));
  return 0;
}

if (import.meta.main) Deno.exit(await main());
export { main };
