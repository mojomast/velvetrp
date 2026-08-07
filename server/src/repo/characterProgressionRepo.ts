import type DatabaseDriver from "better-sqlite3";
import type { Clock, IdGenerator } from "../runtime.js";
import type { ProgressionEvent, ProgressionPreview, ProgressionReceipt, ProgressionSelection, ProgressionState } from "@velvet/contracts";
import { createCharacterProgressionReadRepository } from "./characterProgression/characterProgressionReadRepo.js";
import { createCharacterProgressionWriteRepository, type CharacterProgressionWriteRepository } from "./characterProgression/characterProgressionWriteRepo.js";

export { CharacterProgressionAuthorizationError, CharacterProgressionConflictError, CharacterProgressionStaleError, CharacterProgressionUnavailableError } from "./characterProgression/characterProgressionErrors.js";
export { initializeCharacterProgressionV24 } from "./characterProgression/characterProgressionWriteRepo.js";

/** Public progression repository composed from shared reads and write commands. */
export interface CharacterProgressionRepository extends CharacterProgressionWriteRepository {
  getCharacterProgression(actorPrincipalId:string,campaignCharacterId:string):ProgressionState|null;
  previewCharacterProgression(actorPrincipalId:string,campaignCharacterId:string,selections?:ProgressionSelection[]):ProgressionPreview|null;
  getCharacterProgressionReceipt(actorPrincipalId:string,campaignCharacterId:string,commandId:string):ProgressionReceipt|null;
  listCharacterProgressionEvents(actorPrincipalId:string,campaignCharacterId:string):ProgressionEvent[];
}

/** Creates the public facade while commands and queries share one read repository. */
export function createCharacterProgressionRepository(db:DatabaseDriver.Database,deps:{clock:Clock;ids:IdGenerator},assertFactoryMutation:()=>void):CharacterProgressionRepository {
  const reads=createCharacterProgressionReadRepository(db),writes=createCharacterProgressionWriteRepository(db,{...deps,reads,assertFactoryMutation});
  return {...writes,getCharacterProgression:reads.getCharacterProgression,previewCharacterProgression:reads.previewCharacterProgression,getCharacterProgressionReceipt:reads.getCharacterProgressionReceipt,listCharacterProgressionEvents:reads.listCharacterProgressionEvents};
}
