import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { PROMPT_TEMPLATES } from "../src/promptTemplates.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const templateIds = [
  "character.safety",
  "character.persona",
  "character.constraints",
  "character.customSystem",
  "character.style",
  "character.lore",
  "character.memory",
  "character.context",
  "character.postHistory",
  "character.final",
  "provider.startReply",
  "room.router.system",
  "room.router.user",
  "room.turn.first",
  "room.turn.followup",
  "continuation.single",
  "continuation.roomRouting",
  "continuation.roomTurn",
  "scene.synthesizer.system",
  "scene.synthesizer.user",
] as const;

const rawJson = (value: string) => ({
  headers: { "content-type": "application/json" },
  payload: value,
});

describe("prompt template api compatibility", () => {
  it("lists the exact default templates in hard-coded order and preserves a caller request ID", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/prompt-templates",
      headers: { "x-request-id": "prompt-templates-characterization" },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("prompt-templates-characterization");
    expect(Object.keys(body)).toEqual(["templates"]);
    expect(body).not.toHaveProperty("requestId");
    expect(body.templates).toHaveLength(20);
    expect(body.templates.map((entry: { id: string }) => entry.id)).toEqual(templateIds);
    expect(body.templates).toEqual(PROMPT_TEMPLATES.map((entry) => ({
      ...entry,
      template: entry.defaultTemplate,
      overridden: false,
    })));
    for (const entry of body.templates) {
      expect(Object.keys(entry)).toEqual([
        "id", "label", "description", "defaultTemplate", "placeholders", "template", "overridden",
      ]);
      expect(entry.template).toBe(entry.defaultTemplate);
      expect(entry.overridden).toBe(false);
    }

    await app.close();
  });

  it("saves a valid override, returns the complete list unchanged otherwise, and persists it", async () => {
    const app = buildApp();
    const before = (await app.inject({ method: "GET", url: "/api/prompt-templates" })).json().templates;
    const template = "CUSTOM FINAL FOR {{target.name}}";
    const saved = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/character.final",
      payload: { template },
    });
    const savedTemplates = saved.json().templates;

    expect(saved.statusCode).toBe(200);
    expect(savedTemplates).toHaveLength(20);
    expect(savedTemplates.map((entry: { id: string }) => entry.id)).toEqual(templateIds);
    expect(savedTemplates.find((entry: { id: string }) => entry.id === "character.final")).toEqual({
      ...PROMPT_TEMPLATES.find((entry) => entry.id === "character.final"),
      template,
      overridden: true,
    });
    expect(savedTemplates.filter((entry: { id: string }) => entry.id !== "character.final")).toEqual(
      before.filter((entry: { id: string }) => entry.id !== "character.final"),
    );

    const subsequent = await app.inject({ method: "GET", url: "/api/prompt-templates" });
    expect(subsequent.statusCode).toBe(200);
    expect(subsequent.json()).toEqual(saved.json());
    await app.close();
  });

  it("resets to the default while preserving another override and unrelated harness fields", async () => {
    const app = buildApp();
    const harnessPatch = { recentTurns: 17, temperature: 0.37 };
    expect((await app.inject({ method: "PUT", url: "/api/harness", payload: harnessPatch })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/character.final",
      payload: { template: "Final {{target.name}}" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/provider.startReply",
      payload: { template: "Opening: {{reply.start}}" },
    })).statusCode).toBe(200);

    const reset = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/character.final",
      payload: { template: null },
    });
    const resetTemplates = reset.json().templates;
    const finalDefinition = PROMPT_TEMPLATES.find((entry) => entry.id === "character.final")!;

    expect(reset.statusCode).toBe(200);
    expect(resetTemplates).toHaveLength(20);
    expect(resetTemplates.find((entry: { id: string }) => entry.id === "character.final")).toEqual({
      ...finalDefinition,
      template: finalDefinition.defaultTemplate,
      overridden: false,
    });
    expect(resetTemplates.find((entry: { id: string }) => entry.id === "provider.startReply")).toMatchObject({
      template: "Opening: {{reply.start}}",
      overridden: true,
    });
    expect((await app.inject({ method: "GET", url: "/api/harness" })).json()).toMatchObject(harnessPatch);
    await app.close();
  });

  it("returns the exact not-found response for an unknown ID", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/unknown.template",
      payload: { template: "anything" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "prompt template not found" });
    await app.close();
  });

  it.each([
    ["missing body", undefined],
    ["null body", rawJson("null")],
    ["missing template", rawJson("{}")],
    ["object template", rawJson('{"template":{}}')],
    ["array template", rawJson('{"template":[]}')],
    ["number template", rawJson('{"template":12}')],
    ["boolean template", rawJson('{"template":false}')],
  ])("returns the exact validation response for a %s", async (_name, injection) => {
    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/character.final",
      ...injection,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "template must be a string or null" });
    await app.close();
  });

  it("accepts exactly 64,000 characters and returns the exact error at 64,001", async () => {
    const app = buildApp();
    const accepted = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/scene.synthesizer.system",
      payload: { template: "x".repeat(64_000) },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().templates.find((entry: { id: string }) => entry.id === "scene.synthesizer.system")).toMatchObject({
      template: "x".repeat(64_000),
      overridden: true,
    });

    const rejected = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/scene.synthesizer.system",
      payload: { template: "x".repeat(64_001) },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "template is too long" });
    await app.close();
  });

  it("accepts every allowed placeholder, including whitespace around names", async () => {
    const app = buildApp();
    const template = "{{user.content}} {{ selected.names }} {{target.name}} {{user.content}}";
    const response = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/room.turn.first",
      payload: { template },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().templates.find((entry: { id: string }) => entry.id === "room.turn.first")).toMatchObject({
      template,
      overridden: true,
    });
    await app.close();
  });

  it("reports unknown placeholders in encounter order without deduplicating", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/prompt-templates/room.turn.first",
      payload: {
        template: "{{ unknown.first }} {{target.name}} {{unknown.second}} {{ unknown.first }} {{selected.names}}",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "unknown prompt placeholders",
      unknownPlaceholders: ["unknown.first", "unknown.second", "unknown.first"],
    });
    await app.close();
  });
});
