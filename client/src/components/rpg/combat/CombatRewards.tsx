import type { CombatRewardGrantPublic } from "@velvet/contracts";

export interface CombatRewardsProps {
  rewards: CombatRewardGrantPublic[];
  claimingBundleId?: string | null;
  claimableActorId?: string | null;
  locked?: boolean;
  onClaim?: (reward: CombatRewardGrantPublic) => void;
}

/** Small reusable projection which never conflates a granted bundle with a settled one. */
export function CombatRewards({ rewards, claimingBundleId = null, claimableActorId = null, locked = false, onClaim }: CombatRewardsProps) {
  return <section className="combat-panel combat-rewards" aria-labelledby="combat-rewards-heading">
    <div className="combat-panel-heading"><h2 id="combat-rewards-heading">Combat rewards</h2><span>Explicit settlement</span></div>
    {rewards.length === 0 ? <p className="combat-empty">No reward bundles are visible to this recipient.</p> : <ul>{rewards.map((reward) => {
      const actorBound=claimableActorId===reward.recipientActorId,busy=claimingBundleId===reward.rewardBundleId;
      return <li className={reward.claim.state === "claimed" ? "is-claimed" : "is-unclaimed"} key={reward.rewardBundleId}>
        <div className="combat-reward-heading"><strong>{reward.rewards.map((entry) => entry.kind === "currency" ? `${entry.amount} ${entry.currency.definitionId}`
          : entry.kind === "item" ? `${entry.quantity} ${entry.item.definitionId}` : `${entry.amount} experience`).join(", ")}</strong>
          <span className="combat-reward-state">{reward.claim.state === "claimed" ? "Claimed" : "Unclaimed"}</span></div>
        <p>Recipient <code>{reward.recipientActorId}</code></p>
        {reward.claim.state === "claimed"
          ? <p>Settled <time dateTime={reward.claim.claimedAt}>{reward.claim.claimedAt}</time></p>
          : <>{!actorBound && <p className="combat-authority-note">Load this exact recipient actor before claiming. This bundle is not owned until settlement is confirmed.</p>}
            {onClaim && <button type="button" disabled={!actorBound||locked||busy} onClick={() => onClaim(reward)}>{busy ? "Claiming once…" : "Claim reward"}</button>}</>}
      </li>;
    })}</ul>}
  </section>;
}
