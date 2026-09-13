export function requireInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer`);
}

export function requireNonNegativeInteger(value: number, name: string): void {
  requireInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
}

export function frozenList<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
