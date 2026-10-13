/**
 * Build the frozen blind-prose inventory and the independent grounding-audit
 * artifact for a completed calibration run.
 *
 * Reads only the durable run store. Never dispatches a provider request.
 * Writes the inventory exactly once: regenerating it after judgments would
 * invalidate the census, so a second invocation refuses.
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/collectRunInventory.ts <runId> <seed> <units> <k> [--grounded]
 *   npx tsx dataset/scripts/collectRunInventory.ts <runId> <seed> <units> <k>        # ordinary-RP cohort
 *
 * `--grounded` selects the receipt-narration cohort (grounded-narration plus
 * tool-selection narration-submit). Without it the cohort is ordinary roleplay.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planRun } from "../src/generate.js";
import { stableStringify, type StoredMessage } from "../src/spec.js";
import { createBlindProseInventory, proseArtifactDigest, type ProseSource } from "../src/proseMeasurement.js";
import type { TeacherCompletion, TeacherCompletionRequest } from "../src/teacher.js";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const runId = process.argv[2] ?? "calibration-2026-10-13-v1";
const seed = process.argv[3] ?? runId;
const units = Number(process.argv[4] ?? 20);
const k = Number(process.argv[5] ?? 1);
// `seed` and `k` are retained only as a cross-check against the bound plan; the
// plan is never re-derived here. See the fail-closed check below.
void seed;
const groundedCohort = process.argv[6] === "--grounded";
const root = join(repositoryRoot, ".dataset", "runs", runId, "pipeline");
const output = join(repositoryRoot, ".dataset", "measurements", runId);
mkdirSync(output, { recursive: true });

function checkpoint<T>(key: string): T | null {
  const path = join(root, `${hash(key)}.json`);
  if (!existsSync(path)) return null;
  const wrapper = JSON.parse(readFileSync(path, "utf8")) as { key: string; digest: string; value: unknown };
  if (wrapper.key !== key || wrapper.digest !== hash(stableStringify(wrapper.value))) throw new Error("checkpoint integrity failed");
  return wrapper.value as T;
}

const binding = checkpoint<{ planDigest: string }>("binding");
// FAIL CLOSED. The census MUST describe the plan that actually ran. Substituting
// a freshly planned inventory when the bound artifact is missing would silently
// freeze a different set of units (for example an ordinary plan instead of a
// six-task diagnostic), so a missing or mismatched bound plan is a hard error.
if (!binding) throw new Error("run store has no plan binding; refusing to guess a census plan");
const retainedPlan = checkpoint<string>(`artifact:${binding.planDigest}`);
if (!retainedPlan) throw new Error(`bound plan artifact ${binding.planDigest} is missing; refusing to substitute a freshly planned inventory`);
if (hash(retainedPlan) !== binding.planDigest) throw new Error("retained historical plan integrity mismatch");
const plan = { ...(JSON.parse(retainedPlan) as ReturnType<typeof planRun>), digest: binding.planDigest };
// Cross-check the caller's arguments against the plan that actually ran.
if (plan.scenarioCount !== units) {
  throw new Error(`caller declared ${units} scenarios but the bound plan has ${plan.scenarioCount}`);
}
if (plan.realizationsPerScenario !== k) {
  throw new Error(`caller declared k=${k} but the bound plan has k=${plan.realizationsPerScenario}`);
}

const audit: unknown[] = [];
const sources: ProseSource[] = [];
for (const unit of plan.units) {
  for (let ordinal = 0; ordinal <= 2; ordinal += 1) {
    const id = `${unit.unitId}-a${ordinal}`;
    const dispatch = checkpoint<{ request: TeacherCompletionRequest; identity: { provider: string; model: string } }>(`dispatch:${id}`);
    if (!dispatch && ordinal > 0) continue;
    const response = checkpoint<TeacherCompletion>(`response:${id}`);
    const validation = checkpoint<unknown>(`validation:${id}`);
    const contract = checkpoint<{ attempts: string[]; usable: boolean }>(`review-contract:${id}`);
    const reviews = (contract?.attempts ?? [`${id}-review`]).map((attemptId) => ({
      attemptId,
      dispatch: checkpoint(`dispatch:${attemptId}`),
      completion: checkpoint<TeacherCompletion>(`response:${attemptId}`),
    })).filter((entry) => entry.dispatch);
    const review = reviews.at(-1)?.completion;
    audit.push({
      attemptId: id, family: unit.spec.family, split: unit.spec.split, ordinal, dispatched: !!dispatch,
      responseDigest: response ? proseArtifactDigest(response) : null,
      rawContent: response?.content ?? null, rawToolCalls: response?.toolCalls ?? null,
      validation, reviewContent: review?.content ?? null, reviewContract: contract, reviews,
    });
    const inCohort = groundedCohort
      ? unit.spec.family === "grounded-narration"
        || (unit.spec.family === "tool-selection" && unit.spec.oracle.toolFamily === "narration-submit")
      : unit.spec.family === "roleplay-conversation";
    if (!inCohort) continue;
    const prompt: StoredMessage[] = dispatch ? [
      ...(dispatch.request.system ? [{ role: "system" as const, content: dispatch.request.system }] : []),
      ...dispatch.request.messages.map((message) => ({
        role: message.role, content: message.content,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id, type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        } : {}),
      })),
    ] : [...unit.realization.context];
    const answer: StoredMessage[] | null = response ? [{
      role: "assistant", content: response.content,
      ...(response.toolCalls.length ? { tool_calls: [...response.toolCalls] } : {}),
    }] : null;
    sources.push({
      sourceId: id,
      cohort: groundedCohort ? "generated-grounded" : "generated-rp",
      generator: `${dispatch?.identity.provider ?? "agentrouter"}:${dispatch?.identity.model ?? "deepseek-v4-flash"}`,
      prompt, tools: dispatch?.request.tools ?? [], answer, styleContext: [...unit.realization.context],
      extraction: answer ? { mode: response!.toolCalls.length ? "single-tool-narration" : "assistant-content" } : null,
      ...(answer ? {} : { unavailableReason: "planned initial attempt has no captured logical response; see independently reconciled dispatch ledger" }),
    });
  }
}
if (!sources.length) throw new Error("no planned census sources found for this cohort");

const inventoryPath = join(output, "prose-inventory.json");
if (existsSync(inventoryPath)) throw new Error("inventory already frozen; do not regenerate ids/denominators after judgments");
const inventory = createBlindProseInventory(sources, [], randomBytes(32).toString("hex"));
writeFileSync(inventoryPath, stableStringify(inventory, 2) + "\n", { flag: "wx" });
writeFileSync(join(output, "independent-grounding-audit.json"), stableStringify({ runId, planDigest: plan.digest, plan, attempts: audit }, 2) + "\n", { flag: "wx" });
for (const packet of inventory.packets) {
  writeFileSync(join(output, `blind-${packet.sampleId}.json`), stableStringify({
    rubric: inventory.rubric, protocol: inventory.protocol, instructions: inventory.instructions, packet,
  }, 2) + "\n", { flag: "wx" });
}
console.log(stableStringify({
  runId, planDigest: plan.digest, inventoryDigest: inventory.inventoryDigest,
  cohort: groundedCohort ? "generated-grounded" : "generated-rp",
  plannedProseSamples: inventory.sources.length,
  captured: inventory.sources.filter((source) => source.answer).length,
  blindPackets: inventory.packets.map((packet) => join(output, `blind-${packet.sampleId}.json`)),
  inventoryPath, groundingAuditPath: join(output, "independent-grounding-audit.json"),
}, 2));