import { readFileSync } from "node:fs";
const dir = "data/velvet-bench/eval/dev-cases";
const load = (c) => { const j = JSON.parse(readFileSync(`${dir}/${c}.json`, "utf8")); return j.cases; };

console.log("=== cases carrying setup.committedReceipts ===");
for (const f of ["receipt-grounded-narration", "narration-envelope"]) {
  for (const c of load(f)) {
    if (!c.setup.committedReceipts) continue;
    console.log(`\n${c.id}  [${f}]  outcome=${c.expected.outcome}`);
    console.log("  receipts: " + JSON.stringify(c.setup.committedReceipts));
    console.log("  mustInclude    : " + JSON.stringify(c.expected.mustInclude));
    console.log("  mustNotInclude : " + JSON.stringify(c.expected.mustNotInclude));
    console.log("  forbiddenFacts : " + JSON.stringify(c.expected.forbiddenFacts));
  }
}

const trim = (o, n = 260) => {
  if (o === null || o === undefined) return o;
  if (typeof o === "string") return o.length > n ? o.slice(0, n) + `…[${o.length}]` : o;
  if (Array.isArray(o)) return o.map((x) => trim(x, n));
  if (typeof o === "object") { const r = {}; for (const k of Object.keys(o)) r[k] = trim(o[k], n); return r; }
  return o;
};
for (const cat of process.argv.slice(2)) {
  const c = load(cat)[0];
  console.log(`\n########## ${cat} :: ${c.id} ##########`);
  console.log(JSON.stringify(trim(c), null, 1));
}