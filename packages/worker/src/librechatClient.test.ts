import { describe, expect, it } from "vitest";
import { describeUnexecutedToolCall, extractTokenUsage } from "./librechatClient.js";

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
