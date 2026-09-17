import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemOneSettings } from "./SystemOneSettings";
import { getSystemOne, preflightSystemOne, updateSystemOne, type SystemOneSettings as SystemOneSettingsValue } from "../api";

vi.mock("../api", () => ({
  getSystemOne: vi.fn(),
  updateSystemOne: vi.fn(),
  preflightSystemOne: vi.fn(),
}));

function makeSettings(overrides: Partial<SystemOneSettingsValue> = {}): SystemOneSettingsValue {
  const lanes = ["director-selection", "adventure-selection", "narration-verification", "memory-reranking", "speaker-routing", "guardrails", "cost-router"] as const;
  return {
    id: "system-one",
    providerType: "system-one",
    enabled: false,
    shadow: false,
    baseUrl: "https://api.typesafe.ai/v1",
    model: "jev-latest",
    hasApiKey: false,
    requestTimeoutSeconds: 30,
    pricing: { promptPerMillion: 0.042, completionPerMillion: 0 },
    budget: { maxTotalTokens: 65_536, maxEstimatedCostUsd: null, maxRequestsPerWindow: 60, rateWindowMs: 60_000 },
    confidencePolicy: Object.fromEntries(lanes.map((lane) => [lane, { actionThreshold: 0.75, reviewThreshold: 0.5 }])) as SystemOneSettingsValue["confidencePolicy"],
    updatedAt: "",
    ...overrides,
  };
}

describe("SystemOneSettings", () => {
  beforeEach(() => {
    vi.mocked(getSystemOne).mockReset();
    vi.mocked(updateSystemOne).mockReset();
    vi.mocked(preflightSystemOne).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("populates fields from getSystemOne on mount", async () => {
    vi.mocked(getSystemOne).mockResolvedValue(makeSettings({
      enabled: true,
      baseUrl: "https://example.test/v1",
      model: "jev-test",
      requestTimeoutSeconds: 45,
      confidencePolicy: { ...makeSettings().confidencePolicy, "speaker-routing": { actionThreshold: 0.8, reviewThreshold: 0.4 } },
    }));
    render(<SystemOneSettings />);
    expect(await screen.findByDisplayValue("https://example.test/v1")).toBeTruthy();
    expect(screen.getByDisplayValue("jev-test")).toBeTruthy();
    expect(screen.getByDisplayValue("45")).toBeTruthy();
    expect((screen.getByLabelText("Speaker routing action threshold") as HTMLInputElement).value).toBe("0.8");
    expect((screen.getByRole("checkbox", { name: "Enable System One" }) as HTMLInputElement).checked).toBe(true);
  });

  it("saves the edited patch when toggles change", async () => {
    const settings = makeSettings();
    vi.mocked(getSystemOne).mockResolvedValue(settings);
    vi.mocked(updateSystemOne).mockResolvedValue(makeSettings({ enabled: true, shadow: true }));
    render(<SystemOneSettings />);
    const enable = await screen.findByRole("checkbox", { name: "Enable System One" });
    fireEvent.click(enable);
    fireEvent.click(screen.getByRole("checkbox", { name: "Shadow mode" }));
    fireEvent.change(screen.getByDisplayValue("jev-latest"), { target: { value: "jev-1.13.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(updateSystemOne).toHaveBeenCalledTimes(1));
    expect(updateSystemOne).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      shadow: true,
      model: "jev-1.13.0",
      confidencePolicy: expect.objectContaining({ "speaker-routing": { actionThreshold: 0.75, reviewThreshold: 0.5 } }),
    }));
    await screen.findByText("System One settings saved.");
  });

  it("shows a safe success result from preflight", async () => {
    vi.mocked(getSystemOne).mockResolvedValue(makeSettings());
    vi.mocked(preflightSystemOne).mockResolvedValue({ enabled: true, configured: true, model: "jev-live", ok: true, latencyMs: 42, requestId: "req_1" });
    render(<SystemOneSettings />);
    await screen.findByDisplayValue("jev-latest");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/ok/);
    expect(status.textContent).toMatch(/jev-live/);
    expect(status.textContent).toMatch(/42 ms/);
    expect(status.textContent).toMatch(/req_1/);
  });

  it("shows only the classified failure kind, never provider detail", async () => {
    vi.mocked(getSystemOne).mockResolvedValue(makeSettings());
    vi.mocked(preflightSystemOne).mockResolvedValue({ enabled: true, configured: true, model: "jev-live", ok: false,
      failure: { kind: "transport", status: null, retryable: true, detail: "raw provider text with sk-secret" } });
    render(<SystemOneSettings />);
    await screen.findByDisplayValue("jev-latest");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/transport/);
    expect(status.textContent).not.toMatch(/sk-secret/);
    expect(status.textContent).not.toMatch(/raw provider text/);
  });

  it("never renders a stored API key and keeps the key field blank", async () => {
    const settings = makeSettings({ hasApiKey: true });
    (settings as SystemOneSettingsValue & { apiKey?: string }).apiKey = "super-secret-key";
    vi.mocked(getSystemOne).mockResolvedValue(settings);
    render(<SystemOneSettings />);
    await screen.findByDisplayValue("jev-latest");
    expect(screen.queryByText(/super-secret-key/)).toBeNull();
    const keyField = screen.getByLabelText("System One API key") as HTMLInputElement;
    expect(keyField.value).toBe("");
    expect(screen.getByText(/A key is configured/i)).toBeTruthy();
  });
});
