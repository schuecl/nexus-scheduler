import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JobAttachmentsDialog } from "./JobAttachmentsDialog";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);

function renderDialog(canEdit: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <JobAttachmentsDialog jobId="job-1" canEdit={canEdit} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("JobAttachmentsDialog", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("lists attachments with type and size, and offers delete when canEdit", async () => {
    apiFetchMock.mockResolvedValue([
      {
        id: "att-1",
        filename: "invoice-scan.png",
        mimeType: "image/png",
        sizeBytes: 38510,
        createdAt: "2026-07-17T22:00:00Z",
      },
    ]);
    renderDialog(true);

    expect(await screen.findByText("invoice-scan.png")).toBeInTheDocument();
    expect(screen.getByText(/image\/png · 37\.6 KB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "delete invoice-scan.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload file/ })).toBeInTheDocument();
  });

  it("hides upload and delete affordances without canEdit", async () => {
    apiFetchMock.mockResolvedValue([
      {
        id: "att-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        createdAt: "2026-07-17T22:00:00Z",
      },
    ]);
    renderDialog(false);

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload file/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/ })).not.toBeInTheDocument();
  });

  it("rejects an unsupported file type client-side without calling the API", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderDialog(true);
    await screen.findByText("No attachments yet.");

    // The MUI Dialog renders in a portal, outside the render container.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    fireEvent.change(input, { target: { files: [svg] } });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/unsupported type image\/svg\+xml/);
    // Only the initial list GET — the upload never reached the API.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads a valid file as base64 JSON and surfaces the server's quota error", async () => {
    apiFetchMock.mockImplementation((_path, init) =>
      init?.method === "POST"
        ? Promise.reject(new Error("job already has 10 attachments (limit)"))
        : Promise.resolve([]),
    );
    renderDialog(true);
    await screen.findByText("No attachments yet.");

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const png = new File([new Uint8Array([137, 80, 78, 71])], "scan.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [png] } });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("job already has 10 attachments (limit)");
    await waitFor(() => {
      const postCall = apiFetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(postCall).toBeDefined();
      const body = JSON.parse(String(postCall![1]?.body)) as { filename: string; dataBase64: string };
      expect(body.filename).toBe("scan.png");
      expect(body.dataBase64).toBe(btoa(String.fromCharCode(137, 80, 78, 71)));
    });
  });
});
