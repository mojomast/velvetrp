import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationRecoveryPanel, type GenerationRecoveryApi } from "./GenerationRecoveryPanel";

const api = (): GenerationRecoveryApi => ({ openDraft: vi.fn(), reconcileJob: vi.fn(), retryFailedJob: vi.fn() });
const failed = { jobId: "job-failed", state: "failed" as const, attempt: 2, requestDigest: "sha256:public-digest", updatedAt: "2030-01-01T00:00:00Z", draftId: null };
const uncertain = { jobId: "job-unknown", state: "uncertain" as const, attempt: 1, requestDigest: "sha256:other", updatedAt: "2030-01-02T00:00:00Z", draftId: "draft-one" };
const draft = { draftId: "draft-one", jobId: "job-unknown", state: "staged" as const, revision: 3, createdAt: "2030-01-01T00:00:00Z", artifactCount: 12 };

afterEach(cleanup);

describe("GenerationRecoveryPanel", () => {
  it("renders server-provided durable work and performs no automatic recovery", () => {
    const callbacks = api();
    render(<GenerationRecoveryPanel actorRole="gm" drafts={[draft]} jobs={[failed, uncertain]} api={callbacks} />);
    expect(screen.getByText(/Draft draft-one: staged, revision 3, 12 candidate/)).toBeTruthy();
    expect(callbacks.openDraft).not.toHaveBeenCalled();
    expect(callbacks.reconcileJob).not.toHaveBeenCalled();
    expect(callbacks.retryFailedJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reconcile job" }));
    expect(callbacks.reconcileJob).toHaveBeenCalledWith("job-unknown");
  });

  it("requires review and exact failed-attempt acknowledgement before retry", () => {
    const callbacks = api();
    render(<GenerationRecoveryPanel actorRole="owner" drafts={[]} jobs={[failed]} api={callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Review acknowledged retry" }));
    expect((screen.getByRole("button", { name: "Retry failed job once" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm this exact digest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retry failed job once" }));
    expect(callbacks.retryFailedJob).toHaveBeenCalledWith({ jobId: "job-failed", requestDigest: "sha256:public-digest", failedAttempt: 2 });
  });

  it("keeps recovery mutation disabled for players while allowing durable draft review", () => {
    const callbacks = api();
    render(<GenerationRecoveryPanel actorRole="player" drafts={[draft]} jobs={[uncertain]} api={callbacks} />);
    expect((screen.getByRole("button", { name: "Reconcile job" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open durable draft" }));
    expect(callbacks.openDraft).toHaveBeenCalledWith("draft-one");
  });
});
