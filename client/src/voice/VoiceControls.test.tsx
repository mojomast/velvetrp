import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceControls } from "./VoiceControls";

const catalog = { enabled: true, voices: [{ id: "v1", label: "Warm" }], speakers: [{ id: "narrator", label: "Narrator" }], assignments: [], sources: [{ kind: "adventure", id: "s1", label: "Published scene" }] };
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = ""; currentTime = 0; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve()); pause = vi.fn(); load = vi.fn();
  constructor() { FakeAudio.instances.push(this); }
}
const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("hides disabled voice and never requests synthesis on mount", async () => {
  const fetcher = vi.fn((_url: string, _init?: RequestInit) => reply({ ...catalog, enabled: false })); vi.stubGlobal("fetch", fetcher);
  const { container } = render(<VoiceControls campaignId="c1" />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(container.textContent).toBe("");
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/campaigns/c1/voice");
});

it("plays only an explicit selection in caption order, with pause, resume and stop", async () => {
  FakeAudio.instances = []; vi.stubGlobal("Audio", FakeAudio);
  const segments = [{ index: 0, text: "First line", speakerId: "narrator", state: "ready", audioUrl: "/api/campaigns/c1/voice/jobs/j/audio/0" }, { index: 1, text: "Second line", speakerId: "narrator", state: "ready", audioUrl: "/api/campaigns/c1/voice/jobs/j/audio/1" }];
  const fetcher = vi.fn((url: string, init?: RequestInit) => reply(url.endsWith("/voice") ? catalog : init?.method === "DELETE" ? {} : { id: "j", state: "ready", segments: [...segments].reverse() }));
  vi.stubGlobal("fetch", fetcher); render(<VoiceControls campaignId="c1" />);
  fireEvent.change(await screen.findByLabelText("Published voice source"), { target: { value: JSON.stringify(["adventure", "s1"]) } });
  expect(FakeAudio.instances).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Play voice" }));
  await waitFor(() => expect(FakeAudio.instances[0]?.play).toHaveBeenCalledOnce());
  const audio = FakeAudio.instances[0]!;
  expect(audio.src).toBe(segments[0]!.audioUrl); expect(screen.getByText("First line")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pause voice" })); expect(audio.pause).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Resume voice" }));
  await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
  act(() => audio.onended?.());
  await waitFor(() => expect(audio.src).toBe(segments[1]!.audioUrl));
  fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
  expect(audio.src).toBe("");
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/campaigns/c1/voice/jobs/j", expect.objectContaining({ method: "DELETE" })));
  expect(fetcher.mock.calls.every(([url]) => url.startsWith("/api/campaigns/c1/voice"))).toBe(true);
});

it.each(["room-switch", "new-declaration", "generation", "safety-stop"])("cancels and clears playback on %s context change", async (nextContext) => {
  FakeAudio.instances = []; vi.stubGlobal("Audio", FakeAudio);
  const fetcher = vi.fn((url: string, _init?: RequestInit) => reply(url.endsWith("/voice") ? catalog : {
    id: "j", state: "pending", segments: [{ index: 0, text: "Stale caption", speakerId: "narrator", state: "ready", audioUrl: "/api/campaigns/c1/voice/jobs/j/audio/0" }, { index: 1, text: "Next", speakerId: "narrator", state: "pending" }],
  }));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<VoiceControls {...{ campaignId: "c1", contextKey: "original" }} />);
  fireEvent.change(await screen.findByLabelText("Published voice source"), { target: { value: JSON.stringify(["adventure", "s1"]) } });
  fireEvent.click(screen.getByRole("button", { name: "Play voice" }));
  await waitFor(() => expect(FakeAudio.instances[0]?.play).toHaveBeenCalledOnce());
  const audio = FakeAudio.instances[0]!;
  const staleEnded = audio.onended;
  rerender(<VoiceControls {...{ campaignId: "c1", contextKey: nextContext }} />);
  expect(audio.src).toBe("");
  expect(audio.pause).toHaveBeenCalled();
  expect(audio.onended).toBeNull();
  act(() => staleEnded?.());
  await screen.findByLabelText("Published voice source");
  expect(screen.queryByText("Stale caption")).toBeNull();
  expect((screen.getByLabelText("Published voice source") as HTMLSelectElement).value).toBe("");
  expect(fetcher).toHaveBeenCalledWith("/api/campaigns/c1/voice/jobs/j", expect.objectContaining({ method: "DELETE" }));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

const chooseSource = (label: string) => {
  const option = screen.getByRole("option", { name: label }) as HTMLOptionElement;
  fireEvent.change(screen.getByLabelText("Published voice source"), { target: { value: option.value } });
};
it.each([false, true])("reconciles selected kind/id after casting refresh (removed: %s)", async removed => {
  FakeAudio.instances = []; vi.stubGlobal("Audio", FakeAudio);
  const b = { kind: "dm", id: "s1", label: "Source B" };
  let saved = false;
  const fetcher = vi.fn((url: string, _init?: RequestInit) => {
    if (url.endsWith("/casting")) { saved = true; return reply({}); }
    if (url.endsWith("/voice")) return reply({ ...catalog, sources: saved
      ? [...(removed ? [] : [b]), { kind: "adventure", id: "new", label: "New source" }, ...catalog.sources]
      : [...catalog.sources, b] });
    if (url.includes("/sources/")) return reply({ revision: 0, sourceVersion: "a".repeat(64), segments: [{ index: 0, text: "B caption", speakerId: "narrator" }], speakers: catalog.speakers });
    return reply({ id: "j", state: "ready", segments: [{ index: 0, text: "B audio", speakerId: "narrator", audioUrl: "/api/campaigns/c1/voice/jobs/j/audio/0" }] });
  });
  vi.stubGlobal("fetch", fetcher); render(<VoiceControls campaignId="c1" />);
  await screen.findByLabelText("Published voice source"); chooseSource("Source B");
  fireEvent.click(screen.getByRole("button", { name: "Play voice" }));
  await waitFor(() => expect(FakeAudio.instances[0]?.play).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText("Cast & Voices"));
  fireEvent.change(screen.getByLabelText("Voice for Narrator (narrator)"), { target: { value: "v1" } });
  await screen.findByRole("option", { name: "New source" });
  const select = screen.getByLabelText("Published voice source") as HTMLSelectElement;
  if (removed) {
    expect(select.value).toBe("");
    expect(FakeAudio.instances[0]!.src).toBe("");
    expect(screen.queryByText("B audio")).toBeNull();
    for (const name of ["Play voice", "Replay voice", "Edit line speakers"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/campaigns/c1/voice/jobs/j", expect.objectContaining({ method: "DELETE" }));
  } else {
    expect(select.selectedOptions[0]?.textContent).toBe("Source B");
    expect(FakeAudio.instances[0]!.src).not.toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Replay voice" }));
    await waitFor(() => expect(FakeAudio.instances[1]?.play).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init!.body as string))).toEqual([{ kind: "dm", id: "s1" }, { kind: "dm", id: "s1" }]);
    fireEvent.click(screen.getByRole("button", { name: "Edit line speakers" }));
    await screen.findByText("B caption");
    expect(fetcher).toHaveBeenCalledWith("/api/campaigns/c1/voice/sources/dm/s1", expect.anything());
  }
});

it("saves campaign-wide casting by stable ID with revision and reloads persisted choices", async () => {
  let assigned = false;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { assigned = true; return reply({}); }
    return reply({ ...catalog, speakers: [{ id: "npc:a", label: "Mira" }, { id: "npc:b", label: "Mira" }], assignments: assigned ? [{ speakerId: "npc:a", voiceId: "v1", revision: 1 }] : [] });
  });
  vi.stubGlobal("fetch", fetcher);
  const { unmount } = render(<VoiceControls campaignId="c1" />);
  fireEvent.click(await screen.findByText("Cast & Voices"));
  fireEvent.change(screen.getByLabelText("Voice for Mira (npc:a)"), { target: { value: "v1" } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/campaigns/c1/voice/casting", expect.objectContaining({ method: "PUT", body: JSON.stringify({ speakerId: "npc:a", voiceId: "v1", expectedRevision: 0 }) })));
  await waitFor(() => expect((screen.getByLabelText("Voice for Mira (npc:a)") as HTMLSelectElement).value).toBe("v1"));
  expect((screen.getByLabelText("Voice for Mira (npc:b)") as HTMLSelectElement).value).toBe("");
  unmount(); render(<VoiceControls campaignId="c1" />);
  fireEvent.click(await screen.findByText("Cast & Voices"));
  expect((screen.getByLabelText("Voice for Mira (npc:a)") as HTMLSelectElement).value).toBe("v1");
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("edits exact published captions using eligible stable speaker IDs, not rewritten prose", async () => {
  const fetcher = vi.fn((url: string, _init?: RequestInit) => reply(url.endsWith("/voice") ? catalog : { revision: 2, sourceVersion: "b".repeat(64), segments: [{ index: 0, text: "Hello there.", speakerId: "narrator" }], speakers: [{ id: "narrator", label: "Narrator" }, { id: "npc:a", label: "Mira" }] }));
  vi.stubGlobal("fetch", fetcher); render(<VoiceControls campaignId="c1" />);
  fireEvent.change(await screen.findByLabelText("Published voice source"), { target: { value: JSON.stringify(["adventure", "s1"]) } });
  fireEvent.click(screen.getByRole("button", { name: "Edit line speakers" }));
  expect(await screen.findByText("Hello there.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Speaker for line 1"), { target: { value: "npc:a" } });
  fireEvent.click(screen.getByRole("button", { name: "Save line speakers" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/campaigns/c1/voice/sources/adventure/s1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ expectedRevision: 2, sourceVersion: "b".repeat(64), speakerIds: ["npc:a"] }) })));
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("keeps B's unsaved editor choices when A's unmounted save completes", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return new Promise<Response>(resolve => { finish = resolve; });
    if (url.endsWith("/voice")) return reply({ ...catalog, sources: [...catalog.sources, { kind: "dm", id: "b", label: "Source B" }] });
    return reply({ revision: 0, sourceVersion: "c".repeat(64), segments: [{ index: 0, text: url.endsWith("/b") ? "B text" : "A text", speakerId: "narrator" }], speakers: [...catalog.speakers, { id: "npc:a", label: "Mira" }] });
  });
  vi.stubGlobal("fetch", fetcher); render(<VoiceControls campaignId="c1" />);
  await screen.findByLabelText("Published voice source"); chooseSource("Published scene");
  fireEvent.click(screen.getByText("Edit line speakers")); await screen.findByText("A text");
  fireEvent.click(screen.getByText("Save line speakers"));
  chooseSource("Source B"); fireEvent.click(screen.getByText("Edit line speakers"));
  await screen.findByText("B text");
  fireEvent.change(screen.getByLabelText("Speaker for line 1"), { target: { value: "npc:a" } });
  await act(async () => { finish(new Response(JSON.stringify({}))); });
  expect(screen.getByText("B text")).toBeTruthy();
  expect((screen.getByLabelText("Speaker for line 1") as HTMLSelectElement).value).toBe("npc:a");
});

it("refreshes published sources without autoplay and clears an old selection", async () => {
  let refreshed = false;
  vi.stubGlobal("fetch", vi.fn(() => reply({ ...catalog, sources: refreshed ? [{ kind: "dm", id: "new", label: "New publication" }] : catalog.sources })));
  render(<VoiceControls campaignId="c1" />);
  fireEvent.change(await screen.findByLabelText("Published voice source"), { target: { value: JSON.stringify(["adventure", "s1"]) } });
  refreshed = true; fireEvent.click(screen.getByRole("button", { name: "Refresh voices" }));
  await screen.findByRole("option", { name: "New publication" });
  expect((screen.getByLabelText("Published voice source") as HTMLSelectElement).value).toBe("");
  expect((screen.getByRole("button", { name: "Play voice" }) as HTMLButtonElement).disabled).toBe(true);
});
it("detaches stale playback when the campaign or source selection changes", async () => {
  FakeAudio.instances = []; vi.stubGlobal("Audio", FakeAudio);
  const fetcher = vi.fn((url: string, _init?: RequestInit) => reply(url.endsWith("/voice") ? catalog : { id: "j", state: "ready", segments: [{ index: 0, text: "Old line", speakerId: "narrator", audioUrl: "/api/campaigns/c1/voice/jobs/j/audio/0" }] }));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<VoiceControls campaignId="c1" />);
  fireEvent.change(await screen.findByLabelText("Published voice source"), { target: { value: JSON.stringify(["adventure", "s1"]) } });
  fireEvent.click(screen.getByRole("button", { name: "Play voice" }));
  await waitFor(() => expect(FakeAudio.instances[0]?.play).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Published voice source"), { target: { value: "" } });
  expect(FakeAudio.instances[0]!.src).toBe("");
  fireEvent.change(screen.getByLabelText("Published voice source"), { target: { value: JSON.stringify(["adventure", "s1"]) } });
  fireEvent.click(screen.getByRole("button", { name: "Play voice" }));
  await waitFor(() => expect(FakeAudio.instances[1]?.play).toHaveBeenCalled());
  rerender(<VoiceControls campaignId="c2" />);
  expect(FakeAudio.instances[1]!.src).toBe("");
  await screen.findByLabelText("Published voice source");
  expect(screen.queryByText("Old line")).toBeNull();
});
