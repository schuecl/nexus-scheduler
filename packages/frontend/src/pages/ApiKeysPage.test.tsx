import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "../context/ConfirmContext";
import { ApiKeysPage } from "./ApiKeysPage";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);

const ACTIVE_KEY = {
  id: "k1",
  label: "prod key",
  ownerType: "USER",
  ownerTeamId: null,
  owningTeam: null,
  status: "ACTIVE",
  expiresAt: null,
  createdAt: "2026-07-14T00:00:00.000Z",
};

function mockApi({ keys = [ACTIVE_KEY], onDelete }: { keys?: unknown[]; onDelete?: () => Promise<unknown> } = {}) {
  apiFetchMock.mockImplementation((path, init) => {
    if (init?.method === "DELETE") {
      return (onDelete ?? (() => Promise.resolve(undefined)))();
    }
    if (path === "/api/api-keys") return Promise.resolve(keys);
    return Promise.resolve([]);
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter>
          <ApiKeysPage />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

const deleteCalls = () => apiFetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");

describe("ApiKeysPage", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("renders the empty-state hint when there are no keys", async () => {
    mockApi({ keys: [] });
    renderPage();

    expect(await screen.findByText(/No API keys yet\. Add one to connect/)).toBeInTheDocument();
  });

  it("does not revoke when the confirmation is cancelled", async () => {
    mockApi();
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    // The shared confirm dialog appears with the destructive warning.
    expect(await screen.findByText("Revoke API key?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Revoke API key?")).not.toBeInTheDocument());
    expect(deleteCalls()).toHaveLength(0);
  });

  it("revokes only after confirmation", async () => {
    mockApi();
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    // The dialog's confirm button carries the custom "Revoke" label.
    const confirmButton = within(dialog).getByRole("button", { name: "Revoke" });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(deleteCalls()[0]![0]).toBe("/api/api-keys/k1");
  });

  it("surfaces the server's error message when revoking fails", async () => {
    mockApi({ onDelete: () => Promise.reject(new Error("key is referenced by an active schedule")) });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("key is referenced by an active schedule");
  });
});
