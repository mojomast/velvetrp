import { useEffect, useState } from "react";
import { listCharacters } from "../../../api";
import { createClientId } from "../../../utils/clientId";
import { CharacterBuilderPage, type CharacterBuilderApi } from "../character/CharacterBuilderPage";
import { addCampaignRoomParticipant } from "../overview/activationApi";

export interface CampaignCharacterCreatorProps {
  campaignId: string;
  sessionId: string;
  builderApi: CharacterBuilderApi;
  /** Reads the current campaign administration revision that guards the join. */
  expectedRevision: () => Promise<number>;
  onJoined?: (actorId: string) => void | Promise<void>;
  onOpenCharacter?: (campaignCharacterId: string) => void;
  onExit: () => void;
}

/**
 * Builds and finalizes a character from inside the play surface. Finalization
 * is followed by one revision-bound join so the new character is immediately a
 * participant of the current room; neither step is retried automatically.
 */
export function CampaignCharacterCreator({ campaignId, sessionId, builderApi, expectedRevision, onJoined, onOpenCharacter, onExit }: CampaignCharacterCreatorProps) {
  const [personas, setPersonas] = useState<Array<{ id: string; name: string }> | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void listCharacters().then(({ characters }) => { if (active) setPersonas(characters.map(character => ({ id: character.id, name: character.name }))); })
      .catch(() => { if (active) { setPersonas([]); setError("Personas could not be loaded. Close and reopen this tool."); } });
    return () => { active = false; };
  }, []);

  const api: CharacterBuilderApi = {
    ...builderApi,
    finalize: async (id, draftId, input) => {
      const result = await builderApi.finalize(id, draftId, input);
      try {
        const revision = await expectedRevision();
        const joined = await addCampaignRoomParticipant(campaignId, sessionId, {
          campaignCharacterId: result.character.id, expectedRevision: revision, idempotencyKey: `join-ui-${createClientId()}`,
        });
        setError(""); setNotice(`Joined this room in position ${joined.position + 1}.`);
        await onJoined?.(joined.actorId);
      } catch {
        setNotice("");
        setError("The character was finalized, but the room join was not confirmed. Open the campaign roster and add the character again; the finalized sheet is preserved.");
      }
      return result;
    },
  };

  if (!personas) return <div className="campaign-character-creator">{error ? <p role="alert">{error}</p> : <p role="status">Loading personas…</p>}</div>;
  return <div className="campaign-character-creator">
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <CharacterBuilderPage campaignId={campaignId} personas={personas} api={api} embedded
      onBack={onExit} onUnavailable={onExit} onReviewCampaignRoster={onExit}
      onEditPersona={() => setError("Persona editing stays in the campaign workspace; this draft keeps the selected persona.")}
      onOpenCharacter={(campaignCharacterId) => onOpenCharacter?.(campaignCharacterId)} />
  </div>;
}
