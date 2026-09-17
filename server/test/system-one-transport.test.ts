import { describe, expect, it } from "vitest";
import { buildSystemOneHeaders, canUseSystemOne, validateSystemOneBaseUrl } from "../src/provider/providerTransport.js";

describe("System One transport policy", () => {
  it("accepts https and loopback http only", () => {
    expect(validateSystemOneBaseUrl("https://api.typesafe.ai/v1")).toEqual({ ok: true });
    expect(validateSystemOneBaseUrl("http://127.0.0.1:18999")).toEqual({ ok: true });
    expect(validateSystemOneBaseUrl("http://localhost:18999/v1")).toEqual({ ok: true });
    expect(validateSystemOneBaseUrl("http://api.typesafe.ai/v1").ok).toBe(false);
    expect(validateSystemOneBaseUrl("https://example.test/v1")).toEqual({ ok: true });
    expect(validateSystemOneBaseUrl("not a url").ok).toBe(false);
    expect(validateSystemOneBaseUrl("ftp://api.typesafe.ai").ok).toBe(false);
  });

  it("requires a key for the hosted host and allows keyless loopback", () => {
    expect(canUseSystemOne({ baseUrl: "https://api.typesafe.ai/v1", apiKey: "" })).toBe(false);
    expect(canUseSystemOne({ baseUrl: "https://api.typesafe.ai/v1", apiKey: "secret" })).toBe(true);
    expect(canUseSystemOne({ baseUrl: "http://127.0.0.1:18999", apiKey: "" })).toBe(true);
    expect(canUseSystemOne({ baseUrl: "https://example.test/v1", apiKey: "secret" })).toBe(false);
    expect(canUseSystemOne({ baseUrl: "", apiKey: "secret" })).toBe(false);
  });

  it("sends the credential only to the allowlisted host or loopback", () => {
    expect(buildSystemOneHeaders("https://api.typesafe.ai/v1", " secret ")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(buildSystemOneHeaders("https://api.typesafe.ai/v1", "")).toEqual({ "Content-Type": "application/json" });
    expect(buildSystemOneHeaders("http://127.0.0.1:18999", "secret")).toHaveProperty("Authorization", "Bearer secret");
    expect(buildSystemOneHeaders("https://example.test/v1", "secret")).toEqual({ "Content-Type": "application/json" });
  });
});
