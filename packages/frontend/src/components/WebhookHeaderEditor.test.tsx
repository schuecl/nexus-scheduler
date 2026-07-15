import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WebhookHeaderEditor, headersToRecord, recordToHeaderDrafts } from "./WebhookHeaderEditor";

describe("headersToRecord", () => {
  it("filters out rows with blank keys and trims the kept ones", () => {
    expect(
      headersToRecord([
        { key: "  X-Auth  ", value: "token" },
        { key: "   ", value: "ignored" },
        { key: "", value: "also ignored" },
      ]),
    ).toEqual({ "X-Auth": "token" });
  });

  it("returns undefined when no row has a usable key", () => {
    expect(headersToRecord([])).toBeUndefined();
    expect(headersToRecord([{ key: " ", value: "v" }])).toBeUndefined();
  });
});

describe("recordToHeaderDrafts", () => {
  it("round-trips a record into drafts", () => {
    expect(recordToHeaderDrafts({ "X-Auth": "token" })).toEqual([{ key: "X-Auth", value: "token" }]);
  });

  it("returns an empty list for null/undefined", () => {
    expect(recordToHeaderDrafts(null)).toEqual([]);
    expect(recordToHeaderDrafts(undefined)).toEqual([]);
  });
});

describe("WebhookHeaderEditor", () => {
  it("adds a blank row via onChange when Add header is clicked", () => {
    const onChange = vi.fn();
    render(<WebhookHeaderEditor headers={[{ key: "X-Auth", value: "token" }]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add header" }));

    expect(onChange).toHaveBeenCalledWith([
      { key: "X-Auth", value: "token" },
      { key: "", value: "" },
    ]);
  });

  it("patches only the edited row via onChange", () => {
    const onChange = vi.fn();
    render(
      <WebhookHeaderEditor
        headers={[
          { key: "X-Auth", value: "token" },
          { key: "X-Env", value: "prod" },
        ]}
        onChange={onChange}
      />,
    );

    const valueFields = screen.getAllByLabelText("Value");
    fireEvent.change(valueFields[1]!, { target: { value: "staging" } });

    expect(onChange).toHaveBeenCalledWith([
      { key: "X-Auth", value: "token" },
      { key: "X-Env", value: "staging" },
    ]);
  });

  it("removes the right row via onChange", () => {
    const onChange = vi.fn();
    render(
      <WebhookHeaderEditor
        headers={[
          { key: "X-Auth", value: "token" },
          { key: "X-Env", value: "prod" },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Remove header" })[0]!);

    expect(onChange).toHaveBeenCalledWith([{ key: "X-Env", value: "prod" }]);
  });
});
