import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runReviewedAdventure } from "../run-reviewed-adventure.js";
import { REVIEWED_ADVENTURE_MANIFEST_DIGEST } from "../../server/test/fixtures/reviewedAdventure.js";
import { ProviderConfigurationError } from "../../server/src/provider/index.js";

const fakeProvider: any = { providerType: "openai-compatible", model: "test", baseUrl: "https://example.invalid/v1", pricing: { promptPerMillion: 1, completionPerMillion: 1 }, samplers: { maxTokens: null } };
async function sandbox() { const root = await mkdtemp(path.join(tmpdir(), "velvet-reviewed-runner-")); const target = path.join(root, "target"); await mkdir(target); return { root, target, ledger: path.join(root, "ledger.json") }; }
test("provider-free preflight never dispatches", async () => { const box = await sandbox(); let calls = 0; try { const result = await runReviewedAdventure({ target: box.target, ledger: box.ledger, complete: async () => { calls++; throw new Error("network"); } }); assert.equal(result.mode, "provider-free"); assert.equal(calls, 0); } finally { await rm(box.root, { recursive: true, force: true }); } });
test("live guards reject pricing, cap, mismatch, resume, and unknown outcomes", async () => { const box = await sandbox(); try {
  await assert.rejects(() => runReviewedAdventure({ target: box.target, ledger: box.ledger, live: true, provider: async () => ({ ...fakeProvider, pricing: { promptPerMillion: null, completionPerMillion: null } }) }), /pricing/);
  await assert.rejects(() => runReviewedAdventure({ target: box.target, ledger: box.ledger, live: true, maxCalls: 0, provider: async () => fakeProvider }), /cap/);
  await runReviewedAdventure({ target: box.target, ledger: box.ledger, live: false });
  await assert.rejects(() => runReviewedAdventure({ target: box.target, ledger: box.ledger, live: false }), /duplicate/);
  const saved = JSON.parse(await readFile(box.ledger, "utf8")); saved.state = "unknown"; await (await import("node:fs/promises")).writeFile(box.ledger, JSON.stringify(saved)); await assert.rejects(() => runReviewedAdventure({ target: box.target, ledger: box.ledger, live: false }), /unknown/);
} finally { await rm(box.root, { recursive: true, force: true }); } });
test("failed preflight, provider mismatch, and dispatch failure stay network-free and fail closed", async () => { const box = await sandbox(); try {
  await writeFile(path.join(box.target, "not-empty"), "x"); await assert.rejects(() => runReviewedAdventure({ target: box.target, ledger: box.ledger }), /empty/);
  await rm(box.target, { recursive: true, force: true }); await mkdir(box.target);
  await writeFile(box.ledger, JSON.stringify({ version: 1, manifestDigest: REVIEWED_ADVENTURE_MANIFEST_DIGEST, mode: "live", provider: { type: fakeProvider.providerType, model: "other", baseUrlDigest: "x", pricing: { promptPerMillion: 1, completionPerMillion: 1 } }, state: "preflight", calls: 0, cap: 1, audit: [] }));
  await assert.rejects(() => runReviewedAdventure({ target: box.target, ledger: box.ledger, live: true, provider: async () => fakeProvider }), /mismatch/);
  await rm(box.ledger); await assert.rejects(() => runReviewedAdventure({ target: box.target, ledger: box.ledger, live: true, provider: async () => fakeProvider, complete: async () => { throw new Error("offline fake"); } }), /offline fake/);
  assert.equal(JSON.parse(await readFile(box.ledger, "utf8")).state, "unknown");
} finally { await rm(box.root, { recursive: true, force: true }); } });
test("reservation exhaustion is durable and reported usage settles at the conservative maximum", async () => { const first = await sandbox(), second = await sandbox(); try {
  await assert.rejects(() => runReviewedAdventure({ target: first.target, ledger: first.ledger, live: true, provider: async () => ({ ...fakeProvider, pricing: { promptPerMillion: 10_000, completionPerMillion: 10_000 } }), matchedPlan: { human: { calls: 0, tokens: 0, costUsd: 0, elapsedMs: 0 }, ai: { calls: 0, tokens: 0, costUsd: 0, elapsedMs: 0 } } }), /reservation/);
  assert.equal(JSON.parse(await readFile(first.ledger, "utf8")).state, "failed");
  const result = await runReviewedAdventure({ target: second.target, ledger: second.ledger, live: true, provider: async () => fakeProvider, complete: async () => ({ message: { role: "assistant", content: "{}", toolCalls: [] }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "test", responseModel: "test" } }) as any });
  assert.equal(result.state, "complete"); assert.ok(result.accounting.settled.promptTokens >= result.accounting.reported.promptTokens); assert.ok(result.accounting.settled.completionTokens >= result.accounting.reported.completionTokens);
} finally { await rm(first.root, { recursive: true, force: true }); await rm(second.root, { recursive: true, force: true }); } });
test("provider configuration failure is failed while transport uncertainty remains unknown", async () => { const configuration = await sandbox(); try {
  await assert.rejects(() => runReviewedAdventure({ target: configuration.target, ledger: configuration.ledger, live: true, provider: async () => fakeProvider, complete: async () => { throw new ProviderConfigurationError("fake configuration"); } }), /fake configuration/);
  const ledger = JSON.parse(await readFile(configuration.ledger, "utf8")); assert.equal(ledger.state, "failed"); assert.deepEqual(ledger.audit.at(-1), "provider configuration rejected before transport");
} finally { await rm(configuration.root, { recursive: true, force: true }); } });
test("overlap, negative rates, elapsed expiry, plan exhaustion, and reported overage fail closed", async () => { const a = await sandbox(), b = await sandbox(), c = await sandbox(), d = await sandbox(), e = await sandbox(), f = await sandbox(); try {
  await assert.rejects(() => runReviewedAdventure({ target: a.target, ledger: path.join(a.target, "ledger.json") }), /outside/); assert.deepEqual(await (await import("node:fs/promises")).readdir(a.target), []);
  await assert.rejects(() => runReviewedAdventure({ target: b.target, ledger: b.ledger, live: true, provider: async () => ({ ...fakeProvider, pricing: { promptPerMillion: -1, completionPerMillion: 1 } }) }), /positive/); assert.equal(JSON.parse(await readFile(b.ledger, "utf8")).state, "failed");
  let clock = 0; await assert.rejects(() => runReviewedAdventure({ target: c.target, ledger: c.ledger, live: true, provider: async () => fakeProvider, now: () => clock += 2_500_000 }), /elapsed/); assert.equal(JSON.parse(await readFile(c.ledger, "utf8")).state, "failed");
  await assert.rejects(() => runReviewedAdventure({ target: d.target, ledger: d.ledger, live: true, provider: async () => fakeProvider, matchedPlan: { human: { calls: 131, tokens: 1, costUsd: 0, elapsedMs: 0 }, ai: { calls: 0, tokens: 0, costUsd: 0, elapsedMs: 0 } } }), /plan exceeds/); assert.equal(JSON.parse(await readFile(d.ledger, "utf8")).state, "failed");
  await assert.rejects(() => runReviewedAdventure({ target: f.target, ledger: f.ledger, live: true, provider: async () => fakeProvider, matchedPlan: { human: { calls: 1, tokens: 1, costUsd: 0, elapsedMs: 2_400_001 }, ai: { calls: 0, tokens: 0, costUsd: 0, elapsedMs: 0 } } }), /plan exceeds/); assert.equal(JSON.parse(await readFile(f.ledger, "utf8")).state, "failed");
  await assert.rejects(() => runReviewedAdventure({ target: e.target, ledger: e.ledger, live: true, provider: async () => fakeProvider, complete: async () => ({ message: { role: "assistant", content: "{}", toolCalls: [] }, usage: { promptTokens: 300_000, completionTokens: 1, totalTokens: 300_001 }, model: { requestedModel: "test", responseModel: "test" } }) as any }), /exceeds configured/); assert.equal(JSON.parse(await readFile(e.ledger, "utf8")).state, "failed");
} finally { for (const box of [a, b, c, d, e, f]) await rm(box.root, { recursive: true, force: true }); } });
