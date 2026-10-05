// Panel building: deterministic hashes, duplicate/copied-turn collapse, conversation-grouped
// train/dev/locked-heldout split, the frozen public benchmark, and the private blind-annotation
// queue. Nothing here calls a model or reads a label for the local panel (local pairs have none).

import { createHash } from "node:crypto";
import type { BacktestConfig } from "./config.ts";
import type { RawPair, Tier } from "./transcript.ts";
import { scrubPair } from "./scrub.ts";

export interface Case {
  id: string;
  groupId: string;
  tier: Tier;
  sessionId: string;
  turnId: string;
  userRequest: string;
  assistantFinal: string;
  startedAt: number | null;
  sourcePath: string;
  scrubFlags: string[];
  hash: string;
}

export interface QuarantineRow {
  reason: string;
  tier: Tier;
  chars: number;
}

export interface Panel {
  cases: Case[];
  quarantined: QuarantineRow[];
  duplicates: { same_turn: number; copied_text: number };
}

const TIER_ORDER: Record<Tier, number> = {
  session: 0,
  archive: 1,
  "db-pointer": 2,
};

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Deterministic 16-hex-char hash of any JSON-serializable value. */
export function hash16(value: unknown): string {
  return hashHex(JSON.stringify(value)).slice(0, 16);
}

export function hashHex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Full-file sha256; the binding unit for frozen queues, maps and caches. */
export function fileSha256(path: string): string {
  return hashHex(Deno.readTextFileSync(path));
}

/**
 * Pair hash used by the independent reviewers: sha256(UTF8(request + NUL + final)) over the frozen
 * strings verbatim. Matching their algorithm is what makes a label cache bindable to a queue item.
 */
export function pairHash(request: string, final: string): string {
  return hashHex(`${request}\u0000${final}`);
}

export function caseHash(pair: RawPair): string {
  return hash16({
    session: pair.sessionId,
    turn: pair.turnId,
    request: normalizeText(pair.request),
    final: normalizeText(pair.final),
  });
}

/** Collapse the same turn carried by two files and byte-copied turn pairs. */
export function dedupePairs(
  pairs: RawPair[],
): { kept: RawPair[]; sameTurn: number; copiedText: number } {
  const ordered = [...pairs].sort((a, b) =>
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
    a.sourcePath.localeCompare(b.sourcePath) || a.ordinal - b.ordinal
  );
  const seenTurn = new Set<string>();
  const seenText = new Set<string>();
  const kept: RawPair[] = [];
  let sameTurn = 0;
  let copiedText = 0;
  for (const pair of ordered) {
    const turnKey = `${pair.sessionId}|${pair.turnId}`;
    const textKey = hash16({
      request: normalizeText(pair.request),
      final: normalizeText(pair.final),
    });
    if (seenTurn.has(turnKey)) {
      sameTurn += 1;
      continue;
    }
    seenTurn.add(turnKey);
    if (seenText.has(textKey)) {
      copiedText += 1;
      continue;
    }
    seenText.add(textKey);
    kept.push(pair);
  }
  return { kept, sameTurn, copiedText };
}

/** Scrub first, then length-qualify. An insufficient pair is quarantined, never trimmed into use. */
export function buildPanel(pairs: RawPair[], cfg: BacktestConfig): Panel {
  const deduped = dedupePairs(pairs);
  const cases: Case[] = [];
  const quarantined: QuarantineRow[] = [];
  for (const pair of deduped.kept) {
    const scrub = scrubPair(pair.request, pair.final);
    if (!scrub.ok) {
      quarantined.push({
        reason: `scrub_failed:${scrub.flags.join("+")}`,
        tier: pair.tier,
        chars: pair.request.length,
      });
      continue;
    }
    if (
      normalizeText(scrub.request).length < cfg.minRequestChars ||
      normalizeText(scrub.final).length < cfg.minFinalChars
    ) {
      quarantined.push({
        reason: "insufficient_pair",
        tier: pair.tier,
        chars: scrub.request.length + scrub.final.length,
      });
      continue;
    }
    cases.push({
      id: hash16({ session: pair.sessionId, turn: pair.turnId }).slice(0, 12),
      groupId: hash16(pair.sessionId),
      tier: pair.tier,
      sessionId: pair.sessionId,
      turnId: pair.turnId,
      userRequest: scrub.request,
      assistantFinal: scrub.final,
      startedAt: pair.startedAt,
      sourcePath: pair.sourcePath,
      scrubFlags: scrub.flags,
      hash: caseHash(pair),
    });
  }
  cases.sort((a, b) =>
    a.groupId.localeCompare(b.groupId) || a.hash.localeCompare(b.hash)
  );
  return {
    cases,
    quarantined,
    duplicates: {
      same_turn: deduped.sameTurn,
      copied_text: deduped.copiedText,
    },
  };
}

export interface GroupSplit {
  train: Case[];
  dev: Case[];
  lockedHeldout: Case[];
  assignments: Record<string, "train" | "dev" | "locked-heldout">;
}

/** Every conversation group lands in exactly one split; the heldout split is evaluation-only. */
export function splitByConversation(
  cases: Case[],
  ratios = { train: 0.6, dev: 0.15 },
): GroupSplit {
  const groups = [...new Set(cases.map((c) => c.groupId))].sort((a, b) =>
    hash16(a).localeCompare(hash16(b))
  );
  const trainCount = Math.max(1, Math.floor(groups.length * ratios.train));
  const devCount = Math.max(1, Math.floor(groups.length * ratios.dev));
  const assignments: Record<string, "train" | "dev" | "locked-heldout"> = {};
  groups.forEach((group, index) => {
    assignments[group] = index < trainCount
      ? "train"
      : index < trainCount + devCount
      ? "dev"
      : "locked-heldout";
  });
  return {
    train: cases.filter((c) => assignments[c.groupId] === "train"),
    dev: cases.filter((c) => assignments[c.groupId] === "dev"),
    lockedHeldout: cases.filter((c) =>
      assignments[c.groupId] === "locked-heldout"
    ),
    assignments,
  };
}

/** Representative, deterministic 12: spread across conversations and request-length quartiles. */
export function selectBlindQueue(cases: Case[], size: number): Case[] {
  if (cases.length <= size) {
    return [...cases].sort((a, b) => a.hash.localeCompare(b.hash));
  }
  const sorted = [...cases].sort((a, b) =>
    a.userRequest.length - b.userRequest.length || a.hash.localeCompare(b.hash)
  );
  const buckets: Case[][] = [[], [], [], []];
  sorted.forEach((c, i) =>
    buckets[Math.min(3, Math.floor((i / sorted.length) * 4))].push(c)
  );
  const picked: Case[] = [];
  const usedGroups = new Set<string>();
  for (let round = 0; picked.length < size; round++) {
    for (const bucket of buckets) {
      if (picked.length >= size) break;
      const next = bucket.find((c) =>
        !picked.includes(c) && !usedGroups.has(c.groupId)
      ) ??
        bucket.find((c) => !picked.includes(c));
      if (!next) continue;
      picked.push(next);
      usedGroups.add(next.groupId);
    }
    if (round > size) break;
  }
  return picked.sort((a, b) => a.hash.localeCompare(b.hash));
}

export interface PublicCase {
  id: string;
  groupId: string;
  split: string;
  userRequest: string;
  assistantFinal: string;
  label: string;
  labelConfidence: string;
  labelAuthority: string;
}

export function readPublicDataset(path: string): PublicCase[] {
  const cases: PublicCase[] = [];
  for (const line of Deno.readTextFileSync(path).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    cases.push({
      id: String(row.id),
      groupId: String(row.group_id),
      split: String(row.split),
      userRequest: String(row.user_request),
      assistantFinal: String(row.assistant_final),
      label: String(row.label),
      labelConfidence: String(row.label_confidence ?? ""),
      labelAuthority: String(row.label_authority ?? ""),
    });
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));
  return cases;
}

export interface Benchmark {
  heldout: PublicCase[];
  dev: PublicCase[];
  excludedDevAnchor: string;
}

/** Frozen public benchmark: heldout50 unchanged, dev50 minus the original18-overlapping anchor. */
export function publicBenchmark(
  cases: PublicCase[],
  cfg: BacktestConfig,
): Benchmark {
  const heldout = cases.filter((c) => c.split === "heldout");
  const dev = cases.filter((c) =>
    c.split === "dev" && c.id !== cfg.devAnchorOverlapId
  );
  return { heldout, dev, excludedDevAnchor: cfg.devAnchorOverlapId };
}

export function ensurePrivateDir(dir: string): void {
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  Deno.chmodSync(dir, 0o700);
}

export function writePrivateJson(path: string, value: unknown): void {
  ensurePrivateDir(path.slice(0, path.lastIndexOf("/")));
  Deno.writeTextFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  Deno.chmodSync(path, 0o600);
}

export function writePrivateJsonl(path: string, rows: unknown[]): void {
  ensurePrivateDir(path.slice(0, path.lastIndexOf("/")));
  Deno.writeTextFileSync(
    path,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: 0o600 },
  );
  Deno.chmodSync(path, 0o600);
}

/** Scoring-case shape accepted by the existing jev/score-rubric.py bridge. */
export function toScoringCase(
  c: {
    id: string;
    userRequest: string;
    assistantFinal: string;
    label?: string;
  },
) {
  return {
    id: c.id,
    user_request: c.userRequest,
    assistant_final: c.assistantFinal,
    ...(c.label ? { label: c.label } : {}),
  };
}
