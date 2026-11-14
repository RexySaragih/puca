import { describe, expect, it } from "vitest";
import { add, subtract } from "../src/calc.js";
import { hang } from "../src/hang.js";

describe("calc", () => {
  it("adds", () => {
    expect(add(1, 2)).toBe(3);
  });

  it("subtracts", () => {
    expect(subtract(5, 2)).toBe(3);
  });
});

describe("hang", () => {
  it("returns without spinning when disabled", () => {
    hang(false);
    expect(true).toBe(true);
  });
});
