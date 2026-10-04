// Public validator for the Jev completion dataset.
//
// Read-only: no network, no inference, no environment variables, no CLI flags.
// Run from anywhere:
//   deno run --allow-read jev/dataset/validate.ts
//
// It validates jev/dataset/{cases.jsonl,splits.json,stats.json} against the published
// schema and fails closed on credential / identifier / private-path patterns.
// On failure it exits 1 and prints only rule ids and public case ids, never matched values.

export type Finding = { case_id: string; rule: string };
export type Report = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<string, unknown>;
  privacy_findings: Finding[];
};

export const LABELS = [
  "authorized_unfinished",
  "finished",
  "waiting",
  "unclear",
] as const;
export const AUTHORITIES = [
  "independent_agent_review",
] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const SPLITS = ["dev", "heldout"] as const;
export const SOURCE_KINDS = [
  "owner_continuation_nudge",
  "owner_next_request",
  "owner_ack_continuation",
  "owner_goal_directive",
  "operator_feedback_recorded",
] as const;
export const SOURCE_STRENGTHS = [
  "strong_proxy",
  "moderate_proxy",
  "operator_feedback_proxy_unverified",
] as const;

const TOP_LEVEL_KEYS = new Set([
  "id",
  "group_id",
  "split",
  "task",
  "user_request",
  "assistant_final",
  "label",
  "label_authority",
  "label_confidence",
  "sanitization",
  "natural",
  "context",
  "source_signal",
  "notes",
]);
const SANITIZATION_KEYS = new Set([
  "method",
  "edit_ops",
  "placeholders",
  "semantics_preserved",
  "scorer_truncation_applied",
  "writer_privacy_pass",
]);
const CONTEXT_KEYS = new Set([
  "request_window_chars",
  "final_window_chars",
  "truncated",
]);
const SOURCE_KEYS = new Set(["kind", "strength"]);

export const REQUEST_WINDOW = 900;
export const FINAL_WINDOW = 1200;
const MIN_REQUEST = 40;
const MIN_FINAL = 40;
const MIN_RECORDS = 100;
const MAX_RECORDS = 150;
const MIN_SPLIT_SHARE = 0.3;

// ---------------------------------------------------------------------------
// Public privacy rules. No private identity list is embedded here: the rules are
// pattern classes only. Placeholders such as [USER_EMAIL] are not matches.
// ---------------------------------------------------------------------------

type PrivacyRule = { id: string; re: RegExp };
const PRIVACY_RULES: PrivacyRule[] = [
  {
    id: "aws_access_key_id",
    re: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[0-9A-Z]{16}\b/g,
  },
  {
    id: "github_token",
    re:
      /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    id: "openai_style_key",
    re: /\bsk-(?:proj-|svcacct-|admin-|or-v1-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  { id: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack_token", re: /\bxox[abposrdc]-[A-Za-z0-9-]{10,}\b/g },
  { id: "stripe_live_key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { id: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "gitlab_pat", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: "huggingface_token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { id: "groq_key", re: /\bgsk_[A-Za-z0-9]{40,}\b/g },
  { id: "perplexity_key", re: /\bpplx-[A-Za-z0-9]{40,}\b/g },
  { id: "digitalocean_token", re: /\bdop_v1_[0-9a-f]{64}\b/g },
  { id: "telegram_bot_token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  {
    id: "private_key_block",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  { id: "pgp_private_key", re: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g },
  { id: "age_secret_key", re: /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}\b/g },
  {
    id: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "dsn_with_password",
    re:
      /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:@/]{1,64}:[^\s:@/]{1,128}@[A-Za-z0-9.-]+/g,
  },
  {
    id: "connection_string_password",
    re: /(?:Password|Pwd)\s*=\s*[^;\s"']{6,}/gi,
  },
  {
    id: "authorization_header",
    re:
      /\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  {
    id: "cookie_session",
    re:
      /\b(?:connect\.sid|_gh_sess|sessionid|JSESSIONID|PHPSESSID|csrftoken|next-auth\.session-token|_session_id)\s*=\s*[A-Za-z0-9%._~+/=-]{8,}/gi,
  },
  {
    id: "env_secret_assignment",
    re:
      /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|CLIENT_SECRET|CREDENTIAL|AUTH)[A-Z0-9_]*\s*[:=]\s*["']?[^\s"',;#]{8,}/g,
  },
  {
    id: "aws_secret_access_key",
    re:
      /(?:aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/gi,
  },
  {
    id: "key_value_password",
    re:
      /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*["'][^"'\n]{8,}["']/gi,
  },
  {
    id: "brace_wrapped_secret",
    re:
      /\{(?=[^}\n]{6,40}\})(?=[^}\n]*[A-Za-z])(?=[^}\n]*[0-9!@#$%^&*])[^}\n]+\}/g,
  },
  { id: "deployment_id", re: /\bdpl_[A-Za-z0-9]{16,}\b/g },
  { id: "markdown_bold_issue_number", re: /\*\*#\d{1,6}\*\*/g },
  { id: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    id: "uuid",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  {
    id: "ipv4_or_ipv6",
    re:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4})\b/gi,
  },
  {
    id: "private_hostname",
    re:
      /\b[A-Za-z0-9][A-Za-z0-9-]*\.(?:local|internal|lan|svc|ts\.net|trycloudflare\.com)\b/gi,
  },
  {
    id: "private_hostname",
    re: /\b(?:localhost|127\.0\.0\.1)(?::\d{2,5})?\b/gi,
  },
  {
    id: "private_path",
    re:
      /(?:\/Users\/|\/home\/|\/root\/|\/etc\/|\/srv\/|\/var\/|\/opt\/|\/tmp\/|\/Applications\/|[A-Za-z]:\\\\)/g,
  },
  {
    id: "repo_path_token",
    re:
      /\b(?:src|lib|tests?|app|apps|packages?|components?|hooks?|scripts?)\/[A-Za-z0-9._/-]{2,}/g,
  },
  {
    id: "opaque_revision_id",
    re:
      /\b(?=[a-z0-9]{12,20}\b)(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{12,20}\b/g,
  },
];

const PUBLIC_URL_HOSTS = [
  "docs.typesafe.ai",
  "deno.land",
  "docs.deno.com",
  "developer.mozilla.org",
  "nodejs.org",
  "npmjs.com",
  "pypi.org",
  "docs.python.org",
  "typescriptlang.org",
  "react.dev",
  "sqlite.org",
  "platform.openai.com",
  "docs.anthropic.com",
  "modelcontextprotocol.io",
  "w3.org",
  "ietf.org",
  "stackoverflow.com",
  "unix.stackexchange.com",
  "en.wikipedia.org",
  "arxiv.org",
  "doi.org",
  "github.com",
];

const URL_RE = /\bhttps?:\/\/[^\s"'`)\]}>]+/gi;

/** Returns the privacy rule ids matched in free text. Never returns the matched values. */
export function privacyHits(text: string): string[] {
  const hits = new Set<string>();
  for (const rule of PRIVACY_RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) hits.add(rule.id);
  }
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    let host = "";
    try {
      host = new URL(m[0]).hostname.toLowerCase();
    } catch {
      host = "";
    }
    if (
      !host ||
      !PUBLIC_URL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    ) {
      hits.add("nonpublic_url");
    }
  }
  return [...hits].sort();
}

function typeCheck(
  errors: string[],
  value: unknown,
  label: string,
  type: "string" | "boolean" | "object",
): boolean {
  const ok = type === "object"
    ? typeof value === "object" && value !== null && !Array.isArray(value)
    : typeof value === type;
  if (!ok) {
    errors.push(`${label}: expected ${type}`);
    return false;
  }
  return true;
}

function normalizePair(req: string, fin: string): string {
  return `${req}\u0000${fin}`.toLowerCase().replace(/[^a-z0-9\u0000]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

export function validateDataset(
  casesText: string,
  splitsText: string,
  statsText: string,
): Report {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: Record<string, unknown> = {};
  const privacy: Finding[] = [];

  const parse = (text: string, label: string): unknown => {
    try {
      if (label === "cases.jsonl") {
        return text.split("\n").filter((line) => line.trim().length > 0).map((
          line,
        ) => JSON.parse(line));
      }
      return JSON.parse(text);
    } catch (e) {
      errors.push(
        `${label}: invalid JSON (${(e as Error).message.slice(0, 80)})`,
      );
      return null;
    }
  };

  const rawCases = parse(casesText, "cases.jsonl");
  const splits = parse(splitsText, "splits.json") as
    | Record<string, unknown>
    | null;
  const stats = parse(statsText, "stats.json") as
    | Record<string, unknown>
    | null;
  if (!Array.isArray(rawCases)) {
    errors.push("cases.jsonl: expected one JSON object per line");
    return { ok: false, errors, warnings, counts, privacy_findings: privacy };
  }
  const cases = rawCases as Array<Record<string, unknown>>;
  counts.records = cases.length;

  if (cases.length < MIN_RECORDS || cases.length > MAX_RECORDS) {
    errors.push(
      `cases.jsonl: record count ${cases.length} outside ${MIN_RECORDS}-${MAX_RECORDS}`,
    );
  }

  const ids = new Set<string>();
  const groups = new Map<string, string>();
  const pairs = new Map<string, string>();
  const splitCounts: Record<string, number> = { dev: 0, heldout: 0 };
  const labelCounts: Record<string, number> = {};
  const authorityCounts: Record<string, number> = {};

  for (const [index, c] of cases.entries()) {
    const where = `case[${index}]`;
    if (!typeCheck(errors, c, where, "object")) continue;
    for (const key of Object.keys(c)) {
      if (!TOP_LEVEL_KEYS.has(key)) {
        errors.push(`${where}: unknown field "${key}"`);
      }
    }
    const id = c.id;
    const group = c.group_id;
    if (!typeCheck(errors, id, `${where}.id`, "string")) continue;
    if (!/^public-\d{4}$/.test(id as string)) {
      errors.push(`${where}.id: expected public-NNNN`);
    }
    if (ids.has(id as string)) errors.push(`${where}.id: duplicate ${id}`);
    ids.add(id as string);
    if (!typeCheck(errors, group, `${where}.group_id`, "string")) continue;
    if (!/^group-\d{4}$/.test(group as string)) {
      errors.push(`${where}.group_id: expected group-NNNN`);
    }

    const split = c.split;
    if (
      typeof split !== "string" ||
      !(SPLITS as readonly string[]).includes(split)
    ) {
      errors.push(`${where}.split: expected dev|heldout`);
    } else {
      splitCounts[split]++;
      const previous = groups.get(group as string);
      if (previous !== undefined && previous !== split) {
        errors.push(`${where}.group_id: group ${group} appears in two splits`);
      }
      groups.set(group as string, split);
    }

    if (c.task !== "completion_judgment") {
      errors.push(`${where}.task: expected completion_judgment`);
    }
    if (c.natural !== true) errors.push(`${where}.natural: expected true`);

    const req = c.user_request;
    const fin = c.assistant_final;
    if (!typeCheck(errors, req, `${where}.user_request`, "string")) continue;
    if (!typeCheck(errors, fin, `${where}.assistant_final`, "string")) continue;
    const reqText = req as string;
    const finText = fin as string;
    const reqLength = [...reqText].length;
    const finLength = [...finText].length;
    if (reqLength < MIN_REQUEST || reqLength > REQUEST_WINDOW) {
      errors.push(
        `${where}.user_request: length ${reqLength} outside ${MIN_REQUEST}-${REQUEST_WINDOW}`,
      );
    }
    if (finLength < MIN_FINAL || finLength > FINAL_WINDOW) {
      errors.push(
        `${where}.assistant_final: length ${finLength} outside ${MIN_FINAL}-${FINAL_WINDOW}`,
      );
    }

    const label = c.label;
    if (
      typeof label !== "string" ||
      !(LABELS as readonly string[]).includes(label)
    ) {
      errors.push(`${where}.label: expected one of ${LABELS.join("|")}`);
    } else {
      labelCounts[label] = (labelCounts[label] ?? 0) + 1;
    }
    const authority = c.label_authority;
    if (
      typeof authority !== "string" ||
      !(AUTHORITIES as readonly string[]).includes(authority)
    ) {
      errors.push(
        `${where}.label_authority: expected ${AUTHORITIES.join("|")}`,
      );
    } else {
      authorityCounts[authority] = (authorityCounts[authority] ?? 0) + 1;
    }
    if (
      typeof c.label_confidence !== "string" ||
      !(CONFIDENCES as readonly string[]).includes(c.label_confidence)
    ) {
      errors.push(
        `${where}.label_confidence: expected ${CONFIDENCES.join("|")}`,
      );
    }

    const san = c.sanitization;
    if (typeCheck(errors, san, `${where}.sanitization`, "object")) {
      const s = san as Record<string, unknown>;
      for (const key of Object.keys(s)) {
        if (!SANITIZATION_KEYS.has(key)) {
          errors.push(`${where}.sanitization: unknown field "${key}"`);
        }
      }
      if (typeof s.method !== "string" || s.method.length === 0) {
        errors.push(`${where}.sanitization.method: required`);
      }
      if (
        !Array.isArray(s.edit_ops) ||
        s.edit_ops.some((x) => typeof x !== "string")
      ) {
        errors.push(`${where}.sanitization.edit_ops: expected string[]`);
      }
      if (
        !Array.isArray(s.placeholders) ||
        s.placeholders.some((x) =>
          typeof x !== "string" || !/^\[[A-Z_]+\]$/.test(x)
        )
      ) {
        errors.push(
          `${where}.sanitization.placeholders: expected [UPPER_SNAKE] tokens`,
        );
      }
      if (s.semantics_preserved !== true) {
        errors.push(`${where}.sanitization.semantics_preserved: expected true`);
      }
      if (s.scorer_truncation_applied !== false) {
        errors.push(
          `${where}.sanitization.scorer_truncation_applied: expected false`,
        );
      }
      if (s.writer_privacy_pass !== true) {
        errors.push(`${where}.sanitization.writer_privacy_pass: expected true`);
      }
    }

    const context = c.context;
    if (typeCheck(errors, context, `${where}.context`, "object")) {
      const ctx = context as Record<string, unknown>;
      for (const key of Object.keys(ctx)) {
        if (!CONTEXT_KEYS.has(key)) {
          errors.push(`${where}.context: unknown field "${key}"`);
        }
      }
      if (ctx.request_window_chars !== REQUEST_WINDOW) {
        errors.push(
          `${where}.context.request_window_chars: expected ${REQUEST_WINDOW}`,
        );
      }
      if (ctx.final_window_chars !== FINAL_WINDOW) {
        errors.push(
          `${where}.context.final_window_chars: expected ${FINAL_WINDOW}`,
        );
      }
      if (ctx.truncated !== false) {
        errors.push(
          `${where}.context.truncated: expected false (no truncation)`,
        );
      }
    }

    if (c.source_signal !== undefined) {
      const signal = c.source_signal;
      if (typeCheck(errors, signal, `${where}.source_signal`, "object")) {
        const s = signal as Record<string, unknown>;
        for (const key of Object.keys(s)) {
          if (!SOURCE_KEYS.has(key)) {
            errors.push(`${where}.source_signal: unknown field "${key}"`);
          }
        }
        if (
          typeof s.kind !== "string" ||
          !(SOURCE_KINDS as readonly string[]).includes(s.kind)
        ) {
          errors.push(`${where}.source_signal.kind: unexpected value`);
        }
        if (
          typeof s.strength !== "string" ||
          !(SOURCE_STRENGTHS as readonly string[]).includes(s.strength)
        ) {
          errors.push(`${where}.source_signal.strength: unexpected value`);
        }
        if (
          s.kind === "operator_feedback_recorded" &&
          s.strength !== "operator_feedback_proxy_unverified"
        ) {
          errors.push(
            `${where}.source_signal.strength: operator_feedback_recorded requires operator_feedback_proxy_unverified`,
          );
        }
      }
    } else if (authority !== undefined) {
      warnings.push(
        `${where}.source_signal: absent; behavioral source strength will be undisclosed`,
      );
    }

    if (c.notes !== undefined) {
      if (typeof c.notes !== "string" || c.notes.length > 500) {
        errors.push(`${where}.notes: expected string <= 500 chars`);
      }
    }

    const pairKey = normalizePair(reqText, finText);
    const previousId = pairs.get(pairKey);
    if (previousId !== undefined) {
      errors.push(`${where}: duplicate normalized pair (also ${previousId})`);
    } else pairs.set(pairKey, id as string);

    for (
      const rule of privacyHits(
        `${reqText}\n${finText}\n${typeof c.notes === "string" ? c.notes : ""}`,
      )
    ) {
      privacy.push({ case_id: id as string, rule });
    }
  }

  const total = cases.length;
  for (const split of SPLITS) {
    const share = total > 0 ? splitCounts[split] / total : 0;
    if (share < MIN_SPLIT_SHARE) {
      errors.push(
        `split ${split}: share ${share.toFixed(2)} below ${MIN_SPLIT_SHARE}`,
      );
    }
  }
  counts.splits = splitCounts;
  counts.labels = labelCounts;
  counts.label_authorities = authorityCounts;

  if (splits) {
    if (splits.dataset !== "jev/dataset/cases.jsonl") {
      errors.push("splits.json.dataset: unexpected value");
    }
    const dev = splits.dev;
    const heldout = splits.heldout;
    if (!Array.isArray(dev) || !Array.isArray(heldout)) {
      errors.push("splits.json: dev and heldout must be arrays");
    } else {
      const listed = [...dev, ...heldout];
      if (new Set(listed).size !== listed.length) {
        errors.push("splits.json: a group id appears twice");
      }
      const actual = new Set(groups.keys());
      for (const g of actual) {
        if (!listed.includes(g)) errors.push(`splits.json: group ${g} missing`);
      }
      for (const g of listed) {
        if (!actual.has(g as string)) {
          errors.push(`splits.json: unknown group ${g}`);
        }
      }
      counts.splits_file = { dev: dev.length, heldout: heldout.length };
    }
  }

  if (stats) {
    if (stats.status !== "final_independent_review") {
      errors.push("stats.json.status: expected final_independent_review");
    }
    if (stats.record_count !== total) {
      errors.push("stats.json.record_count: does not match cases.jsonl");
    }
    const labelStats = stats.label_counts as
      | Record<string, unknown>
      | null
      | undefined;
    if (!labelStats || typeof labelStats !== "object") {
      errors.push("stats.json.label_counts: expected regenerated label counts");
    } else {
      const expected = Object.fromEntries(Object.entries(labelCounts).sort());
      const actual = Object.fromEntries(Object.entries(labelStats).sort());
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        errors.push("stats.json.label_counts: does not match cases.jsonl");
      }
    }
    const splitStats = stats.split_counts as
      | Record<string, unknown>
      | undefined;
    if (
      !splitStats || splitStats.dev !== splitCounts.dev ||
      splitStats.heldout !== splitCounts.heldout
    ) {
      errors.push("stats.json.split_counts: does not match cases.jsonl");
    }
  }

  if (privacy.length > 0) {
    errors.push(
      `privacy: ${privacy.length} finding(s) across ${
        new Set(privacy.map((p) => p.case_id)).size
      } case(s)`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts,
    privacy_findings: privacy,
  };
}

async function main(): Promise<void> {
  const dir = new URL(".", import.meta.url);
  const read = async (name: string): Promise<string | null> => {
    try {
      return await Deno.readTextFile(new URL(name, dir));
    } catch {
      return null;
    }
  };
  const cases = await read("cases.jsonl");
  const splits = await read("splits.json");
  const stats = await read("stats.json");
  const missing = [["cases.jsonl", cases], ["splits.json", splits], [
    "stats.json",
    stats,
  ]]
    .filter(([, text]) => text === null)
    .map(([name]) => name);
  const report: Report = missing.length > 0
    ? {
      ok: false,
      errors: missing.map((name) => `${name}: missing`),
      warnings: [],
      counts: {},
      privacy_findings: [],
    }
    : validateDataset(cases as string, splits as string, stats as string);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) Deno.exit(1);
}

if (import.meta.main) await main();
