import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RulesetAdministrationPanel, type RulesetAdministrationApi, type RulesetIdentity } from "./RulesetAdministrationPanel";

const current: RulesetIdentity = { rulesetId: "starter", name: "Starter Rules", version: "1.0.0", digest: "digest-one", migration: "none", capabilities: [{ capabilityId: "combat", label: "Combat", supported: true }, { capabilityId: "magic", label: "Magic", supported: false, detail: "Narrative only" }] };
const target: RulesetIdentity = { rulesetId: "advanced", name: "Advanced Rules", version: "2.0.0", digest: "digest-two", migration: "destructive", migrationSummary: "Existing derived statistics must be rebuilt.", capabilities: [{ capabilityId: "combat", label: "Combat", supported: true }, { capabilityId: "magic", label: "Magic", supported: true }] };
const api = (): RulesetAdministrationApi => ({ selectRuleset: vi.fn(), reconcileSelection: vi.fn() });

afterEach(cleanup);

describe("RulesetAdministrationPanel", () => {
  it("shows exact identity and capabilities while structurally restricting selection to owners", () => {
    render(<RulesetAdministrationPanel actorRole="player" current={current} available={[target]} expectedRevision={7} api={api()} />);
    expect(screen.getByText(/starter @ 1.0.0/)).toBeTruthy();
    expect(screen.getByText(/Combat:/).closest("li")?.textContent).toMatch(/Supported/);
    expect(screen.getByText(/Magic:/).closest("li")?.textContent).toMatch(/Not supported.*Narrative only/);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("requires both exact-selection and migration-warning acknowledgement", () => {
    const callbacks = api();
    render(<RulesetAdministrationPanel actorRole="owner" current={current} available={[target]} expectedRevision={7} api={callbacks} />);
    fireEvent.click(screen.getByRole("radio", { name: /Advanced Rules/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review ruleset change" }));
    const submit = screen.getByRole("button", { name: "Select ruleset once" }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm the exact target identity/ }));
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed the migration warning/ }));
    fireEvent.click(submit);
    expect(callbacks.selectRuleset).toHaveBeenCalledWith({ rulesetId: "advanced", version: "2.0.0", digest: "digest-two", expectedRevision: 7 });
  });

  it("locks selection and delegates uncertain reconciliation", () => {
    const callbacks = api();
    render(<RulesetAdministrationPanel actorRole="owner" current={current} available={[target]} expectedRevision={7} mutation={{ phase: "uncertain", message: "Receipt missing." }} api={callbacks} />);
    expect(screen.getByRole("radio", { name: /Advanced Rules/ }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile authoritative ruleset" }));
    expect(callbacks.reconcileSelection).toHaveBeenCalledOnce();
  });
});
