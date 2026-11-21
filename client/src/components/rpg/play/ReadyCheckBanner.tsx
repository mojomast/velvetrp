export interface ReadyCheckWaitingActor {
  actorId: string;
  name: string;
}

export interface ReadyCheckActiveCheck {
  readyActorIds: readonly string[];
  waiting: readonly ReadyCheckWaitingActor[];
}

export interface ReadyCheckBannerProps {
  enabled: boolean;
  check: ReadyCheckActiveCheck | null;
  canManage: boolean;
  canReady: boolean;
  onEnable?: () => void;
  onStart?: () => void;
  onReady?: () => void;
  onDismiss?: () => void;
}

/** Optional coordination aid; it never blocks or locks out-of-combat turns. */
export function ReadyCheckBanner({
  enabled,
  check,
  canManage,
  canReady,
  onEnable,
  onStart,
  onReady,
  onDismiss,
}: ReadyCheckBannerProps) {
  if (!enabled) {
    if (!canManage || !onEnable || !onStart) return null;
    return (
      <section className="ready-check-banner" aria-label="Ready check">
        <button type="button" onClick={onEnable}>
          Enable ready checks
        </button>
      </section>
    );
  }

  if (!check) {
    if (!canManage || !onStart) return null;
    return (
      <section className="ready-check-banner" aria-label="Ready check">
        <button type="button" onClick={onStart}>
          Start ready check
        </button>
      </section>
    );
  }

  const waitingNames = check.waiting.map((actor) => actor.name).join(", ");
  return (
    <section className="ready-check-banner" aria-label="Ready check">
      <p role="status">{waitingNames ? `Waiting on ${waitingNames}` : "Everyone is ready"}</p>
      <div className="button-row">
        {canReady && onReady && (
          <button type="button" onClick={onReady}>
            I'm ready
          </button>
        )}
        {canManage && onDismiss && (
          <button type="button" onClick={onDismiss}>
            Dismiss ready check
          </button>
        )}
      </div>
    </section>
  );
}
