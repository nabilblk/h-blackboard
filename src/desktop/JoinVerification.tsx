import { Disclosure } from "../ui/Disclosure";
import { Field } from "../ui/Field";

/** The public signing key already shared by a join request, never a secret. */
export function JoinVerification({ ownerKey }: { ownerKey: string }) {
  return (
    <Disclosure title="Verify your join request">
      <p className="d-field-help">
        Share this public key with the mission owner through the channel where
        they invited you. They can compare it with your request before approval.
      </p>
      <Field>
        Your verification key
        <input
          className="d-mono"
          aria-label="Your verification key"
          value={ownerKey}
          readOnly
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
        <span className="d-field-help">
          Select the key to copy it. This is public identity information, not a
          password or recovery key.
        </span>
      </Field>
    </Disclosure>
  );
}
