#!/usr/bin/env node
//
// Merge SRD 5.1 coverage fragments into the aggregate inventory.
//
// Fragments live in docs/coverage/:
//   _envelope.json   - non-domain envelope fields: inventoryVersion, ruleset,
//                      officialSource, license, statusDefinitions
//   <domain-id>.json - one file per inventory domain, holding that domain's
//                      full object exactly as it appears in the aggregate.
//
// The domain order is defined by DOMAIN_ORDER below, not by the filesystem,
// so the aggregate is stable regardless of how fragments are created or
// edited. Output is a hand-rolled 2-space layout: nested domain arrays stay on
// a single line to match the checked-in aggregate byte-for-byte, which plain
// JSON.stringify cannot reproduce.
//
// Usage: node scripts/coverage/merge-coverage.mjs

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FRAGMENT_DIR = path.join(ROOT, "docs", "coverage");
const AGGREGATE_PATH = path.join(ROOT, "docs", "srd-5.1-coverage.v1.json");

const ENVELOPE_FIELDS = [
  "inventoryVersion",
  "ruleset",
  "officialSource",
  "license",
  "statusDefinitions",
];

const DOMAIN_ORDER = [
  "d20-tests",
  "passive-checks",
  "attack-resolution",
  "damage",
  "initiative",
  "movement",
  "rests",
  "concentration",
  "conditions",
  "generic-resource-plans",
  "spell-costs",
  "derived-values",
  "legal-action-envelope",
  "character-options",
  "character-advancement",
  "equipment-catalog",
  "complete-combat-system",
  "underwater-combat",
  "spellcasting-and-spells",
  "monsters",
  "encounter-builder",
  "encounter-rewards",
  "npc-selection",
  "adventuring-environment",
  "training-dummy",
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

const literal = (value) => JSON.stringify(value);

function inlineObject(value, keys) {
  const body = keys.map((key) => `${literal(key)}: ${literal(value[key])}`).join(", ");
  return `{ ${body} }`;
}

function inlineArray(values, render) {
  return `[${values.map(render).join(", ")}]`;
}

function renderExpandedObject(value, indent) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  const entries = Object.entries(value);
  const body = entries
    .map(([key, entry], index) => `${inner}${literal(key)}: ${literal(entry)}${index < entries.length - 1 ? "," : ""}`)
    .join("\n");
  return `{\n${body}\n${pad}}`;
}

function renderEnvelope(envelope) {
  return ENVELOPE_FIELDS.map((key) => {
    const value = envelope[key];
    const rendered = value !== null && typeof value === "object" && !Array.isArray(value)
      ? renderExpandedObject(value, 2)
      : literal(value);
    return `  ${literal(key)}: ${rendered},`;
  }).join("\n");
}

function renderDomain(domain) {
  return [
    "    {",
    `      "id": ${literal(domain.id)},`,
    `      "title": ${literal(domain.title)},`,
    `      "status": ${literal(domain.status)},`,
    `      "complete": ${literal(domain.complete)},`,
    `      "sourceSections": ${inlineArray(domain.sourceSections, (source) => inlineObject(source, ["id", "url"]))},`,
    `      "capabilityEvidence": ${inlineArray(domain.capabilityEvidence, (capability) => inlineObject(capability, ["id", "version", "descriptorStatus"]))},`,
    `      "runtimeEvidence": ${inlineArray(domain.runtimeEvidence, literal)},`,
    `      "apiEvidence": ${inlineArray(domain.apiEvidence, literal)}`,
    "    }",
  ].join("\n");
}

const envelope = readJson(path.join(FRAGMENT_DIR, "_envelope.json"));
const domains = DOMAIN_ORDER.map((id) => readJson(path.join(FRAGMENT_DIR, `${id}.json`)));

const output = `{\n${renderEnvelope(envelope)}\n  "domains": [\n${domains.map(renderDomain).join(",\n")}\n  ]\n}\n`;

writeFileSync(AGGREGATE_PATH, output);
console.log(`wrote ${path.relative(ROOT, AGGREGATE_PATH)} from ${domains.length} domain fragments`);
