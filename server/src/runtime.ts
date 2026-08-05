import { randomInt, randomUUID } from "node:crypto";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(): string;
}

export interface RandomNumberGenerator {
  integer(minInclusive: number, maxExclusive: number): number;
}

export interface RuntimeDependencies {
  clock: Clock;
  ids: IdGenerator;
  rng: RandomNumberGenerator;
}

export const systemRuntime: RuntimeDependencies = {
  clock: { now: () => new Date() },
  ids: { nextId: () => randomUUID() },
  rng: {
    integer: (minInclusive, maxExclusive) => randomInt(minInclusive, maxExclusive),
  },
};
