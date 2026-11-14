import fs from "node:fs";
import path from "node:path";

/**
 * Strip Vite query/hash suffixes (`file.ts?v=…`) before path compare.
 */
export function stripModuleQuery(id: string): string {
  const queryIndex = id.indexOf("?");
  const withoutQuery = queryIndex === -1 ? id : id.slice(0, queryIndex);
  const hashIndex = withoutQuery.indexOf("#");
  return hashIndex === -1 ? withoutQuery : withoutQuery.slice(0, hashIndex);
}

/**
 * Resolve + realpath so `/tmp` vs `/private/tmp` (macOS) and symlinks match
 * Vite module ids used during transform/load.
 */
export function normalizeModulePath(id: string): string {
  const resolved = path.normalize(path.resolve(stripModuleQuery(id)));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      const realDir = fs.realpathSync.native(path.dirname(resolved));
      return path.join(realDir, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/**
 * Look up an active (non-null) overlay buffer for a Vite module id.
 */
export function lookupRamBuffer(
  buffers: Map<string, string | null>,
  id: string,
): string | undefined {
  const normalizedId = normalizeModulePath(id);
  const direct = buffers.get(normalizedId);
  if (direct != null) {
    return direct;
  }

  for (const [key, value] of buffers) {
    if (value == null) {
      continue;
    }
    if (normalizeModulePath(key) === normalizedId) {
      return value;
    }
  }
  return undefined;
}

/**
 * Set the active RAM buffer for one file. Clears any other non-null buffers
 * so at most one path is active (mutant loop invariant).
 */
export function setRamBuffer(
  buffers: Map<string, string | null>,
  file: string,
  source: string | null,
): void {
  const key = normalizeModulePath(file);
  for (const [existingKey, value] of buffers) {
    if (value == null) {
      continue;
    }
    if (normalizeModulePath(existingKey) !== key) {
      buffers.set(existingKey, null);
    }
  }
  buffers.set(key, source);
}

/** Clear the active buffer for a file (null sentinel for Vite invalidate). */
export function clearRamBuffer(
  buffers: Map<string, string | null>,
  file: string,
): void {
  setRamBuffer(buffers, file, null);
}

/**
 * Vite plugin: serve mutant source from an in-memory Map.
 * Never writes to disk. Returns the buffer on load/transform for the active file.
 */
export function pucaRamPlugin(buffers: Map<string, string | null>) {
  return {
    name: "puca-ram",
    enforce: "pre" as const,
    load(id: string): string | undefined {
      return lookupRamBuffer(buffers, id);
    },
    transform(
      _code: string,
      id: string,
    ): { code: string; map: null } | undefined {
      const buffered = lookupRamBuffer(buffers, id);
      if (buffered == null) {
        return undefined;
      }
      return { code: buffered, map: null };
    },
  };
}

export type PucaRamPlugin = ReturnType<typeof pucaRamPlugin>;
