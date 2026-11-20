import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadyCheckBanner } from "./ReadyCheckBanner";

const waiting = [
  { actorId: "orra", name: "Orra Staple" },
  { actorId: "tessel", name: "Tessel Venn" },
];

describe("ReadyCheckBanner", () => {
  afterEach(cleanup);

  it("renders nothing when ready checks are disabled, which is the default freeform mode", () => {
    const { container } = render(
      <ReadyCheckBanner enabled={false} check={null} canManage canReady={false} onEnable={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Start ready check" })).toBeNull();
  });

  it("lets an owner or GM start a ready check only after the optional setting is enabled", () => {
    const start = vi.fn();
    const enable = vi.fn();
    const { rerender } = render(
      <ReadyCheckBanner enabled={false} check={null} canManage canReady={false} onEnable={enable} onStart={start} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable ready checks" }));
    expect(enable).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    rerender(<ReadyCheckBanner enabled check={null} canManage canReady={false} onEnable={enable} onStart={start} />);
    fireEvent.click(screen.getByRole("button", { name: "Start ready check" }));
    expect(start).toHaveBeenCalledOnce();
  });

  it("names who the table is waiting on and records a player's ready mark", () => {
    const ready = vi.fn();
    render(
      <ReadyCheckBanner enabled check={{ readyActorIds: [], waiting }} canManage={false} canReady onReady={ready} />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Waiting on Orra Staple, Tessel Venn/);
    fireEvent.click(screen.getByRole("button", { name: "I'm ready" }));
    expect(ready).toHaveBeenCalledOnce();
  });

  it("announces that everyone is ready and does not block with a generic waiting line", () => {
    render(
      <ReadyCheckBanner
        enabled
        check={{ readyActorIds: ["orra", "tessel"], waiting: [] }}
        canManage
        canReady={false}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Everyone is ready/);
    expect(screen.queryByText(/Waiting on /)).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss ready check" })).toBeTruthy();
  });

  it("hides management controls from ordinary players when no check is active", () => {
    render(<ReadyCheckBanner enabled check={null} canManage={false} canReady={false} />);
    expect(screen.queryByRole("button", { name: "Enable ready checks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start ready check" })).toBeNull();
    expect(screen.queryByRole("button", { name: "I'm ready" })).toBeNull();
  });
});
