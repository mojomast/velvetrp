import { afterEach, describe, expect, it } from "vitest";
import { beginNpcPresenceMutation, clearNpcPresenceMutation, markNpcPresenceAmbiguous, markNpcPresenceReconciliation, reconcileNpcPresenceMutation, releaseNpcPresenceMutation, resetNpcPresenceMutationRegistryForTests } from "./narrativeMutationRegistry";

describe("NPC presence mutation registry", () => {
  afterEach(() => { resetNpcPresenceMutationRegistryForTests(); localStorage.clear(); });

  it("locks campaign and opaque session independently without persistence", () => {
    expect(beginNpcPresenceMutation("campaign", "room/a", "npc-a")).not.toBeNull();
    expect(beginNpcPresenceMutation("campaign", "room/a", "npc-b")).toBeNull();
    expect(beginNpcPresenceMutation("campaign", "room/b", "npc-b")).not.toBeNull();
    expect(beginNpcPresenceMutation("other", "room/a", "npc-c")).not.toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("clears receipt-backed writes at or after the resulting revision", () => {
    const lock = beginNpcPresenceMutation("campaign", "room", "npc")!; markNpcPresenceReconciliation(lock, 8);
    expect(reconcileNpcPresenceMutation("campaign", "room", 7)).toBe(false);
    expect(beginNpcPresenceMutation("campaign", "room", "other")).toBeNull();
    expect(reconcileNpcPresenceMutation("campaign", "room", 9)).toBe(true);
    expect(beginNpcPresenceMutation("campaign", "room", "other")).not.toBeNull();
  });

  it("requires an explicit authoritative refresh to release an ambiguous write", () => {
    const lock = beginNpcPresenceMutation("campaign", "room", "npc")!; markNpcPresenceAmbiguous(lock);
    expect(reconcileNpcPresenceMutation("campaign", "room", 5)).toBe(false);
    expect(reconcileNpcPresenceMutation("campaign", "room", 5, true)).toBe(true);
  });

  it("does not let an invalidated operation repopulate or release a newer lock", () => {
    const old = beginNpcPresenceMutation("campaign", "room", "old")!;
    clearNpcPresenceMutation("campaign", "room");
    const current = beginNpcPresenceMutation("campaign", "room", "current")!;
    markNpcPresenceAmbiguous(old);
    markNpcPresenceReconciliation(old, 9);
    releaseNpcPresenceMutation(old);
    expect(beginNpcPresenceMutation("campaign", "room", "third")).toBeNull();
    releaseNpcPresenceMutation(current);
    expect(beginNpcPresenceMutation("campaign", "room", "third")).not.toBeNull();
  });
});
