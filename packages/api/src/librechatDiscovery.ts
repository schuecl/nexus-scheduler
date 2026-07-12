// REQUIREMENTS §2.1 "Agent discovery": rather than requiring a
// hand-typed LibreChat agent ID, list the Agents available to a given
// API key so the Job form can offer a picker — falling back to manual
// entry if discovery isn't available. LibreChat's Agents API is
// OpenAI-compatible (§2.1) and its chat-completions endpoint already
// lives at /api/agents/v1/chat/completions; this assumes the sibling
// GET /api/agents/v1/models endpoint OpenAI's own convention implies,
// which hasn't been independently confirmed against a live LibreChat
// deployment (§14's open confirmation item). Any failure here — 404,
// network error, unexpected response shape — is deliberately treated
// as "discovery isn't available" by the caller (a plain thrown Error),
// never as something that should break Job creation.
export async function listLibreChatAgentIds(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/agents/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`LibreChat responded ${response.status}`);
    }
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      throw new Error("unexpected response shape from LibreChat's models endpoint");
    }
    return body.data
      .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } finally {
    clearTimeout(timeout);
  }
}
