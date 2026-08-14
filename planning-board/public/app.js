"use strict";

const health = [
  ["documentation-reconciliation", "Documentation reconciliation", "Reconcile roadmap and operational documentation.", "Now"],
  ["migration-support-fixtures", "Migration support and fixtures", "Define compatibility and retain deterministic fixtures.", "Now"],
  ["deterministic-e2e-repair", "Deterministic E2E repair", "Repair unreliable browser flows.", "Now"],
  ["health-gate", "Health gate", "Keep narrow repository health checks green.", "Now"]
];
const featureGroups = [
  ["Characters & Combat", [
    ["npc-presence", "NPC presence", "Persistent NPC state and story presence.", "Next"],
    ["companions", "Companions", "Party companion behavior and authority.", "Next"],
    ["combat-hardening", "Combat hardening", "Close command, lifecycle, and recovery gaps.", "Next"],
    ["multiclass", "Multiclass", "Progression across more than one class.", "Later"],
    ["boss-phases", "Boss phases", "Multi-phase enemy encounters.", "Later"],
    ["tactical-grid-los", "Tactical grid and LOS", "Position, range, and line of sight.", "Unscheduled"],
    ["simultaneous-encounters", "Simultaneous encounters", "More than one active encounter.", "Unscheduled"]
  ]],
  ["Agents, Rules & Content", [
    ["agent-candidate-protocol", "Agent candidate protocol", "Reviewable proposals before agent actions land.", "Next"],
    ["expanded-agent-mechanics", "Expanded agent mechanics", "Bounded agent game mechanics.", "Next"],
    ["declarative-rules-ir", "Declarative rules IR", "Rules independent of imperative code.", "Later"],
    ["mutable-pack-authoring", "Mutable pack authoring", "Safely author and revise packs.", "Unscheduled"],
    ["reference-ingestion", "Reference ingestion", "Trusted references in content workflows.", "Later"]
  ]],
  ["Simulation & Trust", [
    ["verifiable-dice", "Verifiable dice", "Auditable fair random rolls.", "Next"],
    ["branch-local-simulation", "Branch-local simulation", "Safe what-if simulations.", "Later"]
  ]],
  ["Platform, Integrations & Autonomy", [
    ["remote-identity-security", "Remote identity and security", "Identity, tenancy, and authorization.", "Now"],
    ["discord", "Discord", "Discord interaction surface.", "Unscheduled"],
    ["vtt", "VTT", "Virtual tabletop integration.", "Unscheduled"],
    ["proactive-automation", "Proactive automation", "System-initiated bounded automation.", "Later"],
    ["autonomous-parties", "Autonomous parties", "Parties acting within grants.", "Unscheduled"],
    ["harness-budgets-session-overrides", "Harness budgets and session overrides", "Runtime budgets and explicit overrides.", "Later"]
  ]]
];
const features = featureGroups.flatMap(([, items]) => items);
const decisions = [
  ["migration-policy", "Migration window", "Which historical schemas are supported?", "Rolling current-minus-two", ["Rolling current-minus-two", "Latest-only", "All historical"]],
  ["npc-presence", "NPC presence", "What canonical NPC presence is first?", "Session presence plus optional location", ["Session presence plus optional location", "Location-only", "Roster-only"]],
  ["companion-authority", "Companion authority", "What may companions do?", "Bounded controller grants plus confirmation", ["Bounded controller grants plus confirmation", "GM-only", "Standing full autonomy"]],
  ["combat-scope", "Combat scope", "What combat loop is first?", "Atomic legal actions settling power/items", ["Atomic legal actions settling power/items", "Separate command receipts", "Retain basic loop"]],
  ["multiclass-model", "Multiclass model", "How does multiclass progression work?", "Append-only class levels/prereqs", ["Append-only class levels/prereqs", "Primary/secondary", "Mutable respec"]],
  ["rules-ir-dsl", "Rules IR/DSL scope", "How open may rules expression be?", "Closed declarative IR", ["Closed declarative IR", "Declarative + reviewed built-ins", "Executable user code"]],
  ["pack-mutability", "Pack mutability", "How are authored packs versioned?", "Editable drafts plus immutable published versions", ["Editable drafts plus immutable published versions", "Mutable unpinned publication", "In-place published edits"]],
  ["branch-simulation", "Branch simulation", "Where does what-if play run?", "Ephemeral isolated sandbox", ["Ephemeral isolated sandbox", "Persisted simulation timeline", "Reuse campaign fork"]],
  ["boss-phases", "Boss phases", "How are boss phases represented?", "Explicit revisioned phase state", ["Explicit revisioned phase state", "Combatant replacement", "Narrative only"]],
  ["grid-los", "Grid/LOS", "What spatial model comes first?", "Zones/range bands first", ["Zones/range bands first", "Square grid/LOS", "Continuous distance"]],
  ["simultaneous-encounters", "Simultaneous encounters", "What concurrency is permitted?", "Disjoint actor sets", ["Disjoint actor sets", "Shared actors with locking", "Single encounter only"]],
  ["agent-mechanics-candidate-protocol", "Agent candidate protocol", "How do agent proposals become actions?", "Explicit reviewable candidates", ["Explicit reviewable candidates", "Policy-approved auto-commit", "Direct execution"]],
  ["harness-budgets-session-overrides", "Harness budgets", "Where are runtime limits and overrides set?", "Defaults plus explicit session overrides", ["Defaults plus explicit session overrides", "Global limits only", "Per-agent limits"]],
  ["remote-identity-tenancy", "Remote identity tenancy", "What is the remote tenancy boundary?", "Campaign-scoped tenancy", ["Campaign-scoped tenancy", "Organization tenancy", "Single tenant"]],
  ["principal-propagation", "Principal propagation", "How is caller identity carried through actions?", "Immutable authenticated principal", ["Immutable authenticated principal", "Session metadata", "Service identity only"]],
  ["verifiable-dice-fairness", "Verifiable dice fairness", "How should rolls be verified?", "Commit-reveal audit trail", ["Commit-reveal audit trail", "Server-signed rolls", "Trusted server RNG"]],
  ["reference-ingestion-licensing", "Reference ingestion", "Which references may enter content workflows?", "Explicitly licensed sources only", ["Explicitly licensed sources only", "User-attested sources", "Open web sources"]],
  ["external-tool-policy", "External tool policy", "How are external tools admitted?", "Allowlist with scoped grants", ["Allowlist with scoped grants", "Per-session approval", "Open registration"]],
  ["discord-surface", "Discord surface", "What is the first Discord interaction surface?", "Commands and bounded notifications", ["Commands and bounded notifications", "Full play surface", "Notifications only"]],
  ["vtt-mode", "VTT mode", "How should VTT integration begin?", "Adapter with explicit synchronization", ["Adapter with explicit synchronization", "Authoritative VTT", "Import/export only"]],
  ["proactive-automation", "Proactive automation", "When may the system initiate work?", "Policy grants plus visible receipts", ["Policy grants plus visible receipts", "Scheduled tasks only", "Never proactively"]],
  ["autonomous-party-authority", "Autonomous party authority", "What authority may autonomous parties hold?", "Revocable scoped grants", ["Revocable scoped grants", "Confirmation per action", "Standing broad authority"]]
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}
function detailsIndicator(card) {
  if (card.scope && card.dependencies) return "Scope and risk/dependency added";
  if (card.scope) return "Scope added";
  if (card.dependencies) return "Risk/dependency added";
  return "No details";
}
function matchesFeature(metadata, card, filters) {
  const query = filters.search.trim().toLocaleLowerCase();
  const textMatches = !query || `${metadata[1]} ${metadata[2]}`.toLocaleLowerCase().includes(query);
  const inclusionMatches = filters.inclusion === "All" || (filters.inclusion === "Included") === card.enabled;
  return textMatches && inclusionMatches && (filters.priority === "All" || filters.priority === card.priority);
}
function summarize(state) {
  const included = state.cards.filter((card) => card.enabled);
  const priorities = ["Now", "Next", "Later", "Unscheduled"].map((priority) => [priority, included.filter((card) => card.priority === priority).length]);
  const answered = state.decisions.filter((entry) => entry.answer.trim()).length;
  const needsDecision = included.filter((card) => card.choice === "Need decision").length;
  return { included: included.length, priorities, answered, needsDecision, ready: state.ready };
}
function groupedFeatureIds() { return featureGroups.map(([name, items]) => [name, items.map(([id]) => id)]); }
function buildBrief(state) {
  const allMetadata = [...health, ...features];
  const title = (id) => allMetadata.find((metadata) => metadata[0] === id)[1];
  const selected = state.cards.filter((card) => card.enabled).map((card) => `- ${title(card.id)}: ${card.choice} / ${card.priority}${card.scope ? `\n  Scope: ${card.scope}` : ""}${card.dependencies ? `\n  Dependencies/risks: ${card.dependencies}` : ""}`).join("\n") || "- No enabled epics.";
  const answers = state.decisions.map((entry) => [entry, entry.answer.trim()]).filter(([, answer]) => answer).map(([entry, answer]) => `- ${decisions.find((metadata) => metadata[0] === entry.id)[1]}: ${answer}`).join("\n") || "- No decision answers recorded.";
  const blockers = state.blockers.map((blocker) => `- [${blocker.severity}] ${blocker.owner || "Unowned"}: ${blocker.requestedDecision}${blocker.notes ? ` (${blocker.notes})` : ""}`).join("\n") || "- No blockers recorded.";
  return `Repository implementation brief\nReady: ${state.ready ? "Yes" : "No"}\n\nIncluded epics\n${selected}\n\nDecision answers\n${answers}\n\nBlockers\n${blockers}\n\nOverall notes\n${state.overallNotes || "None."}\n`;
}

if (typeof module !== "undefined") module.exports = { buildBrief, detailsIndicator, escapeHtml, featureGroups, features, groupedFeatureIds, health, matchesFeature, summarize };

if (typeof document !== "undefined") {
  let state;
  let retainedCustomDecision = null;
  const byId = (id) => document.getElementById(id);
  const item = (id) => state.cards.find((entry) => entry.id === id);
  const decision = (id) => state.decisions.find((entry) => entry.id === id);
  const option = (value, selected) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(value)}</option>`;

  function cardMarkup(metadata, kind) {
    const [id, title, description, suggested] = metadata;
    const card = item(id);
    const excluded = !card.enabled;
    return `<article class="roadmap-row ${kind}${excluded ? " excluded" : ""}" data-row-card="${id}" aria-labelledby="card-title-${id}">
      <div class="roadmap-main">
        <label class="include-label"><input type="checkbox" data-card="${id}" data-field="enabled" aria-label="Include ${escapeHtml(title)}"${card.enabled ? " checked" : ""}> Include</label>
        <div class="row-copy"><span class="row-title" id="card-title-${id}">${escapeHtml(title)}</span><span class="row-description">${escapeHtml(description)}</span></div>
        <div class="compact-field"><label for="choice-${id}">Disposition</label><select id="choice-${id}" data-card="${id}" data-field="choice" aria-label="Disposition for ${escapeHtml(title)}"${excluded ? " disabled" : ""}>${["Build", "Remove", "Defer", "Need decision"].map((value) => option(value, card.choice)).join("")}</select></div>
        <div class="compact-field priority"><label class="priority-label" for="priority-${id}"><span>Priority</span><span class="suggested">Suggested: ${suggested}</span></label><select id="priority-${id}" data-card="${id}" data-field="priority" aria-label="Priority for ${escapeHtml(title)}"${excluded ? " disabled" : ""}>${["Now", "Next", "Later", "Unscheduled"].map((value) => option(value, card.priority)).join("")}</select></div>
        <details class="item-details"${card.scope || card.dependencies ? " open" : ""}><summary aria-label="Details for ${escapeHtml(title)}">Details<span class="detail-indicator">${detailsIndicator(card)}</span></summary><div class="detail-fields"><label>Scope note<textarea data-card="${id}" data-field="scope" aria-label="Scope note for ${escapeHtml(title)}"${excluded ? " readonly" : ""}>${escapeHtml(card.scope)}</textarea></label><label>Dependencies / risks<textarea data-card="${id}" data-field="dependencies" aria-label="Dependencies and risks for ${escapeHtml(title)}"${excluded ? " readonly" : ""}>${escapeHtml(card.dependencies)}</textarea></label></div></details>
        <span class="retained">Excluded; configuration disabled; details read-only and retained</span>
      </div>
    </article>`;
  }
  function decisionMarkup(metadata) {
    const [id, title, prompt, recommended, choices] = metadata;
    const entry = decision(id);
    const custom = entry.selection === "Custom answer";
    const answered = Boolean(entry.answer.trim());
    return `<article class="decision-row" data-row-decision="${id}" aria-labelledby="decision-title-${id}">
      <div><div class="decision-title" id="decision-title-${id}">${escapeHtml(title)}</div><div class="decision-prompt">${escapeHtml(prompt)}</div><span class="answer-status${answered ? "" : " unanswered"}">${answered ? "Answered" : "Unanswered"}</span></div>
      <p class="recommendation"><strong>Recommendation:</strong> ${escapeHtml(recommended)}</p>
      <div class="decision-answer"><label for="decision-${id}">Answer</label><select id="decision-${id}" data-decision="${id}" aria-label="Answer for ${escapeHtml(title)}"><option value="">Choose an answer</option>${choices.map((value) => option(value, entry.selection)).join("")}<option value="Custom answer"${custom ? " selected" : ""}>Custom answer</option></select></div>
      <div class="custom-answer"${custom ? "" : " hidden"}><label for="custom-${id}">Custom answer</label><textarea id="custom-${id}" data-custom="${id}" aria-label="Answer for ${escapeHtml(title)}">${escapeHtml(custom ? entry.answer : "")}</textarea></div>
    </article>`;
  }
  function renderSummary() {
    const summary = summarize(state);
    const priorities = summary.priorities.map(([name, count]) => `${name} ${count}`).join(" / ");
    byId("summary").innerHTML = `<div class="summary-item"><strong>${summary.included} of 24</strong><span>items included</span></div><div class="summary-item"><strong>${priorities}</strong><span>included priorities</span></div><div class="summary-item"><strong>${summary.answered} of ${state.decisions.length}</strong><span>decisions answered</span></div><div class="summary-item"><strong>${summary.needsDecision}</strong><span>included items need decision</span></div><div class="summary-item"><strong>${summary.ready ? "Ready" : "Not ready"}</strong><span>implementation readiness</span></div>`;
  }
  function render() {
    byId("health").innerHTML = health.map((metadata) => cardMarkup(metadata, "health")).join("");
    byId("features").innerHTML = featureGroups.map(([name, items]) => `<section class="group" data-feature-group><h3 class="group-heading">${escapeHtml(name)}</h3><div class="roadmap-list">${items.map((metadata) => cardMarkup(metadata, "feature")).join("")}</div></section>`).join("");
    byId("decisions").innerHTML = decisions.map(decisionMarkup).join("");
    byId("overall").value = state.overallNotes;
    byId("ready").checked = state.ready;
    renderSummary();
    applyFeatureFilters();
    applyDecisionFilter();
    showStatus(`Saved revision ${state.revision}${state.updatedAt ? `; last update ${new Date(state.updatedAt).toLocaleString()}` : ""}`);
  }
  function showStatus(message, error = false) {
    const box = byId("status");
    box.textContent = message;
    box.className = `status${error ? " error" : ""}`;
    box.setAttribute("role", error ? "alert" : "status");
    box.setAttribute("aria-live", error ? "assertive" : "polite");
  }
  function filters() {
    return { search: byId("search").value, inclusion: byId("inclusion-filter").value, priority: byId("priority-filter").value };
  }
  function applyFeatureFilters() {
    const active = filters();
    let shown = 0;
    for (const metadata of features) {
      const row = document.querySelector(`[data-row-card="${metadata[0]}"]`);
      const visible = matchesFeature(metadata, item(metadata[0]), active);
      row.hidden = !visible;
      if (visible) shown += 1;
    }
    for (const group of document.querySelectorAll("[data-feature-group]")) group.hidden = !group.querySelector(".roadmap-row:not([hidden])");
    byId("filter-status").textContent = `${shown + health.length} of 24 items shown; ${health.length} repository health items are always shown`;
  }
  function applyDecisionFilter(reapply = false) {
    if (reapply) retainedCustomDecision = null;
    const unansweredOnly = byId("unanswered-only").checked;
    for (const metadata of decisions) {
      const row = document.querySelector(`[data-row-decision="${metadata[0]}"]`);
      row.hidden = unansweredOnly && metadata[0] !== retainedCustomDecision && Boolean(decision(metadata[0]).answer.trim());
    }
  }
  function updateCardRow(id) {
    const card = item(id);
    const row = document.querySelector(`[data-row-card="${id}"]`);
    row.classList.toggle("excluded", !card.enabled);
    row.querySelectorAll("select").forEach((control) => { control.disabled = !card.enabled; });
    row.querySelectorAll("textarea").forEach((control) => { control.readOnly = !card.enabled; });
    row.querySelector(".detail-indicator").textContent = detailsIndicator(card);
    renderSummary();
    if (row.classList.contains("feature")) applyFeatureFilters();
  }
  function updateDecisionRow(id, focusCustom = false) {
    const entry = decision(id);
    const row = document.querySelector(`[data-row-decision="${id}"]`);
    const status = row.querySelector(".answer-status");
    const answered = Boolean(entry.answer.trim());
    status.textContent = answered ? "Answered" : "Unanswered";
    status.classList.toggle("unanswered", !answered);
    const custom = row.querySelector(".custom-answer");
    custom.hidden = entry.selection !== "Custom answer";
    renderSummary();
    applyDecisionFilter();
    if (focusCustom && !custom.hidden) custom.querySelector("textarea").focus();
  }
  async function load() {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error();
    state = await response.json();
    render();
  }
  async function save() {
    showStatus("Saving...");
    const response = await fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, expectedRevision: state.revision }) });
    const body = await response.json();
    if (response.status === 409) {
      state = body.state;
      render();
      showStatus("Conflict: another save won. Reloaded saved state; reapply edits.", true);
      return;
    }
    if (!response.ok) throw new Error(body.error);
    state = body;
    renderSummary();
    showStatus(`Saved revision ${state.revision}; last update ${new Date(state.updatedAt).toLocaleString()}`);
  }
  document.addEventListener("input", (event) => {
    const data = event.target.dataset;
    if (data.card && data.field !== "enabled") { item(data.card)[data.field] = event.target.value; updateCardRow(data.card); }
    if (data.custom) { retainedCustomDecision = data.custom; decision(data.custom).answer = event.target.value; updateDecisionRow(data.custom); }
    if (event.target.id === "overall") state.overallNotes = event.target.value;
    if (event.target.id === "search") applyFeatureFilters();
  });
  document.addEventListener("change", (event) => {
    const data = event.target.dataset;
    if (data.card) { item(data.card)[data.field] = data.field === "enabled" ? event.target.checked : event.target.value; updateCardRow(data.card); }
    if (data.decision) {
      const entry = decision(data.decision);
      entry.selection = event.target.value;
      entry.answer = event.target.value && event.target.value !== "Custom answer" ? event.target.value : "";
      retainedCustomDecision = entry.selection === "Custom answer" ? data.decision : null;
      updateDecisionRow(data.decision, true);
    }
    if (event.target.id === "ready") { state.ready = event.target.checked; renderSummary(); }
    if (["inclusion-filter", "priority-filter"].includes(event.target.id)) applyFeatureFilters();
    if (event.target.id === "unanswered-only") applyDecisionFilter(true);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target.dataset.custom && retainedCustomDecision === event.target.dataset.custom) {
      retainedCustomDecision = null;
      applyDecisionFilter();
    }
  });
  byId("clear-filters").onclick = () => { byId("search").value = ""; byId("inclusion-filter").value = "All"; byId("priority-filter").value = "All"; applyFeatureFilters(); byId("search").focus(); };
  byId("save").onclick = () => save().catch(() => showStatus("Save failed. Check the board service and try again.", true));
  byId("reload").onclick = () => load().catch(() => showStatus("Reload failed. Check the board service.", true));
  byId("copy").onclick = async () => { try { await navigator.clipboard.writeText(buildBrief(state)); showStatus("Implementation brief copied."); } catch { showStatus("Clipboard unavailable; use Export brief instead.", true); } };
  byId("export").onclick = () => { const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(new Blob([buildBrief(state)], { type: "text/plain" })); anchor.download = "repository-implementation-brief.txt"; anchor.click(); URL.revokeObjectURL(anchor.href); };
  load().catch(() => showStatus("Unable to load board state. Check that the service is running.", true));
}
