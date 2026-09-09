import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignOverviewPage } from "./CampaignOverviewPage";

const stamp = "2030-01-01T00:00:00.000Z";
let role = "owner";
let active = false;
let ready = true;
let blockers: string[] = [];
let posts: string[] = [];
let uncertain = false;
const readiness = () => ({ campaignId: "campaign-one", sessionId: "session-one", expectedRevision: 3, active, ready, blockers, actorIds: ["actor-one"] });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const props = { campaignId: "campaign-one", destination: "overview" as const, mechanics: true, onAdvanced: vi.fn(), onBuilder: vi.fn(), onCharacter: vi.fn(), onRoom: vi.fn() };
beforeEach(() => {
  localStorage.clear(); role = "owner"; active = false; ready = true; blockers = []; posts = []; uncertain = false; vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/activation-readiness")) return json(readiness());
    if (url.endsWith("/activation-commands")) {
      posts.push(String(init?.body)); active = true;
      if (uncertain && posts.length === 1) throw new TypeError("response lost");
      const body = JSON.parse(String(init?.body));
      return json({ readiness: readiness(), receipt: { commandId: "command-one", idempotencyKey: body.idempotencyKey, occurredAt: stamp, activated: true, placedActorIds: ["actor-one"], reconciledNpcCount: 0 } });
    }
    if (url.endsWith("/characters")) return json({ characters: [{ id: "campaign-character-one", characterId: "persona-one", name: "Rowan" }] });
    if (url.endsWith("/rooms")) return json({ attached: [{ sessionId: "session-one", title: "The crossing", participantNames: ["Rowan"], createdAt: stamp, attachedAt: stamp, stopped: false }], eligible: [] });
    return json({ campaign: { id: "campaign-one", name: "Salt Road", actorRole: role, content: { status: "unconfigured" }, createdAt: stamp, updatedAt: stamp } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("task-focused campaign entry", () => {
  it("explains next steps and keeps normal preparation in the new workspace", async () => {
    render(<CampaignOverviewPage {...props} />);
    await screen.findByText("Choose your campaign rules");
    fireEvent.click(screen.getByRole("button", { name: "Open Rowan" }));
    expect(props.onCharacter).toHaveBeenCalledWith("campaign-character-one");
    fireEvent.click(screen.getByRole("button", { name: "Continue preparation" }));
    await screen.findByTestId("campaign-preparation");
    expect(props.onAdvanced).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
  it("recovers uncertain activation across remount using the exact persisted command", async () => {
    uncertain = true;
    const page = render(<CampaignOverviewPage {...props} destination="rooms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check room readiness" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start room" }));
    await screen.findByText(/Start outcome uncertain/);
    expect(props.onRoom).not.toHaveBeenCalled();
    page.unmount();
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check room readiness" }));
    await screen.findByText(/Active room requires command recovery/);
    expect(screen.queryByRole("button", { name: "Enter adventure" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact room start" }));
    await screen.findByText(/Activation receipt confirmed/);
    expect(posts).toHaveLength(2); expect(posts[0]).toBe(posts[1]);
    fireEvent.click(screen.getByRole("button", { name: "Check room readiness" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enter adventure" }));
    expect(props.onRoom).toHaveBeenCalledWith("session-one");
  });
  it("does not grant observers activation controls and refreshes the actual role", async () => {
    const page = render(<CampaignOverviewPage {...props} destination="rooms" />);
    await screen.findByRole("button", { name: "Check room readiness" });
    role = "observer"; fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "Open room" });
    expect(screen.queryByRole("button", { name: "Check room readiness" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build a character" })).toBeNull();
    page.unmount();
  });
  it("enters an authoritatively active and ready room without posting a start command", async () => {
    active = true;
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check room readiness" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enter adventure" }));
    expect(props.onRoom).toHaveBeenCalledWith("session-one");
    expect(screen.queryByRole("button", { name: "Start room" })).toBeNull();
    expect(posts).toHaveLength(0);
  });
  it("starts a setup-ready room that is not active", async () => {
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check room readiness" }));
    await screen.findByText(/Setup is ready/);
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    await screen.findByText(/Activation receipt confirmed/);
    expect(posts).toHaveLength(1);
  });
  it("links readiness blockers to campaign preparation", async () => {
    ready = false; blockers = ["campaign-not-published"];
    render(<CampaignOverviewPage {...props} destination="rooms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check room readiness" }));
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
    await waitFor(() => expect(posts).toHaveLength(0));
  });
});
