import { describe, expect, it } from "vitest";
import { mul } from "../src/mul.js";

describe("mul", () => {
  it("multiplies", () => {
    expect(mul(2, 3)).toBe(6);
  });

  it("multiplies by zero", () => {
    expect(mul(4, 0)).toBe(0);
  });

  it("multiplies negatives", () => {
    expect(mul(-2, 3)).toBe(-6);
  });
});
