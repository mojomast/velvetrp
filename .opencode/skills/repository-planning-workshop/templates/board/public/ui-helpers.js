"use strict";

(function publish(root, factory) {
  const readiness = typeof module === "object" && module.exports ? require("./readiness.js") : root.RepoWorkshopReadiness;
  const helpers = factory(readiness);
  if (typeof module === "object" && module.exports) module.exports = helpers;
  else root.RepoWorkshopUI = helpers;
})(globalThis, function createHelpers(readiness) {
  const answered = readiness.decisionAnswered;
  const readinessFailures = (state, manifest) => readiness.computeReady(state, manifest).failures;
  function decisionVisible(answer, source, unansweredOnly) { return !unansweredOnly || !answered(answer, source); }
  function epicVisible(source, answer, filters) {
    const query = filters.query.trim().toLocaleLowerCase();
    return (!query || `${source.id} ${source.title} ${source.summary}`.toLocaleLowerCase().includes(query)) &&
      (filters.inclusion === "all" || (filters.inclusion === "included") === answer.enabled) &&
      (filters.priority === "all" || source.suggestedPriority === filters.priority);
  }
  function selectOption(answer, optionId) { return { ...answer, selectedOptionId: optionId }; }
  function selectCustom(answer) { return { ...answer, selectedOptionId: null, customAnswer: answer.customAnswer ?? "" }; }
  function typeCustom(answer, value) { return { ...answer, selectedOptionId: null, customAnswer: value }; }
  function customAnswerControl(source, manifestLimit) {
    const maxlength = String(Math.min(source.customAnswer.maxLength, manifestLimit));
    if (source.customAnswer.validation === "multiline") return { tag: "textarea", attributes: { rows: "3", maxlength } };
    const attributes = { type: "text", maxlength };
    if (source.customAnswer.validation === "single-line") attributes.pattern = "[^\\r\\n]*";
    return { tag: "input", attributes };
  }
  function safeBlock(value) {
    const visible = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
    return (visible || "(none)").split(/\r?\n/u).map((line) => `    ${line.replace(/[<>`]/gu, (character) => ({ "<": "‹", ">": "›", "`": "ˋ" })[character])}`).join("\n");
  }
  function reviewExport(manifest, state) {
    const lines = ["REVIEW ONLY - NON-AUTHORITATIVE", "Saved JSON state is the sole authority.", "", "PROJECT", safeBlock(manifest.project.displayName), "", "BASELINE", safeBlock(manifest.baselineDigest), "", "REVISION", `    ${state.revision}`, "", "INCLUDED WORK"];
    state.epics.forEach((epic, index) => { if (!epic.enabled) return; lines.push("", `  ${epic.id}`, "  Title:", safeBlock(manifest.epics[index].title), "  Disposition:", safeBlock(epic.disposition), "  Reason:", safeBlock(epic.dispositionReason), "  Notes:", safeBlock(epic.notes)); });
    lines.push("", "DECISIONS"); state.decisions.forEach((decision, index) => { const source = manifest.decisions[index]; const selected = source.options.find((option) => option.id === decision.selectedOptionId); lines.push("", `  ${decision.id}`, "  Prompt:", safeBlock(source.prompt), "  Answer:", safeBlock(selected ? selected.label : decision.customAnswer?.trim() ? decision.customAnswer : "Unanswered"), "  Notes:", safeBlock(decision.notes)); });
    lines.push("", "BLOCKERS"); state.blockers.forEach((blocker, index) => lines.push("", `  ${blocker.id}`, "  Title:", safeBlock(manifest.blockers[index].title), "  Status:", `    ${blocker.resolved ? "Resolved" : "Unresolved"}`, "  Resolution note:", safeBlock(blocker.resolutionNote)));
    lines.push("", "OVERALL NOTES", safeBlock(state.overallNotes), ""); return lines.join("\n");
  }
  return { answered, readinessFailures, decisionVisible, epicVisible, selectOption, selectCustom, typeCustom, customAnswerControl, safeBlock, reviewExport };
});
