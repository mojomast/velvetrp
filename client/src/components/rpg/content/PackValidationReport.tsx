import type { CatalogValidationReport } from "@velvet/contracts";

export interface PackValidationReportProps {
  report: CatalogValidationReport;
  onIssueSelect: (path: string) => void;
}

/** Renders server validation without interpreting issue paths as filenames. */
export function PackValidationReport({ report, onIssueSelect }: PackValidationReportProps) {
  return <section className={`pack-validation ${report.valid ? "is-valid" : "is-invalid"}`} aria-labelledby="pack-validation-heading">
    <div className="content-studio-heading">
      <div>
        <p className="eyebrow">IN-MEMORY VALIDATION</p>
        <h2 id="pack-validation-heading">{report.valid ? "Draft is valid" : "Draft needs attention"}</h2>
      </div>
      <span className="status-pill">{report.normalizedSummary.totalDefinitions} definitions</span>
    </div>
    <p className="content-studio-help">Validation checks this local draft only. Nothing has been published or made immutable.</p>
    <dl className="validation-counts" aria-label="Definitions by kind">
      {report.normalizedSummary.counts.map(({ kind, count }) => <div key={kind}><dt>{kind}</dt><dd>{count}</dd></div>)}
    </dl>
    {report.issues.length === 0
      ? <p className="validation-ready" role="status">No validation issues. Review the exact version before publication.</p>
      : <ol className="validation-issues" aria-label="Validation issues">
        {report.issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}>
          <button type="button" onClick={() => onIssueSelect(issue.path)}>
            <span>{issue.message}</span>
            <code>{issue.path}</code>
          </button>
        </li>)}
      </ol>}
  </section>;
}
