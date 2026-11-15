import fs from "node:fs";

/** Sync UTF-8 source cache for report adapters (best-effort; miss → undefined). */
export class SourceTextCache {
  private readonly cache = new Map<string, string | undefined>();

  get(filePath: string): string | undefined {
    if (this.cache.has(filePath)) {
      return this.cache.get(filePath);
    }
    let text: string | undefined;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      text = undefined;
    }
    this.cache.set(filePath, text);
    return text;
  }
}
