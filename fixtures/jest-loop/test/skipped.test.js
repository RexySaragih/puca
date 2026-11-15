const { skippedAdd, keptMul } = require("../src/skipped");

describe("skipped", () => {
  it("adds with disable comment", () => {
    expect(skippedAdd(2, 3)).toBe(5);
  });

  it("multiplies kept site", () => {
    expect(keptMul(3, 4)).toBe(12);
  });
});
