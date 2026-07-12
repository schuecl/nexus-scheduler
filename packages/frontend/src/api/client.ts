// Thin fetch wrapper — same-origin cookies (session auth), JSON in/out.
// Nothing fancier is warranted until the API surface is large enough to
// need retries/interceptors.
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    // Every route handler responds with { error: "..." } on failure —
    // surface that specific message (e.g. "cannot delete — 2 Project(s)
    // are currently tagged...") instead of just the status code, when
    // the body actually parses as JSON with one.
    let message = `Request to ${path} failed with ${response.status}`;
    try {
      const body = (await response.clone().json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) {
        message = body.error;
      }
    } catch {
      // Non-JSON error body — fall back to the generic message above.
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
