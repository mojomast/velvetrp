import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptSettings } from "./PromptSettings";
import * as api from "../api";

afterEach(() => {
  vi.restoreAllMocks();
});

function provider(overrides: Partial<api.ProviderSettings>): api.ProviderSettings {
  return {
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
    ...overrides,
  };
}

function show(value: api.ProviderSettings) {
  vi.spyOn(api, "listPromptTemplates").mockResolvedValue({ templates: [] });
  vi.spyOn(api, "getSystemOne").mockRejectedValue(new Error("not under test"));
  render(
    <PromptSettings
      provider={value}
      harness={null}
      features={{ voice: false, images: false }}
      onProviderChange={() => undefined}
      onHarnessChange={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe("PromptSettings provider key source", () => {
  it("says the key comes from the environment", () => {
    show(provider({ hasApiKey: true, apiKeySource: "environment" }));
    expect(screen.getByText(/Key: from environment/)).toBeTruthy();
  });

  it("says the key is stored in the database and shows the warning", () => {
    show(
      provider({
        hasApiKey: true,
        apiKeySource: "database",
        apiKeyWarning: "This key is stored in plain text in the database.",
      }),
    );
    expect(screen.getByText(/Key: stored in database/)).toBeTruthy();
    expect(screen.getByText("This key is stored in plain text in the database.")).toBeTruthy();
  });

  it("says not configured when there is no key", () => {
    show(provider({ hasApiKey: false, apiKeySource: "none" }));
    expect(screen.getByText(/Key: not configured/)).toBeTruthy();
  });
});
