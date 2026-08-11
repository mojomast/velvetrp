import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  diceRollResultSchema,
  normalizedDiceExpressionSchema,
  type DiceRollResult,
  type NormalizedDiceExpression,
} from "@velvet/contracts";
import {
  CLIENT_ENTROPY_BYTES,
  CLIENT_NONCE_BYTES,
  DIGEST_BYTES,
  MAX_ROLL_TIMEOUT_MS,
  MIN_ROLL_TIMEOUT_MS,
  SERVER_SECRET_BYTES,
  VERIFIABLE_DICE_VERSION,
  VerifiableDiceProtocolError,
  assertBytes,
  assertTimestamp,
  bindingFields,
  canonicalDiceResult,
  diceProtocolDomains,
  frameDiceProtocol,
  validateRollBinding,
  type AbandonedVerifiableRoll,
  type DiceClientContribution,
  type LegacyVerifiableRoll,
  type PendingVerifiableRoll,
  type SettledVerifiableRoll,
  type VerifiableDiceProof,
  type VerifiableRollBinding,
} from "./verifiableDiceContract.js";

export interface SecureByteSource {
  bytes(length: number): Uint8Array;
}

export const platformSecureByteSource: SecureByteSource = {
  bytes: (length) => randomBytes(length),
};

const hash = (input: Uint8Array): Uint8Array => createHash("sha256").update(input).digest();
const hmac = (key: Uint8Array, input: Uint8Array): Uint8Array => createHmac("sha256", key).update(input).digest();

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);

const fail = (message: string): never => {
  throw new VerifiableDiceProtocolError(message);
};

const copy = (value: Uint8Array): Uint8Array => Uint8Array.from(value);

export function createClientEntropy(source: SecureByteSource = platformSecureByteSource): {
  readonly entropy: Uint8Array;
  readonly nonce: Uint8Array;
} {
  const entropy = source.bytes(CLIENT_ENTROPY_BYTES);
  const nonce = source.bytes(CLIENT_NONCE_BYTES);
  assertBytes("client entropy", entropy, CLIENT_ENTROPY_BYTES);
  assertBytes("client nonce", nonce, CLIENT_NONCE_BYTES);
  return { entropy: copy(entropy), nonce: copy(nonce) };
}

export function commitmentFrame(binding: VerifiableRollBinding, serverSecret: Uint8Array): Uint8Array {
  assertBytes("server secret", serverSecret, SERVER_SECRET_BYTES);
  return frameDiceProtocol(diceProtocolDomains.commitment, [
    ...bindingFields(binding),
    { tag: 5, type: "bytes", value: serverSecret },
  ]);
}

export const computeCommitment = (binding: VerifiableRollBinding, serverSecret: Uint8Array): Uint8Array =>
  hash(commitmentFrame(binding, serverSecret));

export function hkdfSaltFrame(
  commitment: Uint8Array,
  clientEntropy: Uint8Array,
  clientNonce: Uint8Array,
): Uint8Array {
  assertBytes("commitment", commitment, DIGEST_BYTES);
  assertBytes("client entropy", clientEntropy, CLIENT_ENTROPY_BYTES);
  assertBytes("client nonce", clientNonce, CLIENT_NONCE_BYTES);
  return frameDiceProtocol(diceProtocolDomains.hkdfSalt, [
    { tag: 1, type: "bytes", value: commitment },
    { tag: 2, type: "bytes", value: clientEntropy },
    { tag: 3, type: "bytes", value: clientNonce },
  ]);
}

export function hkdfInfoFrame(
  binding: VerifiableRollBinding,
  commitment: Uint8Array,
  clientEntropy: Uint8Array,
  clientNonce: Uint8Array,
): Uint8Array {
  assertBytes("commitment", commitment, DIGEST_BYTES);
  assertBytes("client entropy", clientEntropy, CLIENT_ENTROPY_BYTES);
  assertBytes("client nonce", clientNonce, CLIENT_NONCE_BYTES);
  return frameDiceProtocol(diceProtocolDomains.hkdfInfo, [
    ...bindingFields(binding),
    { tag: 5, type: "bytes", value: commitment },
    { tag: 6, type: "bytes", value: clientEntropy },
    { tag: 7, type: "bytes", value: clientNonce },
  ]);
}

/** HKDF-SHA256: IKM=reveal, salt=SHA256(hkdf-salt frame), info=hkdf-info frame, L=32. */
export function deriveRollKey(
  binding: VerifiableRollBinding,
  commitment: Uint8Array,
  serverReveal: Uint8Array,
  clientEntropy: Uint8Array,
  clientNonce: Uint8Array,
): Uint8Array {
  assertBytes("server reveal", serverReveal, SERVER_SECRET_BYTES);
  const salt = hash(hkdfSaltFrame(commitment, clientEntropy, clientNonce));
  const info = hkdfInfoFrame(binding, commitment, clientEntropy, clientNonce);
  return new Uint8Array(hkdfSync("sha256", serverReveal, salt, info, DIGEST_BYTES));
}

export function randomBlockFrame(binding: VerifiableRollBinding, counter: number): Uint8Array {
  return frameDiceProtocol(diceProtocolDomains.randomBlock, [
    ...bindingFields(binding),
    { tag: 5, type: "u32", value: counter },
  ]);
}

export const computeRandomBlock = (
  rollKey: Uint8Array,
  binding: VerifiableRollBinding,
  counter: number,
): Uint8Array => {
  assertBytes("roll key", rollKey, DIGEST_BYTES);
  return hmac(rollKey, randomBlockFrame(binding, counter));
};

/** Maps uniform u32 words to [1, upperBound] and rejects the biased high tail. */
export function sampleUnbiasedBounded(words: Iterator<number>, upperBound: number): number {
  if (!Number.isInteger(upperBound) || upperBound < 2 || upperBound > 1_000) fail("invalid die upper bound");
  const range = 0x1_0000_0000;
  const acceptanceLimit = Math.floor(range / upperBound) * upperBound;
  for (;;) {
    const next = words.next();
    if (next.done) fail("random word stream exhausted during rejection sampling");
    const word = next.value;
    if (!Number.isInteger(word) || word < 0 || word > 0xffff_ffff) fail("invalid random word");
    if (word < acceptanceLimit) return (word % upperBound) + 1;
  }
}

function* hmacWords(key: Uint8Array, binding: VerifiableRollBinding): Generator<number> {
  for (let counter = 0; counter <= 0xffff_ffff; counter += 1) {
    const block = computeRandomBlock(key, binding, counter);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let offset = 0; offset < block.byteLength; offset += 4) yield view.getUint32(offset, false);
  }
  fail("random block counter exhausted");
}

const EXPRESSION = /^([1-9][0-9]{0,2})d([1-9][0-9]{0,3})(?:(kh|kl)([1-9][0-9]{0,2})|(adv|dis))?([+-][1-9][0-9]{0,3})?$/;

const normalizeExpression = (expression: string): NormalizedDiceExpression => {
  validateRollBinding({ rollId: "validation", commandId: "validation", candidateId: null, expression });
  const match = EXPRESSION.exec(expression);
  if (match === null) throw new VerifiableDiceProtocolError("invalid canonical dice expression");
  const selection: NormalizedDiceExpression["selection"] = match[3] === "kh"
    ? { type: "keep_highest", count: Number(match[4]) }
    : match[3] === "kl"
      ? { type: "keep_lowest", count: Number(match[4]) }
      : match[5] === "adv"
        ? { type: "advantage" }
        : match[5] === "dis"
          ? { type: "disadvantage" }
          : { type: "all" };
  return normalizedDiceExpressionSchema.parse({
    count: Number(match[1]),
    sides: Number(match[2]),
    selection,
    modifier: match[6] === undefined ? 0 : Number(match[6]),
  });
};

export function evaluateVerifiableDice(binding: VerifiableRollBinding, rollKey: Uint8Array): DiceRollResult {
  validateRollBinding(binding);
  assertBytes("roll key", rollKey, DIGEST_BYTES);
  const normalized = normalizeExpression(binding.expression);
  const physicalCount = normalized.selection.type === "advantage" || normalized.selection.type === "disadvantage"
    ? 2
    : normalized.count;
  const words = hmacWords(rollKey, binding);
  const values = Array.from({ length: physicalCount }, () => sampleUnbiasedBounded(words, normalized.sides));
  const selection = normalized.selection;
  const keepCount = selection.type === "keep_highest" || selection.type === "keep_lowest"
    ? selection.count
    : selection.type === "all" ? physicalCount : 1;
  const keepHighest = selection.type === "keep_highest" || selection.type === "advantage";
  const ordered = values.map((_, index) => index).sort((left, right) => {
    const difference = keepHighest ? values[right]! - values[left]! : values[left]! - values[right]!;
    return difference === 0 ? left - right : difference;
  });
  const kept = selection.type === "all"
    ? new Set(ordered)
    : new Set(ordered.slice(0, keepCount));
  const terms = values.map((value, index) => ({ value, kept: kept.has(index) }));
  return diceRollResultSchema.parse({
    expression: binding.expression,
    normalized,
    terms,
    modifier: normalized.modifier,
    total: terms.reduce((total, term) => total + (term.kept ? term.value : 0), normalized.modifier),
  });
}

export function transcriptFrame(
  binding: VerifiableRollBinding,
  commitment: Uint8Array,
  clientEntropy: Uint8Array,
  clientNonce: Uint8Array,
  serverReveal: Uint8Array,
  result: DiceRollResult,
): Uint8Array {
  assertBytes("commitment", commitment, DIGEST_BYTES);
  assertBytes("client entropy", clientEntropy, CLIENT_ENTROPY_BYTES);
  assertBytes("client nonce", clientNonce, CLIENT_NONCE_BYTES);
  assertBytes("server reveal", serverReveal, SERVER_SECRET_BYTES);
  return frameDiceProtocol(diceProtocolDomains.transcript, [
    ...bindingFields(binding),
    { tag: 5, type: "bytes", value: commitment },
    { tag: 6, type: "bytes", value: clientEntropy },
    { tag: 7, type: "bytes", value: clientNonce },
    { tag: 8, type: "bytes", value: serverReveal },
    { tag: 9, type: "bytes", value: canonicalDiceResult(result) },
  ]);
}

export const computeTranscriptDigest = (...args: Parameters<typeof transcriptFrame>): Uint8Array =>
  hash(transcriptFrame(...args));

export function proofFrame(binding: VerifiableRollBinding, transcriptDigest: Uint8Array): Uint8Array {
  assertBytes("transcript digest", transcriptDigest, DIGEST_BYTES);
  return frameDiceProtocol(diceProtocolDomains.proof, [
    ...bindingFields(binding),
    { tag: 5, type: "bytes", value: transcriptDigest },
  ]);
}

export const computeProofMac = (
  rollKey: Uint8Array,
  binding: VerifiableRollBinding,
  transcriptDigest: Uint8Array,
): Uint8Array => hmac(rollKey, proofFrame(binding, transcriptDigest));

export function clientContributionFrame(
  binding: VerifiableRollBinding,
  commitment: Uint8Array,
  entropy: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  assertBytes("commitment", commitment, DIGEST_BYTES);
  assertBytes("client entropy", entropy, CLIENT_ENTROPY_BYTES);
  assertBytes("client nonce", nonce, CLIENT_NONCE_BYTES);
  return frameDiceProtocol(diceProtocolDomains.clientContribution, [
    ...bindingFields(binding),
    { tag: 5, type: "bytes", value: commitment },
    { tag: 6, type: "bytes", value: entropy },
    { tag: 7, type: "bytes", value: nonce },
  ]);
}

export const computeClientContributionDigest = (...args: Parameters<typeof clientContributionFrame>): Uint8Array =>
  hash(clientContributionFrame(...args));

export type ProtocolTransitionOperation =
  | Readonly<{
    kind: "create";
    rollId: string;
    commitment: Uint8Array;
    source: "lifecycle" | "observation";
  }>
  | Readonly<{
    kind: "contribute";
    rollId: string;
    commitment: Uint8Array;
    nonce: Uint8Array;
    contributionDigest: Uint8Array;
    expectedCapability: string;
  }>
  | Readonly<{
    kind: "settle";
    rollId: string;
    commitment: Uint8Array;
    contributionDigest: Uint8Array;
    transcriptDigest: Uint8Array;
    expectedCapability: string;
  }>
  | Readonly<{
    kind: "abandon";
    rollId: string;
    commitment: Uint8Array;
    reason: "cancelled" | "timeout" | "withheld";
    expectedCapability: string;
  }>
  | Readonly<{
    kind: "proof";
    rollId: string;
    commitment: Uint8Array;
    nonce: Uint8Array;
    contributionDigest: Uint8Array;
    transcriptDigest: Uint8Array;
    expectedCapability: string;
  }>;

export type ProtocolTransitionConflict =
  | "roll_reused"
  | "commitment_reused"
  | "nonce_reused"
  | "stale_capability"
  | "invalid_transition"
  | "commitment_not_registered"
  | "contribution_mismatch"
  | "roll_terminal";

export type ProtocolTransitionResult = Readonly<{ accepted: true; capability: string | null }>
  | Readonly<{ accepted: false; conflict: ProtocolTransitionConflict }>;

/**
 * One call atomically validates the expected capability, uniqueness constraints,
 * state transition, and replacement capability/terminal state. Durable adapters
 * implement this as one transaction or compare-and-swap; check-then-write is not
 * conforming because concurrent stale handles could both otherwise succeed.
 */
export interface ProtocolTransitionRegistry {
  transition(operation: ProtocolTransitionOperation): ProtocolTransitionResult;
}

const keyOf = (value: Uint8Array): string => Buffer.from(value).toString("hex");

type RegistryRollState =
  | Readonly<{
    state: "pending";
    commitment: string;
    capability: string;
    source: "lifecycle" | "observation";
  }>
  | Readonly<{
    state: "contributed";
    commitment: string;
    nonce: string;
    contributionDigest: string;
    capability: string;
  }>
  | Readonly<{ state: "settled" | "cancelled" | "timeout" | "withheld"; commitment: string }>;

/** Reference atomic state machine for tests and single-process callers. */
export class InMemoryProtocolTransitionRegistry implements ProtocolTransitionRegistry {
  readonly #rolls = new Map<string, RegistryRollState>();
  readonly #commitmentRolls = new Map<string, string>();
  readonly #nonceRolls = new Map<string, string>();
  #capabilitySequence = 0;

  #nextCapability(): string {
    this.#capabilitySequence += 1;
    return `capability-${this.#capabilitySequence}`;
  }

  transition(operation: ProtocolTransitionOperation): ProtocolTransitionResult {
    const commitment = keyOf(operation.commitment);
    const roll = this.#rolls.get(operation.rollId);
    const existingRoll = this.#commitmentRolls.get(commitment);

    if (operation.kind === "create") {
      if (roll !== undefined) return { accepted: false, conflict: "roll_reused" };
      if (existingRoll !== undefined) return { accepted: false, conflict: "commitment_reused" };
      const capability = this.#nextCapability();
      this.#rolls.set(operation.rollId, {
        state: "pending", commitment, capability, source: operation.source,
      });
      this.#commitmentRolls.set(commitment, operation.rollId);
      return { accepted: true, capability };
    }

    if (operation.kind === "proof") {
      if (roll === undefined) return { accepted: false, conflict: "commitment_not_registered" };
      if (roll.state === "pending") return { accepted: false, conflict: "invalid_transition" };
      if (roll.state !== "contributed") {
        return { accepted: false, conflict: "roll_terminal" };
      }
      if (roll.capability !== operation.expectedCapability) {
        return { accepted: false, conflict: "stale_capability" };
      }
      if (roll.commitment !== commitment) return { accepted: false, conflict: "contribution_mismatch" };
      if (roll.commitment !== commitment
          || roll.nonce !== keyOf(operation.nonce)
          || roll.contributionDigest !== keyOf(operation.contributionDigest)) {
        return { accepted: false, conflict: "contribution_mismatch" };
      }
      const nonce = keyOf(operation.nonce);
      const nonceRoll = this.#nonceRolls.get(nonce);
      if (nonceRoll !== undefined && nonceRoll !== operation.rollId) return { accepted: false, conflict: "nonce_reused" };
      this.#rolls.set(operation.rollId, { state: "settled", commitment });
      this.#commitmentRolls.set(commitment, operation.rollId);
      this.#nonceRolls.set(nonce, operation.rollId);
      return { accepted: true, capability: null };
    }

    if (roll === undefined || roll.commitment !== commitment) {
      return { accepted: false, conflict: "invalid_transition" };
    }
    if (roll.state !== "pending" && roll.state !== "contributed") {
      return { accepted: false, conflict: "roll_terminal" };
    }
    if (roll.capability !== operation.expectedCapability) {
      return { accepted: false, conflict: "stale_capability" };
    }

    if (operation.kind === "contribute") {
      if (roll.state !== "pending") return { accepted: false, conflict: "invalid_transition" };
      const nonce = keyOf(operation.nonce);
      const nonceRoll = this.#nonceRolls.get(nonce);
      if (nonceRoll !== undefined) return { accepted: false, conflict: "nonce_reused" };
      const capability = this.#nextCapability();
      this.#nonceRolls.set(nonce, operation.rollId);
      this.#rolls.set(operation.rollId, {
        state: "contributed",
        commitment,
        nonce,
        contributionDigest: keyOf(operation.contributionDigest),
        capability,
      });
      return { accepted: true, capability };
    }

    if (operation.kind === "settle") {
      if (roll.state !== "contributed") return { accepted: false, conflict: "invalid_transition" };
      if (roll.contributionDigest !== keyOf(operation.contributionDigest)) {
        return { accepted: false, conflict: "contribution_mismatch" };
      }
      this.#rolls.set(operation.rollId, { state: "settled", commitment });
      return { accepted: true, capability: null };
    }

    const validAbandonment = (roll.state === "pending"
      && (operation.reason === "cancelled" || operation.reason === "timeout"))
      || (roll.state === "contributed" && operation.reason === "withheld");
    if (!validAbandonment) return { accepted: false, conflict: "invalid_transition" };
    this.#rolls.set(operation.rollId, { state: operation.reason, commitment });
    return { accepted: true, capability: null };
  }
}

const transition = (
  registry: ProtocolTransitionRegistry,
  operation: ProtocolTransitionOperation,
): string | null => {
  const result = registry.transition(operation);
  if (!result.accepted) throw new VerifiableDiceProtocolError(`protocol transition rejected: ${result.conflict}`);
  return result.capability;
};

interface InternalPendingVerifiableRoll extends PendingVerifiableRoll {
  readonly serverSecret: Uint8Array;
  readonly capability: string;
}

export interface PendingVerifiableRollHandle {
  readonly kind: "verifiable-dice-pending-handle";
}

const pendingInternals = new WeakMap<PendingVerifiableRollHandle, InternalPendingVerifiableRoll>();

const pendingHandle = (internal: InternalPendingVerifiableRoll): PendingVerifiableRollHandle => {
  const handle: PendingVerifiableRollHandle = Object.freeze({ kind: "verifiable-dice-pending-handle" });
  pendingInternals.set(handle, internal);
  return handle;
};

const pendingInternal = (handle: PendingVerifiableRollHandle): InternalPendingVerifiableRoll => {
  const internal = pendingInternals.get(handle);
  if (internal === undefined) throw new VerifiableDiceProtocolError("invalid pending roll handle");
  return internal;
};

interface ObservedCommitmentInternal {
  readonly binding: VerifiableRollBinding;
  readonly commitment: Uint8Array;
  readonly capability: string;
}

interface ContributedVerificationInternal extends ObservedCommitmentInternal {
  readonly entropy: Uint8Array;
  readonly nonce: Uint8Array;
}

export interface ObservedVerifiableDiceCommitmentHandle {
  readonly kind: "verifiable-dice-observed-commitment-handle";
}

export interface ContributedVerifiableDiceProofHandle {
  readonly kind: "verifiable-dice-contributed-proof-handle";
}

const observedCommitments = new WeakMap<ObservedVerifiableDiceCommitmentHandle, ObservedCommitmentInternal>();
const contributedProofs = new WeakMap<ContributedVerifiableDiceProofHandle, ContributedVerificationInternal>();

const contributedProofHandle = (
  internal: ContributedVerificationInternal,
): ContributedVerifiableDiceProofHandle => {
  const handle: ContributedVerifiableDiceProofHandle = Object.freeze({
    kind: "verifiable-dice-contributed-proof-handle",
  });
  contributedProofs.set(handle, internal);
  return handle;
};

/**
 * Records the ordering event that the verifier observed this commitment before
 * accepting client input. The opaque capability is advanced by contribution;
 * cryptography cannot independently prove wall-clock ordering.
 */
export function observeVerifiableDiceCommitment(
  binding: VerifiableRollBinding,
  commitment: Uint8Array,
  registry: ProtocolTransitionRegistry,
): ObservedVerifiableDiceCommitmentHandle {
  validateRollBinding(binding);
  assertBytes("observed commitment", commitment, DIGEST_BYTES);
  const capability = transition(registry, {
    kind: "create", rollId: binding.rollId, commitment, source: "observation",
  });
  if (capability === null) throw new VerifiableDiceProtocolError("commitment observation did not return a capability");
  const handle: ObservedVerifiableDiceCommitmentHandle = Object.freeze({
    kind: "verifiable-dice-observed-commitment-handle",
  });
  observedCommitments.set(handle, { binding: { ...binding }, commitment: copy(commitment), capability });
  return handle;
}

export function contributeToObservedVerifiableDiceCommitment(
  handle: ObservedVerifiableDiceCommitmentHandle,
  entropy: Uint8Array,
  nonce: Uint8Array,
  registry: ProtocolTransitionRegistry,
): ContributedVerifiableDiceProofHandle {
  const observed = observedCommitments.get(handle);
  if (observed === undefined) throw new VerifiableDiceProtocolError("invalid observed commitment handle");
  assertBytes("client entropy", entropy, CLIENT_ENTROPY_BYTES);
  assertBytes("client nonce", nonce, CLIENT_NONCE_BYTES);
  const contributionDigest = computeClientContributionDigest(
    observed.binding, observed.commitment, entropy, nonce,
  );
  const capability = transition(registry, {
    kind: "contribute",
    rollId: observed.binding.rollId,
    commitment: observed.commitment,
    nonce,
    contributionDigest,
    expectedCapability: observed.capability,
  });
  if (capability === null) throw new VerifiableDiceProtocolError("contribution transition did not return a capability");
  return contributedProofHandle({
    binding: observed.binding,
    commitment: copy(observed.commitment),
    capability,
    entropy: copy(entropy),
    nonce: copy(nonce),
  });
}

/** Derives proof authority only from a lifecycle handle already transitioned to contributed. */
export function proofHandleFromContributedVerifiableRoll(
  handle: PendingVerifiableRollHandle,
): ContributedVerifiableDiceProofHandle {
  const pending = pendingInternal(handle);
  if (pending.client === null) throw new VerifiableDiceProtocolError("client entropy has not been submitted");
  const client = pending.client;
  return contributedProofHandle({
    binding: pending.binding,
    commitment: copy(pending.commitment),
    capability: pending.capability,
    entropy: copy(client.entropy),
    nonce: copy(client.nonce),
  });
}

/** Returns a defensive, secret-free state suitable for transport or logging. */
export function projectPendingVerifiableRoll(handle: PendingVerifiableRollHandle): PendingVerifiableRoll {
  const pending = pendingInternal(handle);
  return {
    state: "pending",
    binding: { ...pending.binding },
    commitment: copy(pending.commitment),
    committedAtMs: pending.committedAtMs,
    expiresAtMs: pending.expiresAtMs,
    client: pending.client === null ? null : {
      entropy: copy(pending.client.entropy),
      nonce: copy(pending.client.nonce),
      submittedAtMs: pending.client.submittedAtMs,
    },
  };
}

export function beginVerifiableRoll(
  binding: VerifiableRollBinding,
  committedAtMs: number,
  timeoutMs: number,
  registry: ProtocolTransitionRegistry,
  source: SecureByteSource = platformSecureByteSource,
): PendingVerifiableRollHandle {
  validateRollBinding(binding);
  assertTimestamp("committedAtMs", committedAtMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_ROLL_TIMEOUT_MS || timeoutMs > MAX_ROLL_TIMEOUT_MS) {
    fail("invalid roll timeout");
  }
  const expiresAtMs = committedAtMs + timeoutMs;
  if (!Number.isSafeInteger(expiresAtMs)) fail("roll expiry exceeds safe integer range");
  const secret = source.bytes(SERVER_SECRET_BYTES);
  assertBytes("server secret", secret, SERVER_SECRET_BYTES);
  const serverSecret = copy(secret);
  const commitment = computeCommitment(binding, serverSecret);
  const capability = transition(registry, {
    kind: "create", rollId: binding.rollId, commitment, source: "lifecycle",
  });
  if (capability === null) throw new VerifiableDiceProtocolError("create transition did not return a capability");
  return pendingHandle({
    state: "pending",
    binding: { ...binding },
    commitment,
    serverSecret,
    capability,
    committedAtMs,
    expiresAtMs,
    client: null,
  });
}

export function submitClientEntropy(
  handle: PendingVerifiableRollHandle,
  entropy: Uint8Array,
  nonce: Uint8Array,
  submittedAtMs: number,
  registry: ProtocolTransitionRegistry,
): PendingVerifiableRollHandle {
  const pending = pendingInternal(handle);
  if (pending.client !== null) fail("client entropy or nonce reuse for this roll");
  assertTimestamp("submittedAtMs", submittedAtMs);
  if (submittedAtMs < pending.committedAtMs || submittedAtMs >= pending.expiresAtMs) fail("client entropy submitted outside pending window");
  assertBytes("client entropy", entropy, CLIENT_ENTROPY_BYTES);
  assertBytes("client nonce", nonce, CLIENT_NONCE_BYTES);
  const contributionDigest = computeClientContributionDigest(
    pending.binding, pending.commitment, entropy, nonce,
  );
  const capability = transition(registry, {
    kind: "contribute",
    rollId: pending.binding.rollId,
    commitment: pending.commitment,
    nonce,
    contributionDigest,
    expectedCapability: pending.capability,
  });
  if (capability === null) throw new VerifiableDiceProtocolError("contribution transition did not return a capability");
  const client: DiceClientContribution = { entropy: copy(entropy), nonce: copy(nonce), submittedAtMs };
  return pendingHandle({ ...pending, capability, client });
}

export function settleVerifiableRoll(
  handle: PendingVerifiableRollHandle,
  settledAtMs: number,
  registry: ProtocolTransitionRegistry,
): SettledVerifiableRoll {
  const pending = pendingInternal(handle);
  if (pending.client === null) throw new VerifiableDiceProtocolError("client entropy has not been submitted");
  const client = pending.client;
  assertTimestamp("settledAtMs", settledAtMs);
  if (settledAtMs < client.submittedAtMs || settledAtMs >= pending.expiresAtMs) fail("roll cannot settle at or after expiry");
  const { entropy, nonce } = client;
  const rollKey = deriveRollKey(pending.binding, pending.commitment, pending.serverSecret, entropy, nonce);
  const result = evaluateVerifiableDice(pending.binding, rollKey);
  const transcriptDigest = computeTranscriptDigest(
    pending.binding, pending.commitment, entropy, nonce, pending.serverSecret, result,
  );
  transition(registry, {
    kind: "settle",
    rollId: pending.binding.rollId,
    commitment: pending.commitment,
    contributionDigest: computeClientContributionDigest(pending.binding, pending.commitment, entropy, nonce),
    transcriptDigest,
    expectedCapability: pending.capability,
  });
  return {
    state: "settled",
    binding: pending.binding,
    commitment: copy(pending.commitment),
    clientEntropy: copy(entropy),
    clientNonce: copy(nonce),
    serverReveal: copy(pending.serverSecret),
    result,
    transcriptDigest,
    proofMac: computeProofMac(rollKey, pending.binding, transcriptDigest),
    committedAtMs: pending.committedAtMs,
    settledAtMs,
  };
}

export function abandonVerifiableRoll(
  handle: PendingVerifiableRollHandle,
  abandonedAtMs: number,
  registry: ProtocolTransitionRegistry,
  cancellationRequested = false,
): AbandonedVerifiableRoll {
  const pending = pendingInternal(handle);
  assertTimestamp("abandonedAtMs", abandonedAtMs);
  if (abandonedAtMs < pending.committedAtMs) fail("roll cannot be abandoned before commitment");
  const expired = abandonedAtMs >= pending.expiresAtMs;
  if (pending.client !== null && !expired) fail("a contributed roll cannot be cancelled before expiry");
  if (!expired && !cancellationRequested) fail("unexpired roll requires explicit cancellation");
  const reason = expired ? (pending.client === null ? "timeout" : "withheld") : "cancelled";
  const clientContributionEvidenceDigest = pending.client === null
    ? null
    : computeClientContributionDigest(
      pending.binding, pending.commitment, pending.client.entropy, pending.client.nonce,
    );
  transition(registry, {
    kind: "abandon",
    rollId: pending.binding.rollId,
    commitment: pending.commitment,
    reason,
    expectedCapability: pending.capability,
  });
  return {
    state: "abandoned",
    binding: pending.binding,
    commitment: copy(pending.commitment),
    reason,
    committedAtMs: pending.committedAtMs,
    abandonedAtMs,
    clientContributionEvidenceDigest,
  };
}

export function proofFromSettled(settled: SettledVerifiableRoll): VerifiableDiceProof {
  return {
    version: VERIFIABLE_DICE_VERSION,
    binding: settled.binding,
    commitment: copy(settled.commitment),
    clientEntropy: copy(settled.clientEntropy),
    clientNonce: copy(settled.clientNonce),
    serverReveal: copy(settled.serverReveal),
    result: settled.result,
    transcriptDigest: copy(settled.transcriptDigest),
    proofMac: copy(settled.proofMac),
  };
}

export function markLegacyRoll(rollId: string, result: DiceRollResult): LegacyVerifiableRoll {
  validateRollBinding({ rollId, commandId: "legacy", candidateId: null, expression: result.expression });
  return { state: "legacy", rollId, result: diceRollResultSchema.parse(result) };
}

export function verifyVerifiableDiceProof(
  proof: VerifiableDiceProof,
  handle: ContributedVerifiableDiceProofHandle,
  registry: ProtocolTransitionRegistry,
): DiceRollResult {
  const trustedInput = contributedProofs.get(handle);
  if (trustedInput === undefined) throw new VerifiableDiceProtocolError("invalid contributed proof handle");
  const expectedBinding = trustedInput.binding;
  if (proof === null || typeof proof !== "object") fail("malformed proof");
  if (proof.version !== VERIFIABLE_DICE_VERSION) fail("unsupported proof version");
  validateRollBinding(proof.binding);
  validateRollBinding(expectedBinding);
  if (proof.binding.rollId !== expectedBinding.rollId
      || proof.binding.commandId !== expectedBinding.commandId
      || proof.binding.candidateId !== expectedBinding.candidateId
      || proof.binding.expression !== expectedBinding.expression) fail("proof binding mismatch");
  assertBytes("commitment", proof.commitment, DIGEST_BYTES);
  assertBytes("client entropy", proof.clientEntropy, CLIENT_ENTROPY_BYTES);
  assertBytes("client nonce", proof.clientNonce, CLIENT_NONCE_BYTES);
  assertBytes("server reveal", proof.serverReveal, SERVER_SECRET_BYTES);
  assertBytes("transcript digest", proof.transcriptDigest, DIGEST_BYTES);
  assertBytes("proof MAC", proof.proofMac, DIGEST_BYTES);
  assertBytes("observed commitment", trustedInput.commitment, DIGEST_BYTES);
  assertBytes("expected client entropy", trustedInput.entropy, CLIENT_ENTROPY_BYTES);
  assertBytes("expected client nonce", trustedInput.nonce, CLIENT_NONCE_BYTES);
  if (!bytesEqual(proof.commitment, trustedInput.commitment)) fail("proof commitment does not match observed precommitment");
  if (!bytesEqual(proof.clientEntropy, trustedInput.entropy)
      || !bytesEqual(proof.clientNonce, trustedInput.nonce)) fail("proof contribution mismatch");
  diceRollResultSchema.parse(proof.result);
  if (!bytesEqual(proof.commitment, computeCommitment(proof.binding, proof.serverReveal))) fail("commitment mismatch");
  const key = deriveRollKey(
    proof.binding, proof.commitment, proof.serverReveal, proof.clientEntropy, proof.clientNonce,
  );
  const expectedResult = evaluateVerifiableDice(proof.binding, key);
  if (!bytesEqual(canonicalDiceResult(proof.result), canonicalDiceResult(expectedResult))) fail("result mismatch");
  const transcript = computeTranscriptDigest(
    proof.binding, proof.commitment, proof.clientEntropy, proof.clientNonce, proof.serverReveal, proof.result,
  );
  if (!bytesEqual(proof.transcriptDigest, transcript)) fail("transcript mismatch");
  if (!bytesEqual(proof.proofMac, computeProofMac(key, proof.binding, transcript))) fail("proof MAC mismatch");
  transition(registry, {
    kind: "proof",
    rollId: proof.binding.rollId,
    commitment: proof.commitment,
    nonce: proof.clientNonce,
    contributionDigest: computeClientContributionDigest(
      proof.binding, proof.commitment, proof.clientEntropy, proof.clientNonce,
    ),
    transcriptDigest: proof.transcriptDigest,
    expectedCapability: trustedInput.capability,
  });
  return proof.result;
}
