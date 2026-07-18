import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SystemStatusGraph, SystemStatusSummary } from "./SystemStatusGraph";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);

const RESPONSE = {
  components: [
    { id: "api", label: "API", status: "up" },
    { id: "worker", label: "Worker", status: "stale" },
    { id: "postgres", label: "Postgres", status: "up" },
    { id: "redis", label: "Redis", status: "up" },
    { id: "pdf-service", label: "PDF Service", status: "down" },
    { id: "librechat", label: "LibreChat", status: "stale" },
  ],
  edges: [
    { from: "api", to: "postgres" },
    { from: "api", to: "redis" },
    { from: "api", to: "pdf-service" },
    { from: "worker", to: "postgres" },
    { from: "worker", to: "redis" },
    { from: "worker", to: "pdf-service" },
    { from: "worker", to: "librechat" },
  ],
  checkedAt: "2026-07-18T12:00:00.000Z",
};

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("SystemStatusSummary", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("renders a chip per component once loaded", async () => {
    apiFetchMock.mockResolvedValue(RESPONSE);
    renderWithProviders(<SystemStatusSummary />);

    expect(await screen.findByText("API")).toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Postgres")).toBeInTheDocument();
    expect(screen.getByText("Redis")).toBeInTheDocument();
    expect(screen.getByText("PDF Service")).toBeInTheDocument();
    expect(screen.getByText("LibreChat")).toBeInTheDocument();
  });

  it("shows an unavailable message when the request fails", async () => {
    apiFetchMock.mockRejectedValue(new Error("network error"));
    renderWithProviders(<SystemStatusSummary />);

    expect(await screen.findByText("System status unavailable.")).toBeInTheDocument();
  });
});

describe("SystemStatusGraph", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("draws every component as a labeled node", async () => {
    apiFetchMock.mockResolvedValue(RESPONSE);
    renderWithProviders(<SystemStatusGraph />);

    for (const label of ["API", "Worker", "Postgres", "Redis", "PDF Service", "LibreChat"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("surfaces a warning when the Worker itself hasn't reported recently", async () => {
    apiFetchMock.mockResolvedValue(RESPONSE);
    renderWithProviders(<SystemStatusGraph />);

    expect(
      await screen.findByText(/The Worker hasn't reported in recently/),
    ).toBeInTheDocument();
  });

  it("does not show the stale-worker warning once the Worker is reporting up", async () => {
    apiFetchMock.mockResolvedValue({
      ...RESPONSE,
      components: RESPONSE.components.map((c) => (c.id === "worker" ? { ...c, status: "up" } : c)),
    });
    renderWithProviders(<SystemStatusGraph />);

    await screen.findByText("API"); // wait for load
    expect(screen.queryByText(/The Worker hasn't reported in recently/)).not.toBeInTheDocument();
  });
});
