const { hang } = require("../src/hang");

describe("hang", () => {
  it("returns when disabled", () => {
    expect(() => hang(false)).not.toThrow();
  });
});
