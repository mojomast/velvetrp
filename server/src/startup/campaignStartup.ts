import { createHash } from "node:crypto";
import type { CampaignDmRun } from "@velvet/contracts";
import type { CampaignDmRepository } from "../repo/campaignDmRepo.js";
import type { CampaignGenerationRepository } from "../repo/campaignGenerationRepo.js";
import type { CampaignStartupRepository } from "../repo/campaignStartupRepo.js";
import { buildScenePrompt } from "../image/scenePrompt.js";
import type { SceneImageEnqueueInput, SceneImageEnqueueResult } from "../image/service.js";

/**
 * Campaign startup pipeline.
 *
 * One server-owned, owner/GM-authorized command turns a freshly prepared
 * campaign into a playable AI-directed room. It performs exactly four ordered
 * steps and never fabricates canon or bypasses the planning gate:
 *
 *   1. Set the Director to `ai` with the caller as delegator (provider-free).
 *   2. Publish only eligible accepted **public** handouts/scene-prompts through
 *      the existing material-publication command.
 *   3. Run the opening beat through the existing DM repo + orchestrator, which
 *      keeps the server-issued candidate set and the planning gate authoritative.
 *   4. Enqueue one scene image per **public** campaign location (best-effort,
 *      skipped when the scene-image lane is disabled).
 *
 * Every write uses a deterministic idempotency key derived from durable
 * identities, and each call re-reads durable state first, so replaying the same
 * command never double-publishes, double-opens, or double-enqueues. A blocked
 * opening beat is reported as a blocker, not thrown; everything that already
 * took effect stays in effect, and re-running after the campaign is fixed
 * completes the remaining steps.
 */

export class CampaignStartupUnavailableError extends Error {}
export class CampaignStartupConflictError extends Error {}

/** Structural scene-image seam; the concrete `SceneImageRouteService` satisfies it. */
export interface CampaignStartupSceneImagePort {
  getSettings(principalId: string, campaignId: string): {
    settings: {
      enabled: boolean;
      steps: number;
      guidance: number;
      stylePhrase: string;
      promptOverrides: Readonly<Record<string, string>>;
    };
  };
  enqueue(principalId: string, campaignId: string, input: SceneImageEnqueueInput,
    idempotencyKey: string): SceneImageEnqueueResult;
}

export interface CampaignStartupDependencies {
  dm: Pick<CampaignDmRepository, "getDmControl" | "setDmControl" | "openDmBeat" | "getDmRun" | "getDmHistory">;
  generation: Pick<CampaignGenerationRepository, "getCampaignGeneratedPlanning" | "publishCampaignMaterial">;
  startup: Pick<CampaignStartupRepository, "getCampaignStartupRead">;
  /** Bound orchestrator; keeps provider selection and execution out of this module. */
  orchestrate: (principalId: string, runId: string) => Promise<void>;
  sceneImages: {
    installationEnabled: () => boolean;
    service: () => CampaignStartupSceneImagePort | null;
  };
}

export interface CampaignStartupBeat {
  runId: string | null;
  state: CampaignDmRun["state"] | "none";
}

export interface CampaignStartupImage {
  locationId: string;
  jobId: string | null;
  deduped: boolean;
  skipped: string | null;
}

export interface CampaignStartupSummary {
  campaignId: string;
  sessionId: string;
  dmMode: "human" | "ai";
  dmModeRevision: number;
  published: string[];
  beat: CampaignStartupBeat;
  imagesEnqueued: CampaignStartupImage[];
  blockers: string[];
}

export const CAMPAIGN_STARTUP_MAX_PUBLISHED = 64;
export const CAMPAIGN_STARTUP_MAX_IMAGES = 64;
export const CAMPAIGN_STARTUP_MAX_BLOCKERS = 16;

/** Deterministic, bounded idempotency key from a durable identity. */
function startupKey(operation: string, identity: string): string {
  return `startup.${operation}.${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
}

export async function runCampaignStartup(
  input: { principalId: string; campaignId: string; sessionId: string },
  deps: CampaignStartupDependencies,
): Promise<CampaignStartupSummary> {
  const { principalId, campaignId, sessionId } = input;
  const blockers: string[] = [];

  // Re-read durable state and authorize as owner/GM before any write. The room
  // must already be attached to the campaign; a missing room fails closed.
  const read = deps.startup.getCampaignStartupRead(principalId, campaignId, sessionId);
  if (!read) throw new CampaignStartupUnavailableError();
  // A durable preparation token: changing any of these means the opening beat is
  // worth attempting again instead of replaying a previously blocked run.
  const preparationToken = `${read.startingLocationId ?? "none"}:${read.administrationRevision}:${read.sessionState}:${read.sessionStopped ? "stopped" : "running"}`;

  // 1. AI mode with the caller as delegator. A mode change is revision-bound and
  // provider-free; when already AI we keep the existing revision rather than
  // bumping it redundantly. The deterministic key makes a lost response replayed.
  let control = deps.dm.getDmControl(principalId, campaignId);
  if (control.mode !== "ai") {
    deps.dm.setDmControl(principalId, campaignId, {
      mode: "ai",
      expectedRevision: control.revision,
      // The pre-change revision is part of the durable identity, so a fresh
      // delegation after an explicit takeover is a new command, while an
      // immediate replay of the same call still converges.
      idempotencyKey: startupKey("dm-mode", `${campaignId}:${control.revision}`),
    });
    control = deps.dm.getDmControl(principalId, campaignId);
  }

  // 2. Publish every accepted public handout/scene-prompt that is not delivered.
  // Already-published artifacts are skipped so the publish revision never moves
  // on replay; GM-only artifacts are never considered.
  const published: string[] = [];
  const planning = deps.generation.getCampaignGeneratedPlanning(principalId, campaignId);
  if (planning) {
    let revision = planning.deliveryRevision;
    for (const material of planning.deliverables) {
      if (published.length >= CAMPAIGN_STARTUP_MAX_PUBLISHED) break;
      if (material.visibility !== "public" || material.publishedAt !== null) continue;
      const result = deps.generation.publishCampaignMaterial(principalId, campaignId, {
        artifactKey: material.artifactKey,
        expectedRevision: revision,
        idempotencyKey: startupKey("publish", `${campaignId}:${material.artifactKey}`),
      });
      revision = result.receipt.revisionAfter;
      published.push(material.artifactKey);
    }
  }

  // 3. Run the opening beat through the existing planning gate. A terminal open
  // is reused; a pending run resumes; an unpublished/blocked state gets a fresh
  // attempt whose key changes once the durable preparation token changes, so a
  // fixed campaign can complete the opening instead of replaying a stale block.
  let beat: CampaignStartupBeat = { runId: null, state: "none" };
  const history = deps.dm.getDmHistory(principalId, campaignId, sessionId);
  const openRuns = history.runs.filter((run) => run.intent === "open");
  const completedOpen = [...openRuns].reverse().find((run) => run.state === "completed");
  if (completedOpen) {
    beat = { runId: completedOpen.runId, state: completedOpen.state };
  } else {
    const pending = [...openRuns].reverse().find((run) => run.state === "planning" || run.state === "awaiting-approval");
    const run = pending ?? deps.dm.openDmBeat(principalId, campaignId, sessionId, {
      intent: "open",
      expectedModeRevision: control.revision,
      idempotencyKey: startupKey("open", `${campaignId}:${sessionId}:${preparationToken}`),
    });
    await deps.orchestrate(principalId, run.runId);
    const settled = deps.dm.getDmRun(principalId, campaignId, sessionId, run.runId);
    beat = { runId: settled.runId, state: settled.state };
    if (settled.state === "blocked" || settled.state === "unknown" || settled.state === "cancelled") {
      for (const code of settled.blockers) blockers.push(code);
    }
  }

  // 4. Once the opening is committed, enqueue one scene image per public
  // location. A blocked opening defers this step: re-running after the campaign
  // is fixed completes it. The lane is optional: a disabled installation or
  // campaign skips cleanly, and per-location failures are recorded without
  // failing the command. Deterministic per-location keys let the sidecar's own
  // receipt idempotency absorb replay.
  const imagesEnqueued: CampaignStartupImage[] = [];
  try {
    if (beat.state === "completed" && deps.sceneImages.installationEnabled()) {
      const service = deps.sceneImages.service();
      if (service) {
        const settings = service.getSettings(principalId, campaignId).settings;
        if (settings.enabled) {
          for (const location of read.locations) {
            if (imagesEnqueued.length >= CAMPAIGN_STARTUP_MAX_IMAGES) break;
            const sceneKey = `location:${location.locationId}`;
            const override = settings.promptOverrides[sceneKey];
            const prompt = override && override.trim().length > 0 ? override.trim() : buildScenePrompt({
              locationName: location.name,
              focalFeature: location.description,
              composition: "",
              lighting: "",
              materials: [],
              stylePhrase: settings.stylePhrase,
              facts: [],
            });
            try {
              const result = service.enqueue(principalId, campaignId, {
                sessionId,
                sceneKey,
                sceneRevision: 0,
                prompt,
                steps: settings.steps,
                guidance: settings.guidance,
                kind: "single",
                auto: false,
              }, startupKey("image", `${campaignId}:${sessionId}:${location.locationId}`));
              imagesEnqueued.push({
                locationId: location.locationId,
                jobId: result.job?.jobId ?? null,
                deduped: result.deduped,
                skipped: result.job === null ? (result.refusal?.code ?? "refused") : null,
              });
            } catch {
              imagesEnqueued.push({ locationId: location.locationId, jobId: null, deduped: false, skipped: "unavailable" });
            }
          }
        }
      }
    }
  } catch {
    // Scene images are a best-effort post-step; never fail startup for them.
  }

  return {
    campaignId,
    sessionId,
    dmMode: control.mode,
    dmModeRevision: control.revision,
    published,
    beat,
    imagesEnqueued,
    blockers: [...new Set(blockers)].slice(0, CAMPAIGN_STARTUP_MAX_BLOCKERS),
  };
}
