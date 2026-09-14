import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KnownOptionsPanel, type KnownOptionView } from "./KnownOptionsPanel";

afterEach(cleanup);

const options: KnownOptionView[] = [
  { id: "feat", label: "Feat", selectionLabel: "Tough", kind: "feat" },
  { id: "subclass", label: "Subclass", selectionLabel: "Champion", kind: "subclass" },
];

describe("KnownOptionsPanel", () => {
  it("lists recorded feats and subclasses with their kinds", () => {
    render(<KnownOptionsPanel options={options} pendingChoiceCount={0} />);
    expect(screen.getByText("Tough")).toBeTruthy();
    expect(screen.getByText("Champion")).toBeTruthy();
    expect(screen.getByText("feat")).toBeTruthy();
    expect(screen.getByText("subclass")).toBeTruthy();
    expect(screen.getByText("Up to date")).toBeTruthy();
  });

  it("flags pending advancement choices and renders the empty state", () => {
    const { rerender } = render(<KnownOptionsPanel options={options} pendingChoiceCount={2} />);
    expect(screen.getByText("2 pending")).toBeTruthy();
    rerender(<KnownOptionsPanel options={[]} pendingChoiceCount={0} />);
    expect(screen.getByText("No advancement choices recorded.")).toBeTruthy();
  });

  it("omits the status pill when no pending count is supplied", () => {
    render(<KnownOptionsPanel options={options} />);
    expect(screen.queryByText("Up to date")).toBeNull();
    expect(screen.queryByText(/pending/)).toBeNull();
  });
});
