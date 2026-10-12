/**
 * Corpus self-validation: does every dev/sealed positive reference actually pass the
 * production narration grounding predicate it claims to model?
 *
 * Read-only probe. Run: npm exec -- tsx dataset/eval/selfcheck-references.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { providerNarrationMatchesReceipts } from "../../server/src/routes/rpg/v1/adventureTurns.js";

type Case = {
  id: string;
  setup?: {
    currentLocation?: string | null;
    committedReceipts?: unknown[];
    gradingNote?: string;
  };
  expected?: { arguments?: { narration?: string } | null; outcome?: string };
};

const corpusRoot = join(process.cwd(), "dataset/eval/corpus");
let total = 0;
let withReference = 0;
const failures: Array<{ file: string; id: string; reason: string }> = [];

for (const partition of ["dev", "sealed"]) {
  const dir = join(corpusRoot, partition);
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as { cases?: Case[] };
    for (const item of doc.cases ?? []) {
      total += 1;
      const narration = item.expected?.arguments?.narration;
      if (!narration) continue;
      withReference += 1;
      const receipts = (item.setup?.committedReceipts ?? []) as never[];
      const location = item.setup?.currentLocation ?? null;
      const ok = providerNarrationMatchesReceipts(narration, receipts, location);
      if (!ok) {
        failures.push({
          file: `${partition}/${file}`,
          id: item.id,
          reason: `grounding predicate rejected the reference (location=${JSON.stringify(location)}, receipts=${receipts.length})`,
        });
      }
    }
  }
}

console.log(`cases=${total} references=${withReference} rejected=${failures.length}`);
for (const failure of failures) console.log(`  FAIL ${failure.file} :: ${failure.id} :: ${failure.reason}`);