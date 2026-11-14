import { describe, expect, it } from "vitest";
import { compute } from "../src/m14.js";

const SCORE_DELAY_MS = 350;

describe("m14", () => {
  it("computes", async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SCORE_DELAY_MS);
    });
    expect(compute(2, 3)).toBe(5);
  });
});
