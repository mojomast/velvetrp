import type { StarterReferences } from "./references.js";

export function buildCurrencies(refs: StarterReferences) {
  const { currency } = refs;
  return [
    { reference: currency, name: "Gold Piece", description: "A whole-unit development currency reference.", tags: ["srd-5.1"], mechanics: { symbol: "gp", minorPerMajor: 1 } },
  ];
}
