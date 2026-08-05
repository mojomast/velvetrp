import { describe, expect, expectTypeOf, it } from "vitest";
import {
  actorDiceRolledEventDataSchema,
  actorDiceRolledEventSchema,
  actorAttributeSetEventDataSchema,
  actorAttributeSetEventSchema,
  actorResourceInitializedEventDataSchema,
  actorResourceInitializedEventSchema,
  commandEnvelopeSchema,
  commandIdSchema,
  commandReceiptSchema,
  diceExpressionSchema,
  diceRollResultSchema,
  eventIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  initializeActorResourceCommandSchema,
  initializeActorResourcePayloadSchema,
  revisionSchema,
  rollActorDiceCommandSchema,
  rollActorDicePayloadSchema,
  rpgCommandSchema,
  rpgEventSchema,
  setActorAttributeCommandSchema,
  setActorAttributePayloadSchema,
  type CommandEnvelope,
  type CommandReceipt,
  type DiceRollResult,
  type RollActorDiceCommand,
  type RpgCommand,
  type RpgEvent,
} from "../src/index.js";

const command = {
  type: "set_actor_attribute",
  payload: { attributeId: "resolve", value: 13 },
} as const;

const envelope = {
  commandId: "command-one",
  idempotencyKey: "turn_1:set.resolve",
  campaignId: "campaign-one",
  timelineId: "timeline-one",
  actorId: "actor-one",
  expectedRevision: 6,
  sourceTurnId: "turn-one",
  command,
} as const;

const event = {
  eventId: "event-one",
  commandId: envelope.commandId,
  campaignId: envelope.campaignId,
  timelineId: envelope.timelineId,
  actorId: envelope.actorId,
  sourceTurnId: envelope.sourceTurnId,
  type: "actor_attribute_set",
  revision: 7,
  occurredAt: "2030-04-05T06:07:08.009Z",
  data: { attributeId: command.payload.attributeId, valueBefore: 12, valueAfter: command.payload.value },
} as const;

const receipt = {
  commandId: envelope.commandId,
  campaignId: envelope.campaignId,
  revisionBefore: 6,
  revisionAfter: 7,
  events: [event],
} as const;

const resourceCommand = {
  type: "initialize_actor_resource",
  payload: { name: "HP", current: 8, max: 10 },
} as const;

const resourceEvent = {
  ...event,
  eventId: "event-resource-one",
  type: "actor_resource_initialized",
  data: resourceCommand.payload,
} as const;

const resourceReceipt = {
  ...receipt,
  events: [resourceEvent],
} as const;

const diceCommand = {
  type: "roll_actor_dice",
  payload: { expression: "4d6kh3+2" },
} as const;

const diceResult = {
  expression: diceCommand.payload.expression,
  normalized: {
    count: 4,
    sides: 6,
    selection: { type: "keep_highest", count: 3 },
    modifier: 2,
  },
  terms: [
    { value: 2, kept: false },
    { value: 6, kept: true },
    { value: 4, kept: true },
    { value: 3, kept: true },
  ],
  modifier: 2,
  total: 15,
} as const;

const diceEvent = {
  ...event,
  eventId: "event-dice-one",
  type: "actor_dice_rolled",
  data: diceResult,
} as const;

const diceReceipt = {
  ...receipt,
  events: [diceEvent],
} as const;

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

describe("RPG command contracts", () => {
  it("aliases command and event IDs to exact resource IDs", () => {
    for (const schema of [commandIdSchema, eventIdSchema]) {
      expect(schema.parse("kind:local_1.test")).toBe("kind:local_1.test");
      for (const invalid of ["", "has space", "has/slash", "x".repeat(129)]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    }
  });

  it("accepts only untrimmed safe idempotency tokens from 1 through 128 characters", () => {
    for (const valid of ["a", "A0._:-", "x".repeat(128)]) {
      expect(idempotencyKeySchema.parse(valid)).toBe(valid);
    }
    for (const invalid of ["", " key", "key ", "two keys", "line\nbreak", "has/slash", "x".repeat(129)]) {
      expect(idempotencyKeySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("bounds revisions and reserves one safe increment for expected revisions", () => {
    for (const valid of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(revisionSchema.parse(valid)).toBe(valid);
    }
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(revisionSchema.safeParse(invalid).success).toBe(false);
    }
    expect(expectedRevisionSchema.safeParse(Number.MAX_SAFE_INTEGER - 1).success).toBe(true);
    expect(expectedRevisionSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(false);
  });

  it("defines the strict set-actor-attribute command at exact value boundaries", () => {
    for (const value of [-1_000, 0, 1_000]) {
      expect(setActorAttributeCommandSchema.parse({ ...command, payload: { ...command.payload, value } })).toEqual({
        ...command,
        payload: { ...command.payload, value },
      });
    }
    for (const value of [-1_001, 1_001, 1.5]) {
      expect(setActorAttributePayloadSchema.safeParse({ ...command.payload, value }).success).toBe(false);
    }
    expect(setActorAttributePayloadSchema.safeParse({ ...command.payload, attributeId: "bad id" }).success).toBe(false);
    expect(setActorAttributePayloadSchema.safeParse({ ...command.payload, extra: true }).success).toBe(false);
    expect(setActorAttributeCommandSchema.safeParse({ ...command, extra: true }).success).toBe(false);
    expect(setActorAttributeCommandSchema.safeParse({ ...command, payload: { ...command.payload, extra: true } }).success).toBe(false);
  });

  it("keeps the existing attribute command contract unchanged", () => {
    expect(setActorAttributePayloadSchema.parse(command.payload)).toEqual(command.payload);
    expect(setActorAttributeCommandSchema.parse(command)).toEqual(command);
    expect(actorAttributeSetEventDataSchema.parse(event.data)).toEqual(event.data);
    expect(actorAttributeSetEventSchema.parse(event)).toEqual(event);
  });

  it("exposes exactly three command discriminants and narrows every inferred variant", () => {
    expect(rpgCommandSchema.options).toHaveLength(3);
    expect(rpgCommandSchema.parse(command)).toEqual(command);
    expect(rpgCommandSchema.parse(resourceCommand)).toEqual(resourceCommand);
    expect(rpgCommandSchema.parse(diceCommand)).toEqual(diceCommand);
    for (const type of ["roll_dice", "check_actor_skill", "deal_damage", "set_actor_resource", "initialize_actor_resources"]) {
      expect(rpgCommandSchema.safeParse({ type, payload: {} }).success).toBe(false);
    }

    const narrow = (value: RpgCommand) => {
      if (value.type === "set_actor_attribute") {
        expectTypeOf(value).toEqualTypeOf<{
          type: "set_actor_attribute";
          payload: { attributeId: string; value: number };
        }>();
        return value.payload.value;
      }
      if (value.type === "initialize_actor_resource") {
        expectTypeOf(value).toEqualTypeOf<{
          type: "initialize_actor_resource";
          payload: { name: string; current: number; max: number };
        }>();
        return value.payload.current;
      }
      expectTypeOf(value).toEqualTypeOf<RollActorDiceCommand>();
      return value.payload.expression;
    };
    expect(narrow(command)).toBe(13);
    expect(narrow(resourceCommand)).toBe(8);
    expect(narrow(diceCommand)).toBe("4d6kh3+2");
  });

  it("defines one specialized dice command whose strict payload is only a canonical expression", () => {
    expect(rollActorDicePayloadSchema.shape.expression).toBe(diceExpressionSchema);
    expect(rollActorDicePayloadSchema.parse(diceCommand.payload)).toEqual(diceCommand.payload);
    expect(rollActorDiceCommandSchema.parse(diceCommand)).toEqual(diceCommand);
    for (const expression of ["1d20", "1d20adv+2", "100d1000kl1-1000"]) {
      expect(rollActorDicePayloadSchema.parse({ expression })).toEqual({ expression });
    }
    for (const expression of ["d20", "1D20", "01d20", "1d20 ", "2d20adv", "1d20+0"]) {
      expect(rollActorDicePayloadSchema.safeParse({ expression }).success).toBe(false);
    }
    expect(rollActorDicePayloadSchema.safeParse({}).success).toBe(false);
    expect(rollActorDiceCommandSchema.safeParse({ ...diceCommand, extra: true }).success).toBe(false);
    for (const field of ["mechanics", "narration", "check", "abilityId", "difficultyClass", "rng"] as const) {
      expect(rollActorDicePayloadSchema.safeParse({ ...diceCommand.payload, [field]: {} }).success).toBe(false);
      expect(rollActorDiceCommandSchema.safeParse({ ...diceCommand, [field]: {} }).success).toBe(false);
      expect(commandEnvelopeSchema.safeParse({ ...envelope, command: diceCommand, [field]: {} }).success).toBe(false);
    }
  });

  it("defines one strict actor-resource initialization using the shared bounded state", () => {
    expect(initializeActorResourcePayloadSchema).toBe(actorResourceInitializedEventDataSchema);
    expect(initializeActorResourceCommandSchema.parse(resourceCommand)).toEqual(resourceCommand);
    expect(initializeActorResourceCommandSchema.parse({
      ...resourceCommand, payload: { name: "empty", current: 0, max: 0 },
    }).payload.max).toBe(0);
    expect(initializeActorResourcePayloadSchema.safeParse({ ...resourceCommand.payload, current: 11 }).success).toBe(false);
    expect(initializeActorResourcePayloadSchema.safeParse({ ...resourceCommand.payload, current: 1.5 }).success).toBe(false);
    expect(initializeActorResourcePayloadSchema.safeParse({ ...resourceCommand.payload, name: " HP" }).success).toBe(false);
    expect(initializeActorResourcePayloadSchema.safeParse({ ...resourceCommand.payload, extra: true }).success).toBe(false);
    expect(initializeActorResourceCommandSchema.safeParse({ ...resourceCommand, extra: true }).success).toBe(false);
  });

  it("requires the complete strict envelope with non-null actor and required nullable source turn", () => {
    expect(commandEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(commandEnvelopeSchema.parse({ ...envelope, command: resourceCommand }).command).toEqual(resourceCommand);
    expect(commandEnvelopeSchema.parse({ ...envelope, command: diceCommand }).command).toEqual(diceCommand);
    expect(commandEnvelopeSchema.parse({ ...envelope, sourceTurnId: null }).sourceTurnId).toBeNull();
    for (const field of [
      "commandId", "idempotencyKey", "campaignId", "timelineId", "actorId", "expectedRevision", "sourceTurnId", "command",
    ] as const) {
      expect(commandEnvelopeSchema.safeParse(without(envelope, field)).success).toBe(false);
    }
    expect(commandEnvelopeSchema.safeParse({ ...envelope, actorId: null }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ ...envelope, sourceTurnId: undefined }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ ...envelope, timelineId: "bad timeline" }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
  });

  it("requires strict unequal actor-attribute event data", () => {
    expect(actorAttributeSetEventDataSchema.parse(event.data)).toEqual(event.data);
    expect(actorAttributeSetEventDataSchema.safeParse({ ...event.data, valueAfter: event.data.valueBefore }).success).toBe(false);
    for (const field of ["attributeId", "valueBefore", "valueAfter"] as const) {
      expect(actorAttributeSetEventDataSchema.safeParse(without(event.data, field)).success).toBe(false);
    }
    for (const field of ["valueBefore", "valueAfter"] as const) {
      expect(actorAttributeSetEventDataSchema.safeParse({ ...event.data, [field]: 1_001 }).success).toBe(false);
      expect(actorAttributeSetEventDataSchema.safeParse({ ...event.data, [field]: 1.5 }).success).toBe(false);
    }
    expect(actorAttributeSetEventDataSchema.safeParse({ ...event.data, extra: true }).success).toBe(false);
  });

  it("requires a complete strict event, canonical timestamp, positive revision, and nullable source turn", () => {
    expect(actorAttributeSetEventSchema.parse(event)).toEqual(event);
    expect(actorAttributeSetEventSchema.parse({ ...event, sourceTurnId: null }).sourceTurnId).toBeNull();
    for (const field of [
      "eventId", "commandId", "campaignId", "timelineId", "actorId", "sourceTurnId", "type", "revision", "occurredAt", "data",
    ] as const) {
      expect(actorAttributeSetEventSchema.safeParse(without(event, field)).success).toBe(false);
    }
    expect(actorAttributeSetEventSchema.safeParse({ ...event, sourceTurnId: undefined }).success).toBe(false);
    expect(actorAttributeSetEventSchema.safeParse({ ...event, actorId: null }).success).toBe(false);
    expect(actorAttributeSetEventSchema.safeParse({ ...event, revision: 0 }).success).toBe(false);
    expect(actorAttributeSetEventSchema.safeParse({ ...event, revision: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    for (const occurredAt of [
      "2030-04-05T06:07:08Z", "2030-04-05T06:07:08.09Z", "2030-04-05T06:07:08.009+00:00",
      "2030-04-05T07:07:08.009+01:00", "not-a-time",
    ]) {
      expect(actorAttributeSetEventSchema.safeParse({ ...event, occurredAt }).success).toBe(false);
    }
    expect(actorAttributeSetEventSchema.safeParse({ ...event, extra: true }).success).toBe(false);
  });

  it("defines a strict initialized event with the standard unchanged envelope", () => {
    expect(actorResourceInitializedEventSchema.parse(resourceEvent)).toEqual(resourceEvent);
    for (const field of [
      "eventId", "commandId", "campaignId", "timelineId", "actorId", "sourceTurnId", "type", "revision", "occurredAt", "data",
    ] as const) {
      expect(actorResourceInitializedEventSchema.safeParse(without(resourceEvent, field)).success).toBe(false);
    }
    expect(actorResourceInitializedEventSchema.safeParse({ ...resourceEvent, revision: 0 }).success).toBe(false);
    expect(actorResourceInitializedEventSchema.safeParse({
      ...resourceEvent, data: { ...resourceEvent.data, current: resourceEvent.data.max + 1 },
    }).success).toBe(false);
    expect(actorResourceInitializedEventSchema.safeParse({ ...resourceEvent, resourceId: "resource-one" }).success).toBe(false);
    expect(actorResourceInitializedEventSchema.safeParse({ ...resourceEvent, updatedAt: resourceEvent.occurredAt }).success).toBe(false);
  });

  it("defines one public dice event whose strict data is the structured roll result", () => {
    expect(actorDiceRolledEventDataSchema).toBe(diceRollResultSchema);
    expect(actorDiceRolledEventDataSchema.parse(diceResult)).toEqual(diceResult);
    expect(actorDiceRolledEventSchema.parse(diceEvent)).toEqual(diceEvent);
    expectTypeOf<typeof actorDiceRolledEventDataSchema._output>().toEqualTypeOf<DiceRollResult>();
    for (const field of [
      "eventId", "commandId", "campaignId", "timelineId", "actorId", "sourceTurnId", "type", "revision", "occurredAt", "data",
    ] as const) {
      expect(actorDiceRolledEventSchema.safeParse(without(diceEvent, field)).success).toBe(false);
    }
    for (const field of ["mechanics", "narration", "check", "checkResult", "publicFacts", "rng"] as const) {
      expect(actorDiceRolledEventDataSchema.safeParse({ ...diceResult, [field]: {} }).success).toBe(false);
      expect(actorDiceRolledEventSchema.safeParse({ ...diceEvent, [field]: {} }).success).toBe(false);
    }
    expect(actorDiceRolledEventSchema.safeParse({ ...diceEvent, revision: 0 }).success).toBe(false);
    expect(actorDiceRolledEventSchema.safeParse({
      ...diceEvent,
      data: { ...diceResult, total: diceResult.total + 1 },
    }).success).toBe(false);
  });

  it("exposes exactly three event discriminants and narrows every inferred variant", () => {
    expect(rpgEventSchema.options).toHaveLength(3);
    expect(rpgEventSchema.parse(event)).toEqual(event);
    expect(rpgEventSchema.parse(resourceEvent)).toEqual(resourceEvent);
    expect(rpgEventSchema.parse(diceEvent)).toEqual(diceEvent);
    for (const type of ["dice_rolled", "actor_check_resolved", "damage_dealt", "actor_resource_set", "actor_resources_initialized"]) {
      expect(rpgEventSchema.safeParse({ ...event, type }).success).toBe(false);
    }

    const narrow = (value: RpgEvent) => {
      if (value.type === "actor_attribute_set") {
        expectTypeOf(value.data).toEqualTypeOf<{ attributeId: string; valueBefore: number; valueAfter: number }>();
        return value.data.valueAfter;
      }
      if (value.type === "actor_resource_initialized") {
        expectTypeOf(value.data).toEqualTypeOf<{ name: string; current: number; max: number }>();
        return value.data.current;
      }
      expectTypeOf(value.data).toEqualTypeOf<DiceRollResult>();
      return value.data.total;
    };
    expect(narrow(event)).toBe(13);
    expect(narrow(resourceEvent)).toBe(8);
    expect(narrow(rpgEventSchema.parse(diceEvent))).toBe(15);
  });

  it("accepts only strict receipts with exactly one event and one safe revision increment", () => {
    expect(commandReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(commandReceiptSchema.parse(resourceReceipt)).toEqual(resourceReceipt);
    expect(commandReceiptSchema.parse(diceReceipt)).toEqual(diceReceipt);
    for (const field of ["commandId", "campaignId", "revisionBefore", "revisionAfter", "events"] as const) {
      expect(commandReceiptSchema.safeParse(without(receipt, field)).success).toBe(false);
    }
    expect(commandReceiptSchema.safeParse({ ...receipt, events: [] }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({ ...receipt, events: [event, event] }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({ ...receipt, revisionAfter: receipt.revisionBefore }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({ ...receipt, revisionAfter: receipt.revisionAfter + 1 }).success).toBe(false);

    const finalReceipt = {
      ...receipt,
      revisionBefore: Number.MAX_SAFE_INTEGER - 1,
      revisionAfter: Number.MAX_SAFE_INTEGER,
      events: [{ ...event, revision: Number.MAX_SAFE_INTEGER }],
    };
    expect(commandReceiptSchema.safeParse(finalReceipt).success).toBe(true);
  });

  it("rejects every receipt-to-event identity or revision mismatch", () => {
    expect(commandReceiptSchema.safeParse({
      ...receipt, events: [{ ...event, revision: receipt.revisionAfter + 1 }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...receipt, events: [{ ...event, commandId: "command-two" }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...receipt, events: [{ ...event, campaignId: "campaign-two" }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...resourceReceipt, events: [{ ...resourceEvent, revision: resourceReceipt.revisionAfter + 1 }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...resourceReceipt, events: [{ ...resourceEvent, commandId: "command-two" }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...resourceReceipt, events: [{ ...resourceEvent, campaignId: "campaign-two" }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...diceReceipt, events: [{ ...diceEvent, revision: diceReceipt.revisionAfter + 1 }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...diceReceipt, events: [{ ...diceEvent, commandId: "command-two" }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...diceReceipt, events: [{ ...diceEvent, campaignId: "campaign-two" }],
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...diceReceipt, revisionAfter: diceReceipt.revisionBefore,
    }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({
      ...diceReceipt, revisionAfter: diceReceipt.revisionAfter + 1,
      events: [{ ...diceEvent, revision: diceReceipt.revisionAfter + 1 }],
    }).success).toBe(false);
  });

  it("rejects unknown, narration, public-fact, and speculative fields at every exposed level", () => {
    for (const field of ["publicFacts", "narrationHints", "authorizationPrincipal", "rng", "mechanics"] as const) {
      expect(commandReceiptSchema.safeParse({ ...receipt, [field]: [] }).success).toBe(false);
      expect(commandEnvelopeSchema.safeParse({ ...envelope, [field]: [] }).success).toBe(false);
      expect(actorAttributeSetEventSchema.safeParse({ ...event, [field]: [] }).success).toBe(false);
      expect(actorDiceRolledEventSchema.safeParse({ ...diceEvent, [field]: [] }).success).toBe(false);
    }
    expect(commandReceiptSchema.safeParse({ ...receipt, events: [{ ...event, data: { ...event.data, narration: "changed" } }] }).success)
      .toBe(false);
  });

  it("exports the inferred envelope type with the required nullable field", () => {
    expectTypeOf<CommandEnvelope["actorId"]>().toEqualTypeOf<string>();
    expectTypeOf<CommandEnvelope["sourceTurnId"]>().toEqualTypeOf<string | null>();
  });

  it("keeps receipts at exactly one event while accepting every reviewed variant", () => {
    expectTypeOf<CommandReceipt["events"]>().toEqualTypeOf<[RpgEvent]>();
    expect(commandReceiptSchema.safeParse({ ...resourceReceipt, events: [] }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({ ...resourceReceipt, events: [resourceEvent, event] }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({ ...diceReceipt, events: [] }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({ ...diceReceipt, events: [diceEvent, event] }).success).toBe(false);
  });
});
