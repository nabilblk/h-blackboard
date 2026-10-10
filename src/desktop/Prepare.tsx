import { Field } from "../ui/Field";
import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { useApplication } from "./ApplicationProvider";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  Link,
  LockKeyhole,
} from "lucide-react";
import runtimes from "../../shared/runtimes.json";
import {
  type ContributionReview,
  type Limits,
  type LocalState,
  type Mission,
  type Runtime,
} from "../application/contracts/workspace";
import { Heading, Status, type Perform } from "./ui";
import { NetworkAccessField } from "./NetworkAccess";
import type { NetworkAccess } from "../application/contracts/workspace";

export default function Prepare({
  busy,
  perform,
  cancel,
  complete,
  nodeReview,
}: {
  busy: boolean;
  perform: Perform;
  cancel: () => void;
  complete: (value: LocalState) => void;
  nodeReview?: ContributionReview;
}) {
  const { workspace: desktop, missions: node } = useApplication();
  const [invitation, setInvitation] = useState("");
  const [review, setReview] = useState<{
    reviewId: string;
    mission: Mission;
  } | null>(nodeReview ?? null);
  const [workspace, setWorkspace] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [runtime, setRuntime] = useState<Runtime>("grok");
  const [networkAccess, setNetworkAccess] =
    useState<NetworkAccess>("restricted");
  const [mode, setMode] = useState<"bounded" | "unlimited">("bounded");
  const [concurrency, setConcurrency] = useState("1");
  const [turns, setTurns] = useState("20");
  const [minutes, setMinutes] = useState("60");
  return (
    <>
      <button className="d-back" disabled={busy} onClick={cancel}>
        <ArrowLeft size={14} />
        Contributions
      </button>
      <Heading
        section="New contribution"
        title={
          review ? "Choose your local terms." : "Start with an invitation."
        }
      >
        {review
          ? "These choices belong to you. Remote instructions cannot change them."
          : "Read a mission invitation before deciding what to contribute."}
      </Heading>
      {!review ? (
        <div className="d-prepare-grid">
          <form
            className="d-panel d-invitation"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const result = await desktop.inspect(invitation);
                setReview(result);
                setInvitation("");
              });
            }}
          >
            <header>
              <h2>Mission invitation</h2>
              <Link size={17} />
            </header>
            <Field>
              Invitation URL
              <input
                name="invitation"
                type="url"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={invitation}
                onChange={(event) => setInvitation(event.target.value)}
                placeholder="https://board.example/j/…"
                disabled={busy}
                maxLength={4096}
              />
            </Field>
            <p className="d-field-help">
              Use an Agent or Coordinator invitation from a Blackboard mission.
            </p>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !invitation.trim()}
            >
              {busy ? "Inspecting…" : "Inspect invitation"}
              <ArrowRight size={15} />
            </Button>
            <div className="d-form-note">
              <LockKeyhole size={14} />
              <p>
                Inspection contacts that board once. It does not join the
                mission, start an agent, or share your local identity. The
                invitation token is not saved.
              </p>
            </div>
          </form>
          <aside className="d-prepare-guide">
            <span className="d-label">Web board invitation</span>
            <h2>Review the board first.</h2>
            <p>
              A mission invitation identifies a board and a requested role.
              Check the board address and the person who invited you.
            </p>
            <p>
              This legacy web invitation saves local terms only. For a
              decentralized mission, use Join mission with a desktop invitation.
            </p>
          </aside>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!workspace) return;
            const limits: Limits =
              mode === "bounded"
                ? {
                    mode,
                    concurrency: Number(concurrency),
                    turns: Number(turns),
                    minutes: Number(minutes),
                  }
                : { mode, concurrency: Number(concurrency) };
            void perform(async () =>
              complete(
                await (nodeReview ? node.prepareContribution : desktop.prepare)(
                  {
                    reviewId: review.reviewId,
                    workspaceChoiceId: workspace.id,
                    runtime,
                    networkAccess,
                    limits,
                  },
                ),
              ),
            );
          }}
        >
          <div className="d-mission-review">
            <div className="d-hash large">#</div>
            <div>
              <span className="d-label">
                {nodeReview
                  ? "Signed mission terms · owner key verified"
                  : "Invitation preview · owner unverified"}
              </span>
              <h2>{review.mission.name}</h2>
              <p className="d-mono">{review.mission.origin}</p>
            </div>
            <Status muted>
              {review.mission.role === "coordinator" ? "Coordinator" : "Agent"}
            </Status>
            <Button
              type="button"

              disabled={busy}
              onClick={() => (nodeReview ? cancel() : setReview(null))}
            >
              {nodeReview ? "Back to mission" : "Change invitation"}
            </Button>
          </div>
          {nodeReview ? (
            <section
              className="d-panel n-reviewed-terms"
              aria-label="Reviewed contribution terms"
            >
              <h2>{nodeReview.definition.objective}</h2>
              <p className="n-preserve">{nodeReview.definition.scope}</p>
              <ul>
                {nodeReview.definition.criteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
              <Disclosure title={<>Exact signed mission revision</>}>
                <code className="n-key">{nodeReview.nodeBinding.revision}</code>
                <p className="d-field-help">
                  These local terms are bound to this revision. A signature
                  identifies the owner’s key, not their real-world identity.
                </p>
              </Disclosure>
            </section>
          ) : null}
          <div className="d-two-columns d-terms">
            <section className="d-panel">
              <header>
                <h2>Runtime & workspace</h2>
                <FolderOpen size={17} />
              </header>
              <Field>
                Runtime
                <select
                  value={runtime}
                  onChange={(event) =>
                    setRuntime(event.target.value as Runtime)
                  }
                  disabled={busy}
                >
                  {Object.entries(runtimes).map(([id, data]) => (
                    <option key={id} value={id}>
                      {data.label}
                    </option>
                  ))}
                </select>
              </Field>
              {nodeReview ? (
                <NetworkAccessField
                  value={networkAccess}
                  onChange={setNetworkAccess}
                  disabled={busy}
                />
              ) : null}
              <p className="d-field-help">
                Sign in with your own subscription inside each agent’s isolated
                environment after preparation.
              </p>
              <div className="d-field">
                <span>Export folder on this Mac</span>
                <div className="d-folder-choice">
                  {workspace ? (
                    <>
                      <FolderOpen size={17} />
                      <span className="d-mono">{workspace.path}</span>
                    </>
                  ) : (
                    <span className="d-secondary">No location selected</span>
                  )}
                </div>
                <Button
                  type="button"

                  disabled={busy}
                  onClick={() => {
                    void perform(async () => {
                      const choice = await desktop.chooseWorkspace();
                      if (choice) setWorkspace(choice);
                    });
                  }}
                >
                  <FolderOpen size={15} />
                  {workspace ? "Change location" : "Choose folder…"}
                </Button>
              </div>
              <p className="d-field-help">
                Saving creates a dedicated, empty folder inside this location.
                The parent folder is not part of the contribution.
              </p>
            </section>
            <section className="d-panel">
              <header>
                <h2>Local allowance</h2>
                <span className="d-label">You control this</span>
              </header>
              <Field>
                Maximum concurrent agents
                <input
                  type="number"
                  required
                  min={1}
                  max={review.mission.role === "coordinator" ? 1 : 32}
                  value={concurrency}
                  disabled={busy}
                  onChange={(event) => setConcurrency(event.target.value)}
                />
              </Field>
              <div
                className="d-radio-group"
                role="radiogroup"
                aria-label="Turn and time allowance"
              >
                <label>
                  <input
                    type="radio"
                    name="allowance"
                    checked={mode === "bounded"}
                    onChange={() => setMode("bounded")}
                    disabled={busy}
                  />
                  Set limits
                </label>
                <label>
                  <input
                    type="radio"
                    name="allowance"
                    checked={mode === "unlimited"}
                    onChange={() => setMode("unlimited")}
                    disabled={busy}
                  />
                  No turn or time limit
                </label>
              </div>
              {mode === "bounded" ? (
                <div className="d-limit-fields">
                  <Field>
                    Total runtime turns
                    <input
                      type="number"
                      required
                      min={1}
                      max={10000}
                      value={turns}
                      disabled={busy}
                      onChange={(event) => setTurns(event.target.value)}
                    />
                  </Field>
                  <Field>
                    Duration from start (min)
                    <input
                      type="number"
                      required
                      min={1}
                      max={10080}
                      value={minutes}
                      disabled={busy}
                      onChange={(event) => setMinutes(event.target.value)}
                    />
                  </Field>
                </div>
              ) : (
                <p className="d-unlimited">
                  No local turn or duration cap. The concurrency limit remains.
                  Provider subscription limits still apply.
                </p>
              )}
              <p className="d-field-help">
                A turn is one managed runtime invocation. These local limits
                apply when you approve execution; they do not measure tokens or
                subscription credit.
              </p>
            </section>
          </div>
          <div className="d-consent">
            <label>
              <input type="checkbox" required disabled={busy} />
              <span>
                I approve these local terms. Joining and running will require a
                separate step.
              </span>
            </label>
            <div>
              <Button
                type="button"

                disabled={busy}
                onClick={cancel}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={busy || !workspace}
              >
                {busy ? "Saving…" : "Save preparation"}
                <Check size={15} />
              </Button>
            </div>
          </div>
        </form>
      )}
    </>
  );
}
