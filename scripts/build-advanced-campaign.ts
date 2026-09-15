#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";
import { createRepository, createSession, listCharacters, SRD_5_1_STARTER_CATALOG } from "../server/src/repo/index.js";

/**
 * Builds a brand-new campaign with a leveled, multi-class-role party for
 * higher-level mechanics testing. Idempotent per campaign name.
 *
 *   npx tsx scripts/build-advanced-campaign.ts \
 *     --data-dir .velvet/advanced-run \
 *     --campaign-name "The Ashen Accord" \
 *     --classes fighter,cleric,wizard --level 5
 */
const OWNER = "local-owner";

export interface BuildAdvancedCampaignOptions {
  dataDir: string;
  campaignName: string;
  classes?: readonly string[];
  level?: number;
  roomTitle?: string;
}

export interface BuildAdvancedCampaignResult {
  campaignId: string;
  sessionId: string;
  actors: Array<{ personaId: string; actorId: string; campaignCharacterId: string; className: string; level: number; maxHp: number }>;
}

const DEFAULT_CLASSES = ["fighter", "cleric", "wizard"] as const;

function parseArgs(argv: string[]): Required<Pick<BuildAdvancedCampaignOptions, "dataDir" | "campaignName">> & Pick<BuildAdvancedCampaignOptions, "roomTitle"> & { classes: string[]; level: number } {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[++index] ?? "";
  }
  if (!args["data-dir"] || !args["campaign-name"]) throw new Error("usage: --data-dir DIR --campaign-name NAME [--classes fighter,cleric,wizard] [--level 5] [--room-title TITLE]");
  const level = Number(args["level"] ?? "5");
  if (!Number.isInteger(level) || level < 1 || level > 20) throw new Error("--level must be an integer 1-20");
  return { dataDir: args["data-dir"]!, campaignName: args["campaign-name"]!, classes: (args["classes"] ?? DEFAULT_CLASSES.join(",")).split(",").map((value) => value.trim()).filter(Boolean), level, ...(args["room-title"] ? { roomTitle: args["room-title"] } : {}) };
}

function attributeScores(): CharacterBuilderAttributeScores {
  return Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;
}

export async function buildAdvancedCampaign(options: BuildAdvancedCampaignOptions): Promise<BuildAdvancedCampaignResult> {
  const targetLevel = options.level ?? 5;
  const classSlugs = options.classes?.length ? [...options.classes] : [...DEFAULT_CLASSES];
  process.env.VELVET_DATA_DIR = options.dataDir;
  const repository = createRepository({ dataDir: options.dataDir });
  try {
    const campaign = repository.createCampaign(OWNER, { name: options.campaignName });
    repository.installSrdStarterCatalog(OWNER);
    repository.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "advanced.pins" });

    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const reference = (kind: string) => definitions.find((definition) => definition.reference.kind === kind)?.reference;
    const race = reference("race");
    const background = reference("background");
    if (!race || !background) throw new Error("SRD starter race or background is unavailable");
    const classRef = (slug: string) => {
      const found = definitions.find((definition) => definition.reference.kind === "class" && definition.reference.definitionId === `srd-5.1:class:${slug}`);
      if (!found) throw new Error(`SRD starter class ${slug} is unavailable`);
      return found.reference;
    };

    const scores = attributeScores();
    const actors: BuildAdvancedCampaignResult["actors"] = [];
    const personaIds: string[] = [];

    for (const [index, slug] of classSlugs.entries()) {
      const label = slug.replace(/(^|[^a-z])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
      const name = `${options.campaignName} - ${label}`;
      const existing = (await listCharacters()).find((character) => character.name === name);
      const persona = existing ?? repository.createCharacter({ name, age: 30 + index, archetype: `${label} adventurer`,
        boundaries: "Fictional adults. No sexual violence, harm to children, or demeaning portrayals of real communities.", fictionalConfirmed: true });
      personaIds.push(persona.id);
      const draft = repository.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
        allocation: { method: "standard-array", scores }, idempotencyKey: `advanced.${slug}.draft` });
      const selected = repository.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: draft.draft.revision, idempotencyKey: `advanced.${slug}.select`,
        selections: { race, background, class: classRef(slug), starterGrant: "kit" } } as never);
      const finalized = repository.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `advanced.${slug}.finalize` });
      const campaignCharacterId = finalized.receipt.campaignCharacterId;

      let level = 1;
      for (let attempt = 0; attempt < 12 && level < targetLevel; attempt += 1) {
        const state = repository.getCharacterProgression(OWNER, campaignCharacterId)!;
        const targetXp = state.profile.thresholds.find((threshold) => threshold.level >= targetLevel)?.xp ?? state.totalXp;
        if (targetXp > state.totalXp) {
          repository.grantCharacterXp(OWNER, campaignCharacterId, { amount: Math.min(targetXp - state.totalXp, 1_000_000),
            reason: `Advanced simulation to level ${targetLevel}`, expectedRevision: state.revision, idempotencyKey: `advanced.${slug}.xp.${attempt}` });
        }
        const preview = repository.previewCharacterProgression(OWNER, campaignCharacterId)!;
        const selections = preview.pendingChoices.map((choice) => ({ choiceId: choice.choiceId, kind: choice.kind, ability: choice.options[0] }));
        const applied = repository.applyCharacterProgression(OWNER, campaignCharacterId, { previewRevision: preview.revision,
          previewToken: preview.token, selections, idempotencyKey: `advanced.${slug}.apply.${attempt}` });
        level = applied.progression.level;
      }
      const finalState = repository.getCharacterProgression(OWNER, campaignCharacterId)!;
      actors.push({ personaId: persona.id, actorId: finalState.actorId, campaignCharacterId, className: label, level: finalState.level, maxHp: finalState.derived.maxHp });
    }

    const roomTitle = options.roomTitle ?? `${options.campaignName} - War Room`;
    const session = await createSession({ characterIds: personaIds, primaryCharacterId: personaIds[0]!, title: roomTitle, presetId: "default" });
    repository.transitionSession(session.id, "active", "Prepared for higher-level play");
    repository.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id });

    const administration = repository.getCampaignAdministration(OWNER, campaign.id);
    if (administration && administration.status !== "published" && administration.status !== "completed") {
      repository.updateCampaignAdministration(OWNER, campaign.id, { expectedRevision: administration.revision, status: "published", idempotencyKey: "advanced.publish" });
    }
    return { campaignId: campaign.id, sessionId: session.id, actors };
  } finally {
    repository.close();
  }
}

async function main(): Promise<void> {
  const result = await buildAdvancedCampaign(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
