import { useState } from "react";
import "./generation.css";

export const intentQuestions = [
  { key: "premise", label: "Campaign brief", prompt: "What is the central conflict, and where does it unfold?", limit: 900 },
  { key: "heroes", label: "Player fantasy", prompt: "Who are the heroes, and what should players get to do?", limit: 250 },
  { key: "stakes", label: "Stakes and opposition", prompt: "Who wants something incompatible, and what happens if nobody acts?", limit: 250 },
  { key: "opening", label: "Opening and scope", prompt: "How should play begin? Describe the intended campaign length or scale.", limit: 250 },
] as const;
export type CampaignIntent = Record<(typeof intentQuestions)[number]["key"], string>;
export const emptyCampaignIntent: CampaignIntent = { premise: "", heroes: "", stakes: "", opening: "" };
export function intentBrief(intent: CampaignIntent): string {
  return intentQuestions.flatMap(({ key, label }) => intent[key].trim() ? [`${label}: ${intent[key].trim()}`] : []).join("\n");
}

export function CampaignIntentForm({ value, onChange, disabled }: {
  value: CampaignIntent; onChange: (value: CampaignIntent) => void; disabled: boolean;
}) {
  const [mode, setMode] = useState<"questionnaire" | "interview">("questionnaire");
  const [step, setStep] = useState(0);
  return <section className="guided-generation" aria-label="Campaign direction">
    <h3>Shape your campaign</h3>
    <p>For the DM: describe the experience you want to prepare. Both paths produce the same brief and keep your answers when you switch.</p>
    <div className="guided-generation-actions" role="group" aria-label="Guidance mode">
      <button type="button" disabled={disabled} aria-pressed={mode === "questionnaire"} onClick={() => setMode("questionnaire")}>Questionnaire</button>
      <button type="button" disabled={disabled} aria-pressed={mode === "interview"} onClick={() => setMode("interview")}>Scripted guided interview</button>
    </div>
    <p className="builder-help">This is a scripted interview, not an AI adaptive interview. No AI calls occur while answering or reviewing.</p>
    {mode === "interview" && <p aria-live="polite">Question {step + 1} of {intentQuestions.length}</p>}
    {intentQuestions.map(({ key, label, prompt, limit }, index) => mode === "questionnaire" || index === step ? <label className="field" key={key}>
      <span>{label}{key === "premise" ? "" : " (optional)"}</span><small>{prompt}</small>
      <textarea rows={key === "premise" ? 4 : 2} maxLength={limit} disabled={disabled} value={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.value.slice(0, limit) })} />
      <small>{value[key].length}/{limit} characters{key === "premise" ? " - required" : " - leave blank to let generation propose details"}</small>
    </label> : null)}
    {mode === "interview" && <div className="guided-generation-actions">
      <button type="button" disabled={disabled || step === 0} onClick={() => setStep(step - 1)}>Previous question</button>
      {step < intentQuestions.length - 1 ? <button type="button" disabled={disabled} onClick={() => setStep(step + 1)}>Next question</button> : <p>Answers complete. Choose scope and boundaries below, then review the final brief.</p>}
    </div>}
  </section>;
}
