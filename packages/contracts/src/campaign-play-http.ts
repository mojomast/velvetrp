import { z } from "zod";
import { campaignLifecycleStatusSchema } from "./campaign-administration.js";
import { campaignSessionAttachmentSchema } from "./campaigns.js";
import { campaignRoleSchema, resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { revisionSchema } from "./rpg-commands.js";

const hasWellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};

/** Maximum number of session participants that can be offered as playable actors. */
export const MAX_CAMPAIGN_PLAY_ACTORS = 12;

/** Legacy room identity accepted without trimming or resource-ID normalization. */
export const campaignPlaySessionIdSchema = campaignSessionAttachmentSchema.shape.sessionId;

/** Closed description of the actor set available to the requesting campaign role. */
export const campaignPlayControlSchema = z.enum(["all", "controlled", "none"]);

/** Minimal display identity for one participating playable campaign actor. */
export const campaignPlayActorSchema = z.object({
  actorId: resourceIdSchema,
  name: z.string().min(1).max(200)
    .refine(hasWellFormedUtf16, "actor name must contain well-formed UTF-16")
    .refine((value) => value.trim().length > 0, "actor name must not be blank"),
}).strict();

/** Exact session attachment and lifecycle facts needed before starting play. */
export const campaignPlaySessionSchema = z.object({
  attached: z.literal(true),
  attachedAt: utcIsoTimestampSchema,
  active: z.boolean(),
  adventureEligible: z.boolean(),
}).strict().refine((session) => !session.adventureEligible || session.active, {
  message: "adventure-eligible sessions must be active",
  path: ["adventureEligible"],
});

/** Role-safe principal capability without principal or controller identity. */
export const campaignPlayPrincipalSchema = z.object({
  role: campaignRoleSchema,
  control: campaignPlayControlSchema,
}).strict().superRefine(({ role, control }, context) => {
  const expected = role === "owner" || role === "gm" ? "all" : role === "player" ? "controlled" : "none";
  if (control !== expected) context.addIssue({ code: "custom", path: ["control"], message: "control must match role" });
});

/** Server-derived campaign dice authorization for the current principal. */
export const campaignPlayCampaignDiceCapabilitySchema = z.object({
  canView: z.boolean(),
  canRoll: z.boolean(),
}).strict().refine(({ canView, canRoll }) => !canRoll || canView, {
  message: "campaign dice rolling requires history visibility",
  path: ["canRoll"],
});

/** Closed capability set consumed by campaign play clients without inference. */
export const campaignPlayCapabilitiesSchema = z.object({
  campaignDice: campaignPlayCampaignDiceCapabilitySchema,
}).strict();

/**
 * Minimal bootstrap for a campaign play room. The projection intentionally
 * excludes principal, controller, persona, campaign-character, sheet, and
 * timeline identities as well as every private campaign field.
 */
export const campaignPlayBootstrapSchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: campaignPlaySessionIdSchema,
  expectedRevision: revisionSchema,
  dm: z.object({ mode: z.enum(["human", "ai"]), revision: revisionSchema }).strict().optional(),
  session: campaignPlaySessionSchema,
  principal: campaignPlayPrincipalSchema,
  capabilities: campaignPlayCapabilitiesSchema,
  playableActors: z.array(campaignPlayActorSchema).max(MAX_CAMPAIGN_PLAY_ACTORS),
}).strict().superRefine((value, context) => {
  if (value.principal.control === "none" && value.playableActors.length !== 0) {
    context.addIssue({ code: "custom", path: ["playableActors"], message: "roles without control cannot receive actors" });
  }
  if (value.session.adventureEligible && !resourceIdSchema.safeParse(value.sessionId).success) {
    context.addIssue({ code: "custom", path: ["session", "adventureEligible"], message: "adventure stream requires a strict session ID" });
  }
  const dice = value.capabilities.campaignDice;
  if (value.principal.role === "observer" && (dice.canView || dice.canRoll)) {
    context.addIssue({ code: "custom", path: ["capabilities", "campaignDice"], message: "observers cannot use campaign dice" });
  }
  if ((value.principal.role === "owner" || value.principal.role === "gm") && (!dice.canView || !dice.canRoll)) {
    context.addIssue({ code: "custom", path: ["capabilities", "campaignDice"], message: "privileged roles can use campaign dice" });
  }
  if (value.principal.role === "player" && dice.canRoll && value.playableActors.length === 0) {
    context.addIssue({ code: "custom", path: ["capabilities", "campaignDice", "canRoll"], message: "player dice rolling requires a controlled actor" });
  }
});

/** Campaign lifecycle vocabulary used when deriving play eligibility. */
export const campaignPlayLifecycleSchema = campaignLifecycleStatusSchema;

/** Actor-set control available to the requesting role. */
export type CampaignPlayControl = z.infer<typeof campaignPlayControlSchema>;
/** One minimal playable actor. */
export type CampaignPlayActor = z.infer<typeof campaignPlayActorSchema>;
/** Minimal campaign play bootstrap response. */
export type CampaignPlayBootstrap = z.infer<typeof campaignPlayBootstrapSchema>;
