// Types for LibreChat's Agents API (beta, OpenAI-compatible).
// REQUIREMENTS.md §2.1: POST /api/agents/v1/chat/completions
// Kept isolated in one module so upstream breaking changes are a
// single-file fix, not a scavenger hunt (per the §2.1 adapter-isolation
// requirement).

export interface LibreChatChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LibreChatChatCompletionRequest {
  model: string; // LibreChat agent ID
  messages: LibreChatChatMessage[];
  stream?: false; // scheduled/unattended execution never streams (§2.1)
}

// OpenAI's function-calling shape — the beta Agents API's chat/completions
// endpoint is documented as a "backward compatibility" layer for existing
// OpenAI-compatible tooling, distinct from LibreChat's Open Responses
// endpoint (POST /api/agents/v1/responses), which LibreChat's own docs
// describe as what actually has "native support for... tool use" for
// agentic workflows. That framing (plus LibreChat's own roadmap notes
// on Open Responses' tool orchestration still being built out) suggests
// this endpoint may not run an Agent's configured tools the way
// LibreChat's own chat UI does — see describeUnexecutedToolCall() in
// librechatClient.ts, which surfaces this instead of silently discarding
// tool_calls the way treating message.content as the sole output would.
export interface LibreChatToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface LibreChatResponseMessage {
  role: "system" | "user" | "assistant";
  content: string | null;
  tool_calls?: LibreChatToolCall[];
}

// All fields optional and every naming convention below is speculative
// except where noted — "OpenAI-compatible" doesn't guarantee LibreChat
// normalizes every underlying provider's usage reporting to these exact
// field names. In particular, Anthropic's own native Messages API
// reports usage as `input_tokens`/`output_tokens`, not `prompt_tokens`/
// `completion_tokens` — if LibreChat passes a provider's usage object
// through unnormalized (plausible for a still-beta Agents API), a
// Claude-backed deployment could easily see the OpenAI-shaped fields
// simply absent. extractTokenUsage() in librechatClient.ts checks both
// conventions rather than assuming one.
export interface LibreChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface LibreChatChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: LibreChatResponseMessage;
    finish_reason: string;
  }>;
  usage?: LibreChatUsage; // presence to be confirmed against the live deployment, REQUIREMENTS §14
}
