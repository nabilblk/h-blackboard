import { useState } from "react";
import { useApplication } from "./ApplicationProvider";
import { Disclosure } from "../ui/Disclosure";
import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import type { Perform } from "./ui";

export function NodeRecovery({
  enrolled,
  perform,
  updated,
}: {
  enrolled: boolean;
  perform: Perform;
  updated: () => Promise<unknown>;
}) {
  const { missions } = useApplication();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <Disclosure title={enrolled ? "Protect this node" : "Restore a node"}>
      <p>
        Keep your identity, saved mission history and downloaded artifacts in a
        passphrase-protected recovery file. It contains private conversations:
        keep the file and passphrase safe.
      </p>
      <p className="d-field-help">
        Stop agents and finish setup first. VM workspaces, provider sign-ins and
        permission to run agents are separate and are not restored. Recovery
        opens offline on an empty node; the original node must stay stopped to
        prevent conflicting signatures.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setMessage("");
          void perform(async () => {
            const result = enrolled
              ? await missions.backupNode(passphrase)
              : await missions.restoreNode(passphrase, true);
            setPassphrase("");
            setConfirm("");
            if (!result.cancelled) {
              setMessage(
                enrolled
                  ? "Protected recovery file saved. Keep its passphrase separately."
                  : "Node restored offline. Review saved history before enabling networking; prepare agents and approve new execution separately.",
              );
              await updated();
            }
          }).finally(() => setBusy(false));
        }}
      >
        <Field>
          Recovery passphrase
          <input
            type="password"
            autoComplete={enrolled ? "new-password" : "off"}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            minLength={16}
            maxLength={1024}
            required
          />
          <span className="d-field-help">
            At least 16 characters. A long, unique passphrase is best. Harakiri
            cannot recover it.
          </span>
        </Field>
        {enrolled ? (
          <Field>
            Confirm passphrase
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Field>
        ) : (
          <label className="d-checkbox">
            <input
              type="checkbox"
              checked={stopped}
              onChange={(e) => setStopped(e.target.checked)}
              required
            />
            The original node is stopped and will not run with this identity
            again.
          </label>
        )}
        <Button
          type="submit"
          disabled={
            busy ||
            passphrase.length < 16 ||
            (enrolled ? passphrase !== confirm : !stopped)
          }
        >
          {busy
            ? "Processing recovery…"
            : enrolled
              ? "Save protected recovery file"
              : "Choose recovery file"}
        </Button>
        {message ? <p role="status">{message}</p> : null}
      </form>
    </Disclosure>
  );
}
