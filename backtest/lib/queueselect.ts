// Frozen-queue selection. The newest hash-valid queue wins: v4, then v3, then v2, then v1. A v4
// subset is a new version created after quarantining a case, not a silent drop from its parent. A queue whose map
// binding (and manifest binding when present) does not match the file's own sha256 is treated as
// stale and skipped, so corrected versions are consumed and stale labels can never be joined to them.

import { fileSha256 } from "./panel.ts";

export interface SelectedQueue {
  version: number;
  dir: string;
  queuePath: string;
  mapPath: string;
  queueSha256: string;
  manifestPath: string | null;
  /** Directory the two independent annotation JSONL files are read from for this version. */
  annotationDir: string;
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(Deno.readTextFileSync(path)) as Record<string, unknown>;
}

export function selectQueue(privateDir: string): SelectedQueue {
  const candidates = [
    {
      version: 4,
      dir: `${privateDir}/writer-v4`,
      manifest: `${privateDir}/writer-v4/MANIFEST.json`,
      shaKey: "v4_queue_sha256",
      annotationDir: `${privateDir}/writer-v4`,
    },
    {
      version: 3,
      dir: `${privateDir}/writer-v3`,
      manifest: `${privateDir}/writer-v3/MANIFEST.json`,
      shaKey: "v3_queue_sha256",
      annotationDir: `${privateDir}/writer-v3`,
    },
    {
      version: 2,
      dir: `${privateDir}/writer-v2`,
      manifest: `${privateDir}/writer-v2/MANIFEST.json`,
      shaKey: "v2_queue_sha256",
      annotationDir: `${privateDir}/writer-v2`,
    },
    {
      version: 1,
      dir: `${privateDir}/writer-cases`,
      manifest: null,
      shaKey: "",
      annotationDir: privateDir,
    },
  ];
  for (const candidate of candidates) {
    const queuePath = `${candidate.dir}/blind-queue.json`;
    const mapPath = `${candidate.dir}/blind-queue-map.private.json`;
    if (!exists(queuePath) || !exists(mapPath)) continue;
    const map = readJson(mapPath);
    const queueSha = fileSha256(queuePath);
    if (typeof map.queue_sha256 === "string" && map.queue_sha256 !== queueSha) {
      continue;
    }
    if (candidate.manifest && exists(candidate.manifest)) {
      const manifest = readJson(candidate.manifest);
      const bound = manifest[candidate.shaKey];
      if (typeof bound === "string" && bound !== queueSha) continue;
    }
    return {
      version: candidate.version,
      dir: candidate.dir,
      queuePath,
      mapPath,
      queueSha256: queueSha,
      manifestPath: candidate.manifest,
      annotationDir: candidate.annotationDir,
    };
  }
  throw new Error(`no hash-valid frozen queue under ${privateDir}`);
}
