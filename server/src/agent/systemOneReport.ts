import type {
  SystemOneDecisionRecord,
  SystemOneDecisionSummary,
} from "../repo/systemOneDecisionRepo.js";

const EMPTY = "—";

function formatPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatLatency(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * Renders a read-only System One shadow report from an aggregate summary and a
 * window of recent decisions. Pure formatting: it never touches raw decision
 * payloads (`state`, `questions`, `answers`, `request`) and performs no I/O.
 */
export function buildSystemOneShadowReport(
  summary: SystemOneDecisionSummary,
  recent: readonly SystemOneDecisionRecord[],
): string {
  const lines: string[] = [];

  lines.push("# System One shadow decision report");
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Total decisions: ${summary.total}`);
  lines.push(`- Shadow decisions: ${summary.shadow} (${formatPercent(summary.shadow, summary.total)})`);
  lines.push(`- Fallback used: ${summary.fallbackUsed} (${formatPercent(summary.fallbackUsed, summary.total)})`);
  lines.push(`- Mean latency: ${formatLatency(summary.meanLatencyMs)} ms`);
  lines.push(`- Total input tokens: ${summary.totalInputTokens}`);
  lines.push(`- Total output tokens: ${summary.totalOutputTokens}`);
  lines.push("");

  lines.push("## Per-lane breakdown");
  lines.push("");
  if (summary.byLane.length === 0) {
    lines.push("_No decisions recorded._");
  } else {
    lines.push("| Lane | Decisions | Share |");
    lines.push("| --- | ---: | ---: |");
    for (const entry of summary.byLane) {
      lines.push(`| ${entry.lane} | ${entry.count} | ${formatPercent(entry.count, summary.total)} |`);
    }
  }
  lines.push("");

  lines.push("## Per-band breakdown");
  lines.push("");
  if (summary.byBand.length === 0) {
    lines.push("_No decisions recorded._");
  } else {
    lines.push("| Band | Decisions | Share |");
    lines.push("| --- | ---: | ---: |");
    for (const entry of summary.byBand) {
      lines.push(`| ${entry.band} | ${entry.count} | ${formatPercent(entry.count, summary.total)} |`);
    }
  }
  lines.push("");

  lines.push("## Recent decisions");
  lines.push("");
  if (recent.length === 0) {
    lines.push("_No decisions recorded._");
  } else {
    lines.push("| Lane | Band | Fallback | Shadow | Latency (ms) | Created at |");
    lines.push("| --- | --- | --- | --- | ---: | --- |");
    for (const record of recent) {
      lines.push(
        `| ${record.lane} | ${record.confidenceBand} | ${formatBoolean(record.fallbackUsed)}`
        + ` | ${formatBoolean(record.shadow)} | ${formatLatency(record.latencyMs)} | ${record.createdAt} |`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}
