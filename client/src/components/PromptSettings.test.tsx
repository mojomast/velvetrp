import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptSettings } from "./PromptSettings";
import * as api from "../api";

describe("PromptSettings provider preflight", () => {
  it("never probes on load and reports an explicitly requested result", async () => {
    vi.spyOn(api, "listPromptTemplates").mockResolvedValue({ templates: [] });
    const preflight = vi.spyOn(api, "preflightProviderCapabilities").mockResolvedValue({ model: "test", ok: false,
      dmPlayCompatible: true, campaignGenerationCompatible: false, capabilities: [
      { capability: "strict-function-tools", status: "supported" },
      { capability: "strict-json-schema", status: "unavailable", failure: { permanence: "transient", code: "rate-limit", httpStatus: 429, retryAfterMs: 1000 } },
    ] });
    const provider: api.ProviderSettings = { id: "provider", providerType: "openai-compatible", baseUrl: "", model: "test",
      hasApiKey: false, streaming: false, httpReferer: "", appTitle: "Velvet", requireParameters: false, allowFallbacks: true,
      routingSort: "default", dataCollection: "default", zdr: false, requestTimeoutSeconds: 90,
      pricing: { promptPerMillion: null, completionPerMillion: null },
      adventureTurnBudget: { maxTotalTokens: 65_536, maxEstimatedCostUsd: null },
      samplers: { maxTokens: null, topP: null, topK: null, minP: null, repetitionPenalty: null, frequencyPenalty: null,
        presencePenalty: null, seed: null, reasoningEffort: null, stopStrings: [], startReplyWith: "" }, updatedAt: "" };
    render(<PromptSettings provider={provider} harness={null} features={{ voice: false, images: false }}
      onProviderChange={() => undefined} onHarnessChange={() => undefined} onClose={() => undefined} />);
    expect(preflight).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Test provider capabilities" }));
    await waitFor(() => expect(preflight).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toMatch(/DM play function tools: compatible; campaign generation strict JSON: not compatible.*function-tools: supported.*transient rate-limit/);
  });
});
