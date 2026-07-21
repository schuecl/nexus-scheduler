import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JobNotificationsDialog, type JobNotificationSettings } from "./JobNotificationsDialog";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);

const INITIAL: JobNotificationSettings = {
  notifyOnSuccess: true,
  notifyOnFailure: false,
  attachPdfToEmail: false,
  ccRecipients: [],
  emailSubjectTemplate: null,
  emailBodyTemplate: null,
};

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <JobNotificationsDialog jobId="job-1" initial={INITIAL} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// issue #219: the picker offers the caller's own saved mailing lists,
// pre-checks whatever is already attached to this Job, and includes the
// selection in the PUT body on save.
describe("JobNotificationsDialog mailing-list picker", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("renders the caller's lists and pre-checks the ones already attached", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/mailing-lists") {
        return Promise.resolve([
          { id: "list-1", name: "Leadership" },
          { id: "list-2", name: "Ops" },
        ]);
      }
      if (path === "/api/jobs/job-1/mailing-lists") {
        return Promise.resolve([{ id: "list-2", name: "Ops" }]);
      }
      return Promise.resolve([]);
    });
    renderDialog();

    const leadership = (await screen.findByRole("checkbox", { name: "Leadership" })) as HTMLInputElement;
    const ops = (await screen.findByRole("checkbox", { name: "Ops" })) as HTMLInputElement;
    expect(leadership.checked).toBe(false);
    expect(ops.checked).toBe(true);
  });

  it("includes the toggled mailingListIds in the PUT body on save", async () => {
    let putBody: unknown;
    apiFetchMock.mockImplementation((path, init) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(init.body as string);
        return Promise.resolve(undefined);
      }
      if (path === "/api/mailing-lists") {
        return Promise.resolve([{ id: "list-1", name: "Leadership" }]);
      }
      return Promise.resolve([]);
    });
    renderDialog();

    const leadership = await screen.findByRole("checkbox", { name: "Leadership" });
    fireEvent.click(leadership);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(putBody).toBeDefined());
    expect((putBody as { mailingListIds: string[] }).mailingListIds).toEqual(["list-1"]);
  });

  it("shows a message when the caller has no mailing lists yet", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderDialog();

    expect(await screen.findByText("No mailing lists yet.")).toBeInTheDocument();
  });
});
