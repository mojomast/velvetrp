import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DND_5E_RULESET_DESCRIPTOR } from "../src/rulesets/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INVENTORY_PATH = "docs/srd-5.1-coverage.v1.json";
const PDF_URL = "https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf";
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/legalcode";
const STATUSES = new Set(["implemented", "partial", "unsupported", "not-applicable"]);

interface InventoryDomain {
  id: string;
  status: string;
  complete: boolean;
  sourceSections: Array<{ id: string; url: string }>;
  capabilityEvidence: Array<{ id: string; version: string; descriptorStatus: string }>;
  runtimeEvidence: string[];
  apiEvidence: string[];
}

interface CoverageInventory {
  inventoryVersion: string;
  ruleset: { id: string; version: string };
  officialSource: { id: string; title: string; publisher: string; url: string };
  license: { id: string; url: string; attributionFile: string; modified: boolean };
  statusDefinitions: Record<string, string>;
  domains: InventoryDomain[];
}

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function inventory(): CoverageInventory {
  return JSON.parse(read(INVENTORY_PATH)) as CoverageInventory;
}

describe("SRD 5.1 coverage inventory", () => {
  it("maps every advertised D&D capability to exact inventory evidence", () => {
    const coverage = inventory();
    expect(coverage.inventoryVersion).toMatch(/^1\./);
    expect(coverage.ruleset).toEqual({ id: DND_5E_RULESET_DESCRIPTOR.id, version: DND_5E_RULESET_DESCRIPTOR.version });

    const advertised = (DND_5E_RULESET_DESCRIPTOR.capabilities ?? [])
      .map(({ id, version, status }) => `${id}@${version}:${status}`)
      .sort();
    const evidenced = coverage.domains
      .flatMap(({ capabilityEvidence }) => capabilityEvidence)
      .map(({ id, version, descriptorStatus }) => `${id}@${version}:${descriptorStatus}`)
      .sort();

    expect(new Set(evidenced).size, "duplicate capability evidence").toBe(evidenced.length);
    expect(evidenced).toEqual(advertised);
  });

  it("keeps incomplete and non-SRD domains from being reported complete", () => {
    const coverage = inventory();
    expect(Object.keys(coverage.statusDefinitions).sort()).toEqual([...STATUSES].sort());
    expect(new Set(coverage.domains.map(({ id }) => id)).size).toBe(coverage.domains.length);

    for (const domain of coverage.domains) {
      expect(STATUSES.has(domain.status), `${domain.id} status`).toBe(true);
      expect(domain.runtimeEvidence.length + domain.apiEvidence.length, `${domain.id} implementation evidence`).toBeGreaterThan(0);
      if (domain.status !== "implemented") expect(domain.complete, `${domain.id} completeness`).toBe(false);
      if (domain.status === "implemented") expect(domain.complete, `${domain.id} completeness`).toBe(true);
      if (domain.status === "not-applicable") expect(domain.sourceSections, `${domain.id} SRD sources`).toEqual([]);
      else expect(domain.sourceSections.length, `${domain.id} SRD sources`).toBeGreaterThan(0);
      for (const source of domain.sourceSections) {
        expect(source.id, `${domain.id} source section ID`).toMatch(/^SRD5\.1:/);
        expect(source.url, `${domain.id} official source URL`).toMatch(new RegExp(`^${PDF_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#page=\\d+$`));
      }
      for (const reference of domain.runtimeEvidence) {
        expect(existsSync(path.join(ROOT, reference.split("#", 1)[0]!)), `${domain.id} evidence ${reference}`).toBe(true);
      }
    }

    const incompleteCapabilityIds = new Set(coverage.domains
      .filter(({ status }) => status === "partial" || status === "unsupported")
      .flatMap(({ capabilityEvidence }) => capabilityEvidence.map(({ id }) => id)));
    for (const capability of DND_5E_RULESET_DESCRIPTOR.capabilities ?? []) {
      if (capability.status === "partial" || capability.status === "unsupported") {
        expect(incompleteCapabilityIds.has(capability.id), `${capability.id} incomplete evidence`).toBe(true);
      }
    }
  });

  it("keeps attribution, modification, and non-SRD fixture notices release-visible", () => {
    const coverage = inventory();
    const notice = read(coverage.license.attributionFile);
    const coverageGuide = read("docs/srd-5.1-coverage.md");

    expect(coverage.officialSource.url).toBe(PDF_URL);
    expect(coverage.license).toMatchObject({ id: "CC-BY-4.0", url: LICENSE_URL, attributionFile: "NOTICE.md", modified: true });
    for (const releaseText of [notice, coverageGuide]) {
      expect(releaseText).toContain(PDF_URL);
      expect(releaseText).toContain("Creative Commons Attribution 4.0 International");
      expect(releaseText).toContain("CC BY 4.0");
      expect(releaseText.toLowerCase()).toContain("modif");
      expect(releaseText).toContain("Training Dummy");
      expect(releaseText).toMatch(/Training Dummy[^\n]*(?:not SRD|not an SRD|non-SRD)/i);
    }
    expect(coverageGuide).toContain(INVENTORY_PATH.split("/").at(-1)!);
  });
});
