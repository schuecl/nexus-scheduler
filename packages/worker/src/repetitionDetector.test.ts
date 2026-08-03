import { describe, expect, it } from "vitest";
import { detectRepetition } from "./repetitionDetector.js";

describe("detectRepetition", () => {
  it("does not flag a normal, varied answer", () => {
    const text = [
      "## Section one",
      "This covers the first implementation concern in enough detail to be useful.",
      "",
      "## Section two",
      "This covers a distinct second concern, with different content than the first.",
      "",
      "## Section three",
      "This wraps up with a third and final concern, again distinct from the others.",
    ].join("\n");

    const result = detectRepetition(text);

    expect(result.detected).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("does not flag short repeated code tokens (braces, keywords, imports)", () => {
    const text = [
      "function a() {",
      "  return 1;",
      "}",
      "",
      "function b() {",
      "  return 2;",
      "}",
      "",
      "function c() {",
      "  return 3;",
      "}",
    ].join("\n");

    const result = detectRepetition(text);

    expect(result.detected).toBe(false);
  });

  it("flags a paragraph repeated verbatim several times consecutively", () => {
    const paragraph =
      "The gateway must resolve model capabilities before sending any generation parameters downstream.";
    const text = [paragraph, "", paragraph, "", paragraph].join("\n");

    const result = detectRepetition(text);

    expect(result.detected).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("paragraph repeated"))).toBe(true);
  });

  it("flags the same non-trivial line repeated consecutively", () => {
    const line = "Section three is still being generated right now.";
    const text = [line, line, line, line].join("\n");

    const result = detectRepetition(text);

    expect(result.detected).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("line repeated"))).toBe(true);
  });

  it("flags a high ratio of repeated phrases in a long trailing loop even without exact paragraph repeats", () => {
    const loop = Array.from({ length: 40 }, (_, i) => `the model kept restating the same idea number ${i % 3}`).join(
      " ",
    );

    const result = detectRepetition(loop);

    expect(result.detected).toBe(true);
    expect(result.repeatedNgramRatio).toBeGreaterThan(0.35);
  });

  it("handles empty and very short text without throwing", () => {
    expect(detectRepetition("").detected).toBe(false);
    expect(detectRepetition("ok").detected).toBe(false);
  });
});
