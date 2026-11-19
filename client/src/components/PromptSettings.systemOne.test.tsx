import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptSettings } from "./PromptSettings";
import * as api from "../api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const provider: api.ProviderSettings = {
  id: "provider",
  providerType: "openai-compatible",
  baseUrl: "",
  model: "test",
  hasApiKey: false,
  streaming: false,
  httpReferer: "",
  appTitle: "Velvet",
  requireParameters: false,
  allowFallbacks: true,
  routingSort: "default",
  dataCollection: "default",
  zdr: false,
  requestTimeoutSeconds: 90,
  pricing: { promptPerMillion: null, completionPerMillion: null },
  adventureTurnBudget: { maxTotalTokens: 65_536, maxEstimatedCostUsd: null },
  samplers: {
    maxTokens: null,
    topP: null,
    topK: null,
    minP: null,
    repetitionPenalty: null,
    frequencyPenalty: null,
    presencePenalty: null,
    seed: null,
    reasoningEffort: null,
    stopStrings: [],
    startReplyWith: "",
  },
  updatedAt: "",
};

function show(systemOneAvailable?: boolean) {
  vi.spyOn(api, "listPromptTemplates").mockResolvedValue({ templates: [] });
  // A rejected load keeps the panel's own heading and error text deterministic.
  const getSystemOne = vi.spyOn(api, "getSystemOne").mockRejectedValue(new Error("not under test"));
  render(
    <PromptSettings
      provider={provider}
      harness={null}
      features={{ voice: false, images: false }}
      {...(systemOneAvailable === undefined ? {} : { systemOneAvailable })}
      onProviderChange={() => undefined}
      onHarnessChange={() => undefined}
      onClose={() => undefined}
    />,
  );
  return getSystemOne;
}

describe("PromptSettings optional System One panel", () => {
  it("hides the panel and never calls the System One API by default", async () => {
    const getSystemOne = show();
    await waitFor(() => expect(screen.getByText(/Changes apply to the next generation/)).toBeTruthy());
    expect(screen.queryAllByText(/System One/i)).toHaveLength(0);
    expect(getSystemOne).not.toHaveBeenCalled();
  });

  it("hides the panel when the server reports System One is off", async () => {
    const getSystemOne = show(false);
    await waitFor(() => expect(screen.getByText(/Changes apply to the next generation/)).toBeTruthy());
    expect(screen.queryAllByText(/System One/i)).toHaveLength(0);
    expect(getSystemOne).not.toHaveBeenCalled();
  });

  it("shows the panel and loads its settings only when the server reports System One is on", async () => {
    const getSystemOne = show(true);
    await waitFor(() => expect(getSystemOne).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText(/System One/i).length).toBeGreaterThan(0);
  });
});
