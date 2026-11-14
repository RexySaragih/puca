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
  readonly disabledCount: number;
}

export interface PucaBinding {
  discover(filename: string, source: string): SiteDto[];
  discoverOutcome?(filename: string, source: string): DiscoverOutcomeDto;
  apply(source: string, site: SiteDto): string;
}

const require = createRequire(import.meta.url);

/**
 * Resolve host platform ABI suffix used by `napi build --platform`
 * (e.g. darwin-arm64, linux-x64-gnu).
 */
export function hostPlatformAbi(): string {
  const { platform, arch } = process;
  if (platform === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "linux-arm64-gnu" : "linux-x64-gnu";
  }
  if (platform === "win32") {
    return arch === "arm64" ? "win32-arm64-msvc" : "win32-x64-msvc";
  }
  throw new Error(`Unsupported platform for puca-binding: ${platform}-${arch}`);
}

function packageRootFromThisModule(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src|dist/adapters/outbound/napi → package root
  return path.resolve(here, "../../../..");
}

/**
 * Candidate paths for the built addon: package root, then crates/puca-binding
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

/**
 * Load the native addon. Missing `.node` → clear Error (CLI later maps to exit 2).
 */
export function loadPucaBinding(
  root: string = packageRootFromThisModule(),
): PucaBinding {
  const candidates = bindingCandidatePaths(root);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `Native Púca addon (.node) is missing after clone or install. Looked for: ${candidates.join(", ")}. Run npm run build (requires a Rust toolchain).`,
    );
  }
  return require(found) as PucaBinding;
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
        disabledCount: outcome.disabledCount,
      };
    }
    const dtos = this.binding.discover(file, source);
    return {
      sites: dtos.map((dto) => siteFromDto(dto, file, source)),
      disabledCount: 0,
    };
  }

  async apply(source: string, site: Site): Promise<string> {
    return this.binding.apply(source, siteToDto(site));
  }
}
