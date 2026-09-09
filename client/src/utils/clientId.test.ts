import { afterEach, describe, expect, it, vi } from "vitest";
import { idempotencyKeySchema, resourceIdSchema } from "@velvet/contracts";
import { createClientId } from "./clientId";

const originalCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  vi.restoreAllMocks();
});

describe("createClientId", () => {
  it("uses randomUUID when available", () => {
    const randomUUID = vi.fn(() => "12345678-1234-4123-8123-123456789abc" as `${string}-${string}-${string}-${string}-${string}`);
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID } });

    expect(createClientId()).toBe("12345678-1234-4123-8123-123456789abc");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("creates a UUID with getRandomValues when randomUUID is absent", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(0xab); return bytes; });
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } });

    const id = createClientId();
    expect(id).toBe("abababab-abab-4bab-abab-abababababab");
    expect(idempotencyKeySchema.parse(id)).toBe(id);
    expect(resourceIdSchema.parse(id)).toBe(id);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("tries getRandomValues when an exposed randomUUID throws", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(1); return bytes; });
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => { throw new Error("insecure origin"); }, getRandomValues } });

    expect(createClientId()).toBe("01010101-0101-4101-8101-010101010101");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("returns a nonempty compatible fallback without callable crypto methods", () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    vi.spyOn(Date, "now").mockReturnValue(1234);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const id = createClientId();
    expect(id).toBe("1234-i");
    expect(idempotencyKeySchema.parse(id)).toBe(id);
    expect(resourceIdSchema.parse(id)).toBe(id);
  });
});
