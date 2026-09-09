import type DatabaseDriver from "better-sqlite3";

// A fixed, non-renewable lease bounds ownership even across processes. Recovery
// only fences the attempt; it cannot establish whether the provider charged.
export const CAMPAIGN_GENERATION_LEASE_MS = 10 * 60 * 1000;
export function recoverExpiredCampaignGeneration(db: DatabaseDriver.Database, campaignId: string, key: string, now: Date): void {
  db.transaction(() => {
    const row = db.prepare("SELECT job_id,attempt_count,updated_at FROM campaign_generation_jobs_v52 WHERE campaign_id=? AND idempotency_key=? AND state='running'").get(campaignId, key) as {job_id:string;attempt_count:number;updated_at:string} | undefined;
    if (!row || Date.parse(row.updated_at) + CAMPAIGN_GENERATION_LEASE_MS > now.getTime()) return;
    const at = now.toISOString();
    db.prepare("UPDATE campaign_generation_attempts_v52 SET terminal_at=?,outcome_code='outcome-uncertain' WHERE job_id=? AND attempt=? AND terminal_at IS NULL").run(at,row.job_id,row.attempt_count);
    db.prepare("UPDATE campaign_generation_jobs_v52 SET state='failed',last_outcome_code='outcome-uncertain',updated_at=? WHERE job_id=? AND state='running' AND attempt_count=?").run(at,row.job_id,row.attempt_count);
  }).immediate();
}
