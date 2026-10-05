// Thin bridge to the installed SDK 0.7.0 through the documented `uv run python -c` pattern that
// jev/score-rubric.py already uses. Fixed argv, JSON on stdin/stdout, no shell, no new flags, and
// no interpolation of case text into the argv: transcript content can never become a command.
//
// Provider errors abort the batch (non-zero exit, no partial result object): the caller records a
// failed run rather than a fabricated metric. A missing key is reported as `no-key`, not as data.
//
// Cache policy: no JEV_CACHE override by default, so the SDK's own default directory and its
// already-bought entries are reused; unit tests pass an isolated temporary cacheDir.

export interface BatchCase {
  id: string;
  user_request: string;
  assistant_final: string;
}

export interface CaseResult {
  id: string;
  choice: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  replayed: boolean;
  ms: number;
}

export interface BatchMetrics {
  dir: string;
  hits: number;
  misses: number;
  inputTokensBought: number | null;
  inputTokensReplayed: number | null;
}

export interface BatchResult {
  status: "ok" | "no-key";
  results: CaseResult[];
  metrics: BatchMetrics | null;
  /** sha256 of the exact SDK wire form (post-adapter) actually sent for this batch. */
  wireSha256: string;
  /** Question ids whose legacy string instructions were wrapped into `{task: ...}`. */
  adapterApplied: string[];
  elapsedMs: number;
}

export class ProviderError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`provider error: ${detail}`);
    this.name = "ProviderError";
    this.detail = detail;
  }
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BatchSpawn = (
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  stdin: string,
) => Promise<SpawnResult>;

export const PYTHON_RUNNER = String.raw`
import json, sys, time, hashlib
from jev_sandbox import route
route.apply()
from jev_sandbox import wire as jev_wire
from jev_sandbox.client import MissingAPIKey, build_client
from jev_sandbox import experiment

payload = json.loads(sys.stdin.read())
try:
    questions = payload["questions"]
    wire_form = jev_wire.questions_from_json(questions)
    wire_list = [jev_wire.question_to_json(qid, q) for qid, q in wire_form.items()]
    wire_sha = hashlib.sha256(json.dumps(wire_list, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
except Exception as exc:
    print(json.dumps({"status": "wire-error", "error": type(exc).__name__, "message": str(exc)[:400]}))
    sys.exit(4)
try:
    client = build_client()
except MissingAPIKey as exc:
    print(json.dumps({"status": "no-key", "message": str(exc)[:300]}))
    sys.exit(0)
store = getattr(client, "store", None)
out = []
for case in payload["cases"]:
    started = time.time()
    try:
        exp = experiment.run_json(
            {"user_request": case["user_request"][:900], "assistant_final": case["assistant_final"][:1200]},
            questions,
            client=client,
        )
    except Exception as exc:
        print(json.dumps({"status": "provider-error", "case_id": case["id"], "error": type(exc).__name__, "message": str(exc)[:400]}))
        sys.exit(3)
    answer = None
    for bucket in (getattr(exp, "choices", None) or {}, getattr(exp, "nouls", None) or {}):
        if "work" in bucket:
            answer = bucket["work"]
            break
    out.append({
        "id": case["id"],
        "choice": getattr(answer, "choice", None),
        "confidence": getattr(answer, "confidence", None),
        "probabilities": getattr(answer, "probabilities", None),
        "replayed": bool((exp.cache or {}).get("replayed")),
        "ms": round((time.time() - started) * 1000),
    })
metrics = None
if store is not None:
    metrics = {
        "dir": str(store.directory),
        "hits": store.hits,
        "misses": store.misses,
        "input_tokens_bought": store.input_tokens_bought,
        "input_tokens_replayed": store.input_tokens_replayed,
    }
print(json.dumps({"status": "ok", "results": out, "metrics": metrics, "wire_sha256": wire_sha}))
`;

/**
 * Minimal SDK 0.7 legacy-instructions adapter. Persisted question revisions before 0c9d4ca carry
 * `instructions` as a bare string, which the SDK rejects with `BadRequest: instructions must be an
 * object`. The adapter wraps only string instructions into `{task: <original string>}` and leaves
 * object instructions byte-identical, preserving the exact question/criteria text and primitive id.
 * The same adapter function is applied to every arm; `adapter_applied` records where it changed a
 * shape, and both the raw file hash and the normalized wire hash are recorded by the caller.
 */
export function adaptLegacyInstructions(
  questions: unknown,
): { questions: unknown; adapterApplied: string[] } {
  const clone = JSON.parse(JSON.stringify(questions)) as Record<
    string,
    unknown
  >;
  const applied: string[] = [];
  for (const [qid, question] of Object.entries(clone)) {
    if (!question || typeof question !== "object") continue;
    const record = question as Record<string, unknown>;
    if (typeof record.instructions === "string") {
      record.instructions = { task: record.instructions };
      applied.push(qid);
    }
  }
  return { questions: clone, adapterApplied: applied };
}

/** The only argv this bridge ever builds: a constant program plus the fixed runner source. */
export function fixedPythonArgv(): string[] {
  return ["uv", "run", "python", "-c", PYTHON_RUNNER];
}

async function defaultSpawn(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  stdin: string,
): Promise<SpawnResult> {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

export interface RunBatchOptions {
  cwd: string;
  /** Isolated cache for unit tests; unset means the SDK default (trusted shared cache). */
  cacheDir?: string;
  spawn?: BatchSpawn;
  timeoutMs?: number;
}

/** Minimal env: HOME/PATH plus the documented key/cache names only, and never logged. */
export function childEnv(cacheDir?: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: Deno.env.get("HOME") ?? "",
    PATH: Deno.env.get("PATH") ?? "",
  };
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (key) env.OPENROUTER_API_KEY = key;
  if (cacheDir) env.JEV_CACHE = cacheDir;
  else {
    const inherited = Deno.env.get("JEV_CACHE");
    if (inherited) env.JEV_CACHE = inherited;
  }
  return env;
}

export function estimateCostUsd(
  inputTokensBought: number | null,
  pricePerMInputTokens: number,
): number | null {
  if (inputTokensBought === null) return null;
  return Number(
    ((inputTokensBought * pricePerMInputTokens) / 1_000_000).toFixed(8),
  );
}

export async function runBatch(
  questions: unknown,
  cases: BatchCase[],
  opts: RunBatchOptions,
): Promise<BatchResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const started = Date.now();
  const adapted = adaptLegacyInstructions(questions);
  const stdin = JSON.stringify({ questions: adapted.questions, cases });
  const result = await spawn(
    fixedPythonArgv(),
    opts.cwd,
    childEnv(opts.cacheDir),
    stdin,
  );
  if (result.code === 4) {
    throw new WireError(
      result.stderr.trim().slice(-400) || "wire compile failed",
    );
  }
  if (result.code !== 0) {
    throw new ProviderError(
      result.stderr.trim().slice(-400) || `exit ${result.code}`,
    );
  }
  const lines = result.stdout.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(last) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`unparseable bridge output: ${last.slice(0, 200)}`);
  }
  if (parsed.status === "wire-error") {
    throw new WireError(JSON.stringify(parsed).slice(0, 400));
  }
  if (parsed.status === "provider-error") {
    throw new ProviderError(JSON.stringify(parsed).slice(0, 400));
  }
  if (parsed.status === "no-key") {
    return {
      status: "no-key",
      results: [],
      metrics: null,
      wireSha256: String(parsed.wire_sha256 ?? ""),
      adapterApplied: adapted.adapterApplied,
      elapsedMs: Date.now() - started,
    };
  }
  if (parsed.status !== "ok") {
    throw new ProviderError(
      `unexpected bridge status: ${String(parsed.status)}`,
    );
  }
  const rawMetrics = (parsed.metrics ?? null) as Record<string, unknown> | null;
  if (rawMetrics === null) {
    // A disabled or missing cache is not a zero-cost run; it is an unverifiable one.
    throw new CacheUnavailable(
      "bridge reported no cache store: cost/replay cannot be verified",
    );
  }
  const metrics: BatchMetrics = {
    dir: String(rawMetrics.dir),
    hits: Number(rawMetrics.hits ?? 0),
    misses: Number(rawMetrics.misses ?? 0),
    inputTokensBought: rawMetrics.input_tokens_bought === null
      ? null
      : Number(rawMetrics.input_tokens_bought ?? 0),
    inputTokensReplayed: rawMetrics.input_tokens_replayed === null
      ? null
      : Number(rawMetrics.input_tokens_replayed ?? 0),
  };
  const results = (parsed.results as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    choice: row.choice === null ? null : String(row.choice),
    confidence: row.confidence === null ? null : Number(row.confidence),
    probabilities: (row.probabilities ?? null) as Record<string, number> | null,
    replayed: Boolean(row.replayed),
    ms: Number(row.ms ?? 0),
  }));
  return {
    status: "ok",
    results,
    metrics,
    wireSha256: String(parsed.wire_sha256 ?? ""),
    adapterApplied: adapted.adapterApplied,
    elapsedMs: Date.now() - started,
  };
}

export class WireError extends Error {
  constructor(detail: string) {
    super(`wire error: ${detail}`);
    this.name = "WireError";
  }
}

export class CacheUnavailable extends Error {
  constructor(detail: string) {
    super(`cache unavailable: ${detail}`);
    this.name = "CacheUnavailable";
  }
}

export function keyPresent(): boolean {
  return Boolean(Deno.env.get("OPENROUTER_API_KEY"));
}
