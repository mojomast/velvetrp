import { campaignContentGenerationRecoverySchema, campaignContentGenerationRequestSchema, campaignContentApplyRequestSchema, campaignMaterialPublishRequestSchema, resourceIdSchema } from "@velvet/contracts";
import { z } from "zod";

export const generationIntentSchema = z.object({
  input: campaignContentGenerationRequestSchema.omit({ reviewedContent: true }),
  failedAttempt: z.number().int().min(1).max(32).nullable(), ambiguous: z.boolean(),
}).strict();
const fields: Record<string, z.ZodType> = {
  draftId: resourceIdSchema.nullable(),
  generationIntent: generationIntentSchema.nullable(),
  applyIntent: z.object({ draftId: resourceIdSchema, input: campaignContentApplyRequestSchema }).strict().nullable(),
  publishIntent: z.object({ campaignId: resourceIdSchema, input: campaignMaterialPublishRequestSchema, title: z.string().max(200) }).strict().nullable(),
  answers: z.object({premise:z.string().max(900),heroes:z.string().max(250),stakes:z.string().max(250),opening:z.string().max(250)}).strict(),
  tone: z.string().max(200), depth:z.string().max(40), focus:z.array(z.string().max(100)).max(3),
  preset:z.enum(["foundation","full","custom"]), sections:campaignContentGenerationRequestSchema.shape.sections,
  stagedMode:z.boolean(),
  hydrationPlan:z.object({
    version:z.literal(1),currentStep:z.number().int().min(0).max(4),
    completed:z.array(z.object({stepId:z.string().max(40),draftId:resourceIdSchema,returnedCount:z.number().int().min(0).max(128),acceptedCount:z.number().int().min(1).max(128)}).strict()).max(5),
    contextOptions:z.array(z.object({key:z.string().regex(/^[a-z][a-z0-9-]*$/).max(64),label:z.string().min(1).max(200),kind:z.string().min(1).max(80)}).strict()).max(128),
    contextKeys:z.array(z.string().regex(/^[a-z][a-z0-9-]*$/).max(64)).max(16),
  }).strict().nullable(),
  exclusions:z.string().max(3215), feedback:z.string().max(2000), expandKeys:z.string().max(1039),
  stage:z.enum(["foundation","vision","safety","scope","review","candidate","ready"]), reviewed:z.boolean(),
};
const prefix = "velvet-campaign-authoring-v1:";
const maxBytes = 64 * 1024;

export function readAuthoringField(campaignId:string, field:string): unknown {
  if (!fields[field]) return undefined;
  try {
    const raw=sessionStorage.getItem(prefix+campaignId);
    if (!raw || raw.length>maxBytes) return undefined;
    const parsed=fields[field].safeParse(JSON.parse(raw)[field]);
    if (!parsed.success) return undefined;
    const value=parsed.data;
    if (field==="generationIntent" && value && (value as z.infer<typeof generationIntentSchema>).input.campaignId!==campaignId) return undefined;
    if (field==="publishIntent" && value && (value as {campaignId:string}).campaignId!==campaignId) return undefined;
    return value;
  } catch { return undefined; }
}

// Synchronous intent writes happen before dispatch. No preview, credentials, or
// reviewed provider content is persisted. Session storage survives tab reloads.
export function writeAuthoringField(campaignId:string, field:string, value:unknown): void {
  if (!fields[field]) return;
  const parsed=fields[field].parse(value),key=prefix+campaignId;
  if (!sessionStorage.getItem(key) && Object.keys(sessionStorage).filter((key)=>key.startsWith(prefix)).length>=8) throw new Error("Authoring storage is full");
  const raw=sessionStorage.getItem(key);
  const stored=raw&&raw.length<=maxBytes?JSON.parse(raw):{};
  const json=JSON.stringify({...stored,[field]:parsed});
  if(json.length>maxBytes)throw new Error("Authoring storage is full");
  sessionStorage.setItem(key,json);
}

export async function reconcileCampaignGeneration(input:z.infer<typeof campaignContentGenerationRequestSchema>) {
  const response=await fetch("/api/rpg/v1/campaign-content-drafts/reconcile",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  if(!response.ok)throw new Error("Generation reconciliation unavailable");
  const result=campaignContentGenerationRecoverySchema.parse(await response.json());
  if(result.campaignId!==input.campaignId||result.idempotencyKey!==input.idempotencyKey)throw new Error("Generation recovery binding mismatch");
  return result;
}
