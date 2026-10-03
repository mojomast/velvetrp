import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignOverviewPage } from "./CampaignOverviewPage";

const stamp = "2030-01-01T00:00:00.000Z";
const pendingKey = "velvet.room-activation.v1:campaign-one:session-one";
let role = "owner";
let active = false;
let ready = true;
let stopped = false;
let hasParty = true;
let hasRooms = true;
let blockers: string[] = [];
let posts: string[] = [];
let uncertain = false;
let activationStatus = 200;
let expectedRevision = 3;
let readinessReads = 0;
let readResponse: (() => Response | Promise<Response>) | undefined;
const readiness = () => ({ campaignId: "campaign-one", sessionId: "session-one", expectedRevision, active, ready, blockers, actorIds: ["actor-one"] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const props = { campaignId: "campaign-one", destination: "overview" as const, mechanics: true, onAdvanced: vi.fn(), onBuilder: vi.fn(), onCharacter: vi.fn(), onRoom: vi.fn() };
beforeEach(() => {
  localStorage.clear(); role = "owner"; active = false; ready = true; stopped = false; hasParty = true; hasRooms = true; blockers = []; posts = []; uncertain = false; activationStatus = 200; expectedRevision = 3; readinessReads = 0; readResponse = undefined; vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/activation-readiness")) {
      readinessReads += 1;
      return readResponse ? readResponse() : json(readiness());
    }
    if (url.endsWith("/activation-commands")) {
      posts.push(String(init?.body));
      if (activationStatus !== 200) return json({ error: "rejected" }, activationStatus);
      active = true;
      if (uncertain && posts.length === 1) throw new TypeError("response lost");
      const body = JSON.parse(String(init?.body));
      return json({ readiness: { ...readiness(), expectedRevision: body.expectedRevision }, receipt: { commandId: "command-one", idempotencyKey: body.idempotencyKey, occurredAt: stamp, activated: true, placedActorIds: ["actor-one"], reconciledNpcCount: 0 } });
    }
    if (url.endsWith("/characters")) return json({ characters: hasParty ? [{ id: "campaign-character-one", characterId: "persona-one", name: "Rowan" }] : [] });
    if (url.endsWith("/rooms")) return json({ attached: hasRooms ? [{ sessionId: "session-one", title: "The crossing", participantNames: ["Rowan"], createdAt: stamp, attachedAt: stamp, stopped }] : [], eligible: [] });
    return json({ campaign: { id: "campaign-one", name: "Salt Road", actorRole: role, content: { status: "unconfigured" }, createdAt: stamp, updatedAt: stamp } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("task-focused campaign entry", () => {
  it("leads an existing party and room toward Sessions and keeps setup secondary", async () => {
    render(<CampaignOverviewPage {...props} />);
    await screen.findByRole("heading", { name: "Gather your party and play" });
    fireEvent.click(screen.getByRole("button", { name: "Go to Sessions" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Sessions" }));
    expect(screen.getByRole("list", { name: "How to play" }).textContent).toContain("Choose a hero");
    expect(screen.getAllByRole("button", { name: "Open advanced setup" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open Rowan" }));
    expect(props.onCharacter).toHaveBeenCalledWith("campaign-character-one");
    fireEvent.click(screen.getByRole("button", { name: "Continue preparation" }));
    await screen.findByTestId("campaign-preparation");
    expect(props.onAdvanced).not.toHaveBeenCalled();
    expect(props.onRoom).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
  it("keeps initial preparation available for a campaign without a party or room", async () => {
    hasParty = false; hasRooms = false;
    render(<CampaignOverviewPage {...props} />);
    await screen.findByText("Choose your campaign rules");
    expect(screen.queryByRole("button", { name: "Go to Sessions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue preparation" }));
    await screen.findByTestId("campaign-preparation");
    expect(props.onAdvanced).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
  it("auto-reads saved pending recovery across remount and focus without replacing or replaying its command", async () => {
    uncertain = true;
    const page = render(<CampaignOverviewPage {...props} destination="rooms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start room" }));
    await screen.findByText(/Start outcome uncertain/);
    const saved = localStorage.getItem(pendingKey);
    expect(saved).toBe(posts[0]);
    expect(props.onRoom).not.toHaveBeenCalled();
    page.unmount();
    expectedRevision = 9;
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByText(/Active room requires command recovery/);
    expect(readinessReads).toBe(2);
    fireEvent(window, new Event("focus"));
    await screen.findByText(/Current state read. The saved command still requires exact retry/);
    expect(readinessReads).toBe(3);
    expect(localStorage.getItem(pendingKey)).toBe(saved);
    expect(posts).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact room start" }));
    const enter = await screen.findByRole("button", { name: "Enter adventure" });
    expect(posts).toHaveLength(2); expect(posts[0]).toBe(posts[1]);
    expect(JSON.parse(posts[1]!)).toMatchObject({ expectedRevision: 3 });
    expect(readinessReads).toBe(4);
    expect(localStorage.getItem(pendingKey)).toBeNull();
    fireEvent.click(enter);
    expect(props.onRoom).toHaveBeenCalledWith("session-one");
  });
  it("retains a saved pending command after a later rejected retry and a manual readiness read", async () => {
    const saved = JSON.stringify({ expectedRevision: 2, idempotencyKey: "saved-room-start" });
    localStorage.setItem(pendingKey, saved);
    active = true; expectedRevision = 9; activationStatus = 409;
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByText(/Active room requires command recovery/);
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact room start" }));
    await screen.findByText(/Start outcome uncertain/);
    expect(posts).toEqual([saved]);
    expect(localStorage.getItem(pendingKey)).toBe(saved);
    fireEvent.click(screen.getByRole("button", { name: "Check room readiness" }));
    await screen.findByText(/Active room requires command recovery/);
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    expect(localStorage.getItem(pendingKey)).toBe(saved);
    expect(posts).toEqual([saved]);
  });
  it("releases only a definitively rejected first command and requires a fresh read before a new start", async () => {
    activationStatus = 409;
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start room" }));
    await screen.findByText(/Start rejected/);
    expect(localStorage.getItem(pendingKey)).toBeNull();
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry exact room start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check room readiness" }));
    await screen.findByRole("button", { name: "Start room" });
    expect(posts).toHaveLength(1);
  });
  it("does not grant observers activation controls and refreshes the actual role", async () => {
    const page = render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByRole("button", { name: "Start room" });
    role = "observer"; fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "Open room" });
    expect(screen.queryByRole("button", { name: "Check room readiness" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build a character" })).toBeNull();
    page.unmount();
  });
  it("automatically reads on mount and offers entry only once active readiness is confirmed", async () => {
    active = true;
    const initialRead = deferred<Response>();
    readResponse = () => initialRead.promise;
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByText("Checking room readiness...");
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    expect(posts).toHaveLength(0);
    await act(async () => { initialRead.resolve(json(readiness())); });
    fireEvent.click(await screen.findByRole("button", { name: "Enter adventure" }));
    expect(props.onRoom).toHaveBeenCalledWith("session-one");
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    expect(readinessReads).toBe(1);
    expect(posts).toHaveLength(0);
  });
  it("refreshes on focus to offer entry and removes stale entry while rechecking blockers", async () => {
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByRole("button", { name: "Start room" });
    active = true;
    fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "Enter adventure" });
    expect(readinessReads).toBe(2);
    expect(posts).toHaveLength(0);

    const focusRead = deferred<Response>();
    readResponse = () => focusRead.promise;
    ready = false; blockers = ["safety-paused"];
    fireEvent(window, new Event("focus"));
    await screen.findByText("Checking room readiness...");
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    await act(async () => { focusRead.resolve(json(readiness())); });
    await screen.findByText(/Preparation required/);
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    expect(readinessReads).toBe(3);
    expect(posts).toHaveLength(0);
  });
  it("automatically re-reads after activation and waits for current readiness before offering entry", async () => {
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByText(/Setup is ready/);
    const afterActivation = deferred<Response>();
    readResponse = () => afterActivation.promise;
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    await screen.findByText("Activation receipt confirmed. Checking room readiness...");
    expect(readinessReads).toBe(2);
    expect(localStorage.getItem(pendingKey)).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    expect((screen.getByRole("button", { name: "Check room readiness" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { afterActivation.resolve(json(readiness())); });
    await screen.findByRole("button", { name: "Enter adventure" });
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    expect(props.onRoom).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });
  it("keeps a confirmed receipt cleared if the follow-up read fails and offers explicit read recovery", async () => {
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByRole("button", { name: "Start room" });
    readResponse = () => { throw new TypeError("read unavailable"); };
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    await screen.findByText(/Activation receipt confirmed. Readiness unavailable/);
    expect(localStorage.getItem(pendingKey)).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry exact room start" })).toBeNull();
    readResponse = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Check room readiness" }));
    await screen.findByRole("button", { name: "Enter adventure" });
    expect(posts).toHaveLength(1);
  });
  it("does not infer readiness from an attached, non-stopped room when its initial read fails", async () => {
    active = true;
    readResponse = () => { throw new TypeError("read unavailable"); };
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByText(/Readiness unavailable/);
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    readResponse = undefined;
    fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "Enter adventure" });
    expect(posts).toHaveLength(0);
  });
  it("keeps stopped rooms out of the activation flow", async () => {
    stopped = true;
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByRole("button", { name: "Open room" });
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check room readiness" })).toBeNull();
    expect(readinessReads).toBe(0);
    expect(posts).toHaveLength(0);
  });
  it("links readiness blockers to campaign preparation", async () => {
    ready = false; blockers = ["campaign-not-published"];
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByText(/Preparation required/);
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review preparation" }));
    await screen.findByTestId("campaign-preparation");
    expect(posts).toHaveLength(0);
  });
  it("keeps party and rooms as separate destinations", async () => {
    render(<CampaignOverviewPage {...props} destination="party" />);
    await screen.findByRole("button", { name: "Open Rowan" });
    expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
    expect(readinessReads).toBe(0);
    await waitFor(() => expect(posts).toHaveLength(0));
  });
});
