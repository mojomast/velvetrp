import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertTeacherRightsFor, loadTeacherRights, TEACHER_RIGHTS_RECEIPT_SHA256 } from "../src/teacherRights.js";

test("inspected upstream API terms permit training and bind the operator's exact teacher route", () => {
  const rights = loadTeacherRights();
  assert.equal(rights.receiptDigest, TEACHER_RIGHTS_RECEIPT_SHA256);
  assert.equal(rights.license.status, "verified-permitted");
  assert.equal(rights.artifacts.size, 3);
  assert.doesNotThrow(() => assertTeacherRightsFor(rights, rights.teacher));
  const source = readFileSync("dataset/rights/snapshots/deepseek-open-platform-terms.html", "utf8");
  assert.match(source, /training other models\s+\(such as model distillation\)/);
});

test("a different model or relay cannot inherit the inspected training-use grant", () => {
  const rights = loadTeacherRights();
  for (const teacher of [{ ...rights.teacher, model: "other" }, { ...rights.teacher, provider: "other" },
    { ...rights.teacher, baseUrlDigest: "other" }]) assert.throws(() => assertTeacherRightsFor(rights, teacher), /another model or relay/);
  assert.throws(() => assertTeacherRightsFor({ ...rights, teacher: { ...rights.teacher, model: "other" } }, rights.teacher), /another model or relay/);
  assert.throws(() => assertTeacherRightsFor({ ...rights, sourceDigests: {} }, rights.teacher), /source bindings/);
});

test("changed receipts or source bytes fail closed, even if the changed page still mentions distillation", (t) => {
  const root = mkdtempSync("/tmp/opencode/foundry-rights-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync("dataset/rights", root, { recursive: true });
  const page = join(root, "snapshots/deepseek-open-platform-terms.html");
  writeFileSync(page, "training other models (such as model distillation) but different terms");
  assert.throws(() => loadTeacherRights(root), /snapshot differs/);
  writeFileSync(join(root, "routetok-deepseek-flash.json"), "{}");
  assert.throws(() => loadTeacherRights(root), /receipt differs/);
});
