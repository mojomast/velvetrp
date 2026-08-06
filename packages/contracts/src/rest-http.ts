import { z } from "zod";
import { actorResourcesSchema } from "./actor-resources.js";
import { revisionSchema } from "./rpg-commands.js";
import {
  restReceiptSchema,
  takeLongRestCommandSchema,
  takeShortRestCommandSchema,
} from "./rest.js";

/** Route parameters own the campaign and actor identities. */
export const restHttpShortRequestSchema = z.object({
  type: takeShortRestCommandSchema.shape.type,
  expectedRevision: takeShortRestCommandSchema.shape.expectedRevision,
  idempotencyKey: takeShortRestCommandSchema.shape.idempotencyKey,
}).strict();

export const restHttpLongRequestSchema = z.object({
  type: takeLongRestCommandSchema.shape.type,
  expectedRevision: takeLongRestCommandSchema.shape.expectedRevision,
  idempotencyKey: takeLongRestCommandSchema.shape.idempotencyKey,
}).strict();

export const restHttpRequestSchema = z.discriminatedUnion("type", [
  restHttpShortRequestSchema,
  restHttpLongRequestSchema,
]);

/** Receipts prove the rest without exposing route-owned or command identities. */
export const restHttpReceiptSchema = z.object({
  kind: restReceiptSchema.shape.kind,
  recoveredAt: restReceiptSchema.shape.recoveredAt,
  recovery: restReceiptSchema.shape.recovery,
  revisionBefore: restReceiptSchema.shape.revisionBefore,
  revisionAfter: restReceiptSchema.shape.revisionAfter,
  idempotencyKey: restReceiptSchema.shape.idempotencyKey,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1,
  "rest advances exactly one revision");

export const restHttpActorStateSchema = z.object({
  resources: actorResourcesSchema,
  revision: revisionSchema,
}).strict();

export const restHttpResponseSchema = z.object({
  actorState: restHttpActorStateSchema,
  receipt: restHttpReceiptSchema,
}).strict();

export type RestHttpShortRequest = z.infer<typeof restHttpShortRequestSchema>;
export type RestHttpLongRequest = z.infer<typeof restHttpLongRequestSchema>;
export type RestHttpRequest = z.infer<typeof restHttpRequestSchema>;
export type RestHttpReceipt = z.infer<typeof restHttpReceiptSchema>;
export type RestHttpActorState = z.infer<typeof restHttpActorStateSchema>;
export type RestHttpResponse = z.infer<typeof restHttpResponseSchema>;
