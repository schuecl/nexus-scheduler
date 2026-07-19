import { describe, expect, it } from "vitest";
import { encodeRfc5987Filename } from "./runs.js";

describe("encodeRfc5987Filename", () => {
  it("escapes Unicode and the punctuation encodeURIComponent leaves untouched", () => {
    expect(encodeRfc5987Filename("résumé's (final)*.pdf")).toBe(
      "r%C3%A9sum%C3%A9%27s%20%28final%29%2A.pdf",
    );
  });
});
