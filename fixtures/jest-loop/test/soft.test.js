const { isReady, label } = require("../src/soft");

describe("soft", () => {
  it("isReady returns a boolean", () => {
    expect(typeof isReady(true)).toBe("boolean");
  });

  it("label returns a string", () => {
    expect(typeof label(true)).toBe("string");
  });
});
