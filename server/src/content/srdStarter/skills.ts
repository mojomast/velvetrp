import type { StarterReferences } from "./references.js";

export function buildSkills(refs: StarterReferences) {
  const { insight, religion } = refs;
  return [
    { reference: insight, name: "Insight", description: "Wisdom-based discernment.", tags: ["srd-5.1"], mechanics: { attribute: "wisdom" } },
    { reference: religion, name: "Religion", description: "Intelligence-based religious knowledge.", tags: ["srd-5.1"], mechanics: { attribute: "intelligence" } },
  ];
}
