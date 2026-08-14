"use strict";

/* This UMD module is the single readiness implementation used by Node and by
 * the served board. Keep it pure so both environments evaluate identical data. */
(function publish(root, factory) {
  const readiness = factory();
  if (typeof module === "object" && module.exports) module.exports = readiness;
  else root.RepoWorkshopReadiness = readiness;
})(globalThis, function createReadiness() {
  function decisionAnswered(answer, source) {
    if (answer.selectedOptionId !== null) return source.options.some((option) => option.id === answer.selectedOptionId);
    return answer.customAnswer !== null && answer.customAnswer.trim().length > 0;
  }

  function requiredDecisionIds(state, manifest) {
    const required = new Set(manifest.decisions.filter((item) => item.required).map((item) => item.id));
    state.epics.forEach((answer, index) => {
      if (answer.enabled && answer.disposition === "Build") manifest.epics[index].requiredDecisionIds.forEach((id) => required.add(id));
    });
    let changed = true;
    while (changed) {
      changed = false;
      for (const decision of manifest.decisions) {
        if (!required.has(decision.id)) continue;
        for (const dependency of decision.dependsOnDecisionIds) {
          if (!required.has(dependency)) { required.add(dependency); changed = true; }
        }
      }
    }
    return required;
  }

  function computeReady(state, manifest) {
    const failures = [];
    const byEpic = new Map(state.epics.map((item) => [item.id, item]));
    const byDecision = new Map(state.decisions.map((item) => [item.id, item]));
    if (!state.intentAcknowledged) failures.push({ code: "INTENT", targetId: "intent-acknowledgement", message: "Acknowledge the stated intent before approving scope" });
    for (const epic of state.epics) {
      if (epic.enabled && epic.disposition === "Need decision") failures.push({ code: "EPIC_DISPOSITION", targetId: epic.id, control: "disposition", message: `${epic.id}: choose a final disposition` });
      if (["Remove", "Defer"].includes(epic.disposition) && !epic.dispositionReason.trim()) failures.push({ code: "EPIC_REASON", targetId: epic.id, control: "disposition-reason", message: `${epic.id}: add a disposition reason` });
      if (epic.enabled && epic.disposition === "Build" && !epic.approvedPriority) failures.push({ code: "EPIC_PRIORITY", targetId: epic.id, control: "approved-priority", message: `${epic.id}: approve an execution priority` });
      if (epic.enabled && epic.disposition === "Build" && !epic.approvalRationale.trim()) failures.push({ code: "EPIC_APPROVAL", targetId: epic.id, control: "approval-rationale", message: `${epic.id}: record why this work is approved now` });
      if (epic.enabled && epic.disposition === "Build") {
        const source = manifest.epics.find((item) => item.id === epic.id);
        const inspect = (dependencyId, trail = []) => {
          const dependency = byEpic.get(dependencyId);
          const chain = [...trail, dependencyId];
          if (!dependency.enabled || dependency.disposition !== "Build") failures.push({ code: "BUILD_DEPENDENCY", targetId: dependencyId, relatedId: epic.id, message: `${epic.id}: required dependency ${dependencyId} must be enabled Build${chain.length > 1 ? ` (via ${chain.slice(0, -1).join(" -> ")})` : ""}` });
          else manifest.epics.find((item) => item.id === dependencyId).dependsOnEpicIds.forEach((id) => inspect(id, chain));
        };
        source.dependsOnEpicIds.forEach((id) => inspect(id));
        for (const decisionId of source.requiredDecisionIds) {
          if (!decisionAnswered(byDecision.get(decisionId), manifest.decisions.find((item) => item.id === decisionId))) failures.push({ code: "DEPENDENCY_DECISION", targetId: decisionId, relatedId: epic.id, message: `${epic.id}: required dependency decision ${decisionId} is unanswered` });
        }
      }
    }
    const required = requiredDecisionIds(state, manifest);
    for (const id of required) {
      const answer = byDecision.get(id);
      const source = manifest.decisions.find((item) => item.id === id);
      if (!decisionAnswered(answer, source) && !failures.some((item) => item.targetId === id)) failures.push({ code: "REQUIRED_DECISION", targetId: id, message: `${id}: required decision is unanswered` });
      if (decisionAnswered(answer, source) && !answer.selectionRationale.trim()) failures.push({ code: "DECISION_RATIONALE", targetId: id, control: "selection-rationale", message: `${id}: record the selection rationale` });
      if (decisionAnswered(answer, source) && !answer.acceptedRisks.trim()) failures.push({ code: "DECISION_RISK", targetId: id, control: "accepted-risks", message: `${id}: record accepted risks or 'None'` });
    }
    state.decisions.forEach((answer) => {
      if (required.has(answer.id) || answer.selectedOptionId !== null || !answer.customAnswer?.trim()) return;
      if (!answer.selectionRationale.trim()) failures.push({ code: "CUSTOM_INTERPRETATION", targetId: answer.id, control: "selection-rationale", message: `${answer.id}: record the resolved interpretation and affected epics for the custom answer` });
      if (!answer.acceptedRisks.trim()) failures.push({ code: "CUSTOM_RISK", targetId: answer.id, control: "accepted-risks", message: `${answer.id}: record accepted risks or 'None' for the custom answer` });
    });
    const selected = new Set(state.decisions.map((answer) => answer.selectedOptionId).filter(Boolean));
    manifest.decisions.forEach((source, index) => { const selectedId = state.decisions[index].selectedOptionId; const option = source.options.find((item) => item.id === selectedId); if (option?.incompatibleOptionIds.some((id) => selected.has(id))) failures.push({ code: "OPTION_CONFLICT", targetId: source.id, message: `${source.id}: selected option conflicts with another selected option` }); option?.dependsOnEpicIds.forEach((id) => { const epic = byEpic.get(id); if (!epic.enabled || epic.disposition !== "Build") failures.push({ code: "OPTION_DEPENDENCY", targetId: id, relatedId: source.id, message: `${source.id}: selected option requires ${id} to be enabled Build` }); }); });
    state.blockers.forEach((blocker, index) => {
      if (!blocker.resolved || !blocker.resolutionNote.trim()) failures.push({ code: "BLOCKER", targetId: blocker.id, message: `${blocker.id}: resolve the blocker with a note` });
      else {
        const source = manifest.blockers[index];
        if (source.resolutionPredicate === "all-decisions-answered" && source.decisionIds.some((id) => !decisionAnswered(byDecision.get(id), manifest.decisions.find((item) => item.id === id)))) failures.push({ code: "BLOCKER_CONTRADICTION", targetId: blocker.id, message: `${blocker.id}: referenced decisions remain unanswered` });
        if (source.resolutionPredicate === "epics-disabled" && source.epicIds.some((id) => byEpic.get(id).enabled)) failures.push({ code: "BLOCKER_CONTRADICTION", targetId: blocker.id, message: `${blocker.id}: referenced epics remain enabled` });
      }
    });
    return { ready: failures.length === 0, failures };
  }

  return { decisionAnswered, requiredDecisionIds, computeReady };
});
