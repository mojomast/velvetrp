export function requireInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer`);
}

export function requireNonNegativeInteger(value: number, name: string): void {
  requireInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
}

export function requirePositiveInteger(value: number, name: string): void {
  requireInteger(value, name);
  if (value < 1) throw new RangeError(`${name} must be positive`);
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.keys(nested as Record<string, unknown>).sort().map((key) => [key, (nested as Record<string, unknown>)[key]]))
      : nested);

/** Stable key used for deterministic deduplication and sorting. */
export function stableKey(value: unknown): string {
  return canonical(value);
}
