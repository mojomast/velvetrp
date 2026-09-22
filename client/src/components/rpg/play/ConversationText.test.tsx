import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationText, SpeakerName, speakerColor } from "./ConversationText";
import { findActiveSceneImage } from "./sceneImages";
import type { SceneImageGalleryItem } from "../../../api";
afterEach(cleanup);
describe("readable conversation", () => {
  it("keeps name colors stable and names visible", () => {
    expect(speakerColor("aster")).toBe(speakerColor("aster"));
    expect(speakerColor("aster")).not.toBe(speakerColor("bram"));
    render(<SpeakerName identity="aster" name="Aster" />);
    expect(screen.getByText("Aster").getAttribute("style")).toContain(speakerColor("aster"));
  });
  it("separates paragraphs, speech and actions without interpreting HTML", () => {
    const { container } = render(<ConversationText kind="narration" text={'The door opens.\n\n“Welcome.” *bows* <img src=x onerror=alert(1)>'} />);
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector("q")?.textContent).toBe("Welcome.");
    expect(container.querySelector("em")?.textContent).toBe("bows");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("narration")).toBeTruthy();
  });
  it("formats dice notation without rolling or changing its value", () => {
    const { container } = render(<ConversationText kind="narration" text="Roll 1d20 + 3 to attempt this." />);
    expect(container.querySelector("code")?.textContent).toBe("1d20 + 3");
  });
  it("does not lose incomplete streaming text", () => {
    const { container, rerender } = render(<ConversationText kind="narration" text={'“Wait'} />);
    expect(container.textContent).toContain('“Wait');
    rerender(<ConversationText kind="narration" text={'“Wait.”'} />);
    expect(container.querySelector("q")?.textContent).toBe("Wait.");
  });
});
describe("authoritative artwork", () => {
  const image: SceneImageGalleryItem = { assetId: "a", jobId: "j", prompt: "A gate", seed: 1, steps: 20, guidance: 3, status: "ready", selected: true, createdAt: "2030-01-01T00:00:00.000Z" };
  it("never guesses from unbound or unpublished images", () => {
    expect(findActiveSceneImage([image], "gate", [])).toBeNull();
    expect(findActiveSceneImage([{ ...image, sceneKey: "gate", selected: false }], "gate", [])).toBeNull();
  });
  it("uses server bindings without browser storage and can reuse an asset", () => {
    const bound = { ...image, selections: [{ sceneKey: "gate", revision: 2 }, { sceneKey: "harbor", revision: 1 }] };
    expect(findActiveSceneImage([bound], "gate", [])?.assetId).toBe("a");
    expect(findActiveSceneImage([bound], "harbor", [])?.assetId).toBe("a");
    expect(findActiveSceneImage([bound], "cave", [])).toBeNull();
  });
});
