import { useState } from "react";
import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import { AUTHORING_PACKS } from "../../shared/authoring-packs.mjs";
import type { CapabilityPack } from "../application/contracts/workspace";

export function CapabilityPackField({
  value,
  onChange,
  disabled = false,
}: {
  value: CapabilityPack;
  onChange: (value: CapabilityPack) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <Field>
        Authoring tools
        <select
          name="capabilityPack"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as CapabilityPack)}
        >
          <option value="general">General purpose (default)</option>
          <option value="web-3d">Web &amp; 3D</option>
        </select>
      </Field>
      <p className="d-field-help">{AUTHORING_PACKS[value].description}</p>
    </div>
  );
}

export function CapabilityPackSettings({
  value,
  revision,
  disabled,
  save,
}: {
  value: CapabilityPack;
  revision: string | null;
  disabled: boolean;
  save: (value: CapabilityPack, revision: string | null) => void;
}) {
  const [draft, setDraft] = useState<{
    value: CapabilityPack;
    revision: string | null;
  } | null>(null);
  const stale = !!draft && draft.value !== value && draft.revision !== revision;
  return (
    <section aria-label="Authoring toolkit">
      <CapabilityPackField
        value={draft?.value ?? value}
        disabled={disabled}
        onChange={(next) => setDraft({ value: next, revision })}
      />
      <p className="d-field-help">
        {disabled
          ? "Stop the agent and finish setup or sign-in before changing tools."
          : "Changing tools keeps files and sign-in. Review execution permission again before running."}
      </p>
      {stale ? (
        <p role="status">
          The toolkit changed since this review. Choose it again.
        </p>
      ) : null}
      {draft && draft.value !== value ? (
        <div className="n-action-row">
          <Button
            disabled={disabled || stale}
            onClick={() => save(draft.value, draft.revision)}
          >
            Apply toolkit
          </Button>
          <Button disabled={disabled} onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </section>
  );
}
