const { stockLeft } = require("../src/catalog");

describe("catalog barrel", () => {
  it("computes stock via re-export", () => {
    expect(stockLeft(10, 3)).toBe(7);
  });
});
