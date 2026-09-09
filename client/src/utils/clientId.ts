function randomValuesUuid(cryptoApi: Crypto): string {
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function createClientId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    try { return cryptoApi.randomUUID(); }
    catch { /* Some insecure-origin implementations expose a method that throws. */ }
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    try { return randomValuesUuid(cryptoApi); }
    catch { /* Fall back when the exposed method is not usable. */ }
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
