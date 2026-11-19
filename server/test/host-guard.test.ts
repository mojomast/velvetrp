import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hostGuardProblem, isAllowedHostname } from "../src/hostGuard.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENROUTER_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_MODEL", "OPENAI_MODEL"]) {
  delete process.env[name];
}
useTmpDataDir();

const previousAllowed = process.env.VELVET_ALLOWED_HOSTS;
afterEach(() => {
  if (previousAllowed === undefined) delete process.env.VELVET_ALLOWED_HOSTS;
  else process.env.VELVET_ALLOWED_HOSTS = previousAllowed;
});

const preflight = (headers: Record<string, string>) => ({
  method: "POST" as const,
  url: "/api/provider/preflight",
  headers: { "content-type": "application/json", ...headers },
  payload: "{}",
});

describe("host guard unit rules", () => {
  it("allows loopback hostnames on any port and nothing else by default", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"]) expect(isAllowedHostname(host, {})).toBe(true);
    for (const host of ["evil.example", "localhost.evil.example", "127.0.0.1.nip.io", "0.0.0.0", ""]) expect(isAllowedHostname(host, {})).toBe(false);
  });

  it("adds VELVET_ALLOWED_HOSTS entries, trimmed, with a leading dot meaning any subdomain", () => {
    const env = { VELVET_ALLOWED_HOSTS: " velvet.lan , ,.tail.example" };
    expect(isAllowedHostname("velvet.lan", env)).toBe(true);
    expect(isAllowedHostname("a.tail.example", env)).toBe(true);
    expect(isAllowedHostname("tail.example", env)).toBe(true);
    expect(isAllowedHostname("other.example", env)).toBe(false);
    expect(isAllowedHostname("evilvelvet.lan", env)).toBe(false);
  });

  it("returns a problem for a bad host or a foreign write origin and null when allowed", () => {
    expect(hostGuardProblem("GET", { host: "localhost:8787" }, {})).toBeNull();
    expect(hostGuardProblem("GET", { host: "evil.example" }, {})).toMatchObject({ statusCode: 403, code: "VELVET_HOST_NOT_ALLOWED" });
    expect(hostGuardProblem("GET", {}, {})).toMatchObject({ statusCode: 403, code: "VELVET_HOST_NOT_ALLOWED" });
    expect(hostGuardProblem("POST", { host: "localhost:8787", origin: "https://evil.example" }, {}))
      .toMatchObject({ statusCode: 403, code: "VELVET_ORIGIN_NOT_ALLOWED" });
    expect(hostGuardProblem("POST", { host: "localhost:8787", origin: "null" }, {}))
      .toMatchObject({ statusCode: 403, code: "VELVET_ORIGIN_NOT_ALLOWED" });
    expect(hostGuardProblem("DELETE", { host: "localhost:8787", "sec-fetch-site": "cross-site" }, {}))
      .toMatchObject({ statusCode: 403, code: "VELVET_ORIGIN_NOT_ALLOWED" });
    expect(hostGuardProblem("POST", { host: "localhost:8787", origin: "http://localhost:8787" }, {})).toBeNull();
    expect(hostGuardProblem("POST", { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" }, {})).toBeNull();
    expect(hostGuardProblem("POST", { host: "localhost:8787" }, {})).toBeNull();
    // Reads may carry a foreign Origin (no CORS headers are sent, so the browser cannot read the body).
    expect(hostGuardProblem("GET", { host: "localhost:8787", origin: "https://evil.example" }, {})).toBeNull();
  });
});

describe("host guard on the API", () => {
  it("serves loopback hosts and rejects any other Host with 403", async () => {
    const app = buildApp();
    try {
      for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787", "localhost"]) {
        const ok = await app.inject({ method: "GET", url: "/api/health", headers: { host } });
        expect(ok.statusCode, host).toBe(200);
      }
      const bad = await app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example" } });
      expect(bad.statusCode).toBe(403);
      expect(bad.json()).toMatchObject({ code: "VELVET_HOST_NOT_ALLOWED" });
      const rebinding = await app.inject({ method: "GET", url: "/api/provider", headers: { host: "attacker.example:8787" } });
      expect(rebinding.statusCode).toBe(403);
      expect(rebinding.body).not.toMatch(/baseUrl|model/);
    } finally {
      await app.close();
    }
  });

  it("accepts hosts listed in VELVET_ALLOWED_HOSTS", async () => {
    process.env.VELVET_ALLOWED_HOSTS = "velvet.lan,.tail.example";
    const app = buildApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "velvet.lan:8787" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "box.tail.example" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "other.example" } })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rejects writes from a foreign Origin and allows same-origin, loopback and no-Origin writes", async () => {
    const app = buildApp();
    try {
      const foreign = await app.inject(preflight({ host: "localhost:8787", origin: "https://evil.example" }));
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json()).toMatchObject({ code: "VELVET_ORIGIN_NOT_ALLOWED" });
      const crossSite = await app.inject(preflight({ host: "localhost:8787", "sec-fetch-site": "cross-site" }));
      expect(crossSite.statusCode).toBe(403);
      for (const headers of [
        { host: "localhost:8787", origin: "http://localhost:8787" },
        { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" },
        { host: "localhost:8787" },
      ]) {
        const allowed = await app.inject(preflight(headers));
        expect(allowed.statusCode, JSON.stringify(headers)).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
