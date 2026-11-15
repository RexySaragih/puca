import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  coloredStatusLabel,
  sectionHeading,
  shouldUseColor,
  statusLabel,
} from "../src/adapters/outbound/report/terminalStyle.js";

function streamWithTty(isTTY: boolean): NodeJS.WritableStream {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  (stream as NodeJS.WriteStream).isTTY = isTTY;
  return stream;
}

describe("terminalStyle", () => {
  describe("shouldUseColor", () => {
    it("should enable color on TTY when NO_COLOR is unset", () => {
      expect(shouldUseColor(streamWithTty(true), {})).toBe(true);
    });

    it("should disable color when NO_COLOR is set even on TTY", () => {
      expect(shouldUseColor(streamWithTty(true), { NO_COLOR: "1" })).toBe(false);
      expect(shouldUseColor(streamWithTty(true), { NO_COLOR: "" })).toBe(false);
    });

    it("should disable color on non-TTY streams", () => {
      expect(shouldUseColor(streamWithTty(false), {})).toBe(false);
    });

    it("should force color when FORCE_COLOR is set", () => {
      expect(shouldUseColor(streamWithTty(false), { FORCE_COLOR: "1" })).toBe(
        true,
      );
    });

    it("should not force color when FORCE_COLOR is 0", () => {
      expect(shouldUseColor(streamWithTty(false), { FORCE_COLOR: "0" })).toBe(
        false,
      );
    });

    it("should let NO_COLOR win over FORCE_COLOR", () => {
      expect(
        shouldUseColor(streamWithTty(true), {
          NO_COLOR: "1",
          FORCE_COLOR: "1",
        }),
      ).toBe(false);
    });
  });

  describe("coloredStatusLabel", () => {
    it("should return plain labels when color is disabled", () => {
      expect(coloredStatusLabel("Killed", false)).toBe("KILLED");
      expect(coloredStatusLabel("Survived", false)).toBe("SURVIVED");
    });

    it("should wrap status words in ANSI when color is enabled", () => {
      const killed = coloredStatusLabel("Killed", true);
      const survived = coloredStatusLabel("Survived", true);
      expect(killed).toContain("KILLED");
      expect(killed).toMatch(/\x1b\[32m/);
      expect(killed).toMatch(/\x1b\[0m/);
      expect(survived).toContain("SURVIVED");
      expect(survived).toMatch(/\x1b\[31m/);
    });

    it("should keep statusLabel tokens stable for non-color callers", () => {
      expect(statusLabel("Timeout")).toBe("TIMEOUT");
      expect(statusLabel("RuntimeError")).toBe("ERROR");
      expect(statusLabel("NoCoverage")).toBe("NO_COVERAGE");
    });
  });

  describe("sectionHeading", () => {
    it("should render extended rule lines for Summary and File Summary", () => {
      expect(sectionHeading("Summary")).toMatch(/^── Summary ─{2,}$/);
      expect(sectionHeading("File Summary")).toMatch(/^── File Summary ─{2,}$/);
      expect(sectionHeading("Summary").length).toBeGreaterThan(
        "── Summary ──".length,
      );
    });
  });
});
