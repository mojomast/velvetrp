import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EXACT_CANDIDATE_ACTION_FRAME,
  EXACT_CANDIDATE_ENVELOPE_FRAME,
  EXACT_CANDIDATE_POLICY_REASONS,
  EXACT_CANDIDATE_PROTOCOL_VERSION,
  EXACT_CANDIDATE_QUOTE_FRAME,
  MAX_EXACT_CANDIDATE_LIFETIME_MS,
  canonicalExactCandidateActionFrame,
  canonicalExactCandidateEnvelopeFrame,
  canonicalExactCandidateQuoteFrame,
  computeExactCandidateActionDigest,
  computeExactCandidateEnvelopeDigest,
  computeExactCandidateQuoteDigest,
  exactCandidateKindSchema,
  exactCandidateQuoteSchema,
  exactCandidateSafeLabelSchema,
  exactCandidateSelectionResponseSchema,
  internalExactCandidateSchema,
  projectExactCandidateForProvider,
  providerSafeExactCandidateListSchema,
  providerSafeExactCandidateSchema,
  validateExactCandidateSelection as validateExactCandidateSelectionWithCrypto,
  verifyExactCandidateQuoteDigest,
  type ExactCandidateKind,
  type InternalExactCandidate,
  type ProviderSafeExactCandidate,
} from "../src/exact-candidate-protocol.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const crypto = { sha256 };
const ISSUED_AT = "2030-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T00:05:00.000Z";

const candidateBinding = (value: InternalExactCandidate) => ({
  candidateId: value.candidateId,
  kind: value.kind,
  version: value.version,
  scope: value.scope,
  canonicalActionDigest: value.canonicalActionDigest,
});

const candidate = (): InternalExactCandidate => {
  const unsigned: InternalExactCandidate = {
    candidateId: "candidate-1",
    kind: "actor.travel",
    version: EXACT_CANDIDATE_PROTOCOL_VERSION,
    purpose: "execute-once",
    scope: {
      campaignId: "campaign-1",
      sessionId: "session-1",
      actorId: "actor-1",
      principalId: "principal-1",
      connectionId: "provider-connection-1",
      authorizationEffect: "none",
    },
    label: { format: "message-key-v1", key: "candidate.actor.travel.label", routeOption: 1 },
    summary: { format: "message-key-v1", key: "candidate.actor.travel.summary" },
    canonicalActionDigest: "0".repeat(64),
    canonicalEnvelopeDigest: "0".repeat(64),
    privateParameters: { kind: "actor.travel", connectionId: "hidden-world-edge-7", partyActorIds: ["actor-1", "actor-2"] },
    expectedRevisions: [{ domain: "world", revision: 4 }],
    policy: { kind: "actor.travel", result: "allowed", reason: "legal-visible-connection" },
    confirmation: { requirement: "not-required", decision: { state: "not-applicable" } },
    quote: { kind: "not-applicable" },
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    supersession: { state: "current" },
    execution: { state: "unexecuted" },
    executionRequiresAuthorityRecheck: true,
  };
  const actionBound = { ...unsigned, canonicalActionDigest: computeExactCandidateActionDigest(unsigned, crypto) };
  return { ...actionBound, canonicalEnvelopeDigest: computeExactCandidateEnvelopeDigest(actionBound, crypto) };
};

const sealCandidateState = <T extends InternalExactCandidate>(value: T): T => ({
  ...value,
  canonicalEnvelopeDigest: computeExactCandidateEnvelopeDigest(value, crypto),
});

const selection = () => ({ candidateId: "candidate-1", kind: "actor.travel" as const, version: "v1" as const, choices: [] as [] });
const context = () => ({
  campaignId: "campaign-1",
  sessionId: "session-1",
  actorId: "actor-1",
  principalId: "principal-1",
  connectionId: "provider-connection-1",
  now: "2030-01-01T00:01:00.000Z",
  observedRevisions: { world: 4 },
});
const validateExactCandidateSelection = (response: unknown, candidates: readonly unknown[], runtimeContext: unknown) =>
  validateExactCandidateSelectionWithCrypto(response, candidates, runtimeContext, crypto);

describe("exact candidate v1 closed protocol", () => {
  it("freezes one exhaustive first-kind policy vocabulary", () => {
    expect(exactCandidateKindSchema.options).toEqual(["actor.travel"]);
    const exhaustive: Record<ExactCandidateKind, readonly string[]> = EXACT_CANDIDATE_POLICY_REASONS;
    expect(Object.keys(exhaustive)).toEqual(exactCandidateKindSchema.options);
    expect(exhaustive["actor.travel"]).toEqual([
      "legal-visible-connection", "actor-location-unavailable", "connection-not-visible",
      "connection-not-adjacent", "party-ineligible", "world-revision-stale",
    ]);
    for (const reason of exhaustive["actor.travel"]) {
      const result = reason === "legal-visible-connection" ? "allowed" : "denied";
      expect(internalExactCandidateSchema.safeParse({ ...candidate(), policy: { kind: "actor.travel", result, reason } }).success).toBe(true);
      expect(internalExactCandidateSchema.safeParse({ ...candidate(), policy: {
        kind: "actor.travel", result: result === "allowed" ? "denied" : "allowed", reason,
      } }).success).toBe(false);
    }
    expect(internalExactCandidateSchema.safeParse({ ...candidate(), kind: "actor.rest" }).success).toBe(false);
    expect(internalExactCandidateSchema.safeParse({ ...candidate(), policy: { kind: "actor.travel", result: "denied", reason: "unknown" } }).success).toBe(false);
  });

  it("freezes canonical action framing and its digest vector", () => {
    const frame = canonicalExactCandidateActionFrame(candidate());
    expect(frame).toBe("{\"candidateId\":\"candidate-1\",\"domain\":\"velvet.exact-candidate.action.v1\",\"expectedRevisions\":[{\"domain\":\"world\",\"revision\":4}],\"kind\":\"actor.travel\",\"privateParameters\":{\"connectionId\":\"hidden-world-edge-7\",\"kind\":\"actor.travel\",\"partyActorIds\":[\"actor-1\",\"actor-2\"]},\"purpose\":\"execute-once\",\"scope\":{\"actorId\":\"actor-1\",\"authorizationEffect\":\"none\",\"campaignId\":\"campaign-1\",\"connectionId\":\"provider-connection-1\",\"principalId\":\"principal-1\",\"sessionId\":\"session-1\"},\"version\":\"v1\"}");
    expect(EXACT_CANDIDATE_ACTION_FRAME).toBe("velvet.exact-candidate.action.v1");
    expect(computeExactCandidateActionDigest(candidate(), crypto)).toBe("44c745240c4764cb30dd903adb5ebaf43c96a7d821bb3029987a510067dd2b65");
  });

  it("freezes the complete versioned execution-gating envelope vector", () => {
    const frame = canonicalExactCandidateEnvelopeFrame(candidate());
    const decoded = JSON.parse(frame) as Record<string, any>;
    expect(EXACT_CANDIDATE_ENVELOPE_FRAME).toBe("velvet.exact-candidate.envelope.v1");
    expect(decoded).toMatchObject({
      domain: "velvet.exact-candidate.envelope.v1",
      candidateId: "candidate-1",
      policy: { result: "allowed", reason: "legal-visible-connection" },
      confirmation: { requirement: "not-required", authorizer: null,
        decision: { state: "not-applicable", decisionId: null, binding: null, decidedAt: null } },
      quote: { kind: "not-applicable", version: null, quoteId: null, binding: null, cost: null,
        issuedAt: null, expiresAt: null, canonicalQuoteDigest: null },
      supersession: { state: "current", supersededAt: null, replacement: null },
      execution: { state: "unexecuted", receiptId: null, binding: null, linkedAt: null },
    });
    expect(computeExactCandidateEnvelopeDigest(candidate(), crypto)).toBe("3a2c2183055e17fd3b48046727b5a52904dfbe588163f3325210fec386e5150d");
  });

  it("keeps lifecycle absence and presence injective in the envelope frame", () => {
    const base = candidate();
    const pending = { ...base, confirmation: { requirement: "required" as const, authorizer: "controller" as const,
      decision: { state: "pending" as const } } };
    const superseded = { ...base, supersession: { state: "superseded" as const, supersededAt: EXPIRES_AT,
      replacement: { candidateId: "candidate-2", kind: base.kind, version: base.version, scope: base.scope } } };
    const receiptLinked = { ...base, execution: { state: "receipt-linked" as const, receiptId: "receipt-1",
      binding: { ...candidateBinding(base), commandId: "command-1" }, linkedAt: "2030-01-01T00:00:30.000Z" } };
    const frames = [base, pending, superseded, receiptLinked].map(canonicalExactCandidateEnvelopeFrame);
    expect(new Set(frames).size).toBe(frames.length);
    expect(JSON.parse(frames[0]!).execution).toEqual({ state: "unexecuted", receiptId: null, binding: null, linkedAt: null });
    expect(JSON.parse(frames[3]!).execution).toMatchObject({ state: "receipt-linked", receiptId: "receipt-1" });
  });

  it("rejects negative zero and keeps every accepted canonical action number injective", () => {
    const zeroRevision = { ...candidate(), expectedRevisions: [{ domain: "world" as const, revision: 0 }] as const };
    const oneRevision = { ...candidate(), expectedRevisions: [{ domain: "world" as const, revision: 1 }] as const };
    expect(internalExactCandidateSchema.safeParse(zeroRevision).success).toBe(true);
    expect(internalExactCandidateSchema.safeParse({ ...candidate(), expectedRevisions: [{ domain: "world", revision: -0 }] }).success).toBe(false);
    expect(canonicalExactCandidateActionFrame(zeroRevision)).not.toBe(canonicalExactCandidateActionFrame(oneRevision));
    expect(() => canonicalExactCandidateActionFrame({ ...candidate(), expectedRevisions: [{ domain: "world", revision: -0 }] })).toThrow();
    expect(internalExactCandidateSchema.safeParse({ ...candidate(), label: { ...candidate().label, routeOption: -0 } }).success).toBe(false);
  });

  it("enforces bounded, expiring, single-purpose, non-authorizing travel candidates", () => {
    expect(internalExactCandidateSchema.parse(candidate())).toEqual(candidate());
    expect(Date.parse(EXPIRES_AT) - Date.parse(ISSUED_AT)).toBe(MAX_EXACT_CANDIDATE_LIFETIME_MS);
    const invalid = [
      { ...candidate(), purpose: "reusable" },
      { ...candidate(), executionRequiresAuthorityRecheck: false },
      { ...candidate(), scope: { ...candidate().scope, authorizationEffect: "granted" } },
      { ...candidate(), expiresAt: "2030-01-01T00:05:00.001Z" },
      { ...candidate(), expiresAt: ISSUED_AT },
      { ...candidate(), privateParameters: { ...candidate().privateParameters, partyActorIds: ["actor-2"] } },
      { ...candidate(), privateParameters: { ...candidate().privateParameters, partyActorIds: ["actor-1", "actor-1"] } },
      { ...candidate(), expectedRevisions: [] },
      { ...candidate(), quote: { kind: "exact-cost" } },
      { ...candidate(), extra: true },
    ];
    for (const value of invalid) expect(internalExactCandidateSchema.safeParse(value).success).toBe(false);
  });

  it("uses enforceable closed display structures rather than opaque-ID heuristics", () => {
    expect(exactCandidateSafeLabelSchema.parse(candidate().label)).toEqual(candidate().label);
    for (const ordinaryOpaqueId of ["location_123", "private-edge-7", "01J8Y4K7M2N6Q9R3T5V8W1X4Z7", "npc:secret-42"]) {
      expect(exactCandidateSafeLabelSchema.safeParse({ format: "message-key-v1", key: ordinaryOpaqueId, routeOption: 1 }).success).toBe(false);
      expect(exactCandidateSafeLabelSchema.safeParse({ ...candidate().label, text: ordinaryOpaqueId }).success).toBe(false);
    }
  });

  it("versions, binds, canonically frames, and verifies exact-cost quotes", () => {
    const unsigned = {
      kind: "exact-cost" as const,
      version: "v1" as const,
      quoteId: "quote-1",
      binding: candidateBinding(candidate()),
      cost: { currencyId: "currency-gold", minorUnits: 125, display: { format: "minor-units-v1" as const, currency: "gold" as const } },
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      canonicalQuoteDigest: "0".repeat(64),
    };
    const quote = { ...unsigned, canonicalQuoteDigest: computeExactCandidateQuoteDigest(unsigned, crypto) };
    expect(exactCandidateQuoteSchema.parse(quote)).toEqual(quote);
    expect(EXACT_CANDIDATE_QUOTE_FRAME).toBe("velvet.exact-candidate.quote.v1");
    expect(canonicalExactCandidateQuoteFrame(quote)).toContain("\"domain\":\"velvet.exact-candidate.quote.v1\"");
    expect(quote.canonicalQuoteDigest).toBe("c88c2c7bcd33849ce273e827e4e2baa1c346d84b64273b6efb36a5b69776d30a");
    expect(verifyExactCandidateQuoteDigest(quote, crypto)).toBe(true);
    expect(verifyExactCandidateQuoteDigest({ ...quote, cost: { ...quote.cost, minorUnits: 126 } }, crypto)).toBe(false);
    expect(verifyExactCandidateQuoteDigest({ ...quote, binding: { ...quote.binding, candidateId: "candidate-2" } }, crypto)).toBe(false);
    expect(exactCandidateQuoteSchema.safeParse({ ...quote, version: "v2" }).success).toBe(false);
    expect(exactCandidateQuoteSchema.safeParse({ ...quote, expiresAt: ISSUED_AT }).success).toBe(false);
    expect(exactCandidateQuoteSchema.safeParse({ ...quote, cost: { ...quote.cost, minorUnits: -0 } }).success).toBe(false);
    const zeroCost = { ...quote, cost: { ...quote.cost, minorUnits: 0 } };
    const oneUnit = { ...quote, cost: { ...quote.cost, minorUnits: 1 } };
    expect(canonicalExactCandidateQuoteFrame(zeroCost)).not.toBe(canonicalExactCandidateQuoteFrame(oneUnit));
    expect(() => canonicalExactCandidateQuoteFrame({ ...quote, cost: { ...quote.cost, minorUnits: -0 } })).toThrow();
  });

  it("fails quote verification closed for malformed or throwing trusted crypto output", () => {
    const unsigned = {
      kind: "exact-cost" as const, version: "v1" as const, quoteId: "quote-1", binding: candidateBinding(candidate()),
      cost: { currencyId: "currency-gold", minorUnits: 1, display: { format: "minor-units-v1" as const, currency: "gold" as const } },
      issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, canonicalQuoteDigest: "0".repeat(64),
    };
    const quote = { ...unsigned, canonicalQuoteDigest: computeExactCandidateQuoteDigest(unsigned, crypto) };
    expect(verifyExactCandidateQuoteDigest(quote, { sha256: () => "A".repeat(64) })).toBe(false);
    expect(verifyExactCandidateQuoteDigest(quote, { sha256: () => "a".repeat(63) })).toBe(false);
    expect(verifyExactCandidateQuoteDigest(quote, { sha256: () => { throw new Error("crypto unavailable"); } })).toBe(false);
  });

  it("projects only exact provider-safe keys during the explicit current instant", () => {
    const projection = projectExactCandidateForProvider(candidate(), context().now);
    expect(Object.keys(projection)).toEqual([
      "candidateId", "kind", "version", "label", "summary", "confirmation", "quote", "expiresAt", "choices",
    ]);
    expect(Object.keys(projection.label)).toEqual(["format", "key", "routeOption"]);
    expect(Object.keys(projection.summary)).toEqual(["format", "key"]);
    expect(Object.keys(projection.confirmation)).toEqual(["required"]);
    expect(Object.keys(projection.quote)).toEqual(["kind"]);
    expectTypeOf(projection).toEqualTypeOf<ProviderSafeExactCandidate>();
    const serialized = JSON.stringify(projection);
    for (const forbidden of [
      "campaignId", "sessionId", "actorId", "principalId", "connectionId", "authorizationEffect",
      "canonicalActionDigest", "canonicalEnvelopeDigest", "privateParameters", "expectedRevisions", "policy", "reason", "decision",
      "supersession", "execution", "receiptId", "commandId", "hidden-world-edge-7", candidate().canonicalActionDigest,
    ]) expect(serialized).not.toContain(forbidden);
    for (const extraKey of ["privateParameters", "principalId", "policy", "providerMetadata", "receiptId"]) {
      expect(providerSafeExactCandidateSchema.safeParse({ ...projection, [extraKey]: "leak" }).success).toBe(false);
    }
    expect(providerSafeExactCandidateListSchema.safeParse({ version: "v1", candidates: [projection, projection] }).success).toBe(false);
  });

  it("rejects expired and not-yet-issued projections", () => {
    expect(() => projectExactCandidateForProvider(candidate(), EXPIRES_AT)).toThrow("outside its selectable lifetime");
    expect(() => projectExactCandidateForProvider(candidate(), "2029-12-31T23:59:59.999Z")).toThrow("outside its selectable lifetime");
    expect(() => projectExactCandidateForProvider(candidate(), "invalid")).toThrow();
  });

  it("binds decisions, replacement candidates, and receipts", () => {
    const base = candidate();
    const binding = candidateBinding(base);
    const approved = { ...base, confirmation: { requirement: "required" as const, authorizer: "controller" as const,
      decision: { state: "approved" as const, decisionId: "decision-1", binding, decidedAt: "2030-01-01T00:00:30.000Z" } } };
    expect(internalExactCandidateSchema.safeParse(approved).success).toBe(true);
    expect(internalExactCandidateSchema.safeParse({ ...approved, confirmation: { ...approved.confirmation,
      decision: { ...approved.confirmation.decision, binding: { ...binding, candidateId: "candidate-2" } } } }).success).toBe(false);
    expect(internalExactCandidateSchema.safeParse({ ...approved, confirmation: { ...approved.confirmation,
      decision: { ...approved.confirmation.decision, decidedAt: "2030-01-01T00:05:00.001Z" } } }).success).toBe(false);
    expect(internalExactCandidateSchema.safeParse({ ...approved, confirmation: { ...approved.confirmation,
      decision: { ...approved.confirmation.decision, decidedAt: EXPIRES_AT } } }).success).toBe(false);

    const replacement = { candidateId: "candidate-2", kind: base.kind, version: base.version, scope: base.scope };
    expect(internalExactCandidateSchema.safeParse({ ...base, supersession: { state: "superseded", supersededAt: EXPIRES_AT, replacement } }).success).toBe(true);
    expect(internalExactCandidateSchema.safeParse({ ...base, supersession: { state: "superseded", supersededAt: EXPIRES_AT,
      replacement: { ...replacement, scope: { ...replacement.scope, sessionId: "session-2" } } } }).success).toBe(false);

    const receipt = { state: "receipt-linked" as const, receiptId: "receipt-1", binding: { ...binding, commandId: "command-1" }, linkedAt: "2030-01-01T00:00:30.000Z" };
    expect(internalExactCandidateSchema.safeParse({ ...base, execution: receipt }).success).toBe(true);
    expect(internalExactCandidateSchema.safeParse({ ...base, execution: { ...receipt,
      binding: { ...receipt.binding, canonicalActionDigest: "f".repeat(64) } } }).success).toBe(false);
    expect(internalExactCandidateSchema.safeParse({ ...base, execution: { ...receipt,
      binding: { ...receipt.binding, commandId: "" } } }).success).toBe(false);
    const pending = { requirement: "required" as const, authorizer: "controller" as const, decision: { state: "pending" as const } };
    const rejected = { requirement: "required" as const, authorizer: "controller" as const,
      decision: { state: "rejected" as const, decisionId: "decision-1", binding, decidedAt: "2030-01-01T00:00:30.000Z" } };
    expect(internalExactCandidateSchema.safeParse({ ...base, confirmation: pending, execution: receipt }).success).toBe(false);
    expect(internalExactCandidateSchema.safeParse({ ...base, confirmation: rejected, execution: receipt }).success).toBe(false);
    expect(internalExactCandidateSchema.safeParse({ ...approved, execution: receipt }).success).toBe(true);
  });
});

describe("exact candidate execution-boundary vectors", () => {
  it("accepts only the exact current selection without granting authority", () => {
    const result = validateExactCandidateSelection(selection(), [candidate()], context());
    expect(result).toMatchObject({ ok: true, authorityRecheckRequired: true });
    if (result.ok) expect(result.candidate.scope.authorizationEffect).toBe("none");
  });

  it.each([
    ["unknown candidate", { ...selection(), candidateId: "candidate-unknown" }, candidate(), context(), "unknown-candidate"],
    ["tampered kind", { ...selection(), kind: "actor.rest" }, candidate(), context(), "invalid-response"],
    ["tampered visible choice", { ...selection(), choices: [{ choiceId: "destination", optionId: "hidden-world-edge-7" }] }, candidate(), context(), "invalid-response"],
    ["extra provider argument", { ...selection(), connectionId: "hidden-world-edge-7" }, candidate(), context(), "invalid-response"],
    ["valid-hex digest substitution", selection(), { ...candidate(), canonicalActionDigest: "f".repeat(64) }, context(), "tampered-candidate"],
    ["private parameter substitution", selection(), { ...candidate(), privateParameters: { ...candidate().privateParameters, connectionId: "hidden-world-edge-8" } }, context(), "tampered-candidate"],
    ["private party substitution", selection(), { ...candidate(), privateParameters: { ...candidate().privateParameters, partyActorIds: ["actor-1", "actor-3"] } }, context(), "tampered-candidate"],
    ["expired candidate", selection(), candidate(), { ...context(), now: EXPIRES_AT }, "expired"],
    ["not-yet-issued candidate", selection(), candidate(), { ...context(), now: "2029-12-31T23:59:59.999Z" }, "expired"],
    ["stale world revision", selection(), candidate(), { ...context(), observedRevisions: { world: 5 } }, "stale-revision"],
    ["missing world revision", selection(), candidate(), { ...context(), observedRevisions: {} }, "invalid-context"],
    ["cross-campaign", selection(), candidate(), { ...context(), campaignId: "campaign-2" }, "cross-scope"],
    ["cross-session", selection(), candidate(), { ...context(), sessionId: "session-2" }, "cross-scope"],
    ["cross-actor", selection(), candidate(), { ...context(), actorId: "actor-2" }, "cross-scope"],
    ["cross-principal", selection(), candidate(), { ...context(), principalId: "principal-2" }, "cross-scope"],
    ["cross-connection", selection(), candidate(), { ...context(), connectionId: "provider-connection-2" }, "cross-scope"],
    ["denied policy", selection(), sealCandidateState({ ...candidate(), policy: { kind: "actor.travel", result: "denied", reason: "party-ineligible" } }), context(), "policy-denied"],
    ["pending confirmation", selection(), sealCandidateState({ ...candidate(), confirmation: { requirement: "required", authorizer: "controller", decision: { state: "pending" } } }), context(), "confirmation-required"],
  ])("rejects %s", (_name, response, knownCandidate, boundaryContext, code) => {
    expect(validateExactCandidateSelection(response, [knownCandidate], boundaryContext)).toEqual({ ok: false, code });
  });

  it("rejects every valid-shape execution-gate mutation against the sealed envelope", () => {
    const base = candidate();
    const denied = sealCandidateState({ ...base, policy: { kind: "actor.travel", result: "denied", reason: "party-ineligible" } });
    const required = sealCandidateState({ ...base, confirmation: { requirement: "required" as const, authorizer: "controller" as const,
      decision: { state: "pending" as const } } });
    const shortLived = sealCandidateState({ ...base, expiresAt: "2030-01-01T00:04:00.000Z" });
    const superseded = sealCandidateState({ ...base, supersession: { state: "superseded" as const, supersededAt: EXPIRES_AT,
      replacement: { candidateId: "candidate-2", kind: base.kind, version: base.version, scope: base.scope } } });
    const receiptLinked = sealCandidateState({ ...base, execution: { state: "receipt-linked" as const, receiptId: "receipt-1",
      binding: { ...candidateBinding(base), commandId: "command-1" }, linkedAt: "2030-01-01T00:00:30.000Z" } });
    const approved = sealCandidateState({ ...base, confirmation: { requirement: "required" as const, authorizer: "controller" as const,
      decision: { state: "approved" as const, decisionId: "decision-1", binding: candidateBinding(base), decidedAt: "2030-01-01T00:00:30.000Z" } } });
    const mutations = [
      { ...denied, policy: { kind: "actor.travel", result: "allowed", reason: "legal-visible-connection" } },
      { ...required, confirmation: { requirement: "not-required", decision: { state: "not-applicable" } } },
      { ...shortLived, expiresAt: EXPIRES_AT },
      { ...base, issuedAt: "2030-01-01T00:00:01.000Z" },
      { ...superseded, supersession: { state: "current" } },
      { ...receiptLinked, execution: { state: "unexecuted" } },
      { ...approved, confirmation: { ...approved.confirmation,
        decision: { ...approved.confirmation.decision, decisionId: "decision-2" } } },
      { ...base, canonicalEnvelopeDigest: "f".repeat(64) },
    ];
    for (const mutation of mutations) {
      expect(internalExactCandidateSchema.safeParse(mutation).success).toBe(true);
      expect(validateExactCandidateSelection(selection(), [mutation], context())).toEqual({ ok: false, code: "tampered-candidate" });
    }
  });

  it("requires an exact bound approval no later than now and expiry", () => {
    const base = candidate();
    const approval = (decidedAt: string) => ({ ...base, confirmation: { requirement: "required" as const, authorizer: "controller" as const,
      decision: { state: "approved" as const, decisionId: "decision-1", binding: candidateBinding(base), decidedAt } } });
    expect(validateExactCandidateSelection(selection(), [sealCandidateState(approval("2030-01-01T00:00:30.000Z"))], context())).toMatchObject({ ok: true });
    expect(validateExactCandidateSelection(selection(), [sealCandidateState(approval("2030-01-01T00:02:00.000Z"))], context())).toEqual({ ok: false, code: "invalid-decision" });
    expect(validateExactCandidateSelection(selection(), [approval("2030-01-01T00:05:00.001Z")], context())).toEqual({ ok: false, code: "tampered-candidate" });
  });

  it("strictly parses canonical runtime context and never throws for malformed data", () => {
    const invalidContexts = [
      { ...context(), now: "not-a-time" },
      { ...context(), observedRevisions: { world: -0 } },
      { ...context(), observedRevisions: { world: 4, hidden: 4 } },
      { ...context(), unexpected: true },
      { ...context(), sha256 },
      null,
    ];
    for (const runtimeContext of invalidContexts) {
      expect(() => validateExactCandidateSelection(selection(), [candidate()], runtimeContext)).not.toThrow();
      expect(validateExactCandidateSelection(selection(), [candidate()], runtimeContext)).toEqual({ ok: false, code: "invalid-context" });
    }
  });

  it("fails the result boundary closed for throwing or noncanonical crypto output", () => {
    for (const trustedCrypto of [
      { sha256: () => "A".repeat(64) },
      { sha256: () => "a".repeat(63) },
      { sha256: () => "g".repeat(64) },
      { sha256: () => { throw new Error("crypto unavailable"); } },
    ]) {
      expect(() => validateExactCandidateSelectionWithCrypto(selection(), [candidate()], context(), trustedCrypto)).not.toThrow();
      expect(validateExactCandidateSelectionWithCrypto(selection(), [candidate()], context(), trustedCrypto))
        .toEqual({ ok: false, code: "tampered-candidate" });
    }
  });

  it("rejects duplicate candidate IDs before selection", () => {
    expect(validateExactCandidateSelection(selection(), [candidate(), candidate()], context()))
      .toEqual({ ok: false, code: "duplicate-candidate-id" });
  });

  it("rejects superseded and receipt-linked candidates with exact bindings", () => {
    const base = candidate();
    const replacement = { candidateId: "candidate-2", kind: base.kind, version: base.version, scope: base.scope };
    expect(validateExactCandidateSelection(selection(), [sealCandidateState({ ...base, supersession: { state: "superseded", supersededAt: EXPIRES_AT, replacement } })], context()))
      .toEqual({ ok: false, code: "superseded" });
    const execution = { state: "receipt-linked" as const, receiptId: "receipt-1",
      binding: { ...candidateBinding(base), commandId: "command-1" }, linkedAt: "2030-01-01T00:00:30.000Z" };
    expect(validateExactCandidateSelection(selection(), [sealCandidateState({ ...base, execution })], context()))
      .toEqual({ ok: false, code: "already-executed" });
  });

  it("rejects unknown fields, versions, and unbounded batches", () => {
    expect(exactCandidateSelectionResponseSchema.safeParse({ ...selection(), unexpected: true }).success).toBe(false);
    expect(exactCandidateSelectionResponseSchema.safeParse({ ...selection(), version: "v2" }).success).toBe(false);
    expect(validateExactCandidateSelection(selection(), Array.from({ length: 33 }, (_, index) => ({ ...candidate(), candidateId: `candidate-${index}` })), context()))
      .toEqual({ ok: false, code: "invalid-response" });
  });
});
