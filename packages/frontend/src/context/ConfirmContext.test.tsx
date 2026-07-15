import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@mui/material";
import { ConfirmProvider, useConfirm } from "./ConfirmContext";

// Minimal consumer mirroring every real call site: ask for confirmation,
// only run the destructive action when the promise resolves true.
function DeleteThing({ onDelete }: { onDelete: () => void }) {
  const confirm = useConfirm();
  return (
    <Button
      onClick={() => {
        void (async () => {
          const ok = await confirm({ title: "Delete thing?", message: "This can't be undone." });
          if (ok) onDelete();
        })();
      }}
    >
      Delete thing
    </Button>
  );
}

function renderConsumer(onDelete: () => void) {
  return render(
    <ConfirmProvider>
      <DeleteThing onDelete={onDelete} />
    </ConfirmProvider>,
  );
}

describe("ConfirmProvider", () => {
  it("shows title and message, and cancelling does not run the action", async () => {
    const onDelete = vi.fn();
    renderConsumer(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "Delete thing" }));
    expect(await screen.findByText("Delete thing?")).toBeInTheDocument();
    expect(screen.getByText("This can't be undone.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Delete thing?")).not.toBeInTheDocument());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("runs the action only after the destructive default 'Delete' button is clicked", async () => {
    const onDelete = vi.fn();
    renderConsumer(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "Delete thing" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Delete thing?")).not.toBeInTheDocument());
  });

  it("useConfirm throws outside a ConfirmProvider", () => {
    // Silence React's error boundary console noise for the expected throw.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<DeleteThing onDelete={() => {}} />)).toThrow(
      "useConfirm must be used within a ConfirmProvider",
    );
    consoleError.mockRestore();
  });
});
