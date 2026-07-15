import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunHistoryDialog } from "./RunHistoryDialog";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);

function renderDialog(canRun: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RunHistoryDialog jobId="job-1" canRun={canRun} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RunHistoryDialog", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("renders the runnable empty-state hint (and the Run Now button) when canRun", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderDialog(true);

    expect(await screen.findByText(/use "Run Now" below, or attach a schedule/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Now" })).toBeInTheDocument();
  });

  it("renders the read-only empty-state hint (and no Run Now button) when not canRun", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderDialog(false);

    expect(await screen.findByText(/it runs on-demand or on a schedule\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run Now" })).not.toBeInTheDocument();
  });

  it("surfaces an error when Run Now fails instead of swallowing it", async () => {
    apiFetchMock.mockImplementation((_path, init) =>
      init?.method === "POST" ? Promise.reject(new Error("queue unavailable")) : Promise.resolve([]),
    );
    renderDialog(true);

    fireEvent.click(await screen.findByRole("button", { name: "Run Now" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to start a run.");
  });
});
