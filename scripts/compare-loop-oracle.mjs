#!/usr/bin/env node
/**
 * Compare a mutation-testing-report JSON file to fixtures/loop/oracle.statuses.json
 * using the same sort keys as test/e2e.loopFixture.test.ts.
 *
 * Usage: node scripts/compare-loop-oracle.mjs <report.json> <exitCode> [oracle.json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const reportPath = process.argv[2];
const exitCode = Number(process.argv[3]);
const oraclePath =
  process.argv[4] ??
  path.resolve(here, "../fixtures/loop/oracle.statuses.json");

if (reportPath == null || Number.isNaN(exitCode)) {
  console.error(
    "usage: node scripts/compare-loop-oracle.mjs <report.json> <exitCode> [oracle.json]",
  );
  process.exit(2);
}

const oracle = JSON.parse(fs.readFileSync(oraclePath, "utf8"));
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

if (exitCode !== oracle.exitCode) {
  console.error(`exit ${String(exitCode)} != oracle ${String(oracle.exitCode)}`);
  process.exit(1);
}

function sortStatuses(statuses) {
  return [...statuses].sort((a, b) => {
    const keyA = `${a.file}|${a.mutatorName}|${a.original}|${a.replacement}`;
    const keyB = `${b.file}|${b.mutatorName}|${b.original}|${b.replacement}`;
    return keyA.localeCompare(keyB);
  });
}

function guessOriginal(file, replacement) {
  if (file.endsWith("calc.ts") && replacement === "-") {
    return "+";
  }
  if (file.endsWith("calc.ts") && replacement === "+") {
    return "-";
  }
  if (
    file.endsWith("hang.ts") &&
    (replacement === "true" || replacement === "false")
  ) {
    return "enabled";
  }
  if (file.endsWith("uncovered.ts") && replacement === "/") {
    return "*";
  }
  return "?";
}

const actual = [];
for (const [file, entry] of Object.entries(report.files)) {
  for (const mutant of entry.mutants) {
    actual.push({
      file,
      mutatorName: mutant.mutatorName,
      original: guessOriginal(file, mutant.replacement),
      replacement: mutant.replacement,
      status: mutant.status,
      ...(mutant.killedBy?.[0] ? { killedBy: mutant.killedBy[0] } : {}),
    });
  }
}

const left = JSON.stringify(sortStatuses(actual));
const right = JSON.stringify(sortStatuses(oracle.statuses));
if (left !== right) {
  console.error("oracle mismatch");
  console.error(left);
  console.error(right);
  process.exit(1);
}
console.log("oracle match ok");
