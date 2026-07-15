import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VariableEditor, type PromptVariableDraft } from "./VariableEditor";

const TWO_VARIABLES: PromptVariableDraft[] = [
  { name: "region", type: "text", defaultValue: "us-east" },
  { name: "count", type: "number", defaultValue: "3" },
];

describe("VariableEditor", () => {
  it("appends a blank text variable via onChange when Add variable is clicked", () => {
    const onChange = vi.fn();
    render(<VariableEditor variables={TWO_VARIABLES} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));

    expect(onChange).toHaveBeenCalledWith([...TWO_VARIABLES, { name: "", type: "text", defaultValue: "" }]);
  });

  it("patches only the edited variable's name via onChange", () => {
    const onChange = vi.fn();
    render(<VariableEditor variables={TWO_VARIABLES} onChange={onChange} />);

    const nameFields = screen.getAllByLabelText("Name");
    fireEvent.change(nameFields[0]!, { target: { value: "zone" } });

    expect(onChange).toHaveBeenCalledWith([
      { name: "zone", type: "text", defaultValue: "us-east" },
      TWO_VARIABLES[1],
    ]);
  });

  it("removes the right variable via onChange", () => {
    const onChange = vi.fn();
    render(<VariableEditor variables={TWO_VARIABLES} onChange={onChange} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove variable" })[1]!);

    expect(onChange).toHaveBeenCalledWith([TWO_VARIABLES[0]]);
  });
});
