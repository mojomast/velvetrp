import { readFileSync } from "node:fs";
const f = process.argv[2];
const g = JSON.parse(readFileSync(f, "utf8")).graded;
const want = process.argv[3] ?? "";

const pick = want ? g.filter((x) => x.reasons?.some((r) => r.startsWith(want))) : g;
for (const x of pick) {
  console.log(`\n=== ${x.id}  [${x.category}] outcome=${x.outcome} valid=${x.firstAttemptValid} correct=${x.firstAttemptCorrect}`);
  console.log(`    reasons : ${JSON.stringify(x.reasons)}`);
  console.log(`    calls   : ${x.toolCallCount}  first=${x.calledTool ?? "-"}`);
  if (x.argMismatch) {
    console.log(`    expected: ${JSON.stringify(x.argMismatch.expected)}`);
    console.log(`    actual  : ${JSON.stringify(x.argMismatch.actual)}`);
  }
  if (x.groundingViolations?.length) {
    console.log("    grounding:");
    for (const v of x.groundingViolations) console.log(`      ${v.code}: ${v.detail}`);
  }
  console.log(`    prose   : ${JSON.stringify((x.prose ?? "").slice(0, Number(process.argv[4] ?? 400)))}`);
}