import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Character, ProviderSettings, Session } from "../api";
import { CharacterLibraryPage, type CharacterLibraryPageProps } from "./CharacterLibraryPage";

const aria: Character = { id: "char-1", name: "Aria", age: 29, archetype: "Confidant", boundaries: "fictional adults only", safeWord: "anchor", fictionalConfirmed: true, isRealPerson: false, createdAt: "2026-01-01T00:00:00.000Z" };
const rowan: Character = { ...aria, id: "char-2", name: "Rowan", archetype: "Mysterious stranger", safeWord: "harbor" };
const session: Session = { id: "sess-1", characterId: aria.id, primaryCharacterId: aria.id, participants: [aria, rowan], title: "Night watch", state: "active", presetId: "default", activeLeafId: null, createdAt: "2026-01-01T00:00:00.000Z", stoppedAt: null, stopReason: null };
const provider = { id: "provider", providerType: "openai-compatible", model: "test-model", streaming: false } as ProviderSettings;

function props(overrides: Partial<CharacterLibraryPageProps> = {}): CharacterLibraryPageProps {
  return {
    characters: [aria, rowan], sessions: [session], selectedIds: [aria.id, rowan.id], primaryId: aria.id,
    busy: false, error: "Character library warning", provider, campaignLibraryAvailable: false, onCampaigns: vi.fn(),
    onSelected: vi.fn(), onPrimary: vi.fn(), onCreate: vi.fn(), onEdit: vi.fn(), onMemory: vi.fn(), onLore: vi.fn(),
    onStart: vi.fn(), onResume: vi.fn(), onDeleteSession: vi.fn(), onDelete: vi.fn(), onExport: vi.fn(), onImport: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("CharacterLibraryPage compatibility", () => {
  it("preserves representative markup, labels, state, and callback payloads", () => {
    const callbacks = props();
    const { container } = render(<CharacterLibraryPage {...callbacks} />);

    expect(container.firstElementChild?.className).toBe("page library-page");
    expect(container.querySelector("main > .library-shell > .library-header")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Velvet" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Character library warning");
    expect(screen.getByText("openai-compatible · buffered")).toBeTruthy();
    expect(screen.getByText("Night watch")).toBeTruthy();

    const cards = container.querySelectorAll(".character-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.className).toBe("character-card selected");
    expect(cards[1]?.className).toBe("character-card selected");

    const checks = screen.getAllByRole("checkbox");
    fireEvent.click(checks[1]!);
    expect(callbacks.onSelected).toHaveBeenCalledWith([aria.id]);
    fireEvent.click(checks[0]!);
    expect(callbacks.onSelected).toHaveBeenCalledWith([rowan.id]);
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(callbacks.onPrimary).toHaveBeenCalledWith(rowan.id);

    fireEvent.change(screen.getByLabelText("Session title"), { target: { value: "  Shared mystery  " } });
    fireEvent.click(screen.getByRole("button", { name: "Start new session" }));
    expect(callbacks.onStart).toHaveBeenCalledWith("  Shared mystery  ");

    fireEvent.click(screen.getByRole("button", { name: "New character" }));
    fireEvent.click(screen.getByRole("button", { name: "World lore" }));
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
    expect(callbacks.onLore).toHaveBeenCalledOnce();

    const ariaCard = cards[0] as HTMLElement;
    fireEvent.click(within(ariaCard).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(ariaCard).getByRole("button", { name: "Memory" }));
    fireEvent.click(within(ariaCard).getByRole("button", { name: "Export" }));
    fireEvent.click(within(ariaCard).getByRole("button", { name: "Delete" }));
    expect(callbacks.onEdit).toHaveBeenCalledWith(aria.id);
    expect(callbacks.onMemory).toHaveBeenCalledWith(aria.id);
    expect(callbacks.onExport).toHaveBeenCalledWith(aria);
    expect(callbacks.onDelete).toHaveBeenCalledWith(aria);

    fireEvent.click(screen.getByRole("button", { name: /^Night watch/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete session: Night watch" }));
    expect(callbacks.onResume).toHaveBeenCalledWith(session.id);
    expect(callbacks.onDeleteSession).toHaveBeenCalledWith(session);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe("application/json,.json");
    const file = new File(["{}"], "aria.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(callbacks.onImport).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  it("preserves empty and unavailable-provider states", () => {
    const callbacks = props({ characters: [], sessions: [], selectedIds: [], primaryId: "", error: null, provider: null });
    render(<CharacterLibraryPage {...callbacks} />);
    expect(screen.getByText("No characters yet.")).toBeTruthy();
    expect(screen.getByText("No sessions yet.")).toBeTruthy();
    expect(screen.getByText("Local story engine")).toBeTruthy();
    expect(screen.getByText("Provider unavailable")).toBeTruthy();
    expect(screen.queryByLabelText("Session title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create your first character" }));
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
  });

  it("renders feature-owned campaign navigation and invokes its callback", () => {
    const callbacks = props({ campaignLibraryAvailable: true });
    render(<CharacterLibraryPage {...callbacks} />);

    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    expect(callbacks.onCampaigns).toHaveBeenCalledOnce();
  });
});
