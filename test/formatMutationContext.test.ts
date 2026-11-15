import { describe, expect, it } from "vitest";
import { formatMutationLineDiff } from "../src/adapters/outbound/report/formatMutationContext.js";

describe("formatMutationLineDiff", () => {
  describe("when source line surrounds an operator", () => {
    it("should show the full expression before and after", () => {
      // Given
      const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
      const start = source.indexOf("+");
      const site = {
        startOffset: start,
        endOffset: start + 1,
        original: "+",
        replacement: "-",
      };

      // When
      const diff = formatMutationLineDiff(source, site);

      // Then
      expect(diff.before).toContain("return a + b");
      expect(diff.after).toContain("return a - b");
    });
  });

  describe("when source is missing", () => {
    it("should fall back to raw tokens", () => {
      expect(
        formatMutationLineDiff(undefined, {
          startOffset: 0,
          endOffset: 1,
          original: "+",
          replacement: "-",
        }),
      ).toEqual({ before: "+", after: "-" });
    });
  });
});
