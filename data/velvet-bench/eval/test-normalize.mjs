/**
 * Unit checks for the grader's normalisation and needle logic.
 *
 * These exist because real bugs were caught before they could corrupt a 106-case run:
 *   1. normalize("```") returned "" which is a substring of EVERY haystack, so the schema
 *      cases' "no code fence" anchor would have failed all 10 cases unconditionally.
 *   2. A speaker-label strip whose character class allowed spaces and dots deleted whole
 *      sentences: "a total: 22 result" -> "22 result", "you wait. Maren: hello" -> "hello".
 *      Losing text silently would hide fabrications, so label stripping became ADDITIVE:
 *      strict haystack for negative checks, forgiving haystack only for mustInclude.
 *
 * Run: node test-normalize.mjs
 */
import { readFileSync } from "node:fs";

const src = readFileSync("data/velvet-bench/eval/grade-dev-corpus.ts", "utf8");
const strip = (s) => s.replace(/:\s*(string|boolean|number)\b/g, "");
/** Load a function declaration from the grader source as an evaluable expression.
 *  (A bare `eval` of a declaration does not leak into ESM module scope.) */
const load = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`could not extract ${name} from the grader`);
  // eslint-disable-next-line no-eval
  return eval(`(${strip(m[0]).trim()})`);
};
const normalize = load("normalize");
const stripSpeakerLabels = load("stripSpeakerLabels");
const needleHits = load("needleHits");
const included = load("included");

const FENCE = "```";
let pass = 0, fail = 0;
const t = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`}`);
};

console.log("needleHits: the empty-normalisation trap");
t("bare JSON does NOT trip the code-fence anchor", needleHits('plain {"a":1}', normalize('plain {"a":1}'), FENCE), false);
t("an actual code fence IS caught", needleHits(`${FENCE}json\n{}\n${FENCE}`, normalize(`${FENCE}json\n{}\n${FENCE}`), FENCE), true);

console.log("\nnormalize (strict haystack): never deletes content");
t('"a total: 22 result" is preserved verbatim', normalize("a total: 22 result"), "a total: 22 result");
t('"you wait. Maren: hello" is preserved', normalize("You wait. Maren: hello"), "you wait. maren: hello");
t('"total: 22" at start is preserved', normalize("total: 22 result"), "total: 22 result");
t("agency anchor \"I survives", normalize('"I will go"'), '"i will go"');
t("case folding", normalize("You Find the KEY"), "you find the key");
t("whitespace collapsed", normalize("a   b\n\nc"), "a b c");
t("markdown emphasis stripped", normalize("**bold** and _em_"), "bold and em");

console.log("\nstripSpeakerLabels (forgiving haystack, mustInclude only)");
t("[DM] label removed", stripSpeakerLabels("[DM] you arrive"), "you arrive");
t("post-sentence label removed", stripSpeakerLabels("You wait. Maren: hello"), "you wait. hello");

console.log("\nincluded: additive, so stripping can never mask a violation");
const fiction = "You watch the lock click open and the rope disappear below.";
t("fabrication still caught with labels stripped", included(fiction, normalize(fiction), stripSpeakerLabels(fiction), "lock click"), true);
t("mustInclude rescued by a leading speaker label",
  included("[DM] Ailsa refuses", normalize("[DM] Ailsa refuses"), stripSpeakerLabels("[DM] Ailsa refuses"), "ailsa refuses"), true);
t("absent needle stays absent",
  included("you arrive at the docks", normalize("you arrive at the docks"), stripSpeakerLabels("you arrive at the docks"), "you leap"), false);
t("whitespace-insensitive match", needleHits("the  Docks", normalize("the  Docks"), "the Docks"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);