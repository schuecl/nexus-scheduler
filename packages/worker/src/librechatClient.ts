import type {
  LibreChatChatCompletionRequest,
  LibreChatChatCompletionResponse,
  LibreChatResponseMessage,
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
  let extracted: { promptTokens: number; completionTokens: number } | null = null;
  if (typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
    extracted = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
  } else if (typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
    // Anthropic's native Messages API shape — plausible if LibreChat
    // passes a Claude provider's usage through unnormalized.
    extracted = { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens };
  }
  if (!extracted) {
    return null;
  }
  // Verified live against LibreChat v0.8.7 (issue #38): its Agents API
  // returns a well-formed usage object of literal zeros — it doesn't
  // meter headless API-key calls at all (no message/transaction records
  // either). A real run can never consume zero prompt tokens (the
  // prompt is never empty), so all-zero is an "unmetered" sentinel, not
  // a measurement — treat it as no data rather than persisting zeros
  // that read as a genuine count. A legitimate zero on just one side
  // (e.g. an empty completion) is still kept.
  if (extracted.promptTokens === 0 && extracted.completionTokens === 0) {
    return null;
  }
  return extracted;
}

// Surfaces a *genuinely* unresolved tool call rather than silently
// treating a null/empty `message.content` as "the agent had nothing to
// say." An earlier, broader version of this function assumed LibreChat's
// chat/completions endpoint never executes an Agent's tool calls at
// all — real-deployment evidence overturned that: a response can carry
// a populated `tool_calls` array *and* a genuine final answer in
// `message.content` (finish_reason "stop"), where the agent resolved
// the call itself and just echoed it for transparency. The only case
// that's actually missing a usable answer is finish_reason "tool_calls"
// (OpenAI's own signal that the model is paused waiting on a tool
// result) or, defensively, any case where `content` is empty despite
// tool_calls being present. Returns null whenever there's a real answer
// to fall back on, so callers don't prepend a false-positive disclaimer
// to a working response.
export function describeUnexecutedToolCall(
  message: LibreChatResponseMessage | undefined,
  finishReason: string | undefined,
): string | null {
  if (!message?.tool_calls || message.tool_calls.length === 0) {
    return null;
  }
  const hasRealAnswer = typeof message.content === "string" && message.content.trim().length > 0;
  if (finishReason !== "tool_calls" && hasRealAnswer) {
    return null;
  }
  const names = message.tool_calls.map((call) => call.function.name || "unknown").join(", ");
  return (
    `[Nexus Scheduler: the agent attempted to call ${message.tool_calls.length} ` +
    `tool(s) (${names}${finishReason ? `, finish_reason=${finishReason}` : ""}) via ` +
    "LibreChat's Agents API chat/completions endpoint, and this response carried no " +
    "resolved final answer — this run did not receive the agent's actual answer.]"
  );
}
