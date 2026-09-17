import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  compareDirectorAuthority,
  renderDirectorDisagreementReport,
} from "../../server/src/agent/systemOneDisagreement.js";
import type {
  DirectorDecisionAuthority,
  SystemOneDecisionRecord,
} from "../../server/src/repo/index.js";
import { parseDisagreementArgs } from "../report-system-one-disagreements.js";

function makeRecord(decisionId: string, createdAt: string, selection: unknown): SystemOneDecisionRecord {
  return {
    decisionId,
    lane: "director-selection",
    campaignId: null,
    sessionId: null,
    turnId: `turn-${decisionId}`,
    provider: "test",
    model: "test-model",
    confidencePolicyVersion: "v1",
    requestDigest: `request-${decisionId}`,
    questionsDigest: `questions-${decisionId}`,
    stateDigest: `state-${decisionId}`,
    request: { decisionId },
    questions: [],
    state: { decisionId },
    answers: [],
    selection,
    confidenceBand: "act",
    fallbackUsed: false,
    shadow: true,
    usage: null,
    latencyMs: 1,
    createdAt,
  };
}

function makeAuthority(
  decisionId: string,
  createdAt: string,
  directorCandidateIds: string[],
  authoritativeCandidateIds: string[] | null,
  authoritativeMissing = false,
): DirectorDecisionAuthority {
  return {
    decision: makeRecord(
      decisionId,
      createdAt,
      { selections: directorCandidateIds.map((candidateId) => ({ candidateId })) },
    ),
    authoritativeCandidateIds,
    authoritativeMissing,
  };
}

test("parseDisagreementArgs applies defaults", () => {
  assert.deepEqual(parseDisagreementArgs([]), {
    limit: 50,
    includeAgreements: false,
    out: null,
  });
});

test("parseDisagreementArgs reads --limit in both forms", () => {
  assert.equal(parseDisagreementArgs(["--limit", "7"]).limit, 7);
  assert.equal(parseDisagreementArgs(["--limit=7"]).limit, 7);
});

test("parseDisagreementArgs clamps the limit like the sibling CLI", () => {
  assert.equal(parseDisagreementArgs(["--limit", "0"]).limit, 1);
  assert.equal(parseDisagreementArgs(["--limit", "-5"]).limit, 1);
  assert.equal(parseDisagreementArgs(["--limit", "9999"]).limit, 200);
  assert.equal(parseDisagreementArgs(["--limit", "2.9"]).limit, 2);
});

test("parseDisagreementArgs toggles --all", () => {
  assert.equal(parseDisagreementArgs([]).includeAgreements, false);
  assert.equal(parseDisagreementArgs(["--all"]).includeAgreements, true);
});

test("parseDisagreementArgs reads --out in both forms", () => {
  assert.equal(parseDisagreementArgs(["--out", "out.md"]).out, path.resolve("out.md"));
  assert.equal(parseDisagreementArgs(["--out=out.md"]).out, path.resolve("out.md"));
});

test("parseDisagreementArgs signals --help without exiting", () => {
  assert.equal(parseDisagreementArgs(["--help"]).help, true);
  assert.equal(parseDisagreementArgs(["-h"]).help, true);
  assert.equal(parseDisagreementArgs([]).help, undefined);
});

test("parseDisagreementArgs rejects unknown arguments", () => {
  assert.throws(() => parseDisagreementArgs(["--bogus"]), /unknown argument: --bogus/);
  assert.throws(() => parseDisagreementArgs(["--all=true"]), /unknown argument: --all=true/);
  assert.throws(() => parseDisagreementArgs(["--limit", "5", "extra"]), /unknown argument: extra/);
});

test("parseDisagreementArgs rejects invalid numbers", () => {
  assert.throws(() => parseDisagreementArgs(["--limit", "abc"]), /--limit requires a number/);
  assert.throws(() => parseDisagreementArgs(["--limit"]), /--limit requires a number/);
});

test("parseDisagreementArgs rejects missing out paths", () => {
  assert.throws(() => parseDisagreementArgs(["--out"]), /--out requires a path/);
  assert.throws(() => parseDisagreementArgs(["--out="]), /--out requires a path/);
});

test("renders a review queue that omits agreeing decisions by default", () => {
  const agreeing = makeAuthority(
    "director-agree-alpha",
    "2026-09-17T00:00:00.000Z",
    ["candidate-a"],
    ["candidate-a"],
  );
  const disagreeing = makeAuthority(
    "director-disagree-beta",
    "2026-09-17T00:01:00.000Z",
    ["candidate-x"],
    ["candidate-y"],
  );

  const compared = compareDirectorAuthority([agreeing, disagreeing]);
  assert.deepEqual(compared.map((row) => row.agreement), ["agree", "disagree"]);

  const rendered = renderDirectorDisagreementReport(compared, {
    generatedAt: "2026-09-17T00:02:00.000Z",
    source: "/tmp/velvet.sqlite",
  });
  assert.match(rendered, /director-disagree-beta/);
  assert.doesNotMatch(rendered, /director-agree-alpha/);
  assert.match(rendered, /- Agree: 1/);
  assert.match(rendered, /- Disagree: 1/);

  const everything = renderDirectorDisagreementReport(compared, { includeAgreements: true });
  assert.match(everything, /director-agree-alpha/);
  assert.match(everything, /director-disagree-beta/);
});
