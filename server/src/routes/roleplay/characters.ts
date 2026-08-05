import type { FastifyPluginAsync } from "fastify";
import { checkCharacter } from "../../policy.js";
import {
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  updateCharacter,
} from "../../repo.js";
import type { Character, CreateCharacterInput } from "../../types.js";

type ParsedCharacter = { ok: true; value: CreateCharacterInput } | { ok: false; error: string };

function parseCharacterInput(body: Partial<CreateCharacterInput> | null): ParsedCharacter {
  if (!body || typeof body.name !== "string" || body.name.trim() === "") {
    return { ok: false, error: "name is required" };
  }
  if (typeof body.age !== "number" || !Number.isInteger(body.age)) {
    return { ok: false, error: "age must be an integer" };
  }
  if (typeof body.archetype !== "string" || body.archetype.trim() === "") {
    return { ok: false, error: "archetype is required" };
  }
  if (typeof body.boundaries !== "string" || body.boundaries.trim() === "") {
    return { ok: false, error: "boundaries are required" };
  }
  if (typeof body.safeWord !== "string" || body.safeWord.trim() === "") {
    return { ok: false, error: "safeWord is required" };
  }
  if (body.fictionalConfirmed !== true) {
    return { ok: false, error: "fictionalConfirmed must be true" };
  }
  return {
    ok: true,
    value: {
      name: body.name,
      age: body.age,
      archetype: body.archetype,
      boundaries: body.boundaries,
      safeWord: body.safeWord,
      fictionalConfirmed: body.fictionalConfirmed,
    },
  };
}

function candidateFromInput(value: CreateCharacterInput): Character {
  return {
    id: "",
    name: value.name,
    age: value.age,
    archetype: value.archetype,
    boundaries: value.boundaries,
    safeWord: value.safeWord,
    fictionalConfirmed: value.fictionalConfirmed,
    isRealPerson: false,
    createdAt: "",
  };
}

export const roleplayCharacterRoutes: FastifyPluginAsync = async (app) => {
  app.get("/characters", async () => {
    return { characters: await listCharacters() };
  });

  app.post("/characters", async (request, reply) => {
    const parsed = parseCharacterInput(request.body as Partial<CreateCharacterInput> | null);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }
    const policy = checkCharacter(candidateFromInput(parsed.value));
    if (!policy.allowed) {
      return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    }
    const character = await createCharacter(parsed.value);
    return reply.code(201).send(character);
  });

  app.get<{ Params: { id: string } }>("/characters/:id", async (request, reply) => {
    const character = await getCharacter(request.params.id);
    return character ?? reply.code(404).send({ error: "character not found" });
  });

  app.patch<{ Params: { id: string } }>("/characters/:id", async (request, reply) => {
    const existing = await getCharacter(request.params.id);
    if (!existing) return reply.code(404).send({ error: "character not found" });
    const body = request.body as Partial<CreateCharacterInput> | null;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "character patch is required" });
    const parsed = parseCharacterInput({
      name: body.name ?? existing.name,
      age: body.age ?? existing.age,
      archetype: body.archetype ?? existing.archetype,
      boundaries: body.boundaries ?? existing.boundaries,
      safeWord: body.safeWord ?? existing.safeWord,
      fictionalConfirmed: body.fictionalConfirmed ?? existing.fictionalConfirmed,
    });
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const policy = checkCharacter(candidateFromInput(parsed.value));
    if (!policy.allowed) return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    return updateCharacter(existing.id, parsed.value);
  });

  app.delete<{ Params: { id: string } }>("/characters/:id", async (request, reply) => {
    const result = await deleteCharacter(request.params.id);
    if (result === "not-found") return reply.code(404).send({ error: "character not found" });
    if (result === "in-use") return reply.code(409).send({ error: "character is used by a session; delete the session history first" });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/characters/:id/export", async (request, reply) => {
    const character = await getCharacter(request.params.id);
    if (!character) {
      return reply.code(404).send({ error: "character not found" });
    }
    return {
      formatVersion: "velvet-character@1",
      character: {
        name: character.name,
        age: character.age,
        archetype: character.archetype,
        boundaries: character.boundaries,
        safeWord: character.safeWord,
        fictionalConfirmed: character.fictionalConfirmed,
      },
    };
  });

  app.post("/characters/import", async (request, reply) => {
    const body = request.body as (Partial<CreateCharacterInput> & { character?: Partial<CreateCharacterInput> }) | null;
    const candidateBody = body?.character ?? body;
    const parsed = parseCharacterInput(candidateBody ?? null);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }
    const policy = checkCharacter(candidateFromInput(parsed.value));
    if (!policy.allowed) {
      return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    }
    const character = await createCharacter(parsed.value);
    return reply.code(201).send(character);
  });
};
