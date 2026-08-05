import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCampaign, listCampaigns } from "../api";
import { CampaignLibraryPage } from "./CampaignLibraryPage";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  listCampaigns: vi.fn(),
  createCampaign: vi.fn(),
}));

const campaign = {
  id: "campaign-one",
  name: "The Long Road",
  activeTimelineId: "timeline-one",
  ownerPrincipalId: "principal-secret",
  actorRole: "gm" as const,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-04-05T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("CampaignLibraryPage", () => {
  it("shows loading, then an accessible creation form and empty state", async () => {
    let resolve!: (value: { campaigns: [] }) => void;
    vi.mocked(listCampaigns).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<CampaignLibraryPage onBack={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Loading campaigns");
    resolve({ campaigns: [] });
    await screen.findByText("No campaigns yet.");
    expect(screen.getByText("Create one to begin your local campaign library.")).toBeTruthy();
    expect(screen.getByLabelText("Campaign name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create campaign" })).toBeTruthy();
  });

  it("renders only campaign name, role, and updated date", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ campaigns: [campaign] });
    render(<CampaignLibraryPage onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: campaign.name });
    expect(screen.getByText("Gm")).toBeTruthy();
    expect(document.querySelector(`time[datetime="${campaign.updatedAt}"]`)).toBeTruthy();
    expect(screen.queryByText(campaign.ownerPrincipalId)).toBeNull();
    expect(screen.queryByText(campaign.id)).toBeNull();
    expect(screen.queryByText(campaign.activeTimelineId)).toBeNull();
  });

  it("provides an explicit accessible open action", async () => {
    const onOpen = vi.fn();
    vi.mocked(listCampaigns).mockResolvedValue({ campaigns: [campaign] });
    render(<CampaignLibraryPage onBack={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaign.name}` }));
    expect(onOpen).toHaveBeenCalledWith(campaign.id);
  });

  it("shows a generic error and retries", async () => {
    vi.mocked(listCampaigns).mockRejectedValueOnce(new Error("private server detail")).mockResolvedValueOnce({ campaigns: [] });
    render(<CampaignLibraryPage onBack={vi.fn()} />);
    await screen.findByText("Campaigns could not be loaded.");
    expect(screen.queryByText("private server detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No campaigns yet.");
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(2));
  });

  it("provides an accessible return action", () => {
    vi.mocked(listCampaigns).mockReturnValue(new Promise(() => undefined));
    const onBack = vi.fn();
    render(<CampaignLibraryPage onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "← Character library" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("locks duplicate submits, clears after POST success, refreshes authoritatively, and focuses the created card", async () => {
    let resolveCreate!: (value: { campaign: typeof campaign }) => void;
    vi.mocked(listCampaigns).mockResolvedValueOnce({ campaigns: [] }).mockResolvedValueOnce({ campaigns: [campaign] });
    vi.mocked(createCampaign).mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    render(<CampaignLibraryPage onBack={vi.fn()} />);
    await screen.findByText("No campaigns yet.");
    const input = screen.getByLabelText("Campaign name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  The Long Road  " } });
    const form = screen.getByRole("button", { name: "Create campaign" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(createCampaign).toHaveBeenCalledOnce();
    expect(createCampaign).toHaveBeenCalledWith({ name: "  The Long Road  " });
    expect(input.value).toBe("  The Long Road  ");
    resolveCreate({ campaign });
    const heading = await screen.findByRole("heading", { name: campaign.name });
    await waitFor(() => expect(heading.closest("li")).toBe(document.activeElement));
    expect(input.value).toBe("");
    expect(listCampaigns).toHaveBeenCalledTimes(2);
    expect(screen.getByText(`Campaign “${campaign.name}” created.`)).toBeTruthy();
  });

  it("retains the draft on POST failure and reports only a generic error", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ campaigns: [] });
    vi.mocked(createCampaign).mockRejectedValue(new Error("private create detail"));
    render(<CampaignLibraryPage onBack={vi.fn()} />);
    await screen.findByText("No campaigns yet.");
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Road" } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await screen.findByText("Campaign could not be created. Please try again.");
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Road");
    expect(screen.queryByText("private create detail")).toBeNull();
    expect(listCampaigns).toHaveBeenCalledOnce();
  });

  it("does not retry a successful POST when its authoritative refresh fails", async () => {
    vi.mocked(listCampaigns).mockResolvedValueOnce({ campaigns: [] }).mockRejectedValueOnce(new Error("refresh detail")).mockResolvedValueOnce({ campaigns: [campaign] });
    vi.mocked(createCampaign).mockResolvedValue({ campaign });
    render(<CampaignLibraryPage onBack={vi.fn()} />);
    await screen.findByText("No campaigns yet.");
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: campaign.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await screen.findByText(`Campaign “${campaign.name}” was created, but the library could not be refreshed.`);
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: campaign.name });
    expect(createCampaign).toHaveBeenCalledOnce();
    expect(listCampaigns).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale initial success after the post-create refresh and preserves focus", async () => {
    const initial = deferred<{ campaigns: [] }>();
    const refresh = deferred<{ campaigns: [typeof campaign] }>();
    vi.mocked(listCampaigns).mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise);
    vi.mocked(createCampaign).mockResolvedValue({ campaign });
    render(<CampaignLibraryPage onBack={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: campaign.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(2));
    refresh.resolve({ campaigns: [campaign] });
    const heading = await screen.findByRole("heading", { name: campaign.name });
    await waitFor(() => expect(heading.closest("li")).toBe(document.activeElement));

    initial.resolve({ campaigns: [] });
    await waitFor(() => expect(screen.getByRole("heading", { name: campaign.name })).toBeTruthy());
    expect(screen.queryByText("No campaigns yet.")).toBeNull();
    expect(screen.getByText(`Campaign “${campaign.name}” created.`)).toBeTruthy();
  });

  it("ignores a stale initial failure after a successful post-create refresh", async () => {
    const initial = deferred<{ campaigns: [] }>();
    const refresh = deferred<{ campaigns: [typeof campaign] }>();
    vi.mocked(listCampaigns).mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise);
    vi.mocked(createCampaign).mockResolvedValue({ campaign });
    render(<CampaignLibraryPage onBack={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: campaign.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(2));
    refresh.resolve({ campaigns: [campaign] });
    await screen.findByRole("heading", { name: campaign.name });
    initial.reject(new Error("stale private failure"));

    await waitFor(() => expect(screen.queryByText("Campaigns could not be loaded.")).toBeNull());
    expect(screen.getByRole("heading", { name: campaign.name })).toBeTruthy();
    expect(screen.queryByText("stale private failure")).toBeNull();
  });

  it("applies only the newest of rapidly ordered manual retries", async () => {
    const olderRetry = deferred<{ campaigns: [] }>();
    const newerRetry = deferred<{ campaigns: [typeof campaign] }>();
    vi.mocked(listCampaigns)
      .mockRejectedValueOnce(new Error("initial failure"))
      .mockReturnValueOnce(olderRetry.promise)
      .mockReturnValueOnce(newerRetry.promise);
    render(<CampaignLibraryPage onBack={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Retry" });

    act(() => {
      retry.click();
      retry.click();
    });
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(3));
    newerRetry.resolve({ campaigns: [campaign] });
    await screen.findByRole("heading", { name: campaign.name });
    olderRetry.resolve({ campaigns: [] });

    await waitFor(() => expect(screen.getByRole("heading", { name: campaign.name })).toBeTruthy());
    expect(screen.queryByText("No campaigns yet.")).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "ignores an unmounted initial GET %s",
    async (outcome) => {
      const initial = deferred<{ campaigns: [] }>();
      vi.mocked(listCampaigns).mockReturnValue(initial.promise);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { unmount } = render(<CampaignLibraryPage onBack={vi.fn()} />);
      unmount();

      if (outcome === "success") initial.resolve({ campaigns: [] });
      else initial.reject(new Error("unmounted GET"));
      await initial.promise.catch(() => undefined);
      await Promise.resolve();
      expect(listCampaigns).toHaveBeenCalledOnce();
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it("does not refresh, retry, or update after unmount during POST", async () => {
    const post = deferred<{ campaign: typeof campaign }>();
    vi.mocked(listCampaigns).mockResolvedValue({ campaigns: [] });
    vi.mocked(createCampaign).mockReturnValue(post.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<CampaignLibraryPage onBack={vi.fn()} />);
    await screen.findByText("No campaigns yet.");
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: campaign.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(createCampaign).toHaveBeenCalledOnce();
    unmount();

    post.resolve({ campaign });
    await post.promise;
    await Promise.resolve();
    expect(createCampaign).toHaveBeenCalledOnce();
    expect(listCampaigns).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("ignores an authoritative GET completion after unmount without repeating POST", async () => {
    const refresh = deferred<{ campaigns: [typeof campaign] }>();
    vi.mocked(listCampaigns).mockResolvedValueOnce({ campaigns: [] }).mockReturnValueOnce(refresh.promise);
    vi.mocked(createCampaign).mockResolvedValue({ campaign });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<CampaignLibraryPage onBack={vi.fn()} />);
    await screen.findByText("No campaigns yet.");
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: campaign.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(2));
    unmount();

    refresh.resolve({ campaigns: [campaign] });
    await refresh.promise;
    await Promise.resolve();
    expect(createCampaign).toHaveBeenCalledOnce();
    expect(listCampaigns).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
