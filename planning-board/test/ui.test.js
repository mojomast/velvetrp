"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CARD_IDS, defaultState } = require("../state");
const { buildBrief, detailsIndicator, escapeHtml, features, groupedFeatureIds, health, matchesFeature, summarize } = require("../public/app");

test("roadmap metadata forms stable domain groups without changing state order", () => {
  assert.deepEqual(groupedFeatureIds().map(([name]) => name), [
    "Characters & Combat",
    "Agents, Rules & Content",
    "Simulation & Trust",
    "Platform, Integrations & Autonomy"
  ]);
  const displayedIds = groupedFeatureIds().flatMap(([, ids]) => ids);
  assert.equal(new Set(displayedIds).size, 20);
  assert.deepEqual(new Set([...health, ...features].map(([id]) => id)), new Set(CARD_IDS));
  const state = defaultState();
  const originalOrder = state.cards.map(({ id }) => id);
  summarize(state);
  matchesFeature(features[0], state.cards.find(({ id }) => id === features[0][0]), { search: "npc", inclusion: "All", priority: "All" });
  assert.deepEqual(state.cards.map(({ id }) => id), originalOrder);
});

test("details indicators and escaping safely represent user content", () => {
  assert.equal(detailsIndicator({ scope: "", dependencies: "" }), "No details");
  assert.equal(detailsIndicator({ scope: "bounded", dependencies: "" }), "Scope added");
  assert.equal(detailsIndicator({ scope: "", dependencies: "risk" }), "Risk/dependency added");
  assert.equal(detailsIndicator({ scope: "bounded", dependencies: "risk" }), "Scope and risk/dependency added");
  assert.equal(escapeHtml(`<img src=x onerror="bad()"> & 'quoted'`), "&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; &#39;quoted&#39;");
});

test("feature filtering covers description, inclusion, and current priority", () => {
  const card = { enabled: true, priority: "Next" };
  const metadata = ["npc-presence", "NPC presence", "Persistent NPC state and story presence.", "Next"];
  assert.equal(matchesFeature(metadata, card, { search: "story", inclusion: "Included", priority: "Next" }), true);
  assert.equal(matchesFeature(metadata, card, { search: "agent", inclusion: "All", priority: "All" }), false);
  assert.equal(matchesFeature(metadata, card, { search: "", inclusion: "Excluded", priority: "All" }), false);
  assert.equal(matchesFeature(metadata, card, { search: "", inclusion: "All", priority: "Now" }), false);
});

test("summary uses included cards and answered decision text", () => {
  const state = defaultState();
  state.cards[0].enabled = false;
  state.cards[1].choice = "Need decision";
  state.decisions[0].selection = "Custom answer";
  state.decisions[0].answer = "Keep two versions";
  state.ready = true;
  const result = summarize(state);
  assert.equal(result.included, 23);
  assert.equal(result.priorities.find(([priority]) => priority === "Now")[1], 4);
  assert.equal(result.answered, 1);
  assert.equal(result.needsDecision, 1);
  assert.equal(result.ready, true);
});

test("brief trims answers and omits whitespace-only custom answers", () => {
  const state = defaultState();
  state.decisions[0].selection = "Custom answer";
  state.decisions[0].answer = "   \n  ";
  state.decisions[1].selection = "Custom answer";
  state.decisions[1].answer = "  Session roster first  \n";
  const result = buildBrief(state);
  assert.match(result, /^Repository implementation brief\n/);
  assert.match(result, /- NPC presence: Session roster first\n/);
  assert.doesNotMatch(result, /Migration window:/);
  assert.doesNotMatch(result, /Session roster first  /);
  assert.equal(state.decisions[0].answer, "   \n  ");
});

test("structural UI keeps details progressive and ordinary updates targeted", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(page, /<title>Repository Planning Workshop<\/title>/);
  assert.match(page, /<h1>Repository Planning Workshop<\/h1>/);
  assert.match(page, /A focused roadmap conversation for this repository\./);
  assert.match(script, /anchor\.download = "repository-implementation-brief\.txt"/);
  assert.match(script, /<article class="roadmap-row/);
  assert.match(script, /<details class="item-details"\$\{card\.scope \|\| card\.dependencies \? " open" : ""\}/);
  assert.match(script, /<span class="detail-indicator">\$\{detailsIndicator\(card\)\}/);
  assert.match(script, /Excluded; configuration disabled; details read-only and retained/);
  assert.match(script, /custom\.hidden = entry\.selection !== "Custom answer"/);
  assert.match(script, /function updateCardRow[\s\S]*?function updateDecisionRow/);
  const cardUpdater = script.match(/function updateCardRow[\s\S]*?(?=\n  function updateDecisionRow)/)[0];
  const decisionUpdater = script.match(/function updateDecisionRow[\s\S]*?(?=\n  async function load)/)[0];
  assert.doesNotMatch(cardUpdater, /\brender\(\)/);
  assert.doesNotMatch(decisionUpdater, /\brender\(\)/);
  assert.match(script, /if \(response\.status === 409\)[\s\S]*?render\(\)/);
});
