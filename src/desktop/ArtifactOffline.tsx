import { useEffect, useState } from "react";
import { useApplication } from "./ApplicationProvider";
import { observations } from "../application/observations";
import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import type { NodeAPI } from "../application/contracts/workspace";
export function ArtifactOffline({
  mission,
  revision,
}: {
  mission: string;
  revision: string;
}) {
  const { missions: node } = useApplication();
  const [state, setState] = useState<Awaited<
    ReturnType<NodeAPI["artifactCache"]>
  > | null>(null);
  const [error, setError] = useState("");
  useEffect(
    () =>
      observations(node).subscribe(
        `offline:${mission}:${revision}`,
        () => node.artifactCache(mission, revision, "status"),
        setState,
        (e) => setError(e.message),
      ),
    [node, mission, revision],
  );
  async function act(action: "save" | "cancel") {
    setError("");
    try {
      setState(await node.artifactCache(mission, revision, action));
      observations(node).invalidate(`offline:${mission}:${revision}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Disclosure title="Offline copy on this Mac">
      <p>
        {state?.state === "saved"
          ? "All files are saved on this Mac."
          : state
            ? `${state.completed} of ${state.total} files saved · ${(state.bytes / 1024 / 1024).toFixed(1)} MiB total`
            : "Checking saved files…"}
      </p>
      {state?.state === "saving" ? (
        <>
          <progress
            aria-label="Saving artifact files"
            value={state.completed}
            max={Math.max(1, state.total)}
          />
          <Button onClick={() => void act("cancel")}>
            Cancel remaining downloads
          </Button>
        </>
      ) : state?.state !== "saved" ? (
        <Button onClick={() => void act("save")}>
          Save all files for offline use
        </Button>
      ) : null}
      <p className="d-field-help">
        Keeps this exact revision, up to 32 MiB, in the local node profile until
        you remove that profile. It does not reserve storage on other computers.
        An interrupted download keeps verified files and can be retried. A saved
        copy is not a review or acceptance.
      </p>
      {state?.error || error ? (
        <p role="alert">{state?.error || error}</p>
      ) : null}
    </Disclosure>
  );
}
