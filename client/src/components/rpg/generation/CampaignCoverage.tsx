import type { CampaignContentDraftView, CampaignContentGenerationRequest } from "@velvet/contracts";
import "./generation.css";

type Section = CampaignContentGenerationRequest["sections"][number];
const fields: Record<Section, Array<keyof Omit<CampaignContentDraftView["preview"], "npcStats">>> = {
  outline: ["outlines"], arcs: ["arcs"], locations: ["locations", "connections"], factions: ["factions"], npcs: ["npcs"], quests: ["quests"], encounters: ["encounters"], clues: ["clues"], story: ["storyNodes", "storyRelationships"], lore: ["lore"], "quest-items": ["questItems"], "monster-concepts": ["monsterConcepts"], handouts: ["handouts"], "scene-prompts": ["scenePrompts"],
};
export function CampaignCoverage({ preview, requested, options }: {
  preview: CampaignContentDraftView["preview"]; requested: Section[] | null; options: ReadonlyArray<readonly [Section, string]>;
}) {
  return <section className="campaign-coverage" aria-label="Requested versus returned coverage"><h4>Requested vs returned</h4>
    <p>{requested ? `${requested.length} sections requested. Counts show returned artifacts, not completeness or playable readiness.` : "Original requested sections are unavailable for this reopened draft. Returned artifacts are shown without inferring the request."}</p>
    <ul>{options.map(([section, label]) => {
      const count = fields[section].reduce((sum, field) => sum + preview[field].length, 0);
      return <li key={section}>{label}: {requested ? requested.includes(section) ? "Requested" : "Not requested" : "Request unknown"}; {count ? `${count} returned` : "none returned"}</li>;
    })}</ul>
    <h4>Playable readiness signals</h4>
    <ul>
      <li>{preview.quests.filter((item) => item.objectives.length > 0).length} of {preview.quests.length} quests have operational objectives.</li>
      <li>{preview.encounters.filter((item) => item.enemyReferences.length > 0).length} of {preview.encounters.length} encounter plans have exact pinned enemy references. None are started by generation.</li>
      <li>{[...preview.questItems, ...preview.monsterConcepts].filter((item) => item.mechanics.state !== "catalog-bound").length} inert item or monster concepts have no playable mechanics.</li>
    </ul>
    <p>Narrative coverage is not a playable campaign checklist. Review connections and objectives, validate exact rules bindings, prepare maps and player characters, and deliver only the material players should see. Missing sections can be requested as a separate reviewed generation.</p>
  </section>;
}
