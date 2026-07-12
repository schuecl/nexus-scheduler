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

export interface LibreChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LibreChatChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: LibreChatChatMessage;
    finish_reason: string;
  }>;
  usage?: LibreChatUsage; // presence to be confirmed against the live deployment, REQUIREMENTS §14
}
