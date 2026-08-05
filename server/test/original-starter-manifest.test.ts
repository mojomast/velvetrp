import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installContentPackInputSchema, ORIGINAL_STARTER_ID, ORIGINAL_STARTER_PRESENTATION } from "@velvet/contracts";
import { describe, expect, it } from "vitest";
import {
  ORIGINAL_STARTER_MANIFEST,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_IDENTIFIER,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RULES_PROFILE_ID,
} from "../src/content/originalStarterManifest.js";

const ARRAY_NAMES = [
  "classes",
  "races",
  "backgrounds",
  "items",
  "spells",
  "abilities",
  "enemies",
] as const;

const PROVENANCE_PATH = fileURLToPath(
  new URL("../src/content/originalStarterManifest.provenance.md", import.meta.url),
);

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("original starter manifest", () => {
  it("has the exact reviewed namespaced identities and version", () => {
    expect(ORIGINAL_STARTER_RULES_PROFILE_ID).toBe("velvet:rules:original-narrative");
    expect(ORIGINAL_STARTER_PACK_ID).toBe("velvet:original-starter");
    expect(ORIGINAL_STARTER_PACK_VERSION).toBe("1.0.0+d15042935818");
    expect(ORIGINAL_STARTER_ID).toBe(`${ORIGINAL_STARTER_PACK_ID}@${ORIGINAL_STARTER_PACK_VERSION}`);
    expect(ORIGINAL_STARTER_ID)
      .toBe(`${ORIGINAL_STARTER_MANIFEST.packId}@${ORIGINAL_STARTER_MANIFEST.packVersion}`);
    expect(ORIGINAL_STARTER_PRESENTATION.pack).toMatchObject({
      id: ORIGINAL_STARTER_MANIFEST.packId,
      version: ORIGINAL_STARTER_MANIFEST.packVersion,
    });
    expect(ORIGINAL_STARTER_PACK_IDENTIFIER).toEqual({
      packId: "velvet:original-starter",
      packVersion: "1.0.0+d15042935818",
    });
    expect(ORIGINAL_STARTER_MANIFEST).toMatchObject({
      packId: ORIGINAL_STARTER_PACK_ID,
      packVersion: ORIGINAL_STARTER_PACK_VERSION,
      rulesProfileId: ORIGINAL_STARTER_RULES_PROFILE_ID,
    });
  });

  it("parses the complete exported payload through the installation contract", () => {
    expect(installContentPackInputSchema.parse(ORIGINAL_STARTER_MANIFEST))
      .toEqual(ORIGINAL_STARTER_MANIFEST);
    expect(Object.keys(ORIGINAL_STARTER_MANIFEST).sort()).toEqual([
      ...ARRAY_NAMES,
      "description",
      "name",
      "packId",
      "packVersion",
      "rulesProfile",
      "rulesProfileId",
      "tags",
    ].sort());
  });

  it("contains all seven arrays and exactly the three approved definitions", () => {
    for (const arrayName of ARRAY_NAMES) expect(Array.isArray(ORIGINAL_STARTER_MANIFEST[arrayName])).toBe(true);
    expect(ORIGINAL_STARTER_MANIFEST.classes).toEqual([{
      definitionId: "velvet:original-starter:class:pathmender",
      kind: "class",
      name: "Pathmender",
      description: "Pathmenders travel between isolated communities, carrying news and helping neighbors restore neglected meeting places.",
      tags: ["velvet:original", "community", "traveler"],
    }]);
    expect(ORIGINAL_STARTER_MANIFEST.races).toEqual([{
      definitionId: "velvet:original-starter:race:avelune",
      kind: "race",
      name: "Avelune",
      description: "Avelune communities gather around drifting lights and preserve family stories in woven night banners.",
      tags: ["velvet:original", "community", "storytelling"],
    }]);
    expect(ORIGINAL_STARTER_MANIFEST.backgrounds).toEqual([{
      definitionId: "velvet:original-starter:background:rainledger",
      kind: "background",
      name: "Rainledger",
      description: "Rainledgers once recorded seasonal journeys, local customs, and promises exchanged between distant settlements.",
      tags: ["velvet:original", "historian", "traveler"],
    }]);
    expect(ORIGINAL_STARTER_MANIFEST.items).toEqual([]);
    expect(ORIGINAL_STARTER_MANIFEST.spells).toEqual([]);
    expect(ORIGINAL_STARTER_MANIFEST.abilities).toEqual([]);
    expect(ORIGINAL_STARTER_MANIFEST.enemies).toEqual([]);
    expect(ARRAY_NAMES.reduce((count, name) => count + ORIGINAL_STARTER_MANIFEST[name].length, 0)).toBe(3);
  });

  it("contains metadata only, with no unknown mechanics, path, or file fields", () => {
    expect(Object.keys(ORIGINAL_STARTER_MANIFEST.rulesProfile).sort())
      .toEqual(["description", "name", "tags"]);
    for (const arrayName of ARRAY_NAMES) {
      for (const definition of ORIGINAL_STARTER_MANIFEST[arrayName]) {
        expect(Object.keys(definition).sort())
          .toEqual(["definitionId", "description", "kind", "name", "tags"]);
      }
    }
    const serialized = JSON.stringify(ORIGINAL_STARTER_MANIFEST);
    expect(serialized).not.toMatch(/"(?:damage|check|checks|grant|grants|effects?|mechanics?|derived|path|file|files)"\s*:/i);
    expect([
      ORIGINAL_STARTER_MANIFEST.description,
      ORIGINAL_STARTER_MANIFEST.rulesProfile.description,
      ...ARRAY_NAMES.flatMap((name) => ORIGINAL_STARTER_MANIFEST[name].map((entry) => entry.description)),
    ].join(" ")).not.toMatch(/\b(?:damage|checks?|grants?|mechanics?|derived)\b/i);
  });

  it("is deeply immutable, including its narrow identifier", () => {
    expectDeeplyFrozen(ORIGINAL_STARTER_MANIFEST);
    expectDeeplyFrozen(ORIGINAL_STARTER_PACK_IDENTIFIER);
    expect(() => {
      (ORIGINAL_STARTER_MANIFEST.tags as unknown as string[]).push("mutation");
    }).toThrow(TypeError);
    expect(() => {
      (ORIGINAL_STARTER_MANIFEST.classes[0] as unknown as { name: string }).name = "Mutation";
    }).toThrow(TypeError);
    expect(ORIGINAL_STARTER_MANIFEST.classes[0]?.name).toBe("Pathmender");
  });

  it("matches the provenance checksum of the reviewed canonical payload", () => {
    const provenance = readFileSync(PROVENANCE_PATH, "utf8");
    const documentedDigests = [...provenance.matchAll(/^SHA-256: `([0-9a-f]{64})`$/gm)];
    expect(documentedDigests).toHaveLength(1);

    const { packVersion: _versionIdentity, ...versionlessManifest } = ORIGINAL_STARTER_MANIFEST;
    const calculatedDigest = createHash("sha256")
      .update(canonicalJson(versionlessManifest), "utf8")
      .digest("hex");
    expect(calculatedDigest).toBe(documentedDigests[0]?.[1]);
    expect(ORIGINAL_STARTER_PACK_VERSION).toMatch(new RegExp(`\\+${calculatedDigest.slice(0, 12)}$`));

    const changed = { ...versionlessManifest, description: `${versionlessManifest.description} changed` };
    const changedDigest = createHash("sha256").update(canonicalJson(changed), "utf8").digest("hex");
    expect(changedDigest.slice(0, 12)).not.toBe(calculatedDigest.slice(0, 12));
    expect(ORIGINAL_STARTER_PACK_VERSION).not.toMatch(new RegExp(`\\+${changedDigest.slice(0, 12)}$`));
  });

  it("has no repository, installation, database, app, or startup dependency", () => {
    const sourcePath = fileURLToPath(new URL("../src/content/originalStarterManifest.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    expect([...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["'];$/gm)].map((match) => match[1]))
      .toEqual(["@velvet/contracts"]);
    expect(source).not.toMatch(/(?:createRepository|installContentPack\s*\(|buildApp|better-sqlite3|\.open\s*\(|startup|process\.env)/);
  });
});
