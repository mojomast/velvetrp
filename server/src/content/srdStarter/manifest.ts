import { SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";

export function buildManifest(catalogVersion: string, digest: string) {
  return {
    packId: SRD_5_1_STARTER_IDENTITY.packId,
    packVersion: catalogVersion,
    name: "SRD 5.1 Development Starter",
    description: "A reviewed, deliberately narrow SRD 5.1 starter with closed level-one profiles for Fighter, Cleric, Barbarian, Rogue, Wizard, Paladin, and Ranger.",
    tags: ["srd-5.1", "cc-by-4.0", "development-starter"],
    rulesProfile: {
      name: "SRD 5.1 Development Rules",
      description: "Exact dnd-5e@1.0.0 profile with bounded level-one class profiles and a two-level Fighter progression lane.",
      tags: ["srd-5.1", "cc-by-4.0"],
    },
    compatibility: { rulesEngine: "dnd-5e", rulesEngineVersion: "1.0.0", rulesProfileId: SRD_5_1_STARTER_IDENTITY.rulesProfileId, catalogFormat: "validated-v1" },
    digest,
    provenance: {
      authorship: "licensed",
      author: "Wizards of the Coast LLC; integration selection by Velvet project",
      authoredAt: "2016-05-04T00:00:00.000Z",
      reviewedBy: "Velvet SRD integration review",
      reviewedAt: "2026-09-04T00:00:00.000Z",
      declaration: "Narrow, modified selection from the CC BY 4.0 SRD 5.1. Source, license, and modification details are in NOTICE.md.",
      thirdPartyData: true,
    },
  };
}
