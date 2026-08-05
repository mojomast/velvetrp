export interface PromptPreset {
  id: string;
  name: string;
  description: string;
  recentTurns: number;
  memoryChars: number;
  summaryChars: number;
  loreChars: number;
  temperature: number | null;
}

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: "default",
    name: "Balanced",
    description: "Default consistency and pacing.",
    recentTurns: 12,
    memoryChars: 900,
    summaryChars: 700,
    loreChars: 700,
    temperature: null,
  },
  {
    id: "compact",
    name: "Compact context",
    description: "Smaller context window for weaker models.",
    recentTurns: 8,
    memoryChars: 500,
    summaryChars: 400,
    loreChars: 400,
    temperature: null,
  },
  {
    id: "immersive",
    name: "Immersive",
    description: "Longer memory and lore budget for stronger models.",
    recentTurns: 16,
    memoryChars: 1400,
    summaryChars: 1000,
    loreChars: 1000,
    temperature: 0.8,
  },
];

export function getPromptPreset(id: string | null | undefined): PromptPreset {
  const fallback = PROMPT_PRESETS[0];
  if (!fallback) {
    throw new Error("PROMPT_PRESETS must not be empty");
  }
  return PROMPT_PRESETS.find((preset) => preset.id === id) ?? fallback;
}
