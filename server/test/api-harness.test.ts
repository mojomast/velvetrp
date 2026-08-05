import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const defaults = {
  id: "harness",
  systemPrompt: "",
  personaPreamble: "",
  styleGuide: "",
  postHistoryInstructions: "",
  recentTurns: 32,
  memoryChars: 2400,
  summaryChars: 1600,
  loreChars: 1600,
  temperature: 0.8,
  promptOverrides: {},
};

const rawJson = (payload: string) => ({
  headers: { "content-type": "application/json" },
  payload,
});

function expectFullHarness(body: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  expect(Object.keys(body)).toEqual([
    "id",
    "systemPrompt",
    "personaPreamble",
    "styleGuide",
    "postHistoryInstructions",
    "recentTurns",
    "memoryChars",
    "summaryChars",
    "loreChars",
    "temperature",
    "promptOverrides",
    "updatedAt",
  ]);
  expect(body).toMatchObject({ ...defaults, ...fields });
  expect(typeof body.updatedAt).toBe("string");
  expect(new Date(body.updatedAt as string).toISOString()).toBe(body.updatedAt);
}

describe("harness api compatibility", () => {
  it("returns the exact fresh settings and carries the request ID only in the header", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/harness",
      headers: { "x-request-id": "harness-characterization" },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("harness-characterization");
    expect(body).not.toHaveProperty("requestId");
    expectFullHarness(body);
    await app.close();
  });

  it("persists a complete valid patch and retains omitted fields on the next patch", async () => {
    const app = buildApp();
    const complete = {
      systemPrompt: "global system",
      personaPreamble: "persona lead",
      styleGuide: "measured prose",
      postHistoryInstructions: "end on action",
      recentTurns: 14,
      memoryChars: 2100,
      summaryChars: 1400,
      loreChars: 1300,
      temperature: 1.25,
      promptOverrides: { "character.final": "Final for {{target.name}}" },
    };
    const saved = await app.inject({ method: "PUT", url: "/api/harness", payload: complete });
    expect(saved.statusCode).toBe(200);
    expectFullHarness(saved.json(), complete);

    const patched = await app.inject({ method: "PUT", url: "/api/harness", payload: { recentTurns: 9 } });
    expect(patched.statusCode).toBe(200);
    expectFullHarness(patched.json(), { ...complete, recentTurns: 9 });
    expect((await app.inject({ method: "GET", url: "/api/harness" })).json()).toEqual(patched.json());
    await app.close();
  });

  it.each([
    ["systemPrompt", 64_000, "s"],
    ["personaPreamble", 500, "p"],
    ["styleGuide", 900, "g"],
    ["postHistoryInstructions", 700, "h"],
  ] as const)("sanitizes and applies the exact cap to %s", async (field, cap, character) => {
    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/harness",
      payload: { [field]: ` \u0001\u200B${character.repeat(cap + 10)}\u0002\u200D ` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[field]).toBe(character.repeat(cap));
    await app.close();
  });

  it.each([
    ["missing", undefined],
    ["null", rawJson("null")],
    ["string", rawJson('"patch"')],
    ["number", rawJson("7")],
    ["boolean", rawJson("true")],
  ])("returns the exact 400 for a %s top-level body", async (_name, injection) => {
    const app = buildApp();
    const response = await app.inject({ method: "PUT", url: "/api/harness", ...injection });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "harness patch is required" });
    await app.close();
  });

  it.each([
    ["empty object", {}],
    ["array", []],
    ["unknown-only object", { unknown: "value" }],
  ])("accepts a %s as a no-op write and returns the full settings", async (_name, payload) => {
    const app = buildApp();
    const response = await app.inject({ method: "PUT", url: "/api/harness", payload });

    expect(response.statusCode).toBe(200);
    expectFullHarness(response.json());
    await app.close();
  });

  it.each([
    ["systemPrompt", null],
    ["personaPreamble", 12],
    ["styleGuide", false],
    ["postHistoryInstructions", ["invalid"]],
  ])("preserves the current 500 and stored value for non-string %s", async (field, value) => {
    const app = buildApp();
    const seed = await app.inject({ method: "PUT", url: "/api/harness", payload: { [field]: "retained" } });
    expect(seed.statusCode).toBe(200);

    const response = await app.inject({ method: "PUT", url: "/api/harness", payload: { [field]: value } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ statusCode: 500, error: "Internal Server Error", message: expect.any(String) });
    expect((await app.inject({ method: "GET", url: "/api/harness" })).json()[field]).toBe("retained");
    await app.close();
  });

  it("floors and clamps integer fields while ignoring strings, booleans, and null", async () => {
    const app = buildApp();
    const clamped = await app.inject({
      method: "PUT",
      url: "/api/harness",
      payload: { recentTurns: 99.9, memoryChars: -4.8, summaryChars: 345.9, loreChars: 9000.2 },
    });
    expect(clamped.statusCode).toBe(200);
    expect(clamped.json()).toMatchObject({ recentTurns: 32, memoryChars: 200, summaryChars: 345, loreChars: 2000 });

    const ignored = await app.inject({
      method: "PUT",
      url: "/api/harness",
      payload: { recentTurns: "8", memoryChars: true, summaryChars: null, loreChars: "500" },
    });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toMatchObject({ recentTurns: 32, memoryChars: 200, summaryChars: 345, loreChars: 2000 });
    await app.close();
  });

  it("supports temperature null, clamps, fractions, and ignores non-numbers", async () => {
    const app = buildApp();
    for (const [temperature, expected] of [[null, null], [-0.4, 0], [2.4, 2], [0.375, 0.375]] as const) {
      const response = await app.inject({ method: "PUT", url: "/api/harness", payload: { temperature } });
      expect(response.statusCode).toBe(200);
      expect(response.json().temperature).toBe(expected);
    }
    for (const temperature of ["1.2", false, { value: 1 }]) {
      const response = await app.inject({ method: "PUT", url: "/api/harness", payload: { temperature } });
      expect(response.statusCode).toBe(200);
      expect(response.json().temperature).toBe(0.375);
    }
    await app.close();
  });

  it("replaces and filters prompt overrides while capping templates and bypassing ID and placeholder validation", async () => {
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/harness", payload: { promptOverrides: { replaced: "old" } } });
    const template = `{{unknown.placeholder}}${"x".repeat(64_100)}`;
    const response = await app.inject({
      method: "PUT",
      url: "/api/harness",
      payload: {
        promptOverrides: {
          "character.final": template,
          "arbitrary.id": "arbitrary {{anything}}",
          ignoredNumber: 12,
          ignoredArray: [],
          ignoredNull: null,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().promptOverrides).toEqual({
      "character.final": template.slice(0, 64_000),
      "arbitrary.id": "arbitrary {{anything}}",
    });
    const cleared = await app.inject({ method: "PUT", url: "/api/harness", payload: { promptOverrides: {} } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().promptOverrides).toEqual({});
    await app.close();
  });

  it.each([
    ["string", "ab", { "0": "a", "1": "b" }],
    ["array", ["first", 2, "third"], { "0": "first", "2": "third" }],
    ["number", 12, {}],
  ])("preserves the current promptOverrides %s quirk", async (_name, promptOverrides, expected) => {
    const app = buildApp();
    const response = await app.inject({ method: "PUT", url: "/api/harness", payload: { promptOverrides } });

    expect(response.statusCode).toBe(200);
    expect(response.json().promptOverrides).toEqual(expected);
    await app.close();
  });

  it("preserves the current 500 for null promptOverrides without changing storage", async () => {
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/harness", payload: { promptOverrides: { retained: "yes" } } });
    const response = await app.inject({ method: "PUT", url: "/api/harness", payload: { promptOverrides: null } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: expect.any(String),
    });
    expect((await app.inject({ method: "GET", url: "/api/harness" })).json().promptOverrides).toEqual({ retained: "yes" });
    await app.close();
  });

  it("ignores client-supplied id and updatedAt", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/harness",
      payload: { id: "client-id", updatedAt: "1900-01-01T00:00:00.000Z", styleGuide: "saved" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe("harness");
    expect(response.json().updatedAt).not.toBe("1900-01-01T00:00:00.000Z");
    expect(response.json().styleGuide).toBe("saved");
    await app.close();
  });

  it("remains compatible with prompt-template listing and updates", async () => {
    const app = buildApp();
    const bypassed = "Bypassed {{unknown.placeholder}}";
    await app.inject({
      method: "PUT",
      url: "/api/harness",
      payload: { promptOverrides: { "character.final": bypassed, "arbitrary.id": "retained" } },
    });
    const listed = await app.inject({ method: "GET", url: "/api/prompt-templates" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().templates.find((entry: { id: string }) => entry.id === "character.final")).toMatchObject({
      template: bypassed,
      overridden: true,
    });

    const updated = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/character.final",
      payload: { template: "Validated {{target.name}}" },
    });
    expect(updated.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/harness" })).json().promptOverrides).toEqual({
      "character.final": "Validated {{target.name}}",
      "arbitrary.id": "retained",
    });
    await app.close();
  });
});
