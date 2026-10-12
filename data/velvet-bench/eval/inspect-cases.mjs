import { readFileSync, readdirSync } from "node:fs";
const dir = "data/velvet-bench/eval/dev-cases";
const load = (cat) => {
  const j = JSON.parse(readFileSync(`${dir}/${cat}.json`, "utf8"));
  return { wrapperKeys: Object.keys(j), cases: Array.isArray(j) ? j : j.cases ?? j.items };
};

const trim = (o) => {
  if (o === null || o === undefined) return o;
  if (typeof o === "string") return o.length > 320 ? o.slice(0, 320) + `…[${o.length} chars]` : o;
  if (Array.isArray(o)) return o.map(trim);
  if (typeof o === "object") { const r = {}; for (const k of Object.keys(o)) r[k] = trim(o[k]); return r; }
  return o;
};

const first = load("tool-selection");
console.log("wrapper keys:", first.wrapperKeys.join(", "));
console.log("category case counts:");
for (const f of readdirSync(dir).sort()) {
  const { cases } = load(f.replace(".json", ""));
  console.log("  " + f.padEnd(34) + cases.length + "  first id: " + (cases[0]?.id ?? "?"));
}

for (const cat of process.argv.slice(2)) {
  const { cases } = load(cat);
  const c = cases[0];
  console.log(`\n########## ${cat} :: ${c.id} ##########`);
  console.log(JSON.stringify(trim(c), null, 1));
}