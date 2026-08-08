import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogValidationReport } from "@velvet/contracts";
import { PackValidationReport } from "./PackValidationReport";

const counts = ["race", "background", "class", "class-level", "skill", "ability", "spell", "item", "currency", "enemy-template"]
  .map((kind) => ({ kind, count: kind === "race" ? 1 : 0 })) as CatalogValidationReport["normalizedSummary"]["counts"];

describe("PackValidationReport", () => {
  it("groups normalized counts and sends the exact issue path to field navigation", () => {
    const onIssueSelect = vi.fn();
    render(<PackValidationReport report={{ valid: false, issues: [{ code: "invalid-input", path: "definitions[0].mechanics.speed", message: "Speed is required" }], normalizedSummary: { totalDefinitions: 1, counts, digest: null } }} onIssueSelect={onIssueSelect} />);
    expect(screen.getByRole("definition", { name: "Definitions by kind" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Speed is required/ }));
    expect(onIssueSelect).toHaveBeenCalledWith("definitions[0].mechanics.speed");
  });

  it("announces a valid in-memory draft without claiming publication", () => {
    render(<PackValidationReport report={{ valid: true, issues: [], normalizedSummary: { totalDefinitions: 1, counts, digest: "a".repeat(64) } }} onIssueSelect={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toMatch(/No validation issues/);
    expect(screen.getByText(/Nothing has been published/)).toBeTruthy();
  });
});
