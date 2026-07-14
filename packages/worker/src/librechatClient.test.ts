import { describe, expect, it } from "vitest";
import { describeUnexecutedToolCall } from "./librechatClient.js";

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
