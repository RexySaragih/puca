import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DiscoverResult,
  MutatorEnginePort,
} from "../../../application/ports/outbound/MutatorEnginePort.js";
import type { AbsolutePath, Site } from "../../../domain/mutant.js";

/**
 * Shape returned by the puca-binding NAPI addon.
 * napi-rs maps Rust snake_case SiteDto fields to camelCase in JS.
 */
export interface SiteDto {
  readonly path: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly mutatorName: string;
  readonly replacement: string;
}

export interface DiscoverOutcomeDto {
  readonly sites: SiteDto[];
  readonly disabledByDirective: number;
  readonly skippedByHeuristic: number;
  readonly warnings: readonly string[];
}

export interface PucaBinding {
  discover(filename: string, source: string): SiteDto[];
  discoverOutcome?(filename: string, source: string): DiscoverOutcomeDto;
  apply(source: string, site: SiteDto): string;
}

/** ABIs packed by GitHub Releases / `package.json` `napi.targets`. */
export const SUPPORTED_ABIS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64-gnu",
  "win32-x64-msvc",
] as const;

export type SupportedAbi = (typeof SUPPORTED_ABIS)[number];

/**
 * Resolve host platform ABI suffix used by `napi build --platform`
 * (e.g. darwin-arm64, linux-x64-gnu). GNU-only linux suffixes this cycle (ADR-022).
 */
export function hostPlatformAbi(): string {
  return platformAbi(process.platform, process.arch);
}

export function platformAbi(platform: string, arch: string): SupportedAbi {
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "darwin-x64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x64-gnu";
  }
  if (platform === "win32" && arch === "x64") {
    return "win32-x64-msvc";
  }
  throw new Error(
    `Unsupported platform for puca-binding: ${platform}-${arch}. ` +
      `Supported ABIs: ${SUPPORTED_ABIS.join(", ")}.`,
  );
}

function packageRootFromThisModule(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src|dist/adapters/outbound/napi → package root
  return path.resolve(here, "../../../..");
}

/**
 * Candidate filesystem paths for the built addon: package root, then crates/
 * (where `napi build --package puca-binding` writes by default).
 */
export function bindingCandidatePaths(
  root: string = packageRootFromThisModule(),
  abi: string = hostPlatformAbi(),
): readonly string[] {
  const fileName = `puca-binding.${abi}.node`;
  return [
    path.join(root, fileName),
    path.join(root, "crates", "puca-binding", fileName),
  ];
}

/** UX-003 — missing or unloadable native addon (CLI maps throw → exit 2). */
export function formatMissingBindingMessage(abi: string): string {
  return (
    `Native Púca addon is missing for '${abi}'. ` +
    `Looked for puca-binding.${abi}.node (package root, crates/puca-binding) ` +
    `and package 'puca-${abi}'. ` +
    `Run npm run build (requires a Rust toolchain) or install the matching GitHub Release pair (puca + puca-${abi}).`
  );
}

function tryRequireBinding(modulePath: string): PucaBinding {
  const requireFromPath = createRequire(modulePath);
  return requireFromPath(modulePath) as PucaBinding;
}

function tryRequireOptionalPackage(root: string, abi: string): PucaBinding {
  const packageJsonPath = path.join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw Object.assign(new Error("ENOENT package.json"), {
      code: "ENOENT",
    });
  }
  const requireFromRoot = createRequire(packageJsonPath);
  return requireFromRoot(`puca-${abi}`) as PucaBinding;
}

/**
 * Load the native addon (ADR-022):
 * 1) package-root `.node`
 * 2) crates/puca-binding `.node`
 * 3) `createRequire(root/package.json)("puca-"+abi)`
 * Miss / dlopen → throw UX-003 (never exit the process from this adapter).
 */
export function loadPucaBinding(
  root: string = packageRootFromThisModule(),
  abi: string = hostPlatformAbi(),
): PucaBinding {
  const candidates = bindingCandidatePaths(root, abi);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      return tryRequireBinding(candidate);
    } catch (error) {
      throw wrapBindingLoadError(abi, error);
    }
  }

  try {
    return tryRequireOptionalPackage(root, abi);
  } catch (error) {
    if (isMissingOptionalPackage(error)) {
      throw new Error(formatMissingBindingMessage(abi));
    }
    throw wrapBindingLoadError(abi, error);
  }
}

function isMissingOptionalPackage(error: unknown): boolean {
  if (error == null || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "MODULE_NOT_FOUND" || code === "ENOENT";
}

function wrapBindingLoadError(abi: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${formatMissingBindingMessage(abi)} ${detail}`);
}

export function siteIdFromDto(dto: SiteDto): string {
  return `${dto.path}:${dto.startOffset}:${dto.mutatorName}:${dto.replacement}`;
}

/**
 * Slice `source` by UTF-8 byte offsets from oxc/puca-core.
 * `String.prototype.slice` is UTF-16 code units — multi-byte chars (e.g. `—`)
 * would shift originals mid-token (`enabled` → `led) {}`).
 */
export function utf8ByteSlice(
  source: string,
  startOffset: number,
  endOffset: number,
): string {
  return Buffer.from(source, "utf8")
    .subarray(startOffset, endOffset)
    .toString("utf8");
}

export function siteFromDto(
  dto: SiteDto,
  file: AbsolutePath,
  source: string,
): Site {
  return {
    id: siteIdFromDto(dto),
    file,
    startOffset: dto.startOffset,
    endOffset: dto.endOffset,
    line: dto.startLine,
    column: dto.startColumn,
    mutatorName: dto.mutatorName,
    original: utf8ByteSlice(source, dto.startOffset, dto.endOffset),
    replacement: dto.replacement,
  };
}

export function siteToDto(site: Site): SiteDto {
  return {
    path: site.file,
    startOffset: site.startOffset,
    endOffset: site.endOffset,
    startLine: site.line,
    startColumn: site.column,
    endLine: site.line,
    endColumn: site.column,
    mutatorName: site.mutatorName,
    replacement: site.replacement,
  };
}

/**
 * Prod MutatorEnginePort: discover/apply via puca-binding NAPI.
 */
export class NapiMutatorEngine implements MutatorEnginePort {
  private readonly binding: PucaBinding;

  constructor(binding: PucaBinding = loadPucaBinding()) {
    this.binding = binding;
  }

  async discover(
    file: AbsolutePath,
    source: string,
  ): Promise<DiscoverResult> {
    if (typeof this.binding.discoverOutcome === "function") {
      const outcome = this.binding.discoverOutcome(file, source);
      return {
        sites: outcome.sites.map((dto) => siteFromDto(dto, file, source)),
        disabledByDirective: outcome.disabledByDirective,
        skippedByHeuristic: outcome.skippedByHeuristic,
        warnings: outcome.warnings ?? [],
      };
    }
    const dtos = this.binding.discover(file, source);
    return {
      sites: dtos.map((dto) => siteFromDto(dto, file, source)),
      disabledByDirective: 0,
      skippedByHeuristic: 0,
      warnings: [],
    };
  }

  async apply(source: string, site: Site): Promise<string> {
    return this.binding.apply(source, siteToDto(site));
  }
}
