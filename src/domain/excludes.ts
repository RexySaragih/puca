/**
 * Hard excludes — non-overridable even when git or --mutate hits them.
 * See HARD_EXCLUDE_GLOBS for the exact micromatch-style patterns.
 */
export const HARD_EXCLUDE_GLOBS = [
  "**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/*.d.ts",
  "**/node_modules/**",
  "**/dist/**",
] as const;

export function isHardExcluded(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (hasPathSegment(normalized, "node_modules")) {
    return true;
  }
  if (hasPathSegment(normalized, "dist")) {
    return true;
  }
  if (normalized.endsWith(".d.ts")) {
    return true;
  }

  const baseName = fileName(normalized);
  if (baseName.startsWith("vitest.config.")) {
    return true;
  }
  if (baseName.startsWith("vite.config.")) {
    return true;
  }
  if (baseName.startsWith("jest.config.")) {
    return true;
  }
  if (/\.(test|spec)\.([cm]?[jt]sx?)$/.test(baseName)) {
    return true;
  }
  return false;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function fileName(normalizedRelative: string): string {
  const slash = normalizedRelative.lastIndexOf("/");
  return slash === -1
    ? normalizedRelative
    : normalizedRelative.slice(slash + 1);
}

function hasPathSegment(normalizedRelative: string, segment: string): boolean {
  return (
    normalizedRelative === segment ||
    normalizedRelative.startsWith(`${segment}/`) ||
    normalizedRelative.includes(`/${segment}/`)
  );
}
