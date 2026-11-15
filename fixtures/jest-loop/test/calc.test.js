const { add, subtract } = require("../src/calc");

describe("calc", () => {
  it("adds", () => {
    expect(add(1, 2)).toBe(3);
  });

  it("subtracts", () => {
    expect(subtract(5, 2)).toBe(3);
  });
});
