#!/usr/bin/env node
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { createRepository, createSession, MECHANICS_STARTER_CATALOG } from "../server/src/repo/index.js";

/**
 * Makes a hydrated, provider-generated campaign enterable: creates a finalized
 * two-character party, an active attached room, and publishes the campaign.
 * Idempotent per persona name and room title. Intended for local/tailnet play.
 *
 *   npx tsx scripts/prepare-playable-campaign.ts \
 *     --data-dir .velvet/baie-comeau-drowned-boom \
 *     --campaign-id <id> \
 *     --campaign-name "Baie-Comeau: The Drowned Boom"
 */
const OWNER = "local-owner";

function parseArgs(argv: string[]): { dataDir: string; campaignId: string; campaignName: string } {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[++index] ?? "";
  }
  if (!args["data-dir"] || !args["campaign-id"]) throw new Error("usage: --data-dir DIR --campaign-id ID [--campaign-name NAME]");
  return { dataDir: args["data-dir"], campaignId: args["campaign-id"], campaignName: args["campaign-name"] ?? "Campaign" };
}

const options = parseArgs(process.argv.slice(2));
process.env.VELVET_DATA_DIR = options.dataDir;

const scores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as CharacterBuilderAttributeScores;
const starterReference = (kind: "race" | "background" | "class") => {
  const reference = MECHANICS_STARTER_CATALOG.definitions.find((definition) => definition.reference.kind === kind)?.reference;
  if (!reference) throw new Error(`mechanics starter ${kind} is unavailable`);
  return reference;
};

const repository = createRepository({ dataDir: options.dataDir });

function finalizeActor(personaId: string, key: string) {
  const draft = repository.createCharacterDraft(OWNER, options.campaignId, {
    personaId, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores }, idempotencyKey: `play.${key}.draft`,
  });
  const selected = repository.updateCharacterDraft(OWNER, draft.draft.id, {
    expectedRevision: draft.draft.revision, idempotencyKey: `play.${key}.selections`,
    selections: { race: starterReference("race"), background: starterReference("background"), class: starterReference("class"), starterGrant: "kit" },
  } as never);
  const finalized = repository.finalizeCharacterDraft(OWNER, draft.draft.id, {
    expectedRevision: selected.draft.revision, idempotencyKey: `play.${key}.finalize`,
  });
  return { actorId: finalized.receipt.actorId, campaignCharacterId: finalized.receipt.campaignCharacterId, personaId };
}

const personaIds = ["Lead Investigator", "Field Partner"].map((name, index) => repository.createCharacter({
  name: `${options.campaignName} - ${name}`, age: 32 + index, archetype: index === 0 ? "Regional investigator" : "Industrial specialist",
  boundaries: "Fictional adults. No sexual violence, harm to children, or demeaning portrayals of real communities.", fictionalConfirmed: true,
}).id);
const actors = personaIds.map((personaId, index) => finalizeActor(personaId, `actor-${index}`));

const roomTitle = `${options.campaignName} - Opening Room`;
const session = await createSession({ characterIds: personaIds, primaryCharacterId: personaIds[0]!, title: roomTitle, presetId: "default" });
repository.transitionSession(session.id, "active", "Prepared for local play");
repository.attachCampaignSession(OWNER, { campaignId: options.campaignId, sessionId: session.id });

const administration = repository.getCampaignAdministration(OWNER, options.campaignId);
if (administration && administration.status !== "published" && administration.status !== "completed") {
  repository.updateCampaignAdministration(OWNER, options.campaignId, {
    expectedRevision: administration.revision, status: "published", idempotencyKey: "play.publish",
  });
}

console.log(JSON.stringify({ status: "ready", dataDir: options.dataDir, campaignId: options.campaignId, sessionId: session.id,
  actorIds: actors.map((actor) => actor.actorId), campaignCharacterIds: actors.map((actor) => actor.campaignCharacterId) }, null, 2));
repository.close();
