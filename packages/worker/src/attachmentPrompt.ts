const ATTACHMENT_CONTEXT_HEADER = "\n\n--- Attached documents (extracted) ---\n";
const TRUNCATION_NOTICE =
  "\n\n[TRUNCATED: extracted text exceeded this run's configured prompt budget; the remainder was omitted]";

export class AttachmentPromptBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentPromptBudgetError";
  }
}

export interface AttachmentPrompt {
  prompt: string;
  extractedText: string;
  attachmentCharBudget: number;
  truncated: boolean;
}

// Build the exact user message sent to LibreChat under one character
// ceiling. Bounding only extractedText is insufficient: a large rendered
// template can consume the model context before the attachments are added.
export function buildAttachmentPrompt(
  renderedPrompt: string,
  extractedText: string,
  maxPromptChars: number,
): AttachmentPrompt {
  const attachmentCharBudget = maxPromptChars - renderedPrompt.length - ATTACHMENT_CONTEXT_HEADER.length;
  if (attachmentCharBudget <= 0) {
    throw new AttachmentPromptBudgetError(
      `rendered prompt (${renderedPrompt.length} characters) leaves no room for attachments under ` +
        `OCR_EXTRACTED_TEXT_MAX_CHARS=${maxPromptChars}`,
    );
  }

  let boundedText = extractedText;
  const truncated = extractedText.length > attachmentCharBudget;
  if (truncated) {
    if (attachmentCharBudget <= TRUNCATION_NOTICE.length) {
      throw new AttachmentPromptBudgetError(
        `rendered prompt leaves only ${attachmentCharBudget} characters for attachments under ` +
          `OCR_EXTRACTED_TEXT_MAX_CHARS=${maxPromptChars}; increase the limit or shorten the prompt`,
      );
    }
    boundedText =
      extractedText.slice(0, attachmentCharBudget - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
  }

  return {
    prompt: `${renderedPrompt}${ATTACHMENT_CONTEXT_HEADER}${boundedText}`,
    extractedText: boundedText,
    attachmentCharBudget,
    truncated,
  };
}
