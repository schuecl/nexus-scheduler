import { describe, expect, it } from "vitest";
import { AttachmentPromptBudgetError, buildAttachmentPrompt } from "./attachmentPrompt.js";

describe("buildAttachmentPrompt", () => {
  it("preserves extracted text when the complete prompt fits", () => {
    const result = buildAttachmentPrompt("Summarize this", "### file.pdf\nhello", 200);

    expect(result.truncated).toBe(false);
    expect(result.extractedText).toBe("### file.pdf\nhello");
    expect(result.prompt).toContain("Summarize this\n\n--- Attached documents (extracted) ---\n");
    expect(result.prompt.length).toBeLessThanOrEqual(200);
  });

  it("reserves the rendered prompt and truncation marker inside the ceiling", () => {
    const maxPromptChars = 220;
    const result = buildAttachmentPrompt("P".repeat(40), "document text ".repeat(30), maxPromptChars);

    expect(result.truncated).toBe(true);
    expect(result.extractedText).toContain("[TRUNCATED:");
    expect(result.prompt.length).toBe(maxPromptChars);
    expect(result.extractedText.length).toBe(result.attachmentCharBudget);
  });

  it("reduces the attachment budget as the rendered prompt grows", () => {
    const shortPrompt = buildAttachmentPrompt("short", "x".repeat(500), 250);
    const longPrompt = buildAttachmentPrompt("long".repeat(20), "x".repeat(500), 250);

    expect(longPrompt.attachmentCharBudget).toBeLessThan(shortPrompt.attachmentCharBudget);
    expect(longPrompt.prompt.length).toBe(250);
  });

  it("rejects a rendered prompt that leaves no usable attachment budget", () => {
    expect(() => buildAttachmentPrompt("x".repeat(100), "attachment", 120)).toThrow(AttachmentPromptBudgetError);
  });
});
