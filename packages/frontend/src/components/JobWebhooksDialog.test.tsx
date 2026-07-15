import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JobWebhooksDialog } from "./JobWebhooksDialog";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <JobWebhooksDialog jobId="job-1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("JobWebhooksDialog", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("renders the prerequisite hint when no webhook destinations exist", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderDialog();

    expect(
      await screen.findByText(/No webhook destinations exist yet — an admin needs to add one first\./),
    ).toBeInTheDocument();
  });

  it("surfaces the server's error message when saving fails", async () => {
    apiFetchMock.mockImplementation((path, init) => {
      if (init?.method === "PUT") {
        return Promise.reject(new Error("destination was deactivated by an admin"));
      }
      if (path === "/api/webhook-destinations") {
        return Promise.resolve([{ id: "d1", name: "Ops", url: "https://hooks.example", active: true }]);
      }
      return Promise.resolve([]);
    });
    renderDialog();

    // Wait for the destination list, then save into the failing PUT.
    await screen.findByText(/Ops \(https:\/\/hooks\.example\)/);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("destination was deactivated by an admin");
  });
});
