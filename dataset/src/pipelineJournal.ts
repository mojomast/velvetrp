/** Durable request/response checkpoints under the run-store lease. No billing estimates. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableStringify } from "./spec.js";
import { sha256Hex, type TeacherClient, type TeacherCompletion, type TeacherCompletionRequest } from "./teacher.js";
import type { RunStore } from "./runstore.js";

export class UncertainDispatchError extends Error {
  constructor(attemptId: string) { super(`dispatch outcome is unknown for ${attemptId}; resume will not send it twice`); this.name = "UncertainDispatchError"; }
}

function readCheckpoint<T>(root: string, key: string): T | null {
  const path = join(root, `${sha256Hex(key)}.json`);
  if (!existsSync(path)) return null;
  const envelope = JSON.parse(readFileSync(path, "utf8")) as { key: string; digest: string; value: T };
  if (envelope.key !== key || envelope.digest !== sha256Hex(stableStringify(envelope.value))) throw new Error("pipeline checkpoint checksum/key mismatch");
  return envelope.value;
}

/** Read-only inspection for an independent artifact/certificate approval process. */
export function inspectPipelineCheckpoint<T>(store: RunStore, key: string): T | null {
  return readCheckpoint<T>(join(store.paths.runDir, "pipeline"), key);
}

export class PipelineJournal {
  private readonly root: string;
  constructor(private readonly store: RunStore, binding: unknown) {
    this.root = join(store.paths.runDir, "pipeline");
    mkdirSync(this.root, { recursive: true });
    const digest = sha256Hex(stableStringify(binding));
    const note = `pipeline-binding-v1:${digest}`;
    const previous = store.snapshot().notes.find((entry) => entry.startsWith("pipeline-binding-v1:"));
    if (previous && previous !== note) throw new Error("pipeline configuration/plan drift on resume");
    // The event log authenticates the expected file checksum on every reopen.
    if (!previous) {
      if (store.ledger().length) throw new Error("cannot resume pre-journal attempts without a bound runner plan");
      store.addNote(note);
    }
    this.save("binding", binding);
  }

  private path(key: string): string { return join(this.root, `${sha256Hex(key)}.json`); }
  read<T>(key: string): T | null {
    return readCheckpoint<T>(this.root, key);
  }

  save(key: string, value: unknown): void {
    this.store.renewLease();
    const previous = this.read<unknown>(key);
    if (previous !== null) {
      if (stableStringify(previous) !== stableStringify(value)) throw new Error("immutable pipeline checkpoint changed");
      return;
    }
    const path = this.path(key);
    const temp = `${path}.tmp`;
    writeFileSync(temp, stableStringify({ key, digest: sha256Hex(stableStringify(value)), value }) + "\n", { encoding: "utf8" });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(this.root, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }

  hasResponse(attemptId: string): boolean { return this.read(`response:${attemptId}`) !== null; }

  async complete(client: TeacherClient, request: TeacherCompletionRequest, onDispatch?: () => void): Promise<TeacherCompletion> {
    this.store.renewLease();
    const key = request.attemptId;
    const binding = { request, identity: client.identity };
    const existing = this.read<typeof binding>(`dispatch:${key}`);
    if (existing && stableStringify(existing) !== stableStringify(binding)) throw new Error("persisted dispatch request/identity drift");
    const response = this.read<TeacherCompletion>(`response:${key}`);
    if (response) {
      if (!existing) throw new Error("response checkpoint has no dispatch binding");
      return response;
    }
    if (existing) throw new UncertainDispatchError(key);
    this.save(`dispatch:${key}`, binding);
    onDispatch?.();
    const completion = await client.complete(request);
    this.save(`response:${key}`, completion);
    return completion;
  }
}
