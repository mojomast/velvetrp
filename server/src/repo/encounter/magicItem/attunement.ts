import {
  MAGIC_ITEM_ATTUNEMENT_LIMIT,
  type MagicAttunementPrerequisiteState,
  type MagicAttunementState,
  type MagicItemDefinition,
  type MagicItemReference,
  type MagicRestKind,
} from "./types.js";
import { stableKey } from "./internal.js";

/**
 * Bounded attunement engine. Every operation returns a fresh serializable
 * state plus a receipt and never mutates its input. Re-applying the same
 * operation for the same item key is an idempotent no-op (`changed: false`).
 */

const REST_RANK: Readonly<Record<MagicRestKind, number>> = Object.freeze({ "short-rest": 1, "long-rest": 2 });

export type MagicAttunementReceipt = Readonly<{
  kind: "attunement";
  operation: "attune" | "drop";
  key: string;
  changed: boolean;
  prerequisiteSatisfied: MagicRestKind | null;
  attunementCountBefore: number;
  attunementCountAfter: number;
  occurredAt: string;
}>;

export type MagicAttunementResult = Readonly<
  | { ok: true; state: MagicAttunementState; receipt: MagicAttunementReceipt }
  | {
    ok: false;
    code: "invalid-key" | "not-attunable" | "prerequisite-missing" | "capacity-exceeded" | "key-conflict";
    message: string;
    state: MagicAttunementState;
    receipt: MagicAttunementReceipt;
  }
>;

export type AttuneItemInput = Readonly<{
  state: MagicAttunementState;
  key: string;
  definition: MagicItemDefinition;
  prerequisite: MagicAttunementPrerequisiteState;
  occurredAt: string;
}>;

export type DropAttunementInput = Readonly<{
  state: MagicAttunementState;
  key: string;
  occurredAt: string;
}>;

export function createAttunementState(actorId: string): MagicAttunementState {
  return Object.freeze({ actorId, entries: Object.freeze([]) });
}

export function attunementKeys(state: MagicAttunementState): readonly string[] {
  return Object.freeze(state.entries.map((entry) => entry.key));
}

export function isAttuned(state: MagicAttunementState, key: string): boolean {
  return state.entries.some((entry) => entry.key === key);
}

function sameReference(left: MagicItemReference, right: MagicItemReference): boolean {
  return left.packId === right.packId && left.packVersion === right.packVersion && left.definitionId === right.definitionId;
}

function receipt(values: {
  operation: "attune" | "drop";
  key: string;
  changed: boolean;
  prerequisiteSatisfied: MagicRestKind | null;
  before: number;
  after: number;
  occurredAt: string;
}): MagicAttunementReceipt {
  return Object.freeze({
    kind: "attunement",
    operation: values.operation,
    key: values.key,
    changed: values.changed,
    prerequisiteSatisfied: values.prerequisiteSatisfied,
    attunementCountBefore: values.before,
    attunementCountAfter: values.after,
    occurredAt: values.occurredAt,
  });
}

function reject(
  values: AttuneItemInput,
  code: "invalid-key" | "not-attunable" | "prerequisite-missing" | "capacity-exceeded" | "key-conflict",
  message: string,
  prerequisiteSatisfied: MagicRestKind | null,
): MagicAttunementResult {
  const before = values.state.entries.length;
  return Object.freeze({
    ok: false,
    code,
    message,
    state: values.state,
    receipt: receipt({ operation: "attune", key: values.key, changed: false, prerequisiteSatisfied, before, after: before, occurredAt: values.occurredAt }),
  });
}

/** Attunes an item when its prerequisite rest and the 3-item capacity allow it. */
export function attuneItem(input: AttuneItemInput): MagicAttunementResult {
  if (typeof input.key !== "string" || input.key.length === 0) return reject(input, "invalid-key", "attunement key must be non-empty", null);
  const existing = input.state.entries.find((entry) => entry.key === input.key);
  if (existing) {
    if (!sameReference(existing.definition, input.definition.reference)) {
      return reject(input, "key-conflict", "attunement key is already bound to another definition", null);
    }
    const count = input.state.entries.length;
    return Object.freeze({ ok: true, state: input.state,
      receipt: receipt({ operation: "attune", key: input.key, changed: false, prerequisiteSatisfied: null, before: count, after: count, occurredAt: input.occurredAt }) });
  }
  if (input.definition.attunement === null) return reject(input, "not-attunable", "item does not require attunement", null);
  const required = input.definition.attunement.prerequisite;
  const satisfied = input.prerequisite.satisfiedRest;
  const meetsPrerequisite = satisfied !== null && REST_RANK[satisfied] >= REST_RANK[required];
  if (!meetsPrerequisite) {
    return reject(input, "prerequisite-missing", `attunement requires a completed ${required}`, satisfied);
  }
  const before = input.state.entries.length;
  if (before >= MAGIC_ITEM_ATTUNEMENT_LIMIT) {
    return reject(input, "capacity-exceeded", `an actor may attune to at most ${MAGIC_ITEM_ATTUNEMENT_LIMIT} items`, satisfied);
  }
  const entry = Object.freeze({ key: input.key, definition: Object.freeze({ ...input.definition.reference }), attunedAt: input.occurredAt });
  const state = Object.freeze({ actorId: input.state.actorId, entries: Object.freeze([...input.state.entries, entry]) });
  return Object.freeze({ ok: true, state,
    receipt: receipt({ operation: "attune", key: input.key, changed: true, prerequisiteSatisfied: satisfied, before, after: before + 1, occurredAt: input.occurredAt }) });
}

/** Drops an attunement; dropping an unattuned key is an idempotent no-op. */
export function dropAttunement(input: DropAttunementInput): MagicAttunementResult {
  if (typeof input.key !== "string" || input.key.length === 0) {
    const before = input.state.entries.length;
    return Object.freeze({ ok: true, state: input.state,
      receipt: receipt({ operation: "drop", key: String(input.key ?? ""), changed: false, prerequisiteSatisfied: null, before, after: before, occurredAt: input.occurredAt }) });
  }
  const before = input.state.entries.length;
  const entries = input.state.entries.filter((entry) => entry.key !== input.key);
  if (entries.length === before) {
    return Object.freeze({ ok: true, state: input.state,
      receipt: receipt({ operation: "drop", key: input.key, changed: false, prerequisiteSatisfied: null, before, after: before, occurredAt: input.occurredAt }) });
  }
  const state = Object.freeze({ actorId: input.state.actorId, entries: Object.freeze(entries) });
  return Object.freeze({ ok: true, state,
    receipt: receipt({ operation: "drop", key: input.key, changed: true, prerequisiteSatisfied: null, before, after: entries.length, occurredAt: input.occurredAt }) });
}

/** Deterministic serialization of an attunement set for storage or transport. */
export function serializeAttunementState(state: MagicAttunementState): string {
  const entries = [...state.entries]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => ({ key: entry.key, definition: { packId: entry.definition.packId, packVersion: entry.definition.packVersion, definitionId: entry.definition.definitionId }, attunedAt: entry.attunedAt }));
  return stableKey({ actorId: state.actorId, entries });
}
