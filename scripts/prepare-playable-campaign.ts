#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHARACTER_BUILDER_ATTRIBUTE_IDS,
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";
import {
  createRepository,
  createSession,
  listCharacters,
  listSessions,
  MECHANICS_STARTER_CATALOG,
  SRD_5_1_STARTER_CATALOG,
} from "../server/src/repo/index.js";

/**
 * Makes a hydrated, provider-generated campaign enterable: creates a finalized
 * two-character party, an active attached room, and publishes the campaign.
 * Idempotent per persona name and room title. Intended for local/tailnet play.
 *
 *   npx tsx scripts/prepare-playable-campaign.ts \
 *     --data-dir .velvet/baie-comeau-drowned-boom \
 *     --campaign-id <id> \
 *     --campaign-name "Baie-Comeau: The Drowned Boom" \
 *     --starter srd-5.1
 */
const OWNER = "local-owner";

const PERSONAS = [
  { name: "Lead Investigator", archetype: "Regional investigator" },
  { name: "Field Partner", archetype: "Industrial specialist" },
] as const;

export type PlayableStarter = "mechanics" | "srd-5.1";

export interface PreparePlayableCampaignOptions {
  dataDir: string;
  campaignId: string;
  campaignName?: string;
  starter?: PlayableStarter;
  roomTitle?: string;
}

export interface PreparePlayableCampaignResult {
  status: "ready";
  dataDir: string;
  campaignId: string;
  sessionId: string;
  actorIds: string[];
  campaignCharacterIds: string[];
}

type ParsedArgs = Required<Pick<PreparePlayableCampaignOptions, "dataDir" | "campaignId" | "campaignName" | "starter">> & Pick<PreparePlayableCampaignOptions, "roomTitle">;

function parseArgs(argv: string[]): ParsedArgs {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[++index] ?? "";
  }
  if (!args["data-dir"] || !args["campaign-id"]) {
    throw new Error("usage: --data-dir DIR --campaign-id ID [--campaign-name NAME] [--starter mechanics|srd-5.1] [--room-title TITLE]");
  }
  const starter = args["starter"] ?? "mechanics";
  if (starter !== "mechanics" && starter !== "srd-5.1") {
    throw new Error(`unknown starter ${JSON.stringify(starter)}; expected mechanics or srd-5.1`);
  }
  return {
    dataDir: args["data-dir"],
    campaignId: args["campaign-id"],
    campaignName: args["campaign-name"] ?? "Campaign",
    starter,
    ...(args["room-title"] ? { roomTitle: args["room-title"] } : {}),
  };
}

const STARTER_ATTRIBUTES: Record<PlayableStarter, readonly string[]> = {
  mechanics: CHARACTER_BUILDER_ATTRIBUTE_IDS,
  "srd-5.1": SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
};

function attributeScores(starter: PlayableStarter): CharacterBuilderAttributeScores {
  return Object.fromEntries(
    STARTER_ATTRIBUTES[starter].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
  ) as CharacterBuilderAttributeScores;
}

function starterReference(starter: PlayableStarter, kind: "race" | "background" | "class") {
  const catalog = starter === "srd-5.1" ? SRD_5_1_STARTER_CATALOG : MECHANICS_STARTER_CATALOG;
  const reference = catalog.definitions.find((definition) => definition.reference.kind === kind)?.reference;
  if (!reference) throw new Error(`${starter} starter ${kind} is unavailable`);
  return reference;
}

export async function preparePlayableCampaign(options: PreparePlayableCampaignOptions): Promise<PreparePlayableCampaignResult> {
  const starter = options.starter ?? "mechanics";
  const campaignName = options.campaignName ?? "Campaign";
  process.env.VELVET_DATA_DIR = options.dataDir;
  const repository = createRepository({ dataDir: options.dataDir });
  try {
    const scores = attributeScores(starter);
    const finalizeActor = (personaId: string, key: string) => {
      const draft = repository.createCharacterDraft(OWNER, options.campaignId, {
        personaId, controllerPrincipalId: OWNER, durability: "durable",
        allocation: { method: "standard-array", scores }, idempotencyKey: `play.${key}.draft`,
      });
      const selected = repository.updateCharacterDraft(OWNER, draft.draft.id, {
        expectedRevision: draft.draft.revision, idempotencyKey: `play.${key}.selections`,
        selections: {
          race: starterReference(starter, "race"),
          background: starterReference(starter, "background"),
          class: starterReference(starter, "class"),
          starterGrant: "kit",
        },
      } as never);
      const finalized = repository.finalizeCharacterDraft(OWNER, draft.draft.id, {
        expectedRevision: selected.draft.revision, idempotencyKey: `play.${key}.finalize`,
      });
      return { actorId: finalized.receipt.actorId, campaignCharacterId: finalized.receipt.campaignCharacterId, personaId };
    };

    const existingCharacters = await listCharacters();
    const personaIds: string[] = [];
    for (const [index, persona] of PERSONAS.entries()) {
      const name = `${campaignName} - ${persona.name}`;
      const existing = existingCharacters.find((character) => character.name === name);
      if (existing) {
        personaIds.push(existing.id);
        continue;
      }
      const created = repository.createCharacter({
        name, age: 32 + index, archetype: persona.archetype,
        boundaries: "Fictional adults. No sexual violence, harm to children, or demeaning portrayals of real communities.",
        fictionalConfirmed: true,
      });
      personaIds.push(created.id);
    }
    const actors = personaIds.map((personaId, index) => finalizeActor(personaId, `actor-${index}`));

    const roomTitle = options.roomTitle ?? `${campaignName} - Opening Room`;
    const attachments = repository.listCampaignSessionAttachments(OWNER, options.campaignId);
    const attachedSessionIds = new Set(attachments.map((attachment) => attachment.sessionId));
    const sessions = await listSessions();
    const existingRoom = sessions.find((candidate) => candidate.title === roomTitle && attachedSessionIds.has(candidate.id));
    const session = existingRoom ?? (await createSession({
      characterIds: personaIds, primaryCharacterId: personaIds[0]!, title: roomTitle, presetId: "default",
    }));
    repository.transitionSession(session.id, "active", "Prepared for local play");
    if (!attachedSessionIds.has(session.id)) {
      repository.attachCampaignSession(OWNER, { campaignId: options.campaignId, sessionId: session.id });
    }

    const administration = repository.getCampaignAdministration(OWNER, options.campaignId);
    if (administration && administration.status !== "published" && administration.status !== "completed") {
      repository.updateCampaignAdministration(OWNER, options.campaignId, {
        expectedRevision: administration.revision, status: "published", idempotencyKey: "play.publish",
      });
    }

    return {
      status: "ready",
      dataDir: options.dataDir,
      campaignId: options.campaignId,
      sessionId: session.id,
      actorIds: actors.map((actor) => actor.actorId),
      campaignCharacterIds: actors.map((actor) => actor.campaignCharacterId),
    };
  } finally {
    repository.close();
  }
}

async function main(): Promise<void> {
  const result = await preparePlayableCampaign(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
