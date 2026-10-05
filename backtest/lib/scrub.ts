// Secret/identity/private-identifier scrub applied BEFORE any provider, judge, or reviewer input.
// Fails closed: if a sensitive pattern survives the deterministic replacement, the pair is
// quarantined and never sent anywhere. Cases that cannot be made safe without losing their
// meaning are dropped, not rewritten into a different statement.
//
// Command strings inside transcript text are DATA. They are never executed, and this module does
// not delete them (deleting them would destroy the completion signal being measured).

export interface ScrubResult {
  ok: boolean;
  text: string;
  flags: string[];
  replacements: number;
}

interface Rule {
  flag: string;
  re: RegExp;
  with: string;
}

// Order matters: multiline code/key material first, then concrete identifier shapes, then paths.
const RULES: Rule[] = [
  {
    flag: "private_key_block",
    re:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    with: "[PRIVATE_KEY]",
  },
  {
    flag: "fenced_private_code",
    re: /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g,
    with: "[CODE_BLOCK]",
  },
  {
    flag: "memory_citation_block",
    re: /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g,
    with: "[MEMORY_CITATION]",
  },
  {
    flag: "openrouter_key",
    re: /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g,
    with: "[OPENROUTER_KEY]",
  },
  { flag: "openai_key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, with: "[API_KEY]" },
  {
    flag: "github_token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    with: "[GITHUB_TOKEN]",
  },
  {
    flag: "github_pat",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    with: "[GITHUB_TOKEN]",
  },
  { flag: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g, with: "[AWS_KEY]" },
  {
    flag: "slack_token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    with: "[SLACK_TOKEN]",
  },
  {
    flag: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    with: "[JWT]",
  },
  {
    flag: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    with: "Bearer [TOKEN]",
  },
  {
    flag: "key_assignment",
    re:
      /\b(?:OPENROUTER_API_KEY|TYPESAFE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|API_KEY|APIKEY|SECRET|PASSWORD|PASSWD)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
    with: "[SECRET]",
  },
  {
    flag: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    with: "[EMAIL]",
  },
  {
    flag: "internal_artifact_path",
    re: /\b(?:rollout_summaries|handoffs)\/[\w./-]+\.md(?::\d+(?:-\d+)?)?/g,
    with: "[INTERNAL_DOC]",
  },
  {
    flag: "internal_session_id",
    re:
      /\b[A-Za-z]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    with: "[ID]",
  },
  {
    flag: "turn_id",
    re: /\bturn[0-9a-f][0-9a-f-]{12,}\b/gi,
    with: "[TURN_ID]",
  },
  {
    flag: "phone",
    re: /(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g,
    with: "[PHONE]",
  },
  // URLs and hosts become placeholders: the link role is kept, the address identity is not.
  {
    flag: "url",
    re: /\bhttps?:\/\/[^\s"'`)\]}>]+/gi,
    with: "[URL]",
  },
  {
    flag: "hostname",
    re:
      /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|fi|sh|co|app|dev|cloud|me|xyz)\b/gi,
    with: "[HOST]",
  },
  {
    flag: "ssh_fingerprint",
    re: /\bSHA256:[A-Za-z0-9+/=]{40,}=?/g,
    with: "SHA256:[SSH_FINGERPRINT]",
  },
  // Private paths, repos, worktrees and host/user names.
  {
    flag: "home_path",
    re: /(?:\/home|\/Users)\/[A-Za-z0-9._-]+\//g,
    with: "~/",
  },
  {
    flag: "repo_path",
    re: /(?:~\/)?(?:repos|src|code)\/[\w.-]+\/[\w.-]+/g,
    with: "[REPO]",
  },
  {
    flag: "git_remote",
    re: /\bgit@[\w.-]+:[\w.-]+\/[\w.-]+(?:\.git)?\b/g,
    with: "[REPO]",
  },
  { flag: "worktree", re: /\.codex-worktrees\/[\w.-]+/g, with: "[WORKTREE]" },
  {
    flag: "host_home_dir",
    re: /~\/\.codex\/[\w./-]*/g,
    with: "~/.codex/[PRIVATE]/",
  },
  { flag: "rollout_file", re: /\brollout-[\w.:-]+/g, with: "[ROLLOUT]" },
  {
    flag: "case_ref",
    re: /\b(?:blind|group|public|review|case)[-_]\d{2,}\b/g,
    with: "[CASE]",
  },
  { flag: "long_hash", re: /\b[0-9a-f]{32,}\b/g, with: "[HASH]" },
  { flag: "short_sha", re: /`[0-9a-f]{7,39}`/g, with: "`[COMMIT]`" },
  { flag: "pid", re: /\bPID\s*\**\s*\d{4,}\**/g, with: "PID [PID]" },
  {
    flag: "branch_hash",
    re: /\b[a-z][\w-]*\/[\w-]+(?:-[\w-]+)*-g[0-9a-f]{6,}\b/g,
    with: "[BRANCH]",
  },
  {
    flag: "worktree_slug",
    re: /\b[a-z0-9]+(?:-[a-z0-9]+){3,}-g[0-9a-f]{6,}\b/g,
    with: "[WORKTREE]",
  },
  {
    flag: "private_repo_slug",
    re: /\b[a-z0-9]+(?:-[a-z0-9]+)*-(?:private|internal)\b/g,
    with: "[PRIVATE_REPO]",
  },
  {
    flag: "glued_account_handle",
    re: /\b([A-Za-z]+)0x([0-9a-fA-F]{4,})\b/g,
    with: "$1 [ACCOUNT]",
  },
  { flag: "account_handle", re: /\b0x[0-9a-fA-F]{4,}\b/g, with: "[ACCOUNT]" },
  {
    flag: "host_username",
    re: /(\bUsername:\**\s*`?)[\w.-]+(`?)/gi,
    with: "$1[HOST_USER]$2",
  },
  { flag: "hash_issue", re: /#\d{2,}\b/g, with: "[ISSUE]" },
  {
    flag: "issue_ref",
    re: /\b(?:PR|pull request|issue|#)\s*#?\d{2,}\b/gi,
    with: "[ISSUE]",
  },
  {
    flag: "deployment_id",
    re: /\b(?:vps|mac|dev|prod|staging|release)[-_][0-9a-f]{6,}\b/gi,
    with: "[DEPLOY]",
  },
  {
    flag: "auth_file",
    re: /\b(?:auth\.json|credentials\.json|id_rsa|\.keys?\b)/g,
    with: "[CREDENTIAL_FILE]",
  },
];

// Residual patterns that mean the replacement was incomplete; such text is quarantined, never sent.
const RESIDUAL: Rule[] = [
  {
    flag: "residual_private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    with: "",
  },
  {
    flag: "residual_openrouter_key",
    re: /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/,
    with: "",
  },
  { flag: "residual_api_key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/, with: "" },
  {
    flag: "residual_github_token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
    with: "",
  },
  { flag: "residual_aws_key", re: /\bAKIA[0-9A-Z]{16}\b/, with: "" },
  {
    flag: "residual_home_path",
    re: /(?:\/home|\/Users)\/[A-Za-z0-9._-]+\//,
    with: "",
  },
  {
    flag: "residual_repo_path",
    re: /(?:~\/)?repos\/[\w.-]+\/[\w.-]+/,
    with: "",
  },
  { flag: "residual_worktree", re: /\.codex-worktrees\/[\w.-]+/, with: "" },
  { flag: "residual_url", re: /https?:\/\//i, with: "" },
  {
    flag: "residual_hostname",
    re:
      /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|fi|sh|co|app|dev|cloud|me|xyz)\b/i,
    with: "",
  },
  {
    flag: "residual_ssh_fingerprint",
    re: /SHA256:[A-Za-z0-9+/=]{20,}/,
    with: "",
  },
  { flag: "residual_long_hash", re: /\b[0-9a-f]{32,}\b/, with: "" },
  {
    flag: "residual_prefixed_id",
    re:
      /\b[A-Za-z]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
    with: "",
  },
  { flag: "residual_turn_id", re: /\bturn[0-9a-f][0-9a-f-]{12,}\b/i, with: "" },
  { flag: "residual_pid", re: /\bPID\s*\**\s*\d{4,}\**/, with: "" },
  {
    flag: "residual_worktree_slug",
    re: /\b[a-z0-9]+(?:-[a-z0-9]+){3,}-g[0-9a-f]{6,}\b/,
    with: "",
  },
  {
    flag: "residual_private_repo_slug",
    re: /\b[a-z0-9]+(?:-[a-z0-9]+)*-(?:private|internal)\b/,
    with: "",
  },
  { flag: "residual_account", re: /\b0x[0-9a-fA-F]{4,}\b/, with: "" },
  {
    flag: "residual_glued_account",
    re: /\b[A-Za-z]+0x[0-9a-fA-F]{4,}\b/,
    with: "",
  },
  {
    flag: "residual_internal_doc",
    re: /\b(?:rollout_summaries|handoffs)\/[\w./-]+\.md/,
    with: "",
  },
  { flag: "residual_hash_issue", re: /#\d{2,}\b/, with: "" },
];

export function scrubText(input: string): ScrubResult {
  let text = input;
  const flags: string[] = [];
  let replacements = 0;
  for (const rule of RULES) {
    const matches = text.match(rule.re);
    if (!matches || matches.length === 0) continue;
    flags.push(rule.flag);
    replacements += matches.length;
    text = text.replace(rule.re, rule.with);
  }
  const residual: string[] = [];
  for (const rule of RESIDUAL) {
    if (rule.re.test(text)) residual.push(rule.flag);
  }
  if (residual.length > 0) {
    return {
      ok: false,
      text: "",
      flags: [...flags, ...residual],
      replacements,
    };
  }
  // Key material quarantines the pair even after redaction: a transcript that carried a private key
  // is not sent to a provider or a judge in any form.
  if (flags.includes("private_key_block")) {
    return { ok: false, text: "", flags, replacements };
  }
  return { ok: true, text, flags, replacements };
}

export interface ScrubPair {
  ok: boolean;
  request: string;
  final: string;
  flags: string[];
}

/** Scrub both halves; either half failing closes the pair. */
export function scrubPair(request: string, final: string): ScrubPair {
  const a = scrubText(request);
  const b = scrubText(final);
  const ok = a.ok && b.ok;
  return {
    ok,
    request: ok ? a.text : "",
    final: ok ? b.text : "",
    flags: [...new Set([...a.flags, ...b.flags])],
  };
}

/** A case may enter a reviewer/provider queue only when its scrubbed text still reads as a pair. */
export function queueSafe(
  request: string,
  final: string,
): {
  ok: boolean;
  request: string;
  final: string;
  flags: string[];
  reason?: string;
} {
  const scrub = scrubPair(request, final);
  if (!scrub.ok) {
    return {
      ok: false,
      request: "",
      final: "",
      flags: scrub.flags,
      reason: `scrub_failed:${scrub.flags.join("+")}`,
    };
  }
  // Semantic-completeness guards: a pair whose meaning was destroyed by placeholder substitution is
  // dropped rather than rewritten. Placeholder-only text carries no judgeable statement.
  const words = (s: string) =>
    s.replace(/\[[A-Z_]+\]/g, " ").split(/\s+/).filter((w) => w.length > 2)
      .length;
  if (words(scrub.request) < 4 || words(scrub.final) < 12) {
    return {
      ok: false,
      request: "",
      final: "",
      flags: scrub.flags,
      reason: "semantics_lost_after_scrub",
    };
  }
  return {
    ok: true,
    request: scrub.request,
    final: scrub.final,
    flags: scrub.flags,
  };
}
