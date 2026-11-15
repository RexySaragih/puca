/**
 * Pure session score + exit composition for opt-in CI gates (ADR-032).
 * Score = Killed / (Killed + Survived) × 100; denom 0 → N/A (A34–A36).
 */

export interface QualityGateCounts {
  readonly killed: number;
  readonly survived: number;
  readonly noCoverage: number;
  readonly hasRuntimeError: boolean;
}

export interface QualityGateOptions {
  readonly breakOnScore?: number;
  readonly failOnNoCoverage?: boolean;
}

export type SessionScore = number | "N/A";

export function computeSessionScore(
  killed: number,
  survived: number,
): SessionScore {
  const denom = killed + survived;
  if (denom === 0) {
    return "N/A";
  }
  return Math.round((100 * killed) / denom);
}

/**
 * Sole scored-session exit authority when composed by RunMutationSessionUseCase.
 * Priority: RuntimeError → 2; Survived≥1 → 1; score &lt; breakOnScore → 1;
 * failOnNoCoverage && NoCoverage≥1 → 1; else 0.
 */
export function evaluateQualityGates(
  counts: QualityGateCounts,
  options: QualityGateOptions = {},
): number {
  if (counts.hasRuntimeError) {
    return 2;
  }
  if (counts.survived >= 1) {
    return 1;
  }

  const score = computeSessionScore(counts.killed, counts.survived);
  if (
    options.breakOnScore != null &&
    typeof score === "number" &&
    score < options.breakOnScore
  ) {
    return 1;
  }

  if (options.failOnNoCoverage === true && counts.noCoverage >= 1) {
    return 1;
  }

  return 0;
}

export function countsFromStatuses(
  statuses: readonly { readonly status: string }[],
): QualityGateCounts {
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  let hasRuntimeError = false;
  for (const entry of statuses) {
    switch (entry.status) {
      case "Killed":
        killed += 1;
        break;
      case "Survived":
        survived += 1;
        break;
      case "NoCoverage":
        noCoverage += 1;
        break;
      case "RuntimeError":
        hasRuntimeError = true;
        break;
      default:
        break;
    }
  }
  return { killed, survived, noCoverage, hasRuntimeError };
}
