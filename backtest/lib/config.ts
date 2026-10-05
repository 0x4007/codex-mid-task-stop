// Fixed sandbox configuration. Zero-argument entry scripts read these defaults and may merge a
// private JSON override at PRIVATE_CONFIG; nothing here reads a credential value.
//
// New env names, CLI flags, or secrets are deliberately absent: the only env inputs are the ones
// the installed tooling already documents (HOME/PATH, OPENROUTER_API_KEY, JEV_CACHE).

export interface BacktestConfig {
  version: number;
  /** Fixed snapshot cutoff: transcripts/turns after this instant are never ingested. */
  cutoffUtc: string;
  sessionsRoot: string;
  archivedRoot: string;
  historyDb: string;
  /** Read-only private mirror of the original repository (git --git-dir reads only). */
  mirrorGitDir: string;
  /** Installed jev-sandbox checkout; the only Python bridge used. */
  jevSandbox: string;
  dataset: string;
  privateDir: string;
  /** Original question revisions: automatic, pre-teaching, current hand-refined. */
  questionCommits: { auto: string; pre: string; cur: string };
  questionSha16: { auto: string; pre: string; cur: string };
  windows: { request: number; final: number };
  model: string;
  /** Caller-side resume floor and the dev-only threshold grid. */
  floor: number;
  floorGrid: number[];
  limits: {
    maxTrials: number;
    maxLogicalRequests: number;
    costCeilingUsd: number;
    pricePerMInputTokens: number;
  };
  /** Minimum usable pair lengths; shorter pairs are quarantined, not trimmed. */
  minRequestChars: number;
  minFinalChars: number;
  /** Cases reserved for repeat blind annotation. */
  blindQueueSize: number;
  /** Public dev row that overlaps the original18 recorded-feedback set; never tuned on. */
  devAnchorOverlapId: string;
  /** Independent-review reliability gate for the blind annotation cache. */
  judge: {
    reviewers: number;
    minAgreement: number;
    minPerReviewer: number;
    /** Reviewer carrier profile; host-specific values live in the private override. */
    acceptedHeader: string;
    acceptedSandbox: string;
  };
  /** Version tag for versioned scratch/manifest artifacts (v2 queue, champion state). */
  scratchVersion: number;
}

export const DEFAULTS: BacktestConfig = {
  version: 1,
  cutoffUtc: "2026-10-04T23:40:00Z",
  sessionsRoot: "/home/codex/.codex/sessions",
  archivedRoot: "/home/codex/.codex/archived_sessions",
  historyDb: "/home/codex/.codex/thread_history_1.sqlite",
  mirrorGitDir:
    "/home/codex/.local/state/repo-public-audit-20261004-135605/repository.git",
  jevSandbox: "/home/codex/repos/0x4007/jev-sandbox",
  dataset: "jev/dataset/cases.jsonl",
  privateDir: ".publication-audit/backtesting",
  questionCommits: { auto: "f69158a", pre: "cc9d055", cur: "8317dd1" },
  questionSha16: {
    auto: "8410e773ca00dadd",
    pre: "62dc485442a9917f",
    cur: "e31f047b3ff67757",
  },
  windows: { request: 900, final: 1200 },
  model: "jev-1.13.0",
  floor: 0.56,
  floorGrid: [0.5, 0.53, 0.56, 0.6, 0.65],
  limits: {
    maxTrials: 2,
    maxLogicalRequests: 400,
    costCeilingUsd: 0.05,
    pricePerMInputTokens: 0.042,
  },
  minRequestChars: 8,
  minFinalChars: 40,
  blindQueueSize: 12,
  devAnchorOverlapId: "public-0068",
  judge: {
    reviewers: 2,
    minAgreement: 0.75,
    minPerReviewer: 10,
    acceptedHeader: "Ultra/max",
    acceptedSandbox: "workspace-write/ask",
  },
  /** Version tag for versioned scratch/manifest artifacts (v2 queue, champion state). */
  scratchVersion: 2,
};

export const PRIVATE_CONFIG = `${DEFAULTS.privateDir}/writer-config.json`;

export interface Paths {
  privateDir: string;
  snapshotDir: string;
  rawDir: string;
  questionsDir: string;
  casesDir: string;
  resultsDir: string;
}

export function pathsFor(cfg: BacktestConfig): Paths {
  const p = cfg.privateDir;
  return {
    privateDir: p,
    snapshotDir: `${p}/writer-snapshot`,
    rawDir: `${p}/writer-snapshot/raw`,
    questionsDir: `${p}/writer-questions`,
    casesDir: `${p}/writer-cases`,
    resultsDir: `${p}/writer-results`,
  };
}

export interface LoadedConfig {
  config: BacktestConfig;
  overridden: string[];
}

function mergeKnown(
  base: BacktestConfig,
  override: Record<string, unknown>,
): LoadedConfig {
  const merged = structuredClone(base) as unknown as Record<string, unknown>;
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(override)) {
    if (!(key in merged)) throw new Error(`private config: unknown key ${key}`);
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      typeof merged[key] === "object"
    ) {
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      merged[key] = value;
    }
    overridden.push(key);
  }
  return { config: merged as unknown as BacktestConfig, overridden };
}

/** Fixed defaults plus the optional private override file; unknown keys fail closed. */
export function loadConfig(): LoadedConfig {
  try {
    const raw = Deno.readTextFileSync(PRIVATE_CONFIG);
    return mergeKnown(DEFAULTS, JSON.parse(raw) as Record<string, unknown>);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { config: structuredClone(DEFAULTS), overridden: [] };
    }
    throw error;
  }
}

/** Exact truncated state the hook and the existing scorer send. */
export function stateFor(cfg: BacktestConfig, request: string, final: string) {
  return {
    user_request: request.slice(0, cfg.windows.request),
    assistant_final: final.slice(0, cfg.windows.final),
  };
}
