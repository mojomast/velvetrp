import type { GeneratedCampaignContentProvider } from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG } from "../../src/content/srdStarterCatalog.js";

/**
 * Provider-free reviewed content for the Hollowford Reach playtest world.
 *
 * This is the "generation result" for the seed fixture: it carries no provider
 * output and is applied through the ordinary accepted-artifact pipeline so every
 * location, faction, NPC, quest, clue, lore/rumor, encounter, story node, handout
 * and scene prompt lands in `campaign_generation_accepted_artifacts_v52` exactly
 * like a real region pack would. It is deliberately original SRD 5.1 fantasy
 * material: no external setting names, no real people.
 */

const SRD_PACK = {
  packId: SRD_5_1_STARTER_CATALOG.manifest.packId,
  packVersion: SRD_5_1_STARTER_CATALOG.manifest.packVersion,
};

/** An exact pinned SRD 5.1 enemy-template reference; never invented. */
const srdEnemy = (definitionId: string) => ({
  kind: "enemy-template" as const,
  packId: SRD_PACK.packId,
  packVersion: SRD_PACK.packVersion,
  definitionId,
});

export const PLAYTEST_WORLD_START_LOCATION_KEY = "loc-hollowford";
export const PLAYTEST_WORLD_ENCOUNTER_ANCHOR_KEY = "loc-cinder-camp";
export const PLAYTEST_WORLD_VENDOR_NPC_KEY = "npc-smith-bran";

/** Public location keys that the fixture requires to carry an accepted public location artifact. */
export const PLAYTEST_WORLD_LOCATION_KEYS = [
  "loc-hollowford",
  "loc-market-cross",
  "loc-old-mill",
  "loc-stonebridge",
  "loc-warden-tower",
  "loc-whispering-wood",
  "loc-salt-marsh",
  "loc-ruined-chapel",
  "loc-cinder-camp",
  "loc-greyvein-mine",
] as const;

/** Undirected connection pairs; the content supplies both directions for each. */
export const PLAYTEST_WORLD_CONNECTION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["loc-hollowford", "loc-market-cross"],
  ["loc-market-cross", "loc-stonebridge"],
  ["loc-stonebridge", "loc-old-mill"],
  ["loc-old-mill", "loc-warden-tower"],
  ["loc-warden-tower", "loc-whispering-wood"],
  ["loc-hollowford", "loc-salt-marsh"],
  ["loc-salt-marsh", "loc-ruined-chapel"],
  ["loc-ruined-chapel", "loc-greyvein-mine"],
  ["loc-greyvein-mine", "loc-stonebridge"],
  ["loc-whispering-wood", "loc-cinder-camp"],
];

export const PLAYTEST_WORLD_CONTENT: GeneratedCampaignContentProvider = {
  outlines: [
    {
      key: "outline-hollowford-reach",
      opening:
        "The harvest fair at Hollowford has gone quiet. Three nights ago the Greyvein miners stopped coming up the switchback, the old mill wheel began turning against the current, and watchfires were lit at the edge of the Whispering Wood. Mayor Edda Fenn asks the party to find out what walks the Reach before the first frost closes the roads.",
      premise:
        "Hold the frontier together long enough to learn who is feeding the cinder goblins and why the Reach's old warding stones are failing, then decide whether to break the camp, bargain with it, or walk away.",
      startLocationKey: "loc-hollowford",
      visibility: "public",
    },
  ],
  locations: [
    {
      key: "loc-hollowford",
      name: "Hollowford Village",
      description:
        "A compact frontier village of timber longhouses, a stone well, and a palisade that has never quite been finished. Most of the Reach's rumors pass through its one common hall.",
      visibility: "public",
      atmosphere: "Woodsmoke, wet straw, and the low sound of the Hollow river under the bridge.",
      discoveries: ["The ward-stone in the well has cracked", "The miners are four days overdue"],
      hazards: ["Cold rain", "Loose palisade scaffolding"],
      hooks: ["Mayor Edda Fenn needs a trustworthy band", "Innkeeper Tom Barley has heard the mill at night"],
      factionKeys: ["faction-hollowford-council", "faction-river-traders"],
    },
    {
      key: "loc-market-cross",
      name: "The Market Cross",
      description:
        "A crossroads of stalls and open-air forges where the Reach trades grain, iron, and news. Smiths and merchants keep shop under canvas awnings.",
      visibility: "public",
      atmosphere: "Hammer-fall, haggling, roasting nuts, and the smell of hot iron.",
      discoveries: ["Bran Ironhand is short on charcoal", "A trader saw goblin smoke over the wood"],
      hazards: ["Pickpockets", "A skittish draft horse"],
      hooks: ["Mara Voss pays for safe road reports", "Bran needs an escort for a charcoal run"],
      factionKeys: ["faction-river-traders", "faction-hollowford-council"],
    },
    {
      key: "loc-old-mill",
      name: "The Old Mill",
      description:
        "A leaning watermill abandoned after the last miller drowned. Its wheel turns upstream on windless nights, and flour dust hangs in rooms no one has entered in years.",
      visibility: "public",
      atmosphere: "Creaking timbers, black water, and sudden silences where frogsong should be.",
      discoveries: ["The wheel is bound with fresh cord", "Something nests in the grain loft"],
      hazards: ["Rotting floors", "Fast current at the tailrace"],
      hooks: ["Tom Barley will pay for the noise to stop"],
      factionKeys: [],
    },
    {
      key: "loc-stonebridge",
      name: "Stonebridge",
      description:
        "The Reach's only dry crossing in spring flood. A dwarf-cut span of grey stone carries the river road between the village and the eastern mines.",
      visibility: "public",
      atmosphere: "Spray, wheeling swifts, and cart ruts polished by generations of traffic.",
      discoveries: ["A toll chain has been cut and retied", "Bootprints head into the wood"],
      hazards: ["Slippery stone", "Deep water below"],
      hooks: ["Mara Voss needs the road kept open"],
      factionKeys: ["faction-river-traders", "faction-hollow-wardens"],
    },
    {
      key: "loc-warden-tower",
      name: "Warden's Tower",
      description:
        "A squat watchtower on the eastern ridge, half barracks and half archive, where the Hollow Wardens keep the Reach's old survey maps and signal horns.",
      visibility: "public",
      atmosphere: "Cold stone, lamp oil, parchment dust, and a wind that never quite stops.",
      discoveries: ["Three warding stones have gone dark", "The survey maps mark a buried line of stones"],
      hazards: ["Exposed stairs", "Signal fire smoke"],
      hooks: ["Kael Thorn is recruiting for a patrol", "Orin Vale is cataloguing the ward-stones"],
      factionKeys: ["faction-hollow-wardens"],
    },
    {
      key: "loc-whispering-wood",
      name: "The Whispering Wood",
      description:
        "Old pines that seem to murmur when the wind shifts. Paths braid and unbraid themselves, and the Wardens no longer patrol past the second cairn.",
      visibility: "public",
      atmosphere: "Needle fall, distant knocking, and long shadows even at noon.",
      discoveries: ["Cairn stones have been moved", "Fresh wolf scat on the trail"],
      hazards: ["Getting lost", "Wolf pack", "Unstable cairn slopes"],
      hooks: ["A patrol never returned", "Cinder-camp smoke is visible from the ridge"],
      factionKeys: ["faction-hollow-wardens"],
    },
    {
      key: "loc-salt-marsh",
      name: "The Salt Marsh",
      description:
        "A tidal apron of reeds and brackish pools where the Hollow meets the lowland floodplain. A plank walk leads to a ferryman's shack.",
      visibility: "public",
      atmosphere: "Bitter air, insects, and water moving where there is no current to move it.",
      discoveries: ["Someone dredged a channel recently", "A sunken crate is wedged in the reeds"],
      hazards: ["Sucking mud", "Night fog"],
      hooks: ["Pell Marsh has seen lanterns on the water"],
      factionKeys: ["faction-river-traders"],
    },
    {
      key: "loc-ruined-chapel",
      name: "The Ruined Chapel",
      description:
        "A roofless stone chapel to a forgotten order, its walls carved with warding knots. Sister Anabel tends a garden in what used to be the nave.",
      visibility: "public",
      atmosphere: "Bees among wallflowers, wind through empty windows, and a bell rope going nowhere.",
      discoveries: ["One carving matches the ward-stones", "The crypt door is bricked, then unbricked"],
      hazards: ["Falling masonry", "Consecrated ground uneasy to the undead"],
      hooks: ["Sister Anabel will explain the warding knots"],
      factionKeys: [],
    },
    {
      key: PLAYTEST_WORLD_ENCOUNTER_ANCHOR_KEY,
      name: "The Cinder Camp",
      description:
        "A goblin camp built inside a burned-out shepherd's steading at the wood's edge. Cookfires, stolen tools, and a crude totem of jawbones mark it as more organized than a raiding band.",
      visibility: "public",
      atmosphere: "Char, greasy smoke, snare-lines in the bracken, and voices that stop when you listen.",
      discoveries: ["The goblins carry Reach-made iron", "A hooded messenger visits the camp"],
      hazards: ["Goblin sentries", "Snares", "Fire"],
      hooks: ["The camp blocks the eastern road", "Someone is arming the goblins"],
      factionKeys: [],
    },
    {
      key: "loc-greyvein-mine",
      name: "Greyvein Mine",
      description:
        "A hillside iron mine of timber headframes and tailings. The lower galleries flood each winter; the miners are four days overdue and the winch house is barred from the inside.",
      visibility: "public",
      atmosphere: "Iron dust, dripping stone, and a bell that rings without a hand.",
      discoveries: ["A gallery has broken into an older worked seam", "The foreman's log ends mid-sentence"],
      hazards: ["Flooded shafts", "Bad air", "Collapse"],
      hooks: ["Gregor Stone will guide a rescue if the party clears the way"],
      factionKeys: ["faction-river-traders"],
    },
  ],
  connections: [
    { key: "conn-hollowford-market", fromLocationKey: "loc-hollowford", toLocationKey: "loc-market-cross", description: "A mud-and-gravel lane climbs gently from the village well to the crossing. It is a five-minute walk.", visibility: "public" },
    { key: "conn-market-hollowford", fromLocationKey: "loc-market-cross", toLocationKey: "loc-hollowford", description: "The lane drops back toward the smoke of the village hearths. It is a five-minute walk.", visibility: "public" },
    { key: "conn-market-stonebridge", fromLocationKey: "loc-market-cross", toLocationKey: "loc-stonebridge", description: "The river road runs east between hedgerows to the old span.", visibility: "public" },
    { key: "conn-stonebridge-market", fromLocationKey: "loc-stonebridge", toLocationKey: "loc-market-cross", description: "The river road returns west toward the stalls and forges.", visibility: "public" },
    { key: "conn-stonebridge-mill", fromLocationKey: "loc-stonebridge", toLocationKey: "loc-old-mill", description: "A towpath follows the millrace downstream to the rotting wheel.", visibility: "public" },
    { key: "conn-mill-stonebridge", fromLocationKey: "loc-old-mill", toLocationKey: "loc-stonebridge", description: "The towpath climbs back along the race to the stone span.", visibility: "public" },
    { key: "conn-mill-warden", fromLocationKey: "loc-old-mill", toLocationKey: "loc-warden-tower", description: "A switchback track climbs from the millpond to the ridge watchtower.", visibility: "public" },
    { key: "conn-warden-mill", fromLocationKey: "loc-warden-tower", toLocationKey: "loc-old-mill", description: "The switchback descends from the ridge to the millpond.", visibility: "public" },
    { key: "conn-warden-wood", fromLocationKey: "loc-warden-tower", toLocationKey: "loc-whispering-wood", description: "A cairn-marked trail enters the pines below the tower.", visibility: "public" },
    { key: "conn-wood-warden", fromLocationKey: "loc-whispering-wood", toLocationKey: "loc-warden-tower", description: "The cairn trail climbs back out of the pines to the watchtower.", visibility: "public" },
    { key: "conn-hollowford-marsh", fromLocationKey: "loc-hollowford", toLocationKey: "loc-salt-marsh", description: "A sunken boardwalk leads from the lower village green into the reeds.", visibility: "public" },
    { key: "conn-marsh-hollowford", fromLocationKey: "loc-salt-marsh", toLocationKey: "loc-hollowford", description: "The boardwalk returns from the reeds to the village green.", visibility: "public" },
    { key: "conn-marsh-chapel", fromLocationKey: "loc-salt-marsh", toLocationKey: "loc-ruined-chapel", description: "A dry levee path skirts the marsh pools toward the ruined chapel.", visibility: "public" },
    { key: "conn-chapel-marsh", fromLocationKey: "loc-ruined-chapel", toLocationKey: "loc-salt-marsh", description: "The levee path leads back from the chapel to the marsh.", visibility: "public" },
    { key: "conn-chapel-mine", fromLocationKey: "loc-ruined-chapel", toLocationKey: "loc-greyvein-mine", description: "An old pilgrim track climbs from the chapel to the mine's tailings.", visibility: "public" },
    { key: "conn-mine-chapel", fromLocationKey: "loc-greyvein-mine", toLocationKey: "loc-ruined-chapel", description: "The pilgrim track descends from the mine to the chapel garden.", visibility: "public" },
    { key: "conn-mine-stonebridge", fromLocationKey: "loc-greyvein-mine", toLocationKey: "loc-stonebridge", description: "A cart road follows the ore wagons down to the river crossing.", visibility: "public" },
    { key: "conn-stonebridge-mine", fromLocationKey: "loc-stonebridge", toLocationKey: "loc-greyvein-mine", description: "The cart road climbs from the bridge toward the mine headframes.", visibility: "public" },
    { key: "conn-wood-cinder", fromLocationKey: "loc-whispering-wood", toLocationKey: "loc-cinder-camp", description: "A smoke-blackened path pushes through the bracken to the burned steading.", visibility: "public" },
    { key: "conn-cinder-wood", fromLocationKey: "loc-cinder-camp", toLocationKey: "loc-whispering-wood", description: "The bracken path leads back out of the clearing toward the pines.", visibility: "public" },
  ],
  factions: [
    {
      key: "faction-hollowford-council",
      name: "Hollowford Council",
      description:
        "The elected village council, responsible for the ward-stones, the grain store, and the palisade. Cautious, underfunded, and genuinely responsible for the people of the Reach.",
      visibility: "public",
      gmNotes: "The council is split between paying off the goblins and asking the Wardens to burn the camp. Mayor Fenn fears either choice makes the Reach look weak.",
    },
    {
      key: "faction-river-traders",
      name: "River Traders' League",
      description:
        "Charcoal burners, ore carters, and barge families who keep the river road open. They profit from the mine and lose most when the road is closed.",
      visibility: "public",
      gmNotes: "Mara Voss has quietly paid the cinder goblins a toll before and will do it again if the party proves unreliable.",
    },
    {
      key: "faction-hollow-wardens",
      name: "The Hollow Wardens",
      description:
        "A small frontier militia and survey corps who maintain the warding stones and patrol the wood. They answer to the council but act on their own judgment in the field.",
      visibility: "public",
      gmNotes: "Warden Thorn believes the ward-stones are failing because something beneath the Greyvein seam is waking, not because of the goblins.",
    },
  ],
  npcs: [
    {
      key: "npc-mayor-edda",
      name: "Mayor Edda Fenn",
      archetype: "Frontier mayor",
      description: "A weathered, practical mayor who has held Hollowford together through three bad winters and is running out of patience with the goblins.",
      visibility: "public",
      locationKey: "loc-hollowford",
      factionKeys: ["faction-hollowford-council"],
      privateGoals: "Keep the Reach independent and fed. She has already quietly emptied the grain store to buy one month of quiet from the camp.",
    },
    {
      key: PLAYTEST_WORLD_VENDOR_NPC_KEY,
      name: "Bran Ironhand",
      archetype: "Village smith and vendor",
      description: "A broad, laconic smith who repairs tools, shoes horses, and sells simple field gear from a stall at the Market Cross.",
      visibility: "public",
      locationKey: "loc-market-cross",
      factionKeys: ["faction-river-traders"],
      privateGoals: "Keep his forge lit; he owes the League a favour and dislikes being reminded of it. He will trade fairly with anyone who pays in coin.",
    },
    {
      key: "npc-trader-mara",
      name: "Mara Voss",
      archetype: "River trader",
      description: "A sharp-eyed carter who knows every rut of the river road and every debt in the Reach.",
      visibility: "public",
      locationKey: "loc-market-cross",
      factionKeys: ["faction-river-traders"],
      privateGoals: "Protect her caravan and her reputation. She has paid goblin tolls and does not want that known.",
    },
    {
      key: "npc-herbalist-nia",
      name: "Nia Willow",
      archetype: "Herbalist",
      description: "A quiet herbalist who gathers from the marsh edge and treats miners and militia alike, often for no coin.",
      visibility: "public",
      locationKey: "loc-hollowford",
      factionKeys: [],
      privateGoals: "Find her missing brother among the Greyvein miners before the council writes them off.",
    },
    {
      key: "npc-innkeeper-tom",
      name: "Tom Barley",
      archetype: "Innkeeper",
      description: "The cheerful, endlessly talking keeper of the Hollowford common hall, and its best source of rumor.",
      visibility: "public",
      locationKey: "loc-hollowford",
      factionKeys: ["faction-hollowford-council"],
      privateGoals: "Keep the hall full and his cellar dry. He overheard the mayor's grain deal and has told no one.",
    },
    {
      key: "npc-warden-kael",
      name: "Kael Thorn",
      archetype: "Warden captain",
      description: "A scarred, deliberate patrol captain who would rather walk a trail twice than fight once on bad ground.",
      visibility: "public",
      locationKey: "loc-warden-tower",
      factionKeys: ["faction-hollow-wardens"],
      privateGoals: "Find the lost patrol and prove the goblins are not the real threat. He suspects a deeper seam under Greyvein.",
    },
    {
      key: "npc-scholar-orin",
      name: "Orin Vale",
      archetype: "Warden archivist",
      description: "A fussy, bookish surveyor who can date a ward-stone by its carving and complains constantly about the damp.",
      visibility: "public",
      locationKey: "loc-warden-tower",
      factionKeys: ["faction-hollow-wardens"],
      privateGoals: "Complete the Reach survey before his eyes give out. He has hidden the most valuable map from the council.",
    },
    {
      key: "npc-ferryman-pell",
      name: "Pell Marsh",
      archetype: "Marsh ferryman",
      description: "A taciturn old boatman who poles the marsh channels and says little even when he has seen a great deal.",
      visibility: "public",
      locationKey: "loc-salt-marsh",
      factionKeys: ["faction-river-traders"],
      privateGoals: "Avoid whatever is dredging the channel at night. He has seen a lantern-bearer who cast no reflection.",
    },
    {
      key: "npc-sister-anabel",
      name: "Sister Anabel",
      archetype: "Chapel keeper",
      description: "The last keeper of the ruined chapel, patient and sharp, who tends bees and old stone alike.",
      visibility: "public",
      locationKey: "loc-ruined-chapel",
      factionKeys: [],
      privateGoals: "Re-consecrate the crypt before what is buried there wakes. She knows the warding knots are a set of nine.",
    },
    {
      key: "npc-miner-gregor",
      name: "Gregor Stone",
      archetype: "Mine foreman",
      description: "A stubborn foreman who came up out of the Greyvein before the flood and has been organizing a rescue ever since.",
      visibility: "public",
      locationKey: "loc-greyvein-mine",
      factionKeys: ["faction-river-traders"],
      privateGoals: "Get his crew out alive. He saw a worked seam older than the mine and has not told the council.",
    },
  ],
  quests: [
    {
      key: "quest-break-the-camp",
      title: "Break the Cinder Camp",
      description:
        "The goblin camp at the wood's edge is blocking the eastern road and taking Reach iron. Deal with it, by fire, by bargain, or by uncovering who is arming it.",
      visibility: "public",
      locationKeys: ["loc-cinder-camp", "loc-warden-tower"],
      journalText: "Warden Thorn will accept a report on the camp's strength before the council votes.",
      objectives: [
        { key: "obj-scout-camp", description: "Observe the camp and count its sentries", targetProgress: 1, dependencyObjectiveKeys: [], visibility: "public" },
        { key: "obj-identify-supplier", description: "Identify who has been supplying Reach iron", targetProgress: 1, dependencyObjectiveKeys: ["obj-scout-camp"], visibility: "public" },
        { key: "obj-resolve-camp", description: "Resolve the camp threat", targetProgress: 1, dependencyObjectiveKeys: ["obj-scout-camp"], visibility: "public" },
      ],
      rewards: [
        { key: "rew-camp-xp", label: "Camp resolved", kind: "xp", amount: 300, visibility: "public" },
        { key: "rew-camp-coin", label: "Council bounty", kind: "currency", amount: 25, visibility: "public" },
      ],
    },
    {
      key: "quest-missing-miners",
      title: "The Missing Miners",
      description:
        "Four miners are overdue at Greyvein and the winch house is barred from the inside. Find them before the lower galleries flood.",
      visibility: "public",
      locationKeys: ["loc-greyvein-mine", "loc-hollowford"],
      journalText: "Nia Willow's brother is among the missing. She will lend supplies to anyone who goes down.",
      objectives: [
        { key: "obj-open-winch-house", description: "Gain entry to the barred winch house", targetProgress: 1, dependencyObjectiveKeys: [], visibility: "public" },
        { key: "obj-search-galleries", description: "Search the upper galleries", targetProgress: 2, dependencyObjectiveKeys: ["obj-open-winch-house"], visibility: "public" },
        { key: "obj-report-miners", description: "Report the miners' fate to the village", targetProgress: 1, dependencyObjectiveKeys: ["obj-search-galleries"], visibility: "public" },
      ],
      rewards: [
        { key: "rew-miners-xp", label: "Rescue completed", kind: "xp", amount: 250, visibility: "public" },
        { key: "rew-miners-supplies", label: "Herbalist's supplies", kind: "custom", amount: null, visibility: "public" },
      ],
    },
    {
      key: "quest-mill-restless-wheel",
      title: "The Mill's Restless Wheel",
      description:
        "The old mill wheel turns against the current and something nests in the grain loft. Quiet the mill before the village loses what is left of its nerve.",
      visibility: "public",
      locationKeys: ["loc-old-mill"],
      objectives: [
        { key: "obj-inspect-wheel", description: "Inspect the bound water wheel", targetProgress: 1, dependencyObjectiveKeys: [], visibility: "public" },
        { key: "obj-clear-loft", description: "Clear whatever nests in the grain loft", targetProgress: 1, dependencyObjectiveKeys: ["obj-inspect-wheel"], visibility: "public" },
      ],
      rewards: [{ key: "rew-mill-coin", label: "Innkeeper's purse", kind: "currency", amount: 15, visibility: "public" }],
    },
    {
      key: "quest-river-road-bandits",
      title: "Trouble on the River Road",
      description:
        "Mara Voss's ore carts have been stopped twice on the river road. Find the bandits and keep the crossing open before the League takes the road into its own hands.",
      visibility: "public",
      locationKeys: ["loc-stonebridge", "loc-salt-marsh"],
      objectives: [
        { key: "obj-find-bandits", description: "Find the bandit camp or its lookout", targetProgress: 1, dependencyObjectiveKeys: [], visibility: "public" },
        { key: "obj-clear-road", description: "Clear the river road for the ore carts", targetProgress: 1, dependencyObjectiveKeys: ["obj-find-bandits"], visibility: "public" },
      ],
      rewards: [
        { key: "rew-road-coin", label: "League escort fee", kind: "currency", amount: 20, visibility: "public" },
        { key: "rew-road-xp", label: "Road cleared", kind: "xp", amount: 150, visibility: "public" },
      ],
    },
    {
      key: "quest-chapel-relic",
      title: "The Chapel Relic",
      description:
        "Sister Anabel needs the crypt re-consecrated, but the brickwork has been opened from the inside. Recover the warding relic and close the crypt.",
      visibility: "public",
      locationKeys: ["loc-ruined-chapel"],
      objectives: [
        { key: "obj-learn-knots", description: "Learn the order of the nine warding knots", targetProgress: 1, dependencyObjectiveKeys: [], visibility: "public" },
        { key: "obj-enter-crypt", description: "Enter the chapel crypt", targetProgress: 1, dependencyObjectiveKeys: ["obj-learn-knots"], visibility: "public" },
        { key: "obj-restore-relic", description: "Restore the warding relic", targetProgress: 1, dependencyObjectiveKeys: ["obj-enter-crypt"], visibility: "public" },
      ],
      rewards: [
        { key: "rew-relic-xp", label: "Crypt sealed", kind: "xp", amount: 200, visibility: "public" },
        { key: "rew-relic-blessing", label: "Chapel blessing", kind: "custom", amount: null, visibility: "public" },
      ],
    },
  ],
  encounters: [
    {
      key: "enc-cinder-camp-goblins",
      title: "Sentries at the Cinder Camp",
      description:
        "Goblin sentries and their handlers hold the burned steading. The fight is winnable but the camp is stronger than a raiding band should be, and shouting will draw more.",
      visibility: "public",
      locationKey: PLAYTEST_WORLD_ENCOUNTER_ANCHOR_KEY,
      participantNpcKeys: [],
      objectives: ["Break the outer picket", "Prevent an alarm from reaching the main fire"],
      terrain: ["Snare-lines", "Burning timber", "Chokepoint gate"],
      escalation: ["More goblins from the main fire", "A hooded messenger slips away"],
      resolution: "A quick, quiet win keeps the camp confused; a loud one turns it into a running fight through the bracken.",
      enemyReferences: [srdEnemy("srd-5.1:enemy-template:goblin")],
      monsterConceptKeys: [],
    },
    {
      key: "enc-wood-wolves",
      title: "The Pack in the Whispering Wood",
      description:
        "A lean wolf pack shadows the cairn trail, emboldened and unafraid of the ward-stones. It hunts the same failing ground the party must cross.",
      visibility: "gm",
      locationKey: "loc-whispering-wood",
      participantNpcKeys: [],
      objectives: ["Survive the ambush", "Drive the pack off the trail"],
      terrain: ["Dense pines", "Moved cairn stones", "Falling dusk"],
      escalation: ["The pack circles toward the rear", "Something larger answers the howls"],
      resolution: "Frighten or kill the alpha and the rest scatter.",
      enemyReferences: [srdEnemy("srd-5.1:enemy-template:wolf")],
      monsterConceptKeys: [],
    },
  ],
  clues: [
    {
      key: "clue-cracked-wardstone",
      title: "The Cracked Ward-Stone",
      description: "The village well's ward-stone is split along a line that runs toward the wood, not with the grain of the rock.",
      visibility: "public",
      locationKey: "loc-hollowford",
      revealsStoryNodeKey: "story-failing-wards",
    },
    {
      key: "clue-reach-iron",
      title: "Reach-Made Iron",
      description: "Goblin arrowheads and tool-heads are stamped with Greyvein assay marks; someone is trading the Reach's own iron to the camp.",
      visibility: "public",
      locationKey: PLAYTEST_WORLD_ENCOUNTER_ANCHOR_KEY,
      revealsStoryNodeKey: "story-supplier",
    },
    {
      key: "clue-bound-wheel",
      title: "New Cord on an Old Wheel",
      description: "The mill wheel is bound with fresh, tarred cord and turned by a hidden counterweight, not by the river.",
      visibility: "public",
      locationKey: "loc-old-mill",
      revealsStoryNodeKey: "story-failing-wards",
    },
    {
      key: "clue-older-seam",
      title: "A Seam Older Than the Mine",
      description: "Below the Greyvein galleries is a worked seam cut with the same nine-knot pattern as the ward-stones.",
      visibility: "public",
      locationKey: "loc-greyvein-mine",
      revealsStoryNodeKey: "story-deep-seam",
    },
    {
      key: "clue-dredged-channel",
      title: "A Dredged Channel",
      description: "Someone has cleared a channel through the marsh reeds by night, wide enough for a flat boat and a heavy crate.",
      visibility: "public",
      locationKey: "loc-salt-marsh",
      revealsStoryNodeKey: "story-supplier",
    },
    {
      key: "clue-nine-knots",
      title: "The Order of the Nine Knots",
      description: "Sister Anabel can read the chapel carvings: nine warding knots bound in a ring, and one of the nine has been cut.",
      visibility: "public",
      locationKey: "loc-ruined-chapel",
      revealsStoryNodeKey: "story-deep-seam",
    },
  ],
  storyNodes: [
    {
      key: "story-failing-wards",
      title: "The Failing Wards",
      description: "The Reach's warding stones are cracking and the old mill turns against the current: the frontier's protections are coming apart.",
      visibility: "public",
    },
    {
      key: "story-supplier",
      title: "Someone Arming the Camp",
      description: "Reach iron and a dredged channel point to a supplier who wants the goblins strong and the road closed.",
      visibility: "public",
    },
    {
      key: "story-deep-seam",
      title: "The Deep Seam",
      description: "The Greyvein galleries broke into an older worked seam marked with the same nine-knot wards as the chapel and the stones.",
      visibility: "public",
    },
    {
      key: "story-cinder-camp",
      title: "The Cinder Camp",
      description: "The goblin camp is the visible threat, but its organization hides a purpose beyond raiding.",
      visibility: "public",
    },
    {
      key: "story-hidden-patron",
      title: "The Hidden Patron",
      description: "A hooded messenger moves between the marsh, the mine, and the camp, and is not a goblin.",
      visibility: "gm",
    },
    {
      key: "story-what-wakes",
      title: "What Wakes Below",
      description: "Breaking all nine knots would wake whatever the old order buried beneath the Greyvein seam.",
      visibility: "gm",
    },
  ],
  storyRelationships: [
    { key: "edge-wards-deep", fromStoryNodeKey: "story-failing-wards", toStoryNodeKey: "story-deep-seam", description: "The cracked stones and the bound wheel both point down into the old seam.", visibility: "public" },
    { key: "edge-supplier-camp", fromStoryNodeKey: "story-supplier", toStoryNodeKey: "story-cinder-camp", description: "The Reach iron ties the supplier to the camp's growing strength.", visibility: "public" },
    { key: "edge-deep-patron", fromStoryNodeKey: "story-deep-seam", toStoryNodeKey: "story-hidden-patron", description: "The older seam is why someone is quietly arming the camp.", visibility: "gm" },
    { key: "edge-patron-wakes", fromStoryNodeKey: "story-hidden-patron", toStoryNodeKey: "story-what-wakes", description: "The patron's real aim is to break the last knots.", visibility: "gm" },
    { key: "edge-camp-deep", fromStoryNodeKey: "story-cinder-camp", toStoryNodeKey: "story-deep-seam", description: "The camp sits on the road to the old seam.", visibility: "public" },
  ],
  lore: [
    {
      key: "rumor-cinder-smoke",
      title: "Rumor: Smoke Over the Wood",
      summary: "Around the Market Cross they say the cinder camp burns all night and that its goblins answer to a voice that is not goblin.",
      visibility: "public",
      details: ["The camp was a shepherd's steading before it burned.", "Hunters have seen a hooded figure on the marsh path."],
      locationKeys: ["loc-market-cross"],
      factionKeys: ["faction-river-traders"],
      storyNodeKeys: ["story-cinder-camp"],
    },
    {
      key: "rumor-mill-light",
      title: "Rumor: A Light in the Mill",
      summary: "Tom Barley swears a lamp moves through the old mill at night, and that the wheel turns upstream when it does.",
      visibility: "public",
      details: ["The last miller drowned in the tailrace.", "The wheel's binding cord is new, not river-worn."],
      locationKeys: ["loc-old-mill", "loc-hollowford"],
      factionKeys: [],
      storyNodeKeys: ["story-failing-wards"],
    },
    {
      key: "rumor-mine-bell",
      title: "Rumor: The Mine Bell Rings Alone",
      summary: "The Greyvein rescue bell has rung twice with no one at the winch house, and the miners' families are losing hope.",
      visibility: "public",
      details: ["The winch house is barred from the inside.", "The foreman's log ends mid-sentence."],
      locationKeys: ["loc-greyvein-mine"],
      factionKeys: ["faction-river-traders"],
      storyNodeKeys: ["story-deep-seam"],
    },
    {
      key: "rumor-river-toll",
      title: "Rumor: A Toll on the River Road",
      summary: "Carters whisper that the League has been paying the goblins to leave the ore carts alone, and that the payments are late.",
      visibility: "public",
      details: ["Mara Voss's carts have been stopped twice.", "The council will not talk about the grain store."],
      locationKeys: ["loc-stonebridge", "loc-salt-marsh"],
      factionKeys: ["faction-river-traders"],
      storyNodeKeys: ["story-supplier"],
    },
    {
      key: "rumor-chapel-knots",
      title: "Rumor: The Ninth Knot Is Cut",
      summary: "Sister Anabel will tell anyone who asks that the chapel carvings show nine warding knots, and that one has been deliberately cut.",
      visibility: "public",
      details: ["The crypt was bricked, then unbricked from within.", "The carving pattern matches the village ward-stone."],
      locationKeys: ["loc-ruined-chapel"],
      factionKeys: [],
      storyNodeKeys: ["story-failing-wards", "story-deep-seam"],
    },
  ],
  handouts: [
    {
      key: "handout-reach-map",
      title: "A Rough Map of the Reach",
      content: "A charcoal sketch on oiled cloth marks the village, the crossing, the mill, the marsh, the chapel, the mine, and the cairn trail into the wood. Someone has ringed the goblin camp and drawn a question mark beside the mine.",
      visibility: "public",
    },
    {
      key: "handout-warden-muster",
      title: "Warden Muster Notice",
      content: "A notice nailed to the tower door: able bodies are asked to report to Captain Thorn before the first frost, with or without their own steel.",
      visibility: "public",
    },
  ],
  scenePrompts: [
    {
      key: "scene-arrival-hollowford",
      title: "Arrival at the Well",
      prompt:
        "Open at the village well in thin rain. Mayor Fenn is waiting with a cracked ward-stone at her feet and a list of troubles she cannot afford to fix. Let each character notice one ordinary Reach detail before the council asks, plainly, for help.",
      visibility: "public",
      locationKey: "loc-hollowford",
      npcKeys: ["npc-mayor-edda", "npc-innkeeper-tom"],
    },
    {
      key: "scene-camp-edge",
      title: "The Edge of the Cinder Camp",
      prompt:
        "Frame the burned steading at dusk: cookfires, snare-lines, and a jawbone totem. Give the players the camp's shape and its one obvious weakness, then let them choose stealth, parley, or force.",
      visibility: "gm",
      locationKey: PLAYTEST_WORLD_ENCOUNTER_ANCHOR_KEY,
      npcKeys: [],
    },
  ],
  arcs: [],
  questItems: [],
  monsterConcepts: [],
};

/** Deep-frozen so tests and launchers cannot mutate the reviewed world in place. */
export function deepFreezePlaytestWorld<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezePlaytestWorld(child);
  }
  return value;
}
