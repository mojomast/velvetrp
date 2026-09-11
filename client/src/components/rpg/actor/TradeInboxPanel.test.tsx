import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TradeInboxPanel } from "./TradeInboxPanel";

afterEach(cleanup);

describe("TradeInboxPanel", () => {
  it("requires an exact trade ID before accepting or cancelling", () => {
    const onAccept = vi.fn(), onCancel = vi.fn();
    render(<TradeInboxPanel onAccept={onAccept} onCancel={onCancel} />);
    expect((screen.getByRole("button", { name: "Accept trade" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Trade ID"), { target: { value: "trade-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept trade" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel trade" }));
    expect(onAccept).toHaveBeenCalledWith("trade-9");
    expect(onCancel).toHaveBeenCalledWith("trade-9");
  });
});
