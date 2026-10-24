import { useState } from "react";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import type { Limits } from "../application/contracts/workspace";
import type { ExecutionState } from "../application/contracts/execution";

export function LocalAllowanceSettings({
  value,
  revision,
  observed,
  disabled,
  save,
}: {
  value: Limits;
  revision: string | null;
  observed?: ExecutionState["localAllowance"];
  disabled: boolean;
  save: (limits: Limits, revision: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{
    value: Limits;
    revision: string | null;
  } | null>(null);
  const [confirmed, confirm] = useState(false);
  const stale = !!draft && draft.revision !== revision;
  const changed =
    !!draft && JSON.stringify(draft.value) !== JSON.stringify(value);
  return (
    <section aria-label="Local allowance">
      <h4>Local allowance</h4>
      <p>
        {value.mode === "unlimited"
          ? "No total local cap"
          : `${value.turns} turns · ${value.minutes} minutes total`}
      </p>
      {observed ? (
        <p className="d-field-help">
          {observed.used} turns used or reserved.
          {observed.deadline
            ? ` Time window ends ${new Date(observed.deadline).toLocaleString()}.`
            : null}
        </p>
      ) : null}
      {observed?.issue ? <p role="status">{observed.issue}</p> : null}
      {!draft ? (
        <Button
          disabled={disabled}
          onClick={() => {
            setDraft({ value, revision });
            confirm(false);
          }}
        >
          Review local allowance
        </Button>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!confirmed || stale || !changed) return;
            if (await save(draft.value, draft.revision)) setDraft(null);
          }}
        >
          <Field>
            Allowance
            <select
              name="localAllowanceMode"
              value={draft.value.mode}
              disabled={disabled}
              onChange={(e) => {
                confirm(false);
                setDraft({
                  ...draft,
                  value:
                    e.target.value === "unlimited"
                      ? { mode: "unlimited", concurrency: value.concurrency }
                      : {
                          mode: "bounded",
                          concurrency: value.concurrency,
                          turns: value.mode === "bounded" ? value.turns : 20,
                          minutes:
                            value.mode === "bounded" ? value.minutes : 60,
                        },
                });
              }}
            >
              <option value="bounded">Set total turn and time caps</option>
              <option value="unlimited">No total local cap</option>
            </select>
          </Field>
          {draft.value.mode === "bounded" ? (
            <div className="d-fields-2">
              <Field>
                Total turns
                <input
                  name="localAllowanceTurns"
                  type="number"
                  min="1"
                  max="10000"
                  required
                  value={draft.value.turns}
                  disabled={disabled}
                  onChange={(e) => {
                    confirm(false);
                    setDraft({
                      ...draft,
                      value: {
                        ...draft.value,
                        turns: e.target.valueAsNumber,
                      } as Limits,
                    });
                  }}
                />
              </Field>
              <Field>
                Total minutes
                <input
                  name="localAllowanceMinutes"
                  type="number"
                  min="1"
                  max="10080"
                  required
                  value={draft.value.minutes}
                  disabled={disabled}
                  onChange={(e) => {
                    confirm(false);
                    setDraft({
                      ...draft,
                      value: {
                        ...draft.value,
                        minutes: e.target.valueAsNumber,
                      } as Limits,
                    });
                  }}
                />
              </Field>
            </div>
          ) : null}
          <p className="d-field-help">
            These are cumulative caps for this agent. Earlier turns still count,
            and the time window starts at its first permission. Increasing a cap
            keeps its workspace and sign-in. Each run still needs a fresh,
            finite execution approval.
          </p>
          {stale ? (
            <p role="alert">
              The local allowance changed. Cancel and review the current limits.
            </p>
          ) : null}
          <label className="n-check-label">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={disabled || stale}
              onChange={(e) => confirm(e.target.checked)}
            />
            I approve these local limits. Applying them does not start the
            agent.
          </label>
          <div className="n-action-row">
            <Button
              variant="primary"
              type="submit"
              disabled={disabled || stale || !confirmed || !changed}
            >
              Apply local allowance
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {disabled ? (
        <p className="d-field-help">
          Stop this agent and finish setup or sign-in before changing its local
          allowance.
        </p>
      ) : null}
    </section>
  );
}
