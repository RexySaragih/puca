import { describe, expect, it } from "vitest";
import { compute } from "../src/m04.js";

const SCORE_DELAY_MS = 350;

describe("m04", () => {
  it("computes", async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SCORE_DELAY_MS);
    });
    expect(compute(2, 3)).toBe(5);
  });
});
