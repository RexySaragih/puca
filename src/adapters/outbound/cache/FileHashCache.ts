import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CachedMutantStatus,
  CacheKeyInput,
  CachePort,
} from "../../../application/ports/outbound/CachePort.js";
import type { MutantStatus } from "../../../domain/mutant.js";

/** Bump when on-disk entry/document shape is incompatible. */
export const CACHE_SCHEMA_VERSION = 1;
/** Bump when key formula or scoring semantics change (wipes prior hits). */
export const CACHE_ENGINE_VERSION = "3";

const CACHEABLE_STATUSES: ReadonlySet<MutantStatus> = new Set([
  "Killed",
  "Survived",
  "NoCoverage",
]);

const CACHE_DIR_NAME = ".puca";
const CACHE_FILE_NAME = "cache.json";

const VALID_STATUSES: ReadonlySet<MutantStatus> = new Set([
  "Killed",
  "Survived",
  "Timeout",
  "NoCoverage",
  "RuntimeError",
]);

interface CacheDocument {
  readonly schemaVersion: number;
  readonly engineVersion: string;
  readonly entries: Record<string, CachedMutantStatus>;
}

/**
 * Metadata-only mutant status cache under `{cwd}/.puca/cache.json` (ADR-035).
 * Never persists mutated source. Corrupt / mutatedSource → fail-open empty.
 */
export class FileHashCache implements CachePort {
  private entries = new Map<string, CachedMutantStatus>();
  private readonly cachePath: string;

  constructor(private readonly cwd: string) {
    this.cachePath = path.join(cwd, CACHE_DIR_NAME, CACHE_FILE_NAME);
  }

  keyFor(input: CacheKeyInput): string {
    const composite = [
      CACHE_ENGINE_VERSION,
      input.file,
      String(input.startOffset),
      String(input.endOffset),
      input.mutatorName,
      input.replacement,
      input.sourceContents,
      input.relatedContents,
    ].join("\0");
    return createHash("sha256").update(composite, "utf8").digest("hex");
  }

  get(key: string): CachedMutantStatus | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CachedMutantStatus): void {
    if (!CACHEABLE_STATUSES.has(entry.status)) {
      return;
    }
    this.entries.set(key, {
      status: entry.status,
      ...(entry.killedBy != null ? { killedBy: entry.killedBy } : {}),
      schemaVersion: CACHE_SCHEMA_VERSION,
    });
  }

  async load(): Promise<void> {
    this.entries = new Map();
    let raw: string;
    try {
      raw = await fs.readFile(this.cachePath, "utf8");
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    if (!isPlainObject(parsed)) {
      return;
    }
    if (documentHasMutatedSource(parsed)) {
      return;
    }
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.engineVersion !== CACHE_ENGINE_VERSION
    ) {
      return;
    }
    if (!isPlainObject(parsed.entries)) {
      return;
    }

    // R4-M4: skip invalid entries; only document-level corruption wipes all.
    const loaded = new Map<string, CachedMutantStatus>();
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!isPlainObject(value)) {
        continue;
      }
      if ("mutatedSource" in value) {
        continue;
      }
      if (
        value.schemaVersion !== CACHE_SCHEMA_VERSION ||
        !isMutantStatus(value.status) ||
        !CACHEABLE_STATUSES.has(value.status)
      ) {
        continue;
      }
      const killedBy =
        typeof value.killedBy === "string" ? value.killedBy : undefined;
      loaded.set(key, {
        status: value.status,
        ...(killedBy != null ? { killedBy } : {}),
        schemaVersion: CACHE_SCHEMA_VERSION,
      });
    }
    this.entries = loaded;
  }

  async flush(): Promise<void> {
    const document: CacheDocument = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      engineVersion: CACHE_ENGINE_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(
      this.cachePath,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMutantStatus(value: unknown): value is MutantStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as MutantStatus);
}

/** Walk document for forbidden mutated source payloads (fail-open wipe). */
function documentHasMutatedSource(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(documentHasMutatedSource);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if ("mutatedSource" in value) {
    return true;
  }
  return Object.values(value).some(documentHasMutatedSource);
}
