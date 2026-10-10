import { useState } from "react";
import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import type { NetworkAccess } from "../application/contracts/workspace";

export function NetworkAccessField({
  value,
  onChange,
  disabled = false,
}: {
  value: NetworkAccess;
  onChange: (value: NetworkAccess) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <Field>
        Workspace internet
        <select
          name="networkAccess"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as NetworkAccess)}
        >
          <option value="restricted">Blocked (default)</option>
          <option value="internet">Allow public internet · HTTPS</option>
        </select>
      </Field>
      <p className="d-field-help">
        {value === "internet"
          ? "Allows HTTPS websites, APIs and downloads. The agent can send workspace and mission data to external services. Your Mac, local network and provider credentials stay isolated."
          : "The agent can use its AI provider and Blackboard. Workspace commands cannot access the internet."}
      </p>
    </div>
  );
}

export function NetworkAccessSettings({
  value,
  revision,
  disabled,
  save,
}: {
  value: NetworkAccess;
  revision: string | null;
  disabled: boolean;
  save: (value: NetworkAccess, revision: string | null) => void;
}) {
  const [draft, setDraft] = useState<{
    value: NetworkAccess;
    revision: string | null;
  } | null>(null);
  const stale = !!draft && draft.value !== value && draft.revision !== revision;
  return (
    <section aria-label="Workspace internet access">
      <NetworkAccessField
        value={draft?.value ?? value}
        disabled={disabled}
        onChange={(next) => setDraft({ value: next, revision })}
      />
      <p className="d-field-help">
        {disabled
          ? "Stop the agent and finish setup or sign-in before changing access."
          : "Changes keep this agent’s files and sign-in. Review its permission again before running."}
      </p>
      {stale ? (
        <p role="status">
          Access changed since this review. Choose the setting again.
        </p>
      ) : null}
      {draft && draft.value !== value ? (
        <div className="n-action-row">
          <Button
            disabled={disabled || stale}
            onClick={() => save(draft.value, draft.revision)}
          >
            Apply internet setting
          </Button>
          <Button disabled={disabled} onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </section>
  );
}
