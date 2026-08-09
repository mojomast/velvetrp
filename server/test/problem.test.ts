import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createApiProblem } from "../src/http/problem.js";

describe("API problem instances", () => {
  it("preserves the existing structured shape while deriving a path-only instance", () => {
    const request = {
      id: "problem-request",
      url: "/api/rpg/v1/example?token=request-secret",
    } as FastifyRequest;

    expect(createApiProblem(request, 400, "RPG_INVALID_REQUEST", "Request is invalid", {
      violations: ["invalid"],
      issues: [{ path: "name", code: "custom", message: "Name is invalid" }],
    })).toEqual({
      type: "https://velvet.local/problems/rpg-invalid-request",
      title: "Invalid request",
      status: 400,
      detail: "Request is invalid",
      instance: "/api/rpg/v1/example",
      code: "RPG_INVALID_REQUEST",
      requestId: "problem-request",
      error: "Request is invalid",
      violations: ["invalid"],
      issues: [{ path: "name", code: "custom", message: "Name is invalid" }],
    });
  });

  it("replaces concrete campaign IDs with safe route-template instances", () => {
    const request = { id: "problem-override", url: "/ignored?secret=one" } as FastifyRequest;
    const problem = createApiProblem(request, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", {
      instance: "/api/rpg/v1/campaigns/invalid-marker/characters?secret=two",
    });

    expect(problem.instance).toBe("/api/rpg/v1/campaigns/:campaignId/characters");
    expect(JSON.stringify(problem)).not.toMatch(/secret|invalid-marker/);
  });

  it.each([
    ["/api/rpg/v1/campaigns/concrete-marker", "/api/rpg/v1/campaigns/:campaignId"],
    ["/api/rpg/v1/campaigns/%zz-marker/starter-setup", "/api/rpg/v1/campaigns/:campaignId/starter-setup"],
    ["/api/rpg/v1/campaigns/id-marker/characters/creation-options", "/api/rpg/v1/campaigns/:campaignId/characters/creation-options"],
    ["/api/rpg/v1/campaigns/id-marker/characters/lookalike-marker", "/api/rpg/v1/campaigns/:campaignId/*"],
  ])("sanitizes campaign problem instance %s", (url, instance) => {
    const request = { id: "problem-campaign", url: `${url}?query-marker` } as FastifyRequest;
    const problem = createApiProblem(request, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    expect(problem.instance).toBe(instance);
    expect(JSON.stringify(problem)).not.toMatch(/concrete-marker|%zz-marker|id-marker|lookalike-marker|query-marker/);
  });

  it("preserves the static initial-turn reconciliation instance before dynamic turn matching", () => {
    const request = {
      id: "problem-initial-reconcile",
      url: "/api/rpg/v1/adventure-turns/reconcile-initial?campaignId=private-campaign",
    } as FastifyRequest;

    const problem = createApiProblem(request, 400, "RPG_INVALID_REQUEST", "Initial turn reconciliation locator is invalid");
    expect(problem.instance).toBe("/api/rpg/v1/adventure-turns/reconcile-initial");
    expect(JSON.stringify(problem)).not.toContain("private-campaign");
  });
});
