import type {
  LibreChatChatCompletionRequest,
  LibreChatChatCompletionResponse,
  LibreChatUsage,
} from "@nexus-scheduler/shared";

// Single point of contact with LibreChat's Agents API (beta) — kept
// isolated behind this adapter so an upstream breaking change is a
// one-file fix, not a scavenger hunt (REQUIREMENTS.md §2.1).

export class LibreChatError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "LibreChatError";
  }
}

export interface LibreChatClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export async function callAgent(
  agentId: string,
  prompt: string,
  apiKey: string,
  options: LibreChatClientOptions,
): Promise<LibreChatChatCompletionResponse> {
  const body: LibreChatChatCompletionRequest = {
    model: agentId,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(`${options.baseUrl}/api/agents/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      // §2.1: 401/400-class failures are not retried; 5xx/network are.
      const transient = response.status >= 500;
      throw new LibreChatError(
        `LibreChat request failed with status ${response.status}`,
        response.status,
        transient,
      );
    }

    return (await response.json()) as LibreChatChatCompletionResponse;
  } catch (err) {
    if (err instanceof LibreChatError) {
      throw err;
    }
    // Network errors / aborts are treated as transient (§2.1 retry policy).
    throw new LibreChatError(
      err instanceof Error ? err.message : "unknown LibreChat request error",
      0,
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// Checks known usage-reporting conventions in order rather than
// assuming the OpenAI-style field names REQUIREMENTS §2.1 describes are
// actually what a given deployment's underlying provider returns — see
// the LibreChatUsage comment in packages/shared/src/librechat.ts. Never
// guesses a split from total_tokens alone (that would misattribute cost
// between prompt/completion rates); returns null rather than 0 so the
// caller can distinguish "no usage data" from "genuinely zero tokens."
export function extractTokenUsage(
  usage: LibreChatUsage | undefined,
): { promptTokens: number; completionTokens: number } | null {
  if (!usage) {
    return null;
  }
  if (typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
    return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
  }
  // Anthropic's native Messages API shape — plausible if LibreChat
  // passes a Claude provider's usage through unnormalized.
  if (typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
    return { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens };
  }
  return null;
}
