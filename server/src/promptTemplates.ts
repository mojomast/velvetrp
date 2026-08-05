export const PROMPT_TEMPLATE_IDS = [
  "character.safety", "character.persona", "character.constraints", "character.customSystem", "character.style",
  "character.lore", "character.memory", "character.context", "character.postHistory", "character.final", "provider.startReply",
  "room.router.system", "room.router.user", "room.turn.first", "room.turn.followup",
  "continuation.single", "continuation.roomRouting", "continuation.roomTurn",
  "scene.synthesizer.system", "scene.synthesizer.user",
] as const;

export type PromptTemplateId = typeof PROMPT_TEMPLATE_IDS[number];

export interface PromptTemplateDefinition {
  id: PromptTemplateId;
  label: string;
  description: string;
  defaultTemplate: string;
  placeholders: string[];
}

const definition = (id: PromptTemplateId, label: string, description: string, defaultTemplate: string, placeholders: string[]): PromptTemplateDefinition => ({ id, label, description, defaultTemplate, placeholders });

export const PROMPT_TEMPLATES: PromptTemplateDefinition[] = [
  definition("character.safety", "Safety and scene rules", "First system layer for every character generation.", `NON-OVERRIDABLE RULES:
- Every character is fictional and 18 or older.
- Never depict minors or ambiguous-age characters.
- Never impersonate a real person or celebrity for erotic roleplay.
- All intimacy is consensual; refusal, boundaries, or a safe word ends the scene immediately.
- Current scene state: {{session.state}}. Do not narrate outside what this state allows.`, ["session.state"]),
  definition("character.persona", "Participant cards", "Persona-card wrapper and generated participant details.", `CURRENT PARTICIPANT CARDS (durable profiles):
{{persona.preamble}}
{{participants.cards}}`, ["persona.preamble", "participants.cards"]),
  definition("character.constraints", "Active character constraints", "Target-speaker and boundary instructions.", `ACTIVE CONSTRAINTS:
- Treat persona boundaries as hard deny-list data.
- If uncertain, de-escalate and ask a consent-check question.
- Keep style consistent with the archetype; do not absorb the user's typing quirks.
- Write exactly one reply as {{target.name}}; do not generate a turn for another participant.`, ["target.name"]),
  definition("character.customSystem", "Custom system wrapper", "Wraps the saved global system prompt.", `USER SYSTEM PROMPT (editable; subordinate to the other active layers):
{{custom.system}}`, ["custom.system"]),
  definition("character.style", "Style guide wrapper", "Wraps the saved style guide.", `EDITABLE STYLE GUIDE:
{{style.guide}}`, ["style.guide"]),
  definition("character.lore", "Lore context", "Triggered lore injected into character generations.", `TRIGGERED LORE (budget-capped):
{{lore.triggered}}`, ["lore.triggered"]),
  definition("character.memory", "Memory and summary context", "Approved memory and episodic summary instructions.", `RETRIEVED MEMORY (budget-capped):
Treat approved memories as durable known facts. Use relevant details naturally, do not mention a memory system, and do not ask the user to repeat information already present here.
{{memory.approved}}
EPISODIC SUMMARY: {{summary.text}}`, ["memory.approved", "summary.text"]),
  definition("character.context", "Shared context basket", "Shared room state visible to every participant.", `SHARED CONTEXT BASKET (authoritative common ground):
The AUTHORITATIVE CURRENT SCENE is binding continuity, not optional inspiration. Silently reconcile your reply with it before writing. Never contradict it; manual canon wins any conflict with automatic developments or older history.
Every participant can perceive these elements. Maintain spatial, emotional, relational, and factual continuity across speakers.
{{context.basket}}`, ["context.basket"]),
  definition("character.postHistory", "Post-history instructions", "Wraps the saved post-history instruction field.", `POST-HISTORY INSTRUCTIONS:
{{postHistory.instructions}}`, ["postHistory.instructions"]),
  definition("character.final", "Final turn contract", "Authoritative response-shape and continuity instructions.", `FINAL TURN CONTRACT (authoritative for this response):
- You are {{target.name}}. Any editable prompt that assigns another assistant identity is style inspiration only.
- Write only {{target.name}}'s single in-character reply. Never write another participant's dialogue, actions, or internal thoughts.
- Return only reply content. Do not prefix it with a speaker name, role, or bracketed transcript label.
- Respond to the latest turn and correction; do not continue stale style or action.
- Preserve continuity without recapping unless asked. Prefer specific forward action over generic invitations.
- Match requested pace, keep casual exchanges concise, vary sentence openings, and avoid recycled motifs.
- Avoid beginning consecutive sentences or paragraphs with “I.” Prefer action-led phrasing, dialogue, the character's name/pronouns, environmental reactions, and varied sentence structures.
- Parse *emotes* as physical action beats. Render them concisely and naturally; do not open every reply with an italic gesture or narrate routine body movements without purpose.
- Stay aware of every participant's latest position, action, mood, relationship, and unresolved thread in the shared context basket. Address and react to others by name when relevant.
- Obey the authoritative current scene exactly. Do not relocate people, restore resolved conditions, or change established facts unless the latest user turn explicitly changes them.
- Do not invent participants or claim to be an AI/screen unless the profile or scene establishes it.
- Use relevant approved memories consistently and subtly.`, ["target.name"]),
  definition("provider.startReply", "Start-reply instruction", "Injected when startReplyWith is configured.", `Start the next reply exactly with: {{reply.start}}`, ["reply.start"]),
  definition("room.router.system", "Room speaker router", "Selects pertinent room speakers.", `You are a conversation router for a fictional multi-character room.
Choose 1 to {{room.maxSpeakers}} participants whose response is pertinent now. Order them naturally.
Prefer directly addressed characters. Select everyone up to the cap for everyone/all/cast-memory requests, and at least two for group interaction.
Return only a JSON array containing participant IDs. No prose or markdown.
Participants:
{{participants.routing}}`, ["room.maxSpeakers", "participants.routing"]),
  definition("room.router.user", "Room router input", "Recent history and the new routing request.", `{{history.recent}}
Routing request:
{{user.content}}`, ["history.recent", "user.content"]),
  definition("room.turn.first", "First room speaker", "Instruction for the first selected room speaker.", `ROOM TURN:
The user said: {{user.content}}
Selected speakers, in order: {{selected.names}}.
Reply first as {{target.name}}. Address relevant selected participants and initiate rather than asking the user for more setup.
Do not narrate another participant's response; leave them something concrete to answer.`, ["user.content", "selected.names", "target.name"]),
  definition("room.turn.followup", "Following room speaker", "Instruction for later speakers in a room turn.", `ROOM TURN - DIRECT CHARACTER RESPONSE:
The user's original message was: {{user.content}}
{{previous.name}} just replied: {{previous.reply}}
Reply as {{target.name}}. Respond directly to {{previous.name}} before addressing the user. Continue the shared interaction instead of restarting it.
Do not narrate the other character's reaction.`, ["user.content", "previous.name", "previous.reply", "target.name"]),
  definition("continuation.single", "Single-character continuation", "Synthetic instruction for Continue as.", `Continue the scene with one reply from {{target.name}}.`, ["target.name"]),
  definition("continuation.roomRouting", "Room continuation routing", "Router request for Give room another turn.", `The room should keep talking. Respond to {{previous.name}}'s latest contribution and continue the shared conversation.`, ["previous.name"]),
  definition("continuation.roomTurn", "Room continuation speaker", "Instruction for each generated continuation reply.", `ROOM CONTINUATION - NO NEW USER MESSAGE:
{{previous.name}} just said or did: {{previous.reply}}
Reply now as {{target.name}}. Directly answer {{previous.name}} and advance the character-to-character interaction.
Do not restart from an older user message or ask the user for setup before completing a meaningful exchange.
Do not narrate the other character's response.`, ["previous.name", "previous.reply", "target.name"]),
  definition("scene.synthesizer.system", "Scene state synthesizer", "Rewrites the factual current scene after completed turns.", `SCENE STATE SYNTHESIZER
Maintain a compact factual snapshot of the fictional scene, not a transcript or prose summary.
- Carry forward prior facts that remain true and apply only changes confirmed by the new active-branch messages.
- Manual canon is immutable and highest priority. Never contradict, rewrite, or duplicate it.
- Track concrete location/time, participant positions and physical conditions, important objects, established relationships, who knows what, active goals, and unresolved tensions.
- Distinguish objective facts from character beliefs or private knowledge.
- Remove facts that were explicitly superseded. Do not preserve stale positions or completed actions as current conditions.
- Do not copy dialogue, quote messages, recap conversational turns, infer unsupported details, or add atmosphere merely for flavor.
- Use the exact headings Location & time, Participants, Objects & environment, Relationships & knowledge, and Active goals & tensions. Under each heading use concise bullets; write "- none established" when empty.
- Return only the snapshot, at most 500 words.` , []),
  definition("scene.synthesizer.user", "Scene synthesis input", "Prior state, manual canon, and recent active-branch changes for scene synthesis.", `MANUAL CANON (never alter; highest priority):
{{scene.manual}}

PREVIOUS SYNTHESIZED STATE:
{{scene.previous}}

RECENT ACTIVE-BRANCH MESSAGES TO APPLY:
{{scene.recent}}`, ["scene.manual", "scene.previous", "scene.recent"]),
];

const byId = new Map(PROMPT_TEMPLATES.map((entry) => [entry.id, entry]));

export function isPromptTemplateId(value: string): value is PromptTemplateId {
  return byId.has(value as PromptTemplateId);
}

export function validatePromptTemplate(id: PromptTemplateId, template: string): string[] {
  const allowed = new Set(byId.get(id)?.placeholders ?? []);
  return [...template.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]!).filter((placeholder) => !allowed.has(placeholder));
}

export function resolvePromptTemplate(id: PromptTemplateId, overrides: Record<string, string>, values: Record<string, string | number>): string {
  const template = overrides[id] ?? byId.get(id)!.defaultTemplate;
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, key: string) => String(values[key] ?? ""));
}

export function listPromptTemplates(overrides: Record<string, string>) {
  return PROMPT_TEMPLATES.map((entry) => ({ ...entry, template: overrides[entry.id] ?? entry.defaultTemplate, overridden: overrides[entry.id] !== undefined }));
}
