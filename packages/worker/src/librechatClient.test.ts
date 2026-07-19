import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { agentDispatcherOptions, callAgent, describeUnexecutedToolCall, extractTokenUsage } from "./librechatClient.js";

describe("agentDispatcherOptions (issue #127)", () => {
  // undici's default headersTimeout is 300s and LibreChat's
  // non-streaming Agents endpoint sends nothing until generation
  // finishes — without an explicit dispatcher every agent call was
  // silently capped at 5 minutes no matter the run's budget.
  it("derives both timeouts from the caller's budget, slightly above it", () => {
    expect(agentDispatcherOptions(600_000)).toEqual({ headersTimeout: 601_000, bodyTimeout: 601_000 });
  });
});

describe("callAgent dispatcher wiring (issue #127)", () => {
  it("survives a server that sends headers only after a delay (no bytes at all until then)", async () => {
    const server = createServer((req, res) => {
      // Nothing — not even headers — for 1.5s, like a model mid-generation.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          }),
        );
      }, 1_500);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await callAgent("agent_x", "hi", "key", {
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 10_000,
      });
      expect(response.choices[0]?.message?.content).toBe("OK");
    } finally {
      server.close();
    }
  });

  it("still classifies budget expiry as a timeout, not a network error", async () => {
    const server = createServer(() => {
      // never responds
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        callAgent("agent_x", "hi", "key", { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 }),
      ).rejects.toMatchObject({ kind: "timeout", transient: true });
    } finally {
      server.close();
    }
  });

  it("does not cross the request-start boundary when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const onRequestStart = vi.fn();

    await expect(
      callAgent("agent-1", "hello", "test-key", {
        baseUrl: "http://127.0.0.1:1",
        timeoutMs: 1_000,
        abortSignal: controller.signal,
        onRequestStart,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(onRequestStart).not.toHaveBeenCalled();
  });

  it("awaits the request-start boundary before dispatching any bytes", async () => {
    let requestSeen = false;
    const server = createServer((_req, res) => {
      requestSeen = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    let releaseBoundary: (() => void) | undefined;
    const boundary = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    try {
      const responsePromise = callAgent("agent_x", "hi", "key", {
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 10_000,
        onRequestStart: () => boundary,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requestSeen).toBe(false);
      releaseBoundary?.();
      await expect(responsePromise).resolves.toMatchObject({ choices: [{ message: { content: "OK" } }] });
      expect(requestSeen).toBe(true);
    } finally {
      server.close();
    }
  });

  it("rolls back the request-start boundary when cancellation fires while it is awaited", async () => {
    let requestSeen = false;
    const server = createServer((_req, res) => {
      requestSeen = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "unexpected" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    const onRequestAbortedBeforeDispatch = vi.fn();
    const onRequestDispatched = vi.fn();
    try {
      await expect(
        callAgent("agent_x", "hi", "key", {
          baseUrl: `http://127.0.0.1:${port}`,
          timeoutMs: 10_000,
          abortSignal: controller.signal,
          onRequestStart: async () => {
            controller.abort();
            await Promise.resolve();
          },
          onRequestAbortedBeforeDispatch,
          onRequestDispatched,
        }),
      ).rejects.toMatchObject({ kind: "cancelled", transient: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onRequestAbortedBeforeDispatch).toHaveBeenCalledOnce();
      expect(onRequestDispatched).not.toHaveBeenCalled();
      expect(requestSeen).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("describeUnexecutedToolCall", () => {
  it("returns null when there are no tool calls", () => {
    expect(describeUnexecutedToolCall({ role: "assistant", content: "hi" }, "stop")).toBeNull();
    expect(describeUnexecutedToolCall(undefined, "stop")).toBeNull();
  });

  // Regression: a real LibreChat deployment returned a response with
  // *both* a populated tool_calls array (the resolved call) and a real
  // final answer in content, finish_reason "stop" — the agent resolved
  // the call itself. Treating tool_calls alone as "unexecuted" produced
  // a false-positive disclaimer prepended to a working answer.
  it("returns null when the agent already resolved the call and returned a real answer", () => {
    const note = describeUnexecutedToolCall(
      {
        role: "assistant",
        content: "The result of your math problem is 24. Let me know if you need help with anything else!",
        tool_calls: [{ id: "1", type: "function", function: { name: "calculator", arguments: "{}" } }],
      },
      "stop",
    );
    expect(note).toBeNull();
  });

  it("surfaces a diagnostic note when finish_reason is tool_calls (the model is paused on it)", () => {
    const note = describeUnexecutedToolCall(
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", type: "function", function: { name: "calculator", arguments: "{}" } }],
      },
      "tool_calls",
    );
    expect(note).toMatch(/calculator/);
    expect(note).toMatch(/finish_reason=tool_calls/);
  });

  it("surfaces a diagnostic note when content is empty even if finish_reason isn't tool_calls", () => {
    const note = describeUnexecutedToolCall(
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", type: "function", function: { name: "calculator", arguments: "{}" } }],
      },
      "stop",
    );
    expect(note).not.toBeNull();
  });

  it("includes every called tool's name", () => {
    const note = describeUnexecutedToolCall(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "1", type: "function", function: { name: "calculator", arguments: "{}" } },
          { id: "2", type: "function", function: { name: "web_search", arguments: "{}" } },
        ],
      },
      "tool_calls",
    );
    expect(note).toMatch(/calculator, web_search/);
  });
});

describe("extractTokenUsage", () => {
  it("returns null when usage is absent", () => {
    expect(extractTokenUsage(undefined)).toBeNull();
  });

  it("maps the OpenAI shape", () => {
    expect(extractTokenUsage({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 })).toEqual({
      promptTokens: 120,
      completionTokens: 45,
    });
  });

  it("maps the Anthropic shape", () => {
    expect(extractTokenUsage({ input_tokens: 30, output_tokens: 7 })).toEqual({
      promptTokens: 30,
      completionTokens: 7,
    });
  });

  it("returns null for an unrecognized shape", () => {
    expect(extractTokenUsage({ total_tokens: 165 })).toBeNull();
  });

  // Regression for issue #38, verified live against LibreChat v0.8.7:
  // its Agents API returns a well-formed, all-zero usage object because
  // it doesn't meter headless API-key calls. All-zero is an "unmetered"
  // sentinel, not a measurement — persisting it as real zeros is what
  // made every run and report show 0 tokens.
  it("treats an all-zero usage object as no data (LibreChat unmetered sentinel)", () => {
    expect(extractTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeNull();
    expect(extractTokenUsage({ input_tokens: 0, output_tokens: 0 })).toBeNull();
  });

  it("keeps a legitimate zero on one side only", () => {
    expect(extractTokenUsage({ prompt_tokens: 120, completion_tokens: 0, total_tokens: 120 })).toEqual({
      promptTokens: 120,
      completionTokens: 0,
    });
  });
});
