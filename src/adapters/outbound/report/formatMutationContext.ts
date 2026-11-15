import type { Site } from "../../../domain/mutant.js";

const MAX_LINE_CHARS = 120;

export interface MutationLineDiff {
  /** Source line with the original token (trimmed / length-capped). */
  readonly before: string;
  /** Same line with replacement spliced in. */
  readonly after: string;
}

/**
 * Build a human-readable before/after line for a mutation site.
 * Falls back to raw original/replacement tokens when source is missing
 * or offsets are out of range.
 */
export function formatMutationLineDiff(
  source: string | undefined,
  site: Pick<Site, "startOffset" | "endOffset" | "original" | "replacement">,
): MutationLineDiff {
  if (source == null || source.length === 0) {
    return tokenFallback(site);
  }
  if (
    site.startOffset < 0 ||
    site.endOffset < site.startOffset ||
    site.endOffset > source.length
  ) {
    return tokenFallback(site);
  }

  const lineStart = source.lastIndexOf("\n", Math.max(0, site.startOffset - 1)) + 1;
  let lineEnd = source.indexOf("\n", site.startOffset);
  if (lineEnd < 0) {
    lineEnd = source.length;
  }

  const line = source.slice(lineStart, lineEnd);
  const localStart = site.startOffset - lineStart;
  const localEnd = site.endOffset - lineStart;
  if (localStart < 0 || localEnd > line.length) {
    return tokenFallback(site);
  }

  const before = shrinkAround(line, localStart, localEnd);
  const afterLine =
    line.slice(0, localStart) + site.replacement + line.slice(localEnd);
  const afterLocalEnd = localStart + site.replacement.length;
  const after = shrinkAround(afterLine, localStart, afterLocalEnd);

  return { before, after };
}

function tokenFallback(
  site: Pick<Site, "original" | "replacement">,
): MutationLineDiff {
  return {
    before: capLine(collapseWhitespace(site.original)),
    after: capLine(collapseWhitespace(site.replacement)),
  };
}

function capLine(text: string): string {
  if (text.length <= MAX_LINE_CHARS) {
    return text;
  }
  const slice = text.slice(0, MAX_LINE_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  const cut =
    lastSpace >= Math.floor(MAX_LINE_CHARS / 2) ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

/** Keep the mutated span visible when the line is long. */
function shrinkAround(line: string, start: number, end: number): string {
  const collapsed = line.replace(/\t/g, "  ");
  if (collapsed.length <= MAX_LINE_CHARS) {
    return collapsed.trimEnd();
  }

  const markStart = Math.max(0, start - 24);
  const markEnd = Math.min(collapsed.length, end + 24);
  let slice = collapsed.slice(markStart, markEnd).trim();
  if (markStart > 0) {
    slice = `…${slice}`;
  }
  if (markEnd < collapsed.length) {
    slice = `${slice}…`;
  }
  return slice;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
