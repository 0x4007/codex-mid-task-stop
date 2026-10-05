#!/usr/bin/env -S deno run --allow-read --allow-write=.publication-audit/backtesting
// Zero-argument version-3 queue build: correct the reviewed residual identifiers in the frozen v2
// queue without touching labels, tasks or selection.
//
//   deno run --allow-read=.publication-audit/backtesting --allow-write=.publication-audit/backtesting backtest/queuev3.ts
//
// The same 12 queue ids, order, case ids, groups and splits are preserved. Text changes come from the
// general pattern guard in lib/scrub.ts plus role-specific functional substitutions read from the
// private table writer-v3/redactions.private.json (literals never enter public source). Every output
// item is re-scanned with the public dataset validator's privacyHits and a local residual scan; a
// single residual aborts the build. Nothing under writer-v2/, writer-cases/ or writer-snapshot/ is
// modified.

import { loadConfig } from "./lib/config.ts";
import { fileSha256, pairHash, writePrivateJson } from "./lib/panel.ts";
import { scrubText } from "./lib/scrub.ts";
import { privacyHits } from "../jev/dataset/validate.ts";

const B = ".publication-audit/backtesting";
const V2 = `${B}/writer-v2`;
const V3 = `${B}/writer-v3`;

interface QueueItem {
  queue_id: string;
  user_request: string;
  assistant_final: string;
}

interface RedactionEntry {
  literal: string;
  placeholder: string;
  role: string;
  queue_ids: string[];
}

/** Local residual scan: identity-bearing shapes that must not survive into a queue. */
const RESIDUAL: Array<{ id: string; re: RegExp }> = [
  { id: "url", re: /https?:\/\//i },
  {
    id: "hostname",
    re:
      /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|fi|sh|co|app|dev|cloud|me|xyz)\b/i,
  },
  { id: "ssh_fingerprint", re: /SHA256:[A-Za-z0-9+/=]{20,}/ },
  { id: "long_hash", re: /\b[0-9a-f]{32,}\b/ },
  {
    id: "prefixed_id",
    re:
      /\b[A-Za-z]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
  },
  { id: "turn_id", re: /\bturn[0-9a-f][0-9a-f-]{12,}\b/i },
  { id: "pid", re: /\bPID\s*\**\s*\d{4,}\**/ },
  { id: "worktree_slug", re: /\b[a-z0-9]+(?:-[a-z0-9]+){3,}-g[0-9a-f]{6,}\b/ },
  {
    id: "private_repo_slug",
    re: /\b[a-z0-9]+(?:-[a-z0-9]+)*-(?:private|internal)\b/,
  },
  { id: "account_handle", re: /\b0x[0-9a-fA-F]{4,}\b/ },
  { id: "internal_doc", re: /\b(?:rollout_summaries|handoffs)\/[\w./-]+\.md/ },
  { id: "hash_issue", re: /#\d{2,}\b/ },
];

function residualHits(text: string): string[] {
  return RESIDUAL.filter((rule) => rule.re.test(text)).map((rule) => rule.id);
}

async function main(): Promise<number> {
  const { config: cfg } = loadConfig();
  const v2QueuePath = `${V2}/blind-queue.json`;
  const v2MapPath = `${V2}/blind-queue-map.private.json`;
  const v2Queue = JSON.parse(Deno.readTextFileSync(v2QueuePath)) as {
    version: number;
    created_utc: string;
    items: QueueItem[];
  };
  const v2MapDoc = JSON.parse(Deno.readTextFileSync(v2MapPath)) as {
    queue_sha256: string;
    version: number;
    v1_queue_sha256: string;
    map: Record<string, Record<string, unknown>>;
  };
  const v2Sha = fileSha256(v2QueuePath);
  if (v2Sha !== v2MapDoc.queue_sha256) {
    throw new Error(
      `v2 queue sha mismatch: ${v2Sha} != ${v2MapDoc.queue_sha256}`,
    );
  }

  const redactionsPath = `${V3}/redactions.private.json`;
  const redactions = JSON.parse(Deno.readTextFileSync(redactionsPath)) as {
    version: number;
    generated_utc: string;
    entries: RedactionEntry[];
  };
  if (redactions.version !== 3) {
    throw new Error("redaction table is not version 3");
  }

  const items: QueueItem[] = [];
  const map: Record<string, Record<string, unknown>> = {};
  const verification: Record<string, unknown>[] = [];
  const changedItems: string[] = [];
  const unchangedItems: string[] = [];

  for (const item of v2Queue.items) {
    const v2Meta = v2MapDoc.map[item.queue_id];
    if (!v2Meta) throw new Error(`missing v2 map entry for ${item.queue_id}`);
    const categories: string[] = [];
    const changedFields: string[] = [];
    const next: QueueItem = {
      queue_id: item.queue_id,
      user_request: "",
      assistant_final: "",
    };
    for (const field of ["user_request", "assistant_final"] as const) {
      const original = item[field];
      const scrubbed = scrubText(original);
      if (!scrubbed.ok) {
        throw new Error(
          `${item.queue_id}.${field}: guard failed closed (${
            scrubbed.flags.join("+")
          })`,
        );
      }
      let text = scrubbed.text;
      for (const flag of scrubbed.flags) categories.push(`${flag}`);
      for (const entry of redactions.entries) {
        if (
          !entry.queue_ids.includes(item.queue_id) ||
          !text.includes(entry.literal)
        ) continue;
        const count = text.split(entry.literal).length - 1;
        text = text.split(entry.literal).join(entry.placeholder);
        categories.push(`private:${entry.role}x${count}`);
      }
      next[field] = text;
      if (text !== original) changedFields.push(field);
    }
    const residual = [
      ...residualHits(next.user_request),
      ...residualHits(next.assistant_final),
    ];
    const validator = [
      ...privacyHits(next.user_request),
      ...privacyHits(next.assistant_final),
    ];
    verification.push({
      queue_id: item.queue_id,
      changed_fields: changedFields,
      categories: [...new Set(categories)],
      residual_patterns: [...new Set(residual)],
      public_validator_hits: [...new Set(validator)],
      meaning_preserved: {
        request_chars: [item.user_request.length, next.user_request.length],
        final_chars: [item.assistant_final.length, next.assistant_final.length],
      },
    });
    if (residual.length > 0 || validator.length > 0) {
      throw new Error(
        `${item.queue_id}: residual identifiers remain (${
          [...residual, ...validator].join("+")
        })`,
      );
    }
    items.push(next);
    if (changedFields.length > 0) changedItems.push(item.queue_id);
    else unchangedItems.push(item.queue_id);
    map[item.queue_id] = {
      version: 3,
      case_id: v2Meta.case_id,
      group_id: v2Meta.group_id,
      split: v2Meta.split,
      tier: v2Meta.tier,
      shape: v2Meta.shape,
      validation: v2Meta.validation,
      source_path: v2Meta.source_path,
      source_hash: v2Meta.source_hash,
      source_pair_sha256: v2Meta.pair_sha256,
      pair_sha256: pairHash(next.user_request, next.assistant_final),
      changed_fields: changedFields,
      categories: [...new Set(categories)],
      annotation_scope: "review-v3 only",
    };
  }

  // Deterministic content: selection frozen at the v2 creation time, correction time from the
  // private table, so rebuilding on unchanged inputs yields a byte-identical queue hash.
  const queue = {
    version: 3,
    created_utc: v2Queue.created_utc,
    corrected_utc: redactions.generated_utc,
    replaces_queue_sha256: v2Sha,
    instruction: JSON.parse(Deno.readTextFileSync(v2QueuePath)).instruction,
    windows: cfg.windows,
    items,
  };
  writePrivateJson(`${V3}/blind-queue.json`, queue);
  const v3Sha = fileSha256(`${V3}/blind-queue.json`);
  writePrivateJson(`${V3}/blind-queue-map.private.json`, {
    version: 3,
    queue_sha256: v3Sha,
    replaces_queue_sha256: v2Sha,
    v1_queue_sha256: v2MapDoc.v1_queue_sha256,
    redaction_table_sha256: fileSha256(redactionsPath),
    map,
  });
  writePrivateJson(`${V3}/verification.private.json`, {
    version: 3,
    generated_utc: redactions.generated_utc,
    v2_queue_sha256: v2Sha,
    v3_queue_sha256: v3Sha,
    changed_items: changedItems,
    unchanged_items: unchangedItems,
    items: verification,
    guard: {
      rules: RESIDUAL.map((rule) => rule.id),
      residual_hits: 0,
      public_validator_hits: 0,
      note:
        "general pattern guard plus private role-specific substitutions; no literal identity dictionary in public source",
    },
  });
  writePrivateJson(`${V3}/MANIFEST.json`, {
    version: 3,
    generated_utc: redactions.generated_utc,
    replaces: { version: 2, queue_sha256: v2Sha },
    v1_bindings: { queue_sha256: v2MapDoc.v1_queue_sha256 },
    v2_files_modified: 0,
    changed_items: changedItems,
    unchanged_items: unchangedItems,
    labels_prefilled: false,
    v3_queue_sha256: v3Sha,
    outputs: [
      `${V3}/blind-queue.json`,
      `${V3}/blind-queue-map.private.json`,
      `${V3}/verification.private.json`,
      redactionsPath,
    ].map((path) => ({
      path,
      bytes: Deno.statSync(path).size,
      sha256: fileSha256(path),
    })),
  });

  console.log(JSON.stringify(
    {
      ok: true,
      v3_queue: `${V3}/blind-queue.json`,
      v3_queue_sha256: v3Sha,
      replaces_v2_queue_sha256: v2Sha,
      items: items.length,
      changed_items: changedItems,
      unchanged_items: unchangedItems,
      residual_hits: 0,
      public_validator_hits: 0,
      labels_prefilled: false,
    },
    null,
    2,
  ));
  return 0;
}

if (import.meta.main) Deno.exit(await main());
export { main };
