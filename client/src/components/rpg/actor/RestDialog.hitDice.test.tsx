// Approved test (round-2 playtest kink 2): an SRD short rest needs selected hit dice, but the client
// never sent hitDiceToSpend, so short rests always failed. The dialog must let the player choose how
// many hit dice to spend (bounded by what they have) and send exactly that; a long rest sends none.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RestDialog } from "./RestDialog";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(() => cleanup());

const resources = {
  revision: 7,
  resources: [
    { name: "health", current: 9, max: 20 },
    { name: "hit-dice-d6", current: 3, max: 3 },
  ],
} as never;

function confirmAndSubmit() {
  fireEvent.click(screen.getByRole("checkbox", { name: /Confirm this exact rest type/i }));
  fireEvent.click(screen.getByRole("button", { name: "Rest once" }));
}

describe("RestDialog hit dice", () => {
  it("sends the chosen number of hit dice with a short rest", () => {
    const onSubmit = vi.fn();
    render(<RestDialog open resources={resources} onClose={() => {}} onSubmit={onSubmit} />);
    const dice = screen.getByRole("spinbutton", { name: /hit dice to spend/i }) as HTMLInputElement;
    expect(dice.value).toBe("1");
    expect(dice.max).toBe("3");
    fireEvent.change(dice, { target: { value: "2" } });
    confirmAndSubmit();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ type: "take_short_rest", hitDiceToSpend: 2 });
  });

  it("sends no hit dice with a long rest", () => {
    const onSubmit = vi.fn();
    render(<RestDialog open resources={resources} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("radio", { name: /Long rest/i }));
    expect(screen.queryByRole("spinbutton", { name: /hit dice to spend/i })).toBeNull();
    confirmAndSubmit();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ type: "take_long_rest" });
  });
});
