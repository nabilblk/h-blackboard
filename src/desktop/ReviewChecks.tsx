import { useState } from "react";
import type { CheckResult, ReviewCheck } from "./node-contract";

export const reviewMethods = {
  source_inspection: "Source inspection",
  executed_tests: "Executed tests",
  browser_check: "Browser checks",
  visual_inspection: "Visual inspection",
} as const;

export function checksFromForm(data: FormData): ReviewCheck[] {
  return Object.keys(reviewMethods).map((method) => ({
    method: method as ReviewCheck["method"],
    result: String(data.get(`check_${method}`)) as CheckResult,
    details: String(
      data.get(`details_${method}`) || "Not checked in this review.",
    ).trim(),
  }));
}

export function ReviewChecks() {
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  return (
    <fieldset className="n-fields">
      <legend>What did you actually verify?</legend>
      <p className="d-field-help">
        Report only checks you performed on this revision. Reading HTML does not
        establish browser behavior or visual quality.
      </p>
      {Object.entries(reviewMethods).map(([method, label]) => (
        <div key={method}>
          <label className="d-field">
            <span>{label}</span>
            <select
              name={`check_${method}`}
              value={results[method] || "not_run"}
              onChange={(e) =>
                setResults((previous) => ({
                  ...previous,
                  [method]: e.target.value as CheckResult,
                }))
              }
            >
              <option value="not_run">Not checked</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          {results[method] && results[method] !== "not_run" ? (
            <label className="d-field">
              <span>{label} · evidence and environment</span>
              <textarea
                name={`details_${method}`}
                required
                maxLength={1024}
                rows={2}
                placeholder={
                  method === "executed_tests"
                    ? "Command, environment, result and any gaps."
                    : method === "source_inspection"
                      ? "Files and requirements inspected; what remains untested."
                      : "Browser, viewport sizes, interactions and observed results."
                }
              />
            </label>
          ) : null}
        </div>
      ))}
    </fieldset>
  );
}
