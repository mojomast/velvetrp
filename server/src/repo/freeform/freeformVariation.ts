/**
 * Deterministic variation for free-form materialization.
 *
 * Free-form materializers are closed, server-authored and replay-safe: the same
 * durable identity (campaign / session / actor plus a normalized phrase) must
 * always produce byte-identical content, and a replay reads the stored artifact
 * back instead of materializing a second one. At the same time, two different
 * identities that select the same archetype/template should not read as the same
 * copy-pasted persona or place.
 *
 * This module provides that middle ground. Every choice is a **pure function of a
 * seed string** that callers derive from the existing durable identity digest
 * (`sha256(`${identity}:${normalizedPhrase}`)`); nothing here reads a clock, a
 * random source, a database row or module state. As a result:
 *
 * - the same identity + phrase yields the same variation forever (replay-safe);
 * - a different identity or phrase yields a different, but equally stable, pick;
 * - adding/editing an oracle table cannot corrupt already-accepted canon, because
 *   a replay never re-runs the picker — it returns the stored artifact.
 *
 * Variation text is narrative flavor only. It carries no stats, items, prices,
 * stock, catalog references or GM-only secrets when it is destined for a public
 * artifact; GM-only variation uses separate pools and never crosses over.
 */
import { createHash } from "node:crypto";

/** A non-empty, readonly tuple so a picker can never return `undefined`. */
export type VariationPool<T> = readonly [T, ...T[]];

/**
 * Deterministically maps a seed string onto `[0, length)` using the first 32 bits
 * of its SHA-256 digest. Pure: same seed + length always yields the same index.
 */
export function variationIndex(seed: string, length: number): number {
  if (!Number.isSafeInteger(length) || length < 1) throw new RangeError("variation pool must be non-empty");
  return Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % length;
}

/** Deterministically selects one entry of a non-empty pool from a seed string. */
export function pickVariation<T>(seed: string, pool: VariationPool<T>): T {
  return pool[variationIndex(seed, pool.length)]!;
}

/**
 * Appends flavor clauses to a base description without rewriting it, so a base
 * sentence an existing test or canonical artifact depends on stays a literal
 * substring. Inserts a sentence break only when needed.
 */
export function appendSentences(base: string, ...extra: readonly string[]): string {
  let result = base.trim();
  for (const raw of extra) {
    const next = raw.trim();
    if (!next) continue;
    if (!result) {
      result = next;
      continue;
    }
    const separator = /[.!?]$/.test(result) ? " " : ". ";
    result = `${result}${separator}${next}`;
  }
  return result;
}

/** True when a flavor string stays free of invented mechanics or prices. */
export function isFlavorOnly(value: string): boolean {
  return !/\d/.test(value) && !/\b(?:hp|hit points?|damage|gold|silver|copper|platinum|coin|price|cost|gp|sp|cp)\b/i.test(value);
}
