// Read-only transcript ingestion: local Codex rollouts, archived .jsonl.zst, and the read-only
// thread_history_1.sqlite index. Three provenance tiers, never mixed silently:
//
//   session / archive  canonical carriers: turn brackets + response_item messages + assistant
//                      `phase == "final_answer"`.
//   db-pointer         thread_turns.first_user_item_id -> final_agent_item_id resolved to real
//                      item bodies. Supported by recorded pointers, but without turn brackets or
//                      phase metadata, so it is a lower-confidence corpus, never a benchmark arm.
//
// Excluded: child/subagent carriers, sessions operating on this audit workspace, injected context
// and bootstrap AGENTS text, reasoning/tool items, incomplete (open) turns, turns after the fixed
// cutoff, and the duplicate `event_msg item_completed` carrier.

import { DatabaseSync } from "node:sqlite";

export type Carrier = "root_user" | "child" | "observer" | "unknown";
export type Tier = "session" | "archive" | "db-pointer";

export interface RawPair {
  tier: Tier;
  sessionId: string;
  turnId: string;
  request: string;
  final: string;
  startedAt: number | null;
  sourcePath: string;
  /** Stable per-carrier ordinal used only for dedupe ordering. */
  ordinal: number;
}

export interface SessionInfo {
  path: string;
  sessionId: string;
  carrier: Carrier;
  originator: string;
  cwd: string;
  threadSource: string;
  sourceKind: string;
  bytes: number;
}

export interface SessionScan {
  files: SessionInfo[];
  pairs: RawPair[];
  stats: Record<string, number>;
}

interface OpenTurn {
  turnId: string;
  startedAt: number | null;
  steering: string[];
  finals: string[];
  ordinal: number;
  openAtEof: boolean;
}

const STEERING_BLOCK_PREFIXES = ["<", "# AGENTS.md instructions"];
const STEERING_BLOCK_MARKERS = [
  "<environment_context>",
  "<user_instructions>",
  "<hook_prompt>",
  "<INSTRUCTIONS>",
];

function messageText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text;
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("");
}

/** Real user steering: not an injected context block and not bootstrap AGENTS instructions. */
export function isRealSteering(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (STEERING_BLOCK_PREFIXES.some((p) => trimmed.startsWith(p))) return false;
  return !STEERING_BLOCK_MARKERS.some((m) => trimmed.includes(m));
}

export function carrierFor(meta: Record<string, unknown>): Carrier {
  const threadSource = String(meta.thread_source ?? "");
  const source = meta.source;
  const parent = meta.parent_thread_id;
  const sessionId = String(meta.id ?? "");
  const cwd = String(meta.cwd ?? "");
  if (threadSource !== "user" || typeof source !== "string") {
    return threadSource ? "child" : "unknown";
  }
  if (parent && String(parent) !== sessionId) return "child";
  if (cwd.startsWith("/home/codex/.local/state/repo-public-audit-")) {
    return "observer";
  }
  return "root_user";
}

/** Parse one rollout JSONL text into completed-turn pairs. */
export function parseSessionText(text: string, sourcePath: string): {
  pairs: RawPair[];
  meta: Record<string, unknown> | null;
  stats: Record<string, number>;
} {
  const stats: Record<string, number> = {
    turns_opened: 0,
    turns_completed: 0,
    turns_aborted: 0,
    turns_open_at_eof: 0,
    steering_items: 0,
    steering_injected_skipped: 0,
    final_phase_items: 0,
    turns_missing_final_phase: 0,
    turns_missing_steering: 0,
    duplicate_carrier_items_ignored: 0,
  };
  let meta: Record<string, unknown> | null = null;
  let current: OpenTurn | null = null;
  const closed: OpenTurn[] = [];
  const pairs: RawPair[] = [];
  let ordinal = 0;

  const close = (turnId: string, completed: boolean) => {
    if (!current || current.turnId !== turnId) {
      if (completed) stats.turns_completed += 0;
      return;
    }
    if (completed) stats.turns_completed += 1;
    else stats.turns_aborted += 1;
    closed.push(current);
    current = null;
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record.type;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    if (type === "session_meta") {
      meta = payload;
      continue;
    }
    if (type === "event_msg") {
      const sub = payload.type;
      if (sub === "task_started") {
        stats.turns_opened += 1;
        current = {
          turnId: String(payload.turn_id ?? ""),
          startedAt: typeof payload.started_at === "number"
            ? payload.started_at
            : null,
          steering: [],
          finals: [],
          ordinal: ordinal++,
          openAtEof: false,
        };
      } else if (sub === "task_complete") {
        close(String(payload.turn_id ?? ""), !payload.error);
      } else if (sub === "turn_aborted") {
        close(String(payload.turn_id ?? ""), false);
      } else if (sub === "item_completed") {
        // Duplicate carrier: response_item is canonical, so this copy is counted and ignored.
        stats.duplicate_carrier_items_ignored += 1;
      }
      continue;
    }
    if (type !== "response_item" || !current) continue;
    if (payload.type !== "message") continue;
    const role = payload.role;
    if (role === "user") {
      const itemText = messageText(payload);
      if (isRealSteering(itemText)) {
        stats.steering_items += 1;
        current.steering.push(itemText);
      } else if (itemText.trim()) {
        stats.steering_injected_skipped += 1;
      }
    } else if (role === "assistant" && payload.phase === "final_answer") {
      stats.final_phase_items += 1;
      current.finals.push(messageText(payload));
    }
  }

  if (current) {
    stats.turns_open_at_eof += 1;
    current.openAtEof = true;
    closed.push(current);
    current = null;
  }
  for (const turn of closed) {
    // An incomplete (still open at EOF) turn is never paired.
    if (turn.openAtEof) continue;
    if (turn.finals.length === 0) {
      stats.turns_missing_final_phase += 1;
      continue;
    }
    if (turn.steering.length === 0) {
      stats.turns_missing_steering += 1;
      continue;
    }
    const request = turn.steering[turn.steering.length - 1];
    const final = turn.finals[turn.finals.length - 1];
    pairs.push({
      tier: sourcePath.endsWith(".zst") ? "archive" : "session",
      sessionId: String(meta?.id ?? meta?.session_id ?? sourcePath),
      turnId: turn.turnId,
      request,
      final,
      startedAt: turn.startedAt,
      sourcePath,
      ordinal: turn.ordinal,
    });
  }
  return { pairs, meta, stats };
}

function sessionIdFromFilename(path: string): string {
  const base = path.split("/").pop() ?? path;
  const match = base.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
  );
  return match ? match[1] : base;
}

/** Walk the active session store (read-only) and pair every eligible root user turn. */
export function scanSessions(root: string, cutoffMs: number): SessionScan {
  const files: SessionInfo[] = [];
  const pairs: RawPair[] = [];
  const stats: Record<string, number> = {
    files_seen: 0,
    unreadable_files: 0,
    root_user_files: 0,
    child_files: 0,
    observer_files: 0,
    unknown_carrier_files: 0,
    pairs_before_cutoff: 0,
    pairs_after_cutoff: 0,
  };
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) walk(path);
      else if (
        entry.isFile && entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) paths.push(path);
    }
  };
  walk(root);
  paths.sort();
  for (const path of paths) {
    stats.files_seen += 1;
    let text: string;
    try {
      text = Deno.readTextFileSync(path);
    } catch {
      stats.unreadable_files += 1;
      continue;
    }
    const parsed = parseSessionText(text, path);
    const meta = parsed.meta ?? {};
    const carrier = carrierFor(meta);
    const info: SessionInfo = {
      path,
      sessionId: String(meta.id ?? sessionIdFromFilename(path)),
      carrier,
      originator: String(meta.originator ?? ""),
      cwd: String(meta.cwd ?? ""),
      threadSource: String(meta.thread_source ?? ""),
      sourceKind: typeof meta.source === "string"
        ? meta.source
        : typeof meta.source,
      bytes: text.length,
    };
    files.push(info);
    if (carrier === "root_user") stats.root_user_files += 1;
    else if (carrier === "child") stats.child_files += 1;
    else if (carrier === "observer") stats.observer_files += 1;
    else stats.unknown_carrier_files += 1;
    if (carrier !== "root_user") continue;
    for (const pair of parsed.pairs) {
      if (pair.startedAt !== null && pair.startedAt * 1000 > cutoffMs) {
        stats.pairs_after_cutoff += 1;
        continue;
      }
      stats.pairs_before_cutoff += 1;
      pairs.push(pair);
    }
  }
  return { files, pairs, stats };
}

/** Decompress an archived rollout with a fixed argv (no shell); returns null when unreadable. */
export function readArchive(path: string): string | null {
  const command = new Deno.Command("zstd", {
    args: ["-d", "-c", path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = command.outputSync();
  if (!output.success) return null;
  return new TextDecoder().decode(output.stdout);
}

export function scanArchives(root: string, cutoffMs: number): SessionScan {
  const files: SessionInfo[] = [];
  const pairs: RawPair[] = [];
  const stats: Record<string, number> = {
    archives_seen: 0,
    archives_parsed: 0,
    archives_failed: 0,
    pairs: 0,
  };
  let names: string[] = [];
  try {
    names = [...Deno.readDirSync(root)].filter((e) =>
      e.isFile && e.name.endsWith(".jsonl.zst")
    ).map((e) => e.name).sort();
  } catch {
    return { files, pairs, stats };
  }
  for (const name of names) {
    stats.archives_seen += 1;
    const path = `${root}/${name}`;
    const text = readArchive(path);
    if (text === null) {
      stats.archives_failed += 1;
      continue;
    }
    const parsed = parseSessionText(text, path);
    const meta = parsed.meta ?? {};
    const carrier = carrierFor(meta);
    files.push({
      path,
      sessionId: String(meta.id ?? sessionIdFromFilename(path)),
      carrier,
      originator: String(meta.originator ?? ""),
      cwd: String(meta.cwd ?? ""),
      threadSource: String(meta.thread_source ?? ""),
      sourceKind: typeof meta.source === "string"
        ? meta.source
        : typeof meta.source,
      bytes: text.length,
    });
    stats.archives_parsed += 1;
    if (carrier !== "root_user") continue;
    for (const pair of parsed.pairs) {
      if (pair.startedAt !== null && pair.startedAt * 1000 > cutoffMs) continue;
      pairs.push(pair);
      stats.pairs += 1;
    }
  }
  return { files, pairs, stats };
}

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteCtor {
  new (path: string, options?: { readOnly?: boolean }): SqliteDb;
}

export interface DbScan {
  pairs: RawPair[];
  stats: Record<string, number>;
}

/** Read-only DB index scan: only turns whose first-user/final-agent pointers resolve to rows. */
export function scanHistoryDb(
  dbPath: string,
  cutoffMs: number,
  excludeSessionIds: Set<string>,
): DbScan {
  const stats: Record<string, number> = {
    threads_with_items: 0,
    threads_total: 0,
    db_only_threads: 0,
    db_only_threads_with_message_bodies: 0,
    db_only_threads_with_resolvable_pointers: 0,
    pointer_turns_checked: 0,
    pointer_pairs_usable: 0,
    pointer_rows_missing: 0,
    after_cutoff: 0,
    excluded_local_threads: 0,
  };
  const pairs: RawPair[] = [];
  let sqlite: SqliteCtor;
  try {
    sqlite = DatabaseSync as unknown as SqliteCtor;
  } catch {
    stats.sqlite_unavailable = 1;
    return { pairs, stats };
  }
  let db: SqliteDb;
  try {
    db = new sqlite(dbPath, { readOnly: true });
  } catch {
    stats.sqlite_unavailable = 1;
    return { pairs, stats };
  }
  try {
    const threadRows = db.prepare(
      "SELECT thread_id, COUNT(*) AS n FROM thread_items GROUP BY thread_id",
    ).all();
    stats.threads_with_items = threadRows.length;
    const turnThreads = db.prepare(
      "SELECT DISTINCT thread_id FROM thread_turns",
    ).all();
    stats.threads_total = turnThreads.length;
    const itemKinds = db
      .prepare(
        "SELECT thread_id, SUM(CASE WHEN item_type='userMessage' THEN 1 ELSE 0 END) AS u, " +
          "SUM(CASE WHEN item_type='agentMessage' THEN 1 ELSE 0 END) AS a " +
          "FROM thread_items GROUP BY thread_id",
      )
      .all();
    const withBodies = new Set(
      itemKinds.filter((r) => Number(r.u) > 0 && Number(r.a) > 0).map((r) =>
        String(r.thread_id)
      ),
    );
    const dbOnly = new Set<string>();
    for (const row of turnThreads) {
      const id = String(row.thread_id);
      if (excludeSessionIds.has(id)) {
        stats.excluded_local_threads += 1;
        continue;
      }
      dbOnly.add(id);
    }
    stats.db_only_threads = dbOnly.size;
    stats.db_only_threads_with_message_bodies = [...dbOnly].filter((id) =>
      withBodies.has(id)
    ).length;

    const pointerTurns = db
      .prepare(
        "SELECT thread_id, turn_id, first_user_item_id, final_agent_item_id, started_at FROM thread_turns " +
          "WHERE first_user_item_id IS NOT NULL AND final_agent_item_id IS NOT NULL",
      )
      .all();
    const itemStmt = db.prepare(
      "SELECT item_json FROM thread_items WHERE thread_id = ? AND item_id = ? LIMIT 1",
    );
    const pointerThreads = new Set<string>();
    for (const turn of pointerTurns) {
      const threadId = String(turn.thread_id);
      if (!dbOnly.has(threadId)) continue;
      pointerThreads.add(threadId);
      stats.pointer_turns_checked += 1;
      const startedAt = Number(turn.started_at ?? 0);
      if (startedAt > 0 && startedAt * 1000 > cutoffMs) {
        stats.after_cutoff += 1;
        continue;
      }
      const userRow =
        itemStmt.all(threadId, String(turn.first_user_item_id))[0];
      const agentRow =
        itemStmt.all(threadId, String(turn.final_agent_item_id))[0];
      if (!userRow || !agentRow) {
        stats.pointer_rows_missing += 1;
        continue;
      }
      const request = dbItemText("userMessage", userRow.item_json);
      const final = dbItemText("agentMessage", agentRow.item_json);
      if (!request || !final) continue;
      pairs.push({
        tier: "db-pointer",
        sessionId: threadId,
        turnId: String(turn.turn_id),
        request,
        final,
        startedAt: startedAt > 0 ? startedAt : null,
        sourcePath: `${dbPath}#${threadId}`,
        ordinal: stats.pointer_pairs_usable,
      });
      stats.pointer_pairs_usable += 1;
    }
    stats.db_only_threads_with_resolvable_pointers = pointerThreads.size;
  } finally {
    db.close();
  }
  return { pairs, stats };
}

function dbItemText(
  kind: "userMessage" | "agentMessage",
  raw: unknown,
): string {
  if (typeof raw !== "string") return "";
  try {
    const item = JSON.parse(raw) as Record<string, unknown>;
    if (kind === "userMessage") {
      const content = item.content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((c): c is Record<string, unknown> =>
          !!c && typeof c === "object"
        )
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
    }
    return typeof item.text === "string" ? item.text : "";
  } catch {
    return "";
  }
}
