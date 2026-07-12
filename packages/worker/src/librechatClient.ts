import type {
  LibreChatChatCompletionRequest,
  LibreChatChatCompletionResponse,
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
