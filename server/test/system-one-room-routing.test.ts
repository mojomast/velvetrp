import { afterEach, describe, expect, it } from "vitest";
import { defaultHarnessSettings, defaultProviderSettings, defaultSystemOneLaneModes, defaultSystemOneSettings } from "../src/defaults.js";
import {
  buildRoomRoutingQuestions,
  composeRoomRoutingSelection,
  ROOM_ROUTING_BEST_SPEAKER_KEY,
  ROOM_ROUTING_NONE,
  type RoomRoutingParticipant,
} from "../src/agent/systemOneRoomRouting.js";
import { selectRoomSpeakers, type RoomRoutingSystemOne } from "../src/llm.js";
import { getPromptPreset } from "../src/presets.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import type { SystemOneCaller } from "../src/provider/systemOneCompletion.js";
import type { Character, SystemOneSettings } from "../src/types.js";
import { startFakeProvider, type FakeProvider } from "./helpers.js";

const participants: Character[] = [
  { id: "c1", name: "Aria", age: 29, archetype: "confident space captain", boundaries: "", fictionalConfirmed: true, isRealPerson: false, createdAt: new Date().toISOString() },
  { id: "c2", name: "Rowan", age: 41, archetype: "wry engineer", boundaries: "", fictionalConfirmed: true, isRealPerson: false, createdAt: new Date().toISOString() },
];

const projection: RoomRoutingParticipant[] = participants.map((participant) => ({ id: participant.id, name: participant.name, archetype: participant.archetype }));

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

/** Speaker routing acts only when the lane is `active` and has a passing promotion record. */
function activeSpeakerRouting(): SystemOneSettings["laneModes"] {
  return { ...defaultSystemOneLaneModes(), "speaker-routing": "active" };
}

function systemOneLane(caller: SystemOneCaller, overrides: Partial<RoomRoutingSystemOne["settings"]> = {}): RoomRoutingSystemOne {
  return {
    settings: { ...defaultSystemOneSettings(), enabled: true, laneModes: activeSpeakerRouting(), apiKey: "test-key", ...overrides },
    caller,
    thresholds,
  };
}

async function route(systemOne?: RoomRoutingSystemOne, baseUrl = "http://127.0.0.1:1/v1") {
  return selectRoomSpeakers({
    participants,
    primaryCharacterId: "c1",
    history: [],
    userContent: "Rowan, what do you make of the signal?",
    maxSpeakers: 2,
    provider: { ...defaultProviderSettings(), baseUrl },
    harness: defaultHarnessSettings(),
    preset: getPromptPreset("default"),
    ...(systemOne ? { systemOne } : {}),
  });
}

let fake: FakeProvider | null = null;
afterEach(async () => {
  if (fake) { await fake.close(); fake = null; }
});

describe("System One room routing lane", () => {
  it("builds one atomic noul question per participant plus an aggregate best-speaker choice", () => {
    const questions = buildRoomRoutingQuestions(projection, "Rowan, your call?", "Aria: hello");
    expect(Object.keys(questions)).toEqual(["c1", "c2", ROOM_ROUTING_BEST_SPEAKER_KEY]);
    expect(questions.c1).toMatchObject({ type: "noul" });
    expect(questions.c2).toMatchObject({ type: "noul" });
    expect(questions[ROOM_ROUTING_BEST_SPEAKER_KEY]).toMatchObject({ type: "choice" });
    expect(JSON.stringify(questions.c2)).toContain("Rowan");
  });

  it("rescues an ambiguous turn with the best-speaker choice instead of deferring", () => {
    const answers = {
      c1: { type: "noul", noul: 0.2 } as const,
      c2: { type: "noul", noul: 0.3 } as const,
      [ROOM_ROUTING_BEST_SPEAKER_KEY]: { type: "choice", choice: "c1", confidence: 0.61, probabilities: { c1: 0.66, c2: 0.3, none_of_these: 0.04 } } as const,
    };
    expect(composeRoomRoutingSelection(projection, answers, thresholds, 2)).toMatchObject({ band: "act", method: "best-pick", speakerIds: ["c1"] });
  });

  it("still defers when the best-speaker choice is none or below the review threshold", () => {
    const noneAnswers = {
      c1: { type: "noul", noul: 0.2 } as const,
      [ROOM_ROUTING_BEST_SPEAKER_KEY]: { type: "choice", choice: ROOM_ROUTING_NONE, confidence: 0.5, probabilities: { c1: 0.3, c2: 0.3, none_of_these: 0.4 } } as const,
    };
    expect(composeRoomRoutingSelection(projection, noneAnswers, thresholds, 2)).toMatchObject({ band: "fallback", method: "defer", speakerIds: [] });
    const weak = {
      [ROOM_ROUTING_BEST_SPEAKER_KEY]: { type: "choice", choice: "c1", confidence: 0.4, probabilities: { c1: 0.4, c2: 0.35, none_of_these: 0.25 } } as const,
    };
    expect(composeRoomRoutingSelection(projection, weak, thresholds, 2)).toMatchObject({ band: "fallback", method: "defer", speakerIds: [] });
  });

  it("composes only action-threshold participants, highest first, capped", () => {
    const answers = {
      c1: { type: "noul", noul: 0.4 } as const,
      c2: { type: "noul", noul: 0.95 } as const,
    };
    expect(composeRoomRoutingSelection(projection, answers, thresholds, 2)).toMatchObject({ band: "act", speakerIds: ["c2"] });
    expect(composeRoomRoutingSelection(projection, answers, thresholds, 2).topSignal).toBe(0.95);
  });

  it("defers to confirm/fallback when nobody clears the action threshold", () => {
    const confirm = { c1: { type: "noul", noul: 0.6 } as const, c2: { type: "noul", noul: 0.2 } as const };
    expect(composeRoomRoutingSelection(projection, confirm, thresholds, 2)).toMatchObject({ band: "confirm", speakerIds: [] });
    const fallback = { c1: { type: "noul", noul: 0.1 } as const, c2: { type: "noul", noul: 0.2 } as const };
    expect(composeRoomRoutingSelection(projection, fallback, thresholds, 2)).toMatchObject({ band: "fallback", speakerIds: [] });
  });

  it("uses the System One selection and reports lane-specific usage when a participant acts", async () => {
    const caller = createFakeSystemOneCaller({
      scripted: { c1: { type: "noul", noul: 0.3 }, c2: { type: "noul", noul: 0.92 } },
      responseModel: "jev-1.13.0",
      usage: { input_tokens: 210, output_tokens: 6 },
    });
    const selection = await route(systemOneLane(caller));
    expect(selection.speakerIds).toEqual(["c2"]);
    expect(selection.source).toBe("model");
    expect(selection.kind).toBe("system-one");
    expect(selection.usage).toEqual({ promptTokens: 210, completionTokens: 6, totalTokens: 216, source: "provider", model: "jev-1.13.0" });
    expect(caller.calls).toHaveLength(1);
    expect(Object.keys(caller.calls[0]!.questions)).toEqual(["c1", "c2", ROOM_ROUTING_BEST_SPEAKER_KEY]);
  });

  it("falls through to the LLM path when the lane is disabled", async () => {
    fake = await startFakeProvider({ replyTexts: ['["Rowan"]'] });
    const caller = createFakeSystemOneCaller({ scripted: { c1: { type: "noul", noul: 0.9 } } });
    const selection = await route(systemOneLane(caller, { enabled: false }), fake.baseUrl);
    expect(selection.speakerIds).toEqual(["c2"]);
    expect(selection.kind).toBe("llm");
    expect(caller.calls).toHaveLength(0);
  });

  it("falls through to the LLM path on low confidence", async () => {
    fake = await startFakeProvider({ replyTexts: ['["Rowan"]'] });
    const caller = createFakeSystemOneCaller({ scripted: {
      c1: { type: "noul", noul: 0.61 },
      c2: { type: "noul", noul: 0.2 },
      [ROOM_ROUTING_BEST_SPEAKER_KEY]: { type: "choice", choice: ROOM_ROUTING_NONE, confidence: 0.34, probabilities: { c1: 0.34, c2: 0.31, none_of_these: 0.35 } },
    } });
    const selection = await route(systemOneLane(caller), fake.baseUrl);
    expect(selection.speakerIds).toEqual(["c2"]);
    expect(selection.kind).toBe("llm");
    expect(caller.calls).toHaveLength(1);
  });

  it("falls through to the LLM path when the lane fails", async () => {
    fake = await startFakeProvider({ replyTexts: ['["Rowan"]'] });
    const caller = createFakeSystemOneCaller({ failWith: new Error("boom") });
    const selection = await route(systemOneLane(caller), fake.baseUrl);
    expect(selection.speakerIds).toEqual(["c2"]);
  });

  it("attaches an auditable decision payload when it acts", async () => {
    const caller = createFakeSystemOneCaller({ scripted: { c1: { type: "noul", noul: 0.2 }, c2: { type: "noul", noul: 0.95 } }, responseModel: "jev-1.13.0" });
    const selection = await route(systemOneLane(caller));
    expect(selection.kind).toBe("system-one");
    expect(selection.systemOneDecision).toMatchObject({
      lane: "speaker-routing", provider: "typesafe", model: "jev-1.13.0", shadow: false, fallbackUsed: false,
    });
    expect(selection.systemOneDecision?.selection).toMatchObject({ method: "threshold", speakerIds: ["c2"] });
    expect(selection.systemOneDecision?.questions).toBeDefined();
  });

  it("shadow mode records the decision but leaves routing on the LLM path", async () => {
    fake = await startFakeProvider({ replyTexts: ['["Aria"]'] });
    const caller = createFakeSystemOneCaller({ scripted: { c1: { type: "noul", noul: 0.1 }, c2: { type: "noul", noul: 0.99 } } });
    const selection = await route(systemOneLane(caller, { laneModes: defaultSystemOneLaneModes() }), fake.baseUrl);
    expect(selection.speakerIds).toEqual(["c1"]);
    expect(selection.kind).toBe("llm");
    expect(selection.systemOneDecision).toMatchObject({ shadow: true, fallbackUsed: true, lane: "speaker-routing" });
    // The recorded would-be selection is still captured for comparison.
    expect(selection.systemOneDecision?.selection).toMatchObject({ method: "threshold", speakerIds: ["c2"] });
  });

  it("keeps the System One decision even when no LLM provider is usable", async () => {
    const caller = createFakeSystemOneCaller({ scripted: { c1: { type: "noul", noul: 0.1 }, c2: { type: "noul", noul: 0.99 } } });
    const selection = await route(systemOneLane(caller), "");
    expect(selection.speakerIds).toEqual(["c2"]);
    expect(selection.kind).toBe("system-one");
  });
});
