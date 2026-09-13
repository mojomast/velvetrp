import type { StarterReferences } from "./references.js";

export function buildBackgrounds(refs: StarterReferences) {
  const { ref, currency, insight, religion, acolyteEquipment } = refs;
  return [
    { reference: ref("background", "srd-5.1:background:acolyte"), name: "Acolyte", description: "An SRD background with Insight, Religion, and a bounded starter-equipment package.", tags: ["srd-5.1"], mechanics: { skillRefs: [insight, religion], itemRefs: [acolyteEquipment], startingCurrency: { currency, amount: 15 } } },
  ];
}
