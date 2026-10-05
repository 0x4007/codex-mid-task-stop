#!/usr/bin/env -S deno run --allow-read=.publication-audit/backtesting --allow-write=.publication-audit/backtesting
// Zero-argument gated-label import for the current frozen queue.
//
//   deno run --allow-read=.publication-audit/backtesting --allow-write=.publication-audit/backtesting backtest/labels.ts
//
// Default target is the v2 queue when it exists (writer-v2/blind-queue.json), else the preserved v1
// queue. The sandbox never launches a reviewer: root places two independent annotation JSONL files
// next to the queue and this command binds, validates, and joins them. Missing, privacy-rejected,
// context-insufficient, disputed or hash-mismatched items fail the reliability gate and emit NO
// labels. Provenance is independent agent review, never human annotation.

import { loadConfig } from "./lib/config.ts";
import { importGatedLabels } from "./lib/labelimport.ts";
import { writePrivateJson } from "./lib/panel.ts";
import { reviewerCommands } from "./lib/judge.ts";
import { selectQueue } from "./lib/queueselect.ts";

const B = ".publication-audit/backtesting";

async function main(): Promise<number> {
  const { config: cfg } = loadConfig();
  // Newest hash-valid queue wins (v3 -> v2 -> v1); annotations are read only from that version's
  // own directory, so a corrected queue can never consume the previous version's labels.
  const selected = selectQueue(B);
  const result = importGatedLabels({
    queuePath: selected.queuePath,
    mapPath: selected.mapPath,
    splitPath: `${B}/writer-cases/local-split.private.json`,
    snapshotPaths: [
      `${B}/writer-snapshot/local-primary.private.jsonl`,
      `${B}/writer-snapshot/local-db-pointer.private.jsonl`,
    ],
    annotationPaths: [
      {
        reviewer: "reviewer-a",
        path: `${selected.annotationDir}/reviewer-a-annotations.jsonl`,
      },
      {
        reviewer: "reviewer-b",
        path: `${selected.annotationDir}/reviewer-b-annotations.jsonl`,
      },
    ],
    expectedQueueSha256: selected.queueSha256,
    cfg,
  });

  const labelsDir = selected.version === 1
    ? B
    : `${B}/writer-v${selected.version}`;
  Deno.mkdirSync(labelsDir, { recursive: true, mode: 0o700 });
  const labelsPath =
    `${labelsDir}/local-labels-gated-v${selected.version}.private.jsonl`;
  if (result.labels.length > 0) {
    Deno.writeTextFileSync(
      labelsPath,
      result.labels.map((row) => JSON.stringify(row)).join("\n") + "\n",
      { mode: 0o600 },
    );
    Deno.chmodSync(labelsPath, 0o600);
  }
  const report = {
    report: "backtest-labels",
    generated_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    target: `v${selected.version}`,
    queue: selected.queuePath,
    queue_version: selected.version,
    queue_sha256: result.queue_sha256,
    expected_queue_sha256: selected.queueSha256,
    status: result.status,
    coverage: result.coverage,
    reviewers: result.reviewer_stats,
    agreement: result.agreement,
    gate: result.gate,
    label_counts: result.label_counts,
    splits: result.splits,
    quarantined: result.quarantined,
    labels_written: result.labels.length,
    labels_path: result.labels.length > 0 ? labelsPath : null,
    acceptance_rule: "exit 0 + header_verified + accepted.header " +
      cfg.judge.acceptedHeader + " + accepted.sandbox " +
      cfg.judge.acceptedSandbox +
      " + Ultra/max model echo + label in {finished,authorized_unfinished,waiting,unclear} + privacy_pass && context_sufficient on both reviewers + pair sha256 match + queue sha256 match",
    provenance:
      "independent_agent_review (not human annotation, not ground truth)",
    reviewer_commands: reviewerCommands(selected.queuePath, 6, 2),
  };
  writePrivateJson(`${B}/writer-results/writer-labels-report.json`, report);
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (import.meta.main) Deno.exit(await main());
export { main };
