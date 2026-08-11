import { z } from "zod";
import { canonicalAgentJson, canonicalSha256DigestSchema, type AgentJsonObject } from "./agent-execution.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { actorIdSchema, campaignIdSchema, principalIdSchema } from "./rpg-characters.js";
import { locationConnectionIdSchema, MAX_TRAVEL_PARTY_SIZE } from "./world.js";

export const EXACT_CANDIDATE_PROTOCOL_VERSION = "v1" as const;
export const EXACT_CANDIDATE_ACTION_FRAME = "velvet.exact-candidate.action.v1" as const;
export const EXACT_CANDIDATE_ENVELOPE_FRAME = "velvet.exact-candidate.envelope.v1" as const;
export const EXACT_CANDIDATE_QUOTE_VERSION = "v1" as const;
export const EXACT_CANDIDATE_QUOTE_FRAME = "velvet.exact-candidate.quote.v1" as const;
export const MAX_EXACT_CANDIDATES_PER_RESPONSE = 32;
export const MAX_EXACT_CANDIDATE_LIFETIME_MS = 5 * 60 * 1_000;

/** V1 deliberately freezes only the first family in the rollout. New families require a new protocol version. */
export const exactCandidateKindSchema = z.enum(["actor.travel"]);
export const exactCandidateVersionSchema = z.literal(EXACT_CANDIDATE_PROTOCOL_VERSION);
export type ExactCandidateKind = z.infer<typeof exactCandidateKindSchema>;

export const EXACT_CANDIDATE_POLICY_REASONS = Object.freeze({
  "actor.travel": Object.freeze([
    "legal-visible-connection",
    "actor-location-unavailable",
    "connection-not-visible",
    "connection-not-adjacent",
    "party-ineligible",
    "world-revision-stale",
  ] as const),
} satisfies Record<ExactCandidateKind, readonly string[]>);

const candidateIdSchema = resourceIdSchema;
const canonicalIntegerSchema = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum)
  .refine((value) => !Object.is(value, -0), "negative zero is not canonical");
export const exactCandidateCanonicalRevisionSchema = canonicalIntegerSchema(0, Number.MAX_SAFE_INTEGER - 1);
export const exactCandidateCanonicalMinorUnitsSchema = canonicalIntegerSchema(0, Number.MAX_SAFE_INTEGER);

/** Closed message keys have no free-form slot in which an opaque private identifier can be asserted safe. */
export const exactCandidateSafeLabelSchema = z.object({
  format: z.literal("message-key-v1"),
  key: z.literal("candidate.actor.travel.label"),
  routeOption: canonicalIntegerSchema(1, MAX_EXACT_CANDIDATES_PER_RESPONSE),
}).strict();
export const exactCandidateSafeSummarySchema = z.object({
  format: z.literal("message-key-v1"),
  key: z.literal("candidate.actor.travel.summary"),
}).strict();

export const exactCandidateScopeSchema = z.object({
  campaignId: campaignIdSchema,
  sessionId: resourceIdSchema,
  actorId: actorIdSchema,
  principalId: principalIdSchema,
  connectionId: resourceIdSchema,
  authorizationEffect: z.literal("none"),
}).strict();

export const exactCandidateBindingSchema = z.object({
  candidateId: candidateIdSchema,
  kind: z.literal("actor.travel"),
  version: exactCandidateVersionSchema,
  scope: exactCandidateScopeSchema,
  canonicalActionDigest: canonicalSha256DigestSchema,
}).strict();

export const exactCandidateExpectedRevisionSchema = z.object({
  domain: z.literal("world"),
  revision: exactCandidateCanonicalRevisionSchema,
}).strict();

export const exactCandidateTravelParametersSchema = z.object({
  kind: z.literal("actor.travel"),
  connectionId: locationConnectionIdSchema,
  partyActorIds: z.array(actorIdSchema).min(1).max(MAX_TRAVEL_PARTY_SIZE),
}).strict().superRefine((parameters, context) => {
  if (new Set(parameters.partyActorIds).size !== parameters.partyActorIds.length) {
    context.addIssue({ code: "custom", message: "travel party actor IDs must be unique", path: ["partyActorIds"] });
  }
});

export const exactCandidateTravelPolicySchema = z.object({
  kind: z.literal("actor.travel"),
  result: z.enum(["allowed", "denied"]),
  reason: z.enum(EXACT_CANDIDATE_POLICY_REASONS["actor.travel"]),
}).strict().superRefine((policy, context) => {
  if ((policy.result === "allowed") !== (policy.reason === "legal-visible-connection")) {
    context.addIssue({ code: "custom", message: "travel policy result and reason must agree", path: ["reason"] });
  }
});

const exactCandidateDecisionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({
    state: z.literal("approved"),
    decisionId: resourceIdSchema,
    binding: exactCandidateBindingSchema,
    decidedAt: utcIsoTimestampSchema,
  }).strict(),
  z.object({
    state: z.literal("rejected"),
    decisionId: resourceIdSchema,
    binding: exactCandidateBindingSchema,
    decidedAt: utcIsoTimestampSchema,
  }).strict(),
]);

export const exactCandidateConfirmationSchema = z.discriminatedUnion("requirement", [
  z.object({
    requirement: z.literal("not-required"),
    decision: z.object({ state: z.literal("not-applicable") }).strict(),
  }).strict(),
  z.object({
    requirement: z.literal("required"),
    authorizer: z.enum(["controller", "gm"]),
    decision: exactCandidateDecisionSchema,
  }).strict(),
]);

const exactCandidateCostSchema = z.object({
  currencyId: resourceIdSchema,
  minorUnits: exactCandidateCanonicalMinorUnitsSchema,
  display: z.object({
    format: z.literal("minor-units-v1"),
    currency: z.enum(["gold", "silver", "copper"]),
  }).strict(),
}).strict();

export const exactCandidateQuoteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-applicable") }).strict(),
  z.object({
    kind: z.literal("exact-cost"),
    version: z.literal(EXACT_CANDIDATE_QUOTE_VERSION),
    quoteId: resourceIdSchema,
    binding: exactCandidateBindingSchema,
    cost: exactCandidateCostSchema,
    issuedAt: utcIsoTimestampSchema,
    expiresAt: utcIsoTimestampSchema,
    canonicalQuoteDigest: canonicalSha256DigestSchema,
  }).strict().refine((quote) => Date.parse(quote.expiresAt) > Date.parse(quote.issuedAt), {
    message: "quote must expire after issuance",
    path: ["expiresAt"],
  }),
]);

export const exactCandidateSupersessionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("current") }).strict(),
  z.object({
    state: z.literal("superseded"),
    supersededAt: utcIsoTimestampSchema,
    replacement: z.object({
      candidateId: candidateIdSchema,
      kind: z.literal("actor.travel"),
      version: exactCandidateVersionSchema,
      scope: exactCandidateScopeSchema,
    }).strict(),
  }).strict(),
]);

export const exactCandidateExecutionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unexecuted") }).strict(),
  z.object({
    state: z.literal("receipt-linked"),
    receiptId: resourceIdSchema,
    binding: exactCandidateBindingSchema.extend({ commandId: resourceIdSchema }).strict(),
    linkedAt: utcIsoTimestampSchema,
  }).strict(),
]);

const sameScope = (left: z.infer<typeof exactCandidateScopeSchema>, right: z.infer<typeof exactCandidateScopeSchema>) =>
  left.campaignId === right.campaignId && left.sessionId === right.sessionId && left.actorId === right.actorId
  && left.principalId === right.principalId && left.connectionId === right.connectionId
  && left.authorizationEffect === right.authorizationEffect;

/** Private server envelope. It is an exact proposal and explicitly has no authorization effect. */
export const internalExactCandidateSchema = z.object({
  candidateId: candidateIdSchema,
  kind: z.literal("actor.travel"),
  version: exactCandidateVersionSchema,
  purpose: z.literal("execute-once"),
  scope: exactCandidateScopeSchema,
  label: exactCandidateSafeLabelSchema,
  summary: exactCandidateSafeSummarySchema,
  canonicalActionDigest: canonicalSha256DigestSchema,
  canonicalEnvelopeDigest: canonicalSha256DigestSchema,
  privateParameters: exactCandidateTravelParametersSchema,
  expectedRevisions: z.tuple([exactCandidateExpectedRevisionSchema]),
  policy: exactCandidateTravelPolicySchema,
  confirmation: exactCandidateConfirmationSchema,
  quote: z.object({ kind: z.literal("not-applicable") }).strict(),
  issuedAt: utcIsoTimestampSchema,
  expiresAt: utcIsoTimestampSchema,
  supersession: exactCandidateSupersessionSchema,
  execution: exactCandidateExecutionSchema,
  executionRequiresAuthorityRecheck: z.literal(true),
}).strict().superRefine((candidate, context) => {
  const issuedAt = Date.parse(candidate.issuedAt);
  const expiresAt = Date.parse(candidate.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_EXACT_CANDIDATE_LIFETIME_MS) {
    context.addIssue({ code: "custom", message: "candidate lifetime must be positive and bounded", path: ["expiresAt"] });
  }
  if (!candidate.privateParameters.partyActorIds.includes(candidate.scope.actorId)) {
    context.addIssue({ code: "custom", message: "travel party must contain the scoped actor", path: ["privateParameters", "partyActorIds"] });
  }
  const bindingMatches = (binding: z.infer<typeof exactCandidateBindingSchema>) =>
    binding.candidateId === candidate.candidateId && binding.kind === candidate.kind && binding.version === candidate.version
    && sameScope(binding.scope, candidate.scope) && binding.canonicalActionDigest === candidate.canonicalActionDigest;
  if (candidate.confirmation.requirement === "required" && candidate.confirmation.decision.state !== "pending") {
    if (!bindingMatches(candidate.confirmation.decision.binding)) {
      context.addIssue({ code: "custom", message: "decision must bind the exact candidate action and scope", path: ["confirmation", "decision", "binding"] });
    }
    const decidedAt = Date.parse(candidate.confirmation.decision.decidedAt);
    if (decidedAt < issuedAt || decidedAt >= expiresAt) {
      context.addIssue({ code: "custom", message: "decision must occur during candidate lifetime", path: ["confirmation", "decision", "decidedAt"] });
    }
  }
  if (candidate.supersession.state === "superseded") {
    if (candidate.supersession.replacement.candidateId === candidate.candidateId) {
      context.addIssue({ code: "custom", message: "candidate cannot supersede itself", path: ["supersession", "replacement", "candidateId"] });
    }
    if (candidate.supersession.replacement.kind !== candidate.kind
      || candidate.supersession.replacement.version !== candidate.version
      || !sameScope(candidate.supersession.replacement.scope, candidate.scope)) {
      context.addIssue({ code: "custom", message: "replacement must retain candidate kind, version, and scope", path: ["supersession", "replacement"] });
    }
    if (Date.parse(candidate.supersession.supersededAt) < issuedAt) {
      context.addIssue({ code: "custom", message: "supersession cannot predate candidate", path: ["supersession", "supersededAt"] });
    }
  }
  if (candidate.execution.state === "receipt-linked") {
    if (candidate.confirmation.requirement === "required" && candidate.confirmation.decision.state !== "approved") {
      context.addIssue({ code: "custom", message: "receipt-linked candidate requires no confirmation or an approved decision", path: ["execution"] });
    }
    if (!bindingMatches(candidate.execution.binding)) {
      context.addIssue({ code: "custom", message: "receipt must bind the exact candidate action and scope", path: ["execution", "binding"] });
    }
    if (Date.parse(candidate.execution.linkedAt) < issuedAt) {
      context.addIssue({ code: "custom", message: "receipt link cannot predate candidate", path: ["execution", "linkedAt"] });
    }
  }
  if (candidate.confirmation.requirement === "required" && candidate.confirmation.decision.state === "rejected"
    && candidate.execution.state === "receipt-linked") {
    context.addIssue({ code: "custom", message: "rejected candidate cannot link an execution receipt", path: ["execution"] });
  }
});

export type TrustedExactCandidateCrypto = Readonly<{
  /** Server-owned cryptographic SHA-256 implementation, never supplied by request or provider data. */
  sha256: (canonicalFrame: string) => string;
}>;

/** Exact UTF-16 canonical JSON frame hashed for the action digest. */
export function canonicalExactCandidateActionFrame(candidate: unknown): string {
  const parsed = internalExactCandidateSchema.parse(candidate);
  const frame: AgentJsonObject = {
    domain: EXACT_CANDIDATE_ACTION_FRAME,
    candidateId: parsed.candidateId,
    kind: parsed.kind,
    version: parsed.version,
    purpose: parsed.purpose,
    scope: parsed.scope,
    privateParameters: parsed.privateParameters,
    expectedRevisions: parsed.expectedRevisions,
  };
  return canonicalAgentJson(frame);
}

export function computeExactCandidateActionDigest(candidate: unknown, crypto: TrustedExactCandidateCrypto): string {
  return canonicalSha256DigestSchema.parse(crypto.sha256(canonicalExactCandidateActionFrame(candidate)));
}

/**
 * Fixed-shape state frame for every execution gate. Nullable lifecycle slots
 * make absence explicit and prevent omitted/current states from colliding.
 */
export function canonicalExactCandidateEnvelopeFrame(candidate: unknown): string {
  const parsed = internalExactCandidateSchema.parse(candidate);
  const confirmation = parsed.confirmation.requirement === "not-required" ? {
    requirement: parsed.confirmation.requirement,
    authorizer: null,
    decision: { state: parsed.confirmation.decision.state, decisionId: null, binding: null, decidedAt: null },
  } : parsed.confirmation.decision.state === "pending" ? {
    requirement: parsed.confirmation.requirement,
    authorizer: parsed.confirmation.authorizer,
    decision: { state: parsed.confirmation.decision.state, decisionId: null, binding: null, decidedAt: null },
  } : {
    requirement: parsed.confirmation.requirement,
    authorizer: parsed.confirmation.authorizer,
    decision: {
      state: parsed.confirmation.decision.state,
      decisionId: parsed.confirmation.decision.decisionId,
      binding: parsed.confirmation.decision.binding,
      decidedAt: parsed.confirmation.decision.decidedAt,
    },
  };
  const supersession = parsed.supersession.state === "current"
    ? { state: parsed.supersession.state, supersededAt: null, replacement: null }
    : { state: parsed.supersession.state, supersededAt: parsed.supersession.supersededAt, replacement: parsed.supersession.replacement };
  const execution = parsed.execution.state === "unexecuted"
    ? { state: parsed.execution.state, receiptId: null, binding: null, linkedAt: null }
    : { state: parsed.execution.state, receiptId: parsed.execution.receiptId, binding: parsed.execution.binding, linkedAt: parsed.execution.linkedAt };
  const frame: AgentJsonObject = {
    domain: EXACT_CANDIDATE_ENVELOPE_FRAME,
    candidateId: parsed.candidateId,
    kind: parsed.kind,
    version: parsed.version,
    purpose: parsed.purpose,
    scope: parsed.scope,
    privateParameters: parsed.privateParameters,
    canonicalActionDigest: parsed.canonicalActionDigest,
    expectedRevisions: parsed.expectedRevisions,
    policy: parsed.policy,
    confirmation,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
    quote: { kind: parsed.quote.kind, version: null, quoteId: null, binding: null, cost: null,
      issuedAt: null, expiresAt: null, canonicalQuoteDigest: null },
    supersession,
    execution,
    executionRequiresAuthorityRecheck: parsed.executionRequiresAuthorityRecheck,
  };
  return canonicalAgentJson(frame);
}

export function computeExactCandidateEnvelopeDigest(candidate: unknown, crypto: TrustedExactCandidateCrypto): string {
  return canonicalSha256DigestSchema.parse(crypto.sha256(canonicalExactCandidateEnvelopeFrame(candidate)));
}

/** Exact UTF-16 canonical JSON frame hashed for a versioned quote digest. */
export function canonicalExactCandidateQuoteFrame(quote: unknown): string {
  const parsed = exactCandidateQuoteSchema.parse(quote);
  if (parsed.kind !== "exact-cost") throw new Error("not-applicable quote has no digest frame");
  const frame: AgentJsonObject = {
    domain: EXACT_CANDIDATE_QUOTE_FRAME,
    version: parsed.version,
    quoteId: parsed.quoteId,
    binding: parsed.binding,
    cost: parsed.cost,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
  };
  return canonicalAgentJson(frame);
}

export function computeExactCandidateQuoteDigest(quote: unknown, crypto: TrustedExactCandidateCrypto): string {
  return canonicalSha256DigestSchema.parse(crypto.sha256(canonicalExactCandidateQuoteFrame(quote)));
}

export function verifyExactCandidateQuoteDigest(quote: unknown, crypto: TrustedExactCandidateCrypto): boolean {
  try {
    const parsed = exactCandidateQuoteSchema.safeParse(quote);
    return parsed.success && parsed.data.kind === "exact-cost"
      && computeExactCandidateQuoteDigest(parsed.data, crypto) === parsed.data.canonicalQuoteDigest;
  } catch {
    return false;
  }
}

/** The provider sees no scope, private IDs, action digest, revisions, policy internals, authority, or receipt links. */
export const providerSafeExactCandidateSchema = z.object({
  candidateId: candidateIdSchema,
  kind: z.literal("actor.travel"),
  version: exactCandidateVersionSchema,
  label: exactCandidateSafeLabelSchema,
  summary: exactCandidateSafeSummarySchema,
  confirmation: z.object({ required: z.boolean() }).strict(),
  quote: z.object({ kind: z.literal("not-applicable") }).strict(),
  expiresAt: utcIsoTimestampSchema,
  choices: z.tuple([]),
}).strict();

export const providerSafeExactCandidateListSchema = z.object({
  version: exactCandidateVersionSchema,
  candidates: z.array(providerSafeExactCandidateSchema).max(MAX_EXACT_CANDIDATES_PER_RESPONSE),
}).strict().superRefine((list, context) => {
  if (new Set(list.candidates.map((candidate) => candidate.candidateId)).size !== list.candidates.length) {
    context.addIssue({ code: "custom", message: "candidate IDs must be unique", path: ["candidates"] });
  }
});

/** Provider response can select one issued candidate and no mechanics arguments. */
export const exactCandidateSelectionResponseSchema = z.object({
  candidateId: candidateIdSchema,
  kind: z.literal("actor.travel"),
  version: exactCandidateVersionSchema,
  choices: z.tuple([]),
}).strict();

export function projectExactCandidateForProvider(candidate: unknown, now: string): z.infer<typeof providerSafeExactCandidateSchema> {
  const parsed = internalExactCandidateSchema.parse(candidate);
  const parsedNow = utcIsoTimestampSchema.parse(now);
  if (Date.parse(parsedNow) < Date.parse(parsed.issuedAt) || Date.parse(parsedNow) >= Date.parse(parsed.expiresAt)) {
    throw new Error("candidate is outside its selectable lifetime");
  }
  if (parsed.policy.result !== "allowed" || parsed.supersession.state !== "current"
    || parsed.execution.state !== "unexecuted"
    || (parsed.confirmation.requirement === "required" && parsed.confirmation.decision.state === "rejected")) {
    throw new Error("candidate is not provider-selectable");
  }
  return providerSafeExactCandidateSchema.parse({
    candidateId: parsed.candidateId,
    kind: parsed.kind,
    version: parsed.version,
    label: parsed.label,
    summary: parsed.summary,
    confirmation: { required: parsed.confirmation.requirement === "required" },
    quote: parsed.quote,
    expiresAt: parsed.expiresAt,
    choices: [],
  });
}

export const exactCandidateBoundaryFailureCodeSchema = z.enum([
  "invalid-response",
  "invalid-context",
  "unknown-candidate",
  "duplicate-candidate-id",
  "tampered-candidate",
  "cross-scope",
  "expired",
  "superseded",
  "stale-revision",
  "policy-denied",
  "confirmation-required",
  "invalid-decision",
  "already-executed",
]);

export const exactCandidateBoundaryContextSchema = z.object({
  campaignId: campaignIdSchema,
  sessionId: resourceIdSchema,
  actorId: actorIdSchema,
  principalId: principalIdSchema,
  connectionId: resourceIdSchema,
  now: utcIsoTimestampSchema,
  observedRevisions: z.object({ world: exactCandidateCanonicalRevisionSchema }).strict(),
}).strict();
export type ExactCandidateBoundaryContext = z.infer<typeof exactCandidateBoundaryContextSchema>;

export type ExactCandidateBoundaryResult =
  | { ok: true; candidate: z.infer<typeof internalExactCandidateSchema>; authorityRecheckRequired: true }
  | { ok: false; code: z.infer<typeof exactCandidateBoundaryFailureCodeSchema> };

/** Pure execution gate. Success identifies an exact intent but never authorizes its execution. */
export function validateExactCandidateSelection(
  response: unknown,
  candidates: readonly unknown[],
  context: unknown,
  crypto: TrustedExactCandidateCrypto,
): ExactCandidateBoundaryResult {
  const selection = exactCandidateSelectionResponseSchema.safeParse(response);
  if (!selection.success || candidates.length > MAX_EXACT_CANDIDATES_PER_RESPONSE) return { ok: false, code: "invalid-response" };
  const parsedContext = exactCandidateBoundaryContextSchema.safeParse(context);
  if (!parsedContext.success) return { ok: false, code: "invalid-context" };
  const parsedCandidates = candidates.map((candidate) => internalExactCandidateSchema.safeParse(candidate));
  if (parsedCandidates.some((candidate) => !candidate.success)) return { ok: false, code: "tampered-candidate" };
  const validCandidates = parsedCandidates.flatMap((parsed) => parsed.success ? [parsed.data] : []);
  if (new Set(validCandidates.map(({ candidateId }) => candidateId)).size !== validCandidates.length) {
    return { ok: false, code: "duplicate-candidate-id" };
  }
  const candidate = validCandidates.find((item) => item.candidateId === selection.data.candidateId);
  if (!candidate) return { ok: false, code: "unknown-candidate" };
  if (candidate.kind !== selection.data.kind || candidate.version !== selection.data.version) {
    return { ok: false, code: "tampered-candidate" };
  }
  try {
    if (computeExactCandidateActionDigest(candidate, crypto) !== candidate.canonicalActionDigest) {
      return { ok: false, code: "tampered-candidate" };
    }
    if (computeExactCandidateEnvelopeDigest(candidate, crypto) !== candidate.canonicalEnvelopeDigest) {
      return { ok: false, code: "tampered-candidate" };
    }
  } catch {
    return { ok: false, code: "tampered-candidate" };
  }
  const runtime = parsedContext.data;
  const scope = candidate.scope;
  if (scope.campaignId !== runtime.campaignId || scope.sessionId !== runtime.sessionId || scope.actorId !== runtime.actorId
    || scope.principalId !== runtime.principalId || scope.connectionId !== runtime.connectionId) {
    return { ok: false, code: "cross-scope" };
  }
  const now = Date.parse(runtime.now);
  if (now < Date.parse(candidate.issuedAt) || now >= Date.parse(candidate.expiresAt)) {
    return { ok: false, code: "expired" };
  }
  if (candidate.supersession.state === "superseded") return { ok: false, code: "superseded" };
  if (candidate.expectedRevisions.some(({ domain, revision }) => runtime.observedRevisions[domain] !== revision)) {
    return { ok: false, code: "stale-revision" };
  }
  if (candidate.policy.result === "denied") return { ok: false, code: "policy-denied" };
  if (candidate.confirmation.requirement === "required") {
    if (candidate.confirmation.decision.state !== "approved") return { ok: false, code: "confirmation-required" };
    if (Date.parse(candidate.confirmation.decision.decidedAt) > now) return { ok: false, code: "invalid-decision" };
  }
  if (candidate.execution.state === "receipt-linked") return { ok: false, code: "already-executed" };
  return { ok: true, candidate, authorityRecheckRequired: true };
}

export type InternalExactCandidate = z.infer<typeof internalExactCandidateSchema>;
export type ProviderSafeExactCandidate = z.infer<typeof providerSafeExactCandidateSchema>;
export type ExactCandidateSelectionResponse = z.infer<typeof exactCandidateSelectionResponseSchema>;
