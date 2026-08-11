import {
  diceExpressionSchema,
  diceRollResultSchema,
  type DiceRollResult,
} from "@velvet/contracts";

export const VERIFIABLE_DICE_VERSION = 1;
export const VERIFIABLE_DICE_MAGIC = new TextEncoder().encode("VLVTDICE");
export const SERVER_SECRET_BYTES = 32;
export const CLIENT_ENTROPY_BYTES = 32;
export const CLIENT_NONCE_BYTES = 16;
export const DIGEST_BYTES = 32;
export const MAX_BINDING_UTF8_BYTES = 128;
export const MAX_FRAME_FIELDS = 32;
export const MAX_FRAME_DOMAIN_UTF8_BYTES = 64;
export const MAX_FRAME_PAYLOAD_BYTES = 65_535;
export const MIN_ROLL_TIMEOUT_MS = 1_000;
export const MAX_ROLL_TIMEOUT_MS = 300_000;

export const diceProtocolDomains = {
  commitment: "velvet.dice/commitment",
  hkdfSalt: "velvet.dice/hkdf-salt",
  hkdfInfo: "velvet.dice/hkdf-info",
  randomBlock: "velvet.dice/random-block",
  canonicalResult: "velvet.dice/canonical-result",
  clientContribution: "velvet.dice/client-contribution",
  transcript: "velvet.dice/transcript",
  proof: "velvet.dice/proof",
} as const;

export type DiceProtocolDomain = typeof diceProtocolDomains[keyof typeof diceProtocolDomains];

export type FrameField =
  | Readonly<{ tag: number; type: "bytes"; value: Uint8Array }>
  | Readonly<{ tag: number; type: "utf8"; value: string }>
  | Readonly<{ tag: number; type: "u32"; value: number }>
  | Readonly<{ tag: number; type: "i32"; value: number }>
  | Readonly<{ tag: number; type: "optionalUtf8"; value: string | null }>;

const FIELD_TYPES = {
  bytes: 1,
  utf8: 2,
  u32: 3,
  i32: 4,
  optionalUtf8: 5,
} as const;

const utf8 = new TextEncoder();

export class VerifiableDiceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifiableDiceProtocolError";
  }
}

const fail = (message: string): never => {
  throw new VerifiableDiceProtocolError(message);
};

/** TextEncoder replaces lone UTF-16 surrogates with U+FFFD, so reject them before any encoding. */
export function assertUnicodeScalarText(name: string, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) fail(`${name} contains an unpaired UTF-16 surrogate`);
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(`${name} contains an unpaired UTF-16 surrogate`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${name} contains an unpaired UTF-16 surrogate`);
    }
  }
}

const encodeUtf8 = (name: string, value: string): Uint8Array => {
  assertUnicodeScalarText(name, value);
  return utf8.encode(value);
};

const u16 = (value: number): Uint8Array => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) fail("invalid unsigned 16-bit integer");
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, false);
  return output;
};

const u32 = (value: number): Uint8Array => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) fail("invalid unsigned 32-bit integer");
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
};

const i32 = (value: number): Uint8Array => {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) fail("invalid signed 32-bit integer");
  const output = new Uint8Array(4);
  new DataView(output.buffer).setInt32(0, value, false);
  return output;
};

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const encodeField = (field: FrameField): Uint8Array => {
  if (!Number.isInteger(field.tag) || field.tag < 1 || field.tag > 255) fail("invalid frame field tag");
  let payload: Uint8Array;
  switch (field.type) {
    case "bytes":
      payload = Uint8Array.from(field.value);
      break;
    case "utf8":
      payload = encodeUtf8("UTF-8 frame field", field.value);
      break;
    case "u32":
      payload = u32(field.value);
      break;
    case "i32":
      payload = i32(field.value);
      break;
    case "optionalUtf8":
      payload = field.value === null
        ? Uint8Array.of(0)
        : join([Uint8Array.of(1), encodeUtf8("optional UTF-8 frame field", field.value)]);
      break;
  }
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) fail("frame field payload is too large");
  return join([
    Uint8Array.of(field.tag, FIELD_TYPES[field.type]),
    u32(payload.byteLength),
    payload,
  ]);
};

/**
 * V1 framing table (all integers are big-endian):
 *
 * | bytes | value |
 * | 8 | ASCII `VLVTDICE` |
 * | 2 | protocol version |
 * | 2 + N | domain UTF-8 byte length, then domain bytes |
 * | 2 | field count |
 * | repeated | tag:u8, type:u8, payload length:u32, payload bytes |
 *
 * Field types are bytes=1, UTF-8=2, u32=3, i32=4, optional UTF-8=5.
 * Optional UTF-8 payload is 0x00 for absent or 0x01 || UTF-8 for present.
 * Tags are unique and strictly increasing. UTF-8 inputs must be Unicode scalar
 * sequences; callers validate binding text as NFC before framing.
 *
 * Domain procedures and exact tags:
 * commitment=(binding 1..4, secret 5); hkdf-salt=(commitment 1, entropy 2,
 * nonce 3); hkdf-info=(binding 1..4, commitment 5, entropy 6, nonce 7);
 * random-block=(binding 1..4, counter 5); canonical-result=(expression 1,
 * terms 2, modifier 3, total 4); client-contribution=(binding 1..4,
 * commitment 5, entropy 6, nonce 7); transcript=(binding 1..4, commitment 5,
 * entropy 6, nonce 7, reveal 8, canonical result 9); proof=(binding 1..4,
 * transcript digest 5).
 */
export function frameDiceProtocol(domain: DiceProtocolDomain, fields: readonly FrameField[]): Uint8Array {
  const domainBytes = encodeUtf8("frame domain", domain);
  if (domainBytes.byteLength === 0 || domainBytes.byteLength > MAX_FRAME_DOMAIN_UTF8_BYTES) {
    fail("invalid frame domain length");
  }
  if (fields.length > MAX_FRAME_FIELDS) fail("too many frame fields");
  let priorTag = 0;
  for (const field of fields) {
    if (field.tag <= priorTag) fail("frame field tags must be unique and strictly increasing");
    priorTag = field.tag;
  }
  return join([
    VERIFIABLE_DICE_MAGIC,
    u16(VERIFIABLE_DICE_VERSION),
    u16(domainBytes.byteLength),
    domainBytes,
    u16(fields.length),
    ...fields.map(encodeField),
  ]);
}

export interface VerifiableRollBinding {
  readonly rollId: string;
  readonly commandId: string;
  readonly candidateId: string | null;
  readonly expression: string;
}

const assertCanonicalText = (name: string, value: string): void => {
  assertUnicodeScalarText(name, value);
  const bytes = utf8.encode(value);
  if (value.length === 0 || bytes.byteLength > MAX_BINDING_UTF8_BYTES) fail(`invalid ${name} length`);
  if (value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value)) fail(`invalid ${name} text`);
};

export function validateRollBinding(binding: VerifiableRollBinding): void {
  assertCanonicalText("rollId", binding.rollId);
  assertCanonicalText("commandId", binding.commandId);
  if (binding.candidateId !== null) assertCanonicalText("candidateId", binding.candidateId);
  diceExpressionSchema.parse(binding.expression);
}

export function bindingFields(binding: VerifiableRollBinding): readonly FrameField[] {
  validateRollBinding(binding);
  return [
    { tag: 1, type: "utf8", value: binding.rollId },
    { tag: 2, type: "utf8", value: binding.commandId },
    { tag: 3, type: "optionalUtf8", value: binding.candidateId },
    { tag: 4, type: "utf8", value: binding.expression },
  ];
}

export function canonicalDiceResult(result: DiceRollResult): Uint8Array {
  const parsed = diceRollResultSchema.parse(result);
  const termBytes = new Uint8Array(2 + parsed.terms.length * 3);
  const view = new DataView(termBytes.buffer);
  view.setUint16(0, parsed.terms.length, false);
  parsed.terms.forEach((term, index) => {
    const offset = 2 + index * 3;
    view.setUint16(offset, term.value, false);
    termBytes[offset + 2] = term.kept ? 1 : 0;
  });
  return frameDiceProtocol(diceProtocolDomains.canonicalResult, [
    { tag: 1, type: "utf8", value: parsed.expression },
    { tag: 2, type: "bytes", value: termBytes },
    { tag: 3, type: "i32", value: parsed.modifier },
    { tag: 4, type: "i32", value: parsed.total },
  ]);
}

export interface DiceClientContribution {
  readonly entropy: Uint8Array;
  readonly nonce: Uint8Array;
  readonly submittedAtMs: number;
}

export interface PendingVerifiableRoll {
  readonly state: "pending";
  readonly binding: VerifiableRollBinding;
  readonly commitment: Uint8Array;
  readonly committedAtMs: number;
  readonly expiresAtMs: number;
  readonly client: DiceClientContribution | null;
}

export interface SettledVerifiableRoll {
  readonly state: "settled";
  readonly binding: VerifiableRollBinding;
  readonly commitment: Uint8Array;
  readonly clientEntropy: Uint8Array;
  readonly clientNonce: Uint8Array;
  readonly serverReveal: Uint8Array;
  readonly result: DiceRollResult;
  readonly transcriptDigest: Uint8Array;
  readonly proofMac: Uint8Array;
  readonly committedAtMs: number;
  readonly settledAtMs: number;
}

export type DiceAbandonReason = "cancelled" | "timeout" | "withheld";

export interface AbandonedVerifiableRoll {
  readonly state: "abandoned";
  readonly binding: VerifiableRollBinding;
  readonly commitment: Uint8Array;
  readonly reason: DiceAbandonReason;
  readonly committedAtMs: number;
  readonly abandonedAtMs: number;
  readonly clientContributionEvidenceDigest: Uint8Array | null;
}

export interface LegacyVerifiableRoll {
  readonly state: "legacy";
  readonly rollId: string;
  readonly result: DiceRollResult;
}

export type VerifiableRollLifecycle =
  | PendingVerifiableRoll
  | SettledVerifiableRoll
  | AbandonedVerifiableRoll
  | LegacyVerifiableRoll;

export interface VerifiableDiceProof {
  readonly version: 1;
  readonly binding: VerifiableRollBinding;
  readonly commitment: Uint8Array;
  readonly clientEntropy: Uint8Array;
  readonly clientNonce: Uint8Array;
  readonly serverReveal: Uint8Array;
  readonly result: DiceRollResult;
  readonly transcriptDigest: Uint8Array;
  readonly proofMac: Uint8Array;
}

export function assertBytes(name: string, value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) fail(`${name} must be exactly ${length} bytes`);
}

export function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative safe integer`);
}
