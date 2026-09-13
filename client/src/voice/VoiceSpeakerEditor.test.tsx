import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceSpeakerEditor } from "./VoiceSpeakerEditor";

const source = { kind: "adventure", id: "a" };
const script = (text: string) => ({ revision: 0, sourceVersion: "a".repeat(64), segments: [{ index: 0, text, speakerId: "narrator" }], speakers: [{ id: "narrator", label: "Narrator" }, { id: "npc:a", label: "Mira" }] });
const response = (body: unknown) => new Response(JSON.stringify(body));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["unmount", "source-success", "source-failure"])("fences save completion after %s", async boundary => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => init?.method === "PUT"
    ? new Promise<Response>(resolve => { finish = resolve; })
    : Promise.resolve(response(script(url.endsWith("/a") ? "A text" : "B text")))));
  const onClose = vi.fn();
  const { rerender, unmount } = render(<VoiceSpeakerEditor campaignId="c" source={source} onClose={onClose} />);
  await screen.findByText("A text");
  fireEvent.click(screen.getByRole("button", { name: "Save line speakers" }));
  if (boundary === "unmount") unmount();
  else {
    rerender(<VoiceSpeakerEditor campaignId="c" source={{ ...source, id: "b" }} onClose={onClose} />);
    await screen.findByText("B text");
  }
  await act(async () => { finish(boundary === "source-failure" ? new Response("conflict", { status: 409 }) : response({})); });
  expect(onClose).not.toHaveBeenCalled();
  if (boundary !== "unmount") {
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Save line speakers" }) as HTMLButtonElement).disabled).toBe(false);
  }
});

it("allows the new source to save while an obsolete save is still pending", async () => {
  let finishA!: (value: Response) => void;
  let finishB!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => init?.method === "PUT"
    ? new Promise<Response>(resolve => { if (url.endsWith("/a")) finishA = resolve; else finishB = resolve; })
    : Promise.resolve(response(script(url.endsWith("/a") ? "A text" : "B text")))));
  const onClose = vi.fn();
  const { rerender } = render(<VoiceSpeakerEditor campaignId="c" source={source} onClose={onClose} />);
  await screen.findByText("A text"); fireEvent.click(screen.getByText("Save line speakers"));
  rerender(<VoiceSpeakerEditor campaignId="c" source={{ ...source, id: "b" }} onClose={onClose} />);
  await screen.findByText("B text");
  expect((screen.getByText("Save line speakers") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Speaker for line 1"), { target: { value: "npc:a" } });
  fireEvent.click(screen.getByText("Save line speakers"));
  await act(async () => { finishA(response({})); });
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByText("Save line speakers") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Speaker for line 1") as HTMLSelectElement).value).toBe("npc:a");
  await act(async () => { finishB(response({})); });
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
