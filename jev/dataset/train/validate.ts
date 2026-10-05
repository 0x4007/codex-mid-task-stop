// Read-only validator for the proxy-labelled training split.
// Run: deno run --allow-read jev/dataset/train/validate.ts
const HERE = new URL(".", import.meta.url).pathname;
const CASES = `${HERE}cases.jsonl`;
const STATS = `${HERE}stats.json`;
const LABELS = ["authorized_unfinished", "finished"];
const AUTHORITIES = ["proxy_source_label", "owner_feedback"];
const SOURCES = ["corpus.jsonl", "triggers.jsonl", "feedback-corpus.jsonl"];
const RULES: Array<[string, RegExp]> = [
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["abs_path", /(?:\/Users\/|\/home\/[a-z]+\/|\/root\/)/g],
  ["secret", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-)/g],
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
];
const errors: string[] = [];
const findings: Array<{ id: string; rule: string }> = [];
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const sha = async (t: string) => {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const rows = Deno.readTextFileSync(CASES).split("\n").filter((l) => l.trim().length > 0);
const seenIds = new Set<string>();
const seenKeys = new Set<string>();
let n = 0;
for (const line of rows) {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line) as Record<string, unknown>;
  } catch {
    errors.push("json");
    continue;
  }
  n++;
  const id = String(r.id ?? "");
  if (!/^train-\d{4}$/.test(id)) errors.push(`id:${id}`);
  if (seenIds.has(id)) errors.push(`dup-id:${id}`);
  seenIds.add(id);
  if (!LABELS.includes(String(r.label))) errors.push(`label:${id}`);
  if (!AUTHORITIES.includes(String(r.label_authority))) errors.push(`authority:${id}`);
  if (!SOURCES.includes(String(r.source))) errors.push(`source:${id}`);
  if (r.split !== "train") errors.push(`split:${id}`);
  const req = String(r.user_request ?? "");
  const fin = String(r.assistant_final ?? "");
  if (req.length < 40 || req.length > 900) errors.push(`req-window:${id}`);
  if (fin.length < 40 || fin.length > 1200) errors.push(`fin-window:${id}`);
  for (const [rule, re] of RULES) {
    re.lastIndex = 0;
    if (re.test(req) || re.test(fin)) findings.push({ id, rule });
  }
  const key = await sha(norm(req) + "\u0000" + norm(fin));
  if (seenKeys.has(key)) errors.push(`dup-pair:${id}`);
  seenKeys.add(key);
}
const stats = JSON.parse(Deno.readTextFileSync(STATS)) as { record_count?: number };
if (stats.record_count !== n) errors.push(`stats-count:${stats.record_count}!=${n}`);
console.log(JSON.stringify({ ok: errors.length === 0 && findings.length === 0, records: n, errors, privacy_findings: findings }, null, 2));
if (errors.length || findings.length) Deno.exit(1);
