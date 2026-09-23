import runtimes from "../shared/runtimes.json";
import type { RuntimeId } from "./model";
import { useState, type FormEvent } from "react";
import { Copy, Check } from "lucide-react";
import { rpc, quote } from "./client";
import { ModalFrame, Field } from "./ui";
import { RecoveryDialog } from "./Recovery";
import type { Context, Mission, Modal, Session } from "./model";
const titles: Record<Modal["kind"], [string, string]> = {
  mission: ["New channel", "Define the mission"],
  "edit-mission": ["Mission", "Update instructions"],
  criterion: ["Completion criterion", "Update status"],
  recovery: ["Agent recovery", "Resume existing agents"],
  invite: ["Invite agents", ""],
  stream: ["New workstream", "Define its goal"],
  "edit-stream": ["Workstream", "Update its goal"],
  assignment: ["Assignment", "Assign a workstream"],
  task: ["Optional task", "Define a task"],
  plan: ["Coordinator", "Shared plan"],
};
export function Dialogs({
  modal,
  context,
  session,
  close,
  saved,
}: {
  modal: Modal;
  context: Context | null;
  session: Session;
  close: () => void;
  saved: (mission?: Mission) => Promise<void>;
}) {
  const m = context?.mission;
  const [editingVersion] = useState(m?.version);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [criteria, setCriteria] = useState<
    { id?: string; text: string; met: boolean }[]
  >(modal.kind === "edit-mission" ? m!.criteria : []);
  const [draft, setDraft] = useState("");
  const [objective, setObjective] = useState(
    modal.kind === "edit-mission" ? m!.objective : "",
  );
  const add = () => {
    if (draft.trim()) {
      setCriteria((old) => [...old, { text: draft.trim(), met: false }]);
      setDraft("");
    }
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError("");
    try {
      let created: Mission | undefined;
      const base = { channel_id: m?.id };
      switch (modal.kind) {
        case "mission":
        case "edit-mission": {
          const pending = draft.trim()
            ? [...criteria, { text: draft.trim(), met: false }]
            : criteria;
          const input = {
            name: String(data.name || objective.slice(0, 48)).trim(),
            objective,
            scope: String(data.scope || ""),
          };
          if (modal.kind === "mission")
            created = await rpc<Mission>("mission_create", {
              ...input,
              criteria: pending.map((c) => c.text),
              coordination_mode: data.coordination_mode,
            });
          else
            await rpc("mission_update", {
              ...base,
              ...input,
              version: editingVersion,
              criteria: pending.map(({ id, text }) => ({ id, text })),
            });
          break;
        }
        case "criterion":
          await rpc("criterion_update", {
            ...base,
            version: editingVersion,
            criterion_id: modal.criterion!.id,
            met: data.status === "met",
            summary: data.summary,
            refs: data.ref ? [data.ref] : [],
          });
          break;
        case "stream":
          await rpc("stream_create", { ...base, ...data });
          break;
        case "edit-stream":
          await rpc("stream_update", {
            ...base,
            ...data,
            stream_id: modal.stream!.id,
            version: modal.stream!.version,
            archived: !!modal.stream?.archived,
          });
          break;
        case "assignment":
          await rpc("assignment_create", {
            ...base,
            ...data,
            agent_id: modal.agent!.id,
          });
          break;
        case "task":
          await rpc("task_create", {
            ...base,
            ...data,
            agent_ids: new FormData(event.currentTarget).getAll("agent_ids"),
          });
          break;
        case "plan":
          await rpc("plan_update", {
            ...base,
            plan: data.plan,
            version: m!.version,
          });
          break;
      }
      await saved(created);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalFrame
      label={titles[modal.kind][0]}
      title={modal.kind === "invite" ? m!.name : titles[modal.kind][1]}
      close={close}
    >
      {modal.kind === "recovery" ? (
        <RecoveryDialog
          context={context!}
          session={session}
          refresh={() => saved()}
          close={close}
        />
      ) : modal.kind === "invite" ? (
        <Invite context={context!} session={session} />
      ) : (
        <form onSubmit={submit}>
          <div className="dialog-body">
            {modal.kind === "criterion" ? (
              <>
                <p>{modal.criterion!.text}</p>
                <Field label="Status">
                  <select
                    name="status"
                    defaultValue={modal.criterion!.met ? "unmet" : "met"}
                  >
                    <option value="met">Reported complete</option>
                    <option value="unmet">Not yet met</option>
                  </select>
                </Field>
                <Field
                  label="Evidence or reason"
                  hint="Shared in Main. Include test results, sources, or the remaining gap. You keep the final decision on mission completion."
                >
                  <textarea
                    name="summary"
                    rows={4}
                    required
                    maxLength={16000}
                    autoFocus
                    placeholder="What supports this status?"
                  />
                </Field>
                <Field label="Supporting message · optional">
                  <select name="ref" defaultValue="">
                    <option value="">No message reference</option>
                    {context!.messages
                      .filter(
                        (message) => !message.directAgentId && !message.removed,
                      )
                      .map((message) => (
                        <option key={message.id} value={message.id}>
                          {message.body.slice(0, 100)}
                        </option>
                      ))}
                  </select>
                </Field>
                {editingVersion !== m?.version ? (
                  <p className="warning" role="status">
                    The mission changed while you were reviewing it. Close and
                    reopen this dialog to review the current status before
                    saving.
                  </p>
                ) : null}
              </>
            ) : null}
            {modal.kind === "mission" || modal.kind === "edit-mission" ? (
              <>
                <Field label="Objective">
                  <textarea
                    rows={2}
                    required
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    placeholder="What should the agents accomplish?"
                    autoFocus
                  />
                </Field>
                <Field label="Scope">
                  <textarea
                    name="scope"
                    rows={3}
                    defaultValue={modal.kind === "edit-mission" ? m?.scope : ""}
                    placeholder="What is in, what is out, and what the agents may change."
                  />
                </Field>
                <div className="field">
                  <span className="label">
                    Completion criteria · {criteria.length}
                  </span>
                  {criteria.map((c, i) => (
                    <div className="criterion-item" key={c.id || i}>
                      <span className="mono muted">{i + 1}</span>
                      <span>{c.text}</span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setCriteria((items) =>
                            items.filter((_, at) => at !== i),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="input-row">
                    <input
                      aria-label="New completion criterion"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Add a criterion and press Enter"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          add();
                        }
                      }}
                    />
                    <button className="button" type="button" onClick={add}>
                      Add
                    </button>
                  </div>
                </div>
                <Field
                  label="Channel name"
                  hint="Leave blank to use a short version of the objective."
                >
                  <input
                    name="name"
                    maxLength={180}
                    defaultValue={modal.kind === "edit-mission" ? m?.name : ""}
                    placeholder="e.g. next-horizon"
                  />
                </Field>
                {modal.kind === "mission" ? (
                  <Field
                    label="Coordination"
                    hint="Agents join in preparation. You decide when the mission starts."
                  >
                    <select name="coordination_mode" defaultValue="coordinated">
                      <option value="coordinated">Coordinator-led</option>
                      <option value="peer">Peer collaboration</option>
                    </select>
                  </Field>
                ) : null}
              </>
            ) : null}
            {modal.kind === "stream" || modal.kind === "edit-stream" ? (
              <>
                <Field label="Workstream name">
                  <input
                    name="name"
                    required
                    autoFocus
                    defaultValue={modal.stream?.name}
                  />
                </Field>
                <Field label="Goal">
                  <textarea
                    name="goal"
                    required
                    rows={4}
                    defaultValue={modal.stream?.goal}
                    placeholder="What should this group explore or accomplish?"
                  />
                </Field>
                <p className="hint">
                  Agents can collaborate toward this goal without creating
                  tasks.
                </p>
              </>
            ) : null}
            {modal.kind === "assignment" ? (
              <>
                <div className="inset">
                  <strong>{modal.agent?.name}</strong>
                  <span className="muted">
                    {modal.agent?.role === "coordinator"
                      ? "Coordinator"
                      : "Agent"}
                  </span>
                </div>
                <Field label="Workstream">
                  <select name="stream_id" defaultValue={modal.agent?.streamId}>
                    {context!.workstreams
                      .filter((s) => !s.archived)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Instructions">
                  <textarea
                    name="instruction"
                    rows={4}
                    required
                    autoFocus
                    placeholder="Explain the direction and the next useful checkpoint."
                  />
                </Field>
                <p className="hint">
                  This is a direct human assignment. It remains pending until
                  the agent acknowledges it.
                </p>
              </>
            ) : null}
            {modal.kind === "task" ? (
              <>
                <Field label="Task">
                  <input name="title" required autoFocus />
                </Field>
                <Field label="Participation">
                  <select name="mode">
                    <option value="parallel">
                      Parallel · several agents can explore
                    </option>
                    <option value="individual">Individual · one agent</option>
                  </select>
                </Field>
                <Field label="Workstream">
                  <select name="stream_id">
                    {context!.workstreams
                      .filter((w) => !w.archived)
                      .map((w) => (
                        <option value={w.id} key={w.id}>
                          {w.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Context">
                  <textarea name="description" rows={3} />
                </Field>
                <Field label="Completion criteria">
                  <textarea name="criteria" rows={2} />
                </Field>
                {context!.agents.length ? (
                  <Field
                    label="Assign agents"
                    hint="Optional. Select multiple agents for a parallel task."
                  >
                    <select
                      multiple
                      name="agent_ids"
                      size={Math.min(5, context!.agents.length)}
                    >
                      {context!.agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
              </>
            ) : null}
            {modal.kind === "plan" ? (
              <Field label="Shared plan">
                <textarea
                  name="plan"
                  rows={10}
                  defaultValue={m?.plan}
                  required
                  autoFocus
                  placeholder="Explain the current directions, groups, and next checkpoints."
                />
              </Field>
            ) : null}
            {error ? (
              <div className="error" role="alert">
                {error}
              </div>
            ) : null}
          </div>
          <footer className="dialog-footer">
            <button className="button" type="button" onClick={close}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                (modal.kind === "criterion" && editingVersion !== m?.version)
              }
            >
              {busy
                ? "Saving…"
                : modal.kind === "mission"
                  ? "Create channel"
                  : modal.kind === "stream"
                    ? "Create workstream"
                    : modal.kind === "task"
                      ? "Create task"
                      : modal.kind === "assignment"
                        ? "Assign agent"
                        : "Save changes"}
            </button>
          </footer>
        </form>
      )}
    </ModalFrame>
  );
}
function Invite({ context, session }: { context: Context; session: Session }) {
  const [tab, setTab] = useState("single"),
    [role, setRole] = useState("agent"),
    [stream, setStream] = useState(context.mission.defaultStreamId),
    [runtime, setRuntime] = useState<RuntimeId>("claude"),
    [count, setCount] = useState(4),
    [permissions, setPermissions] = useState("default"),
    [layout, setLayout] = useState("per-agent"),
    [workspace, setWorkspace] = useState(
      () =>
        `~/Harakiri/missions/${
          context.mission.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50) || "mission"
        }-${context.mission.id.slice(-6)}`,
    ),
    [invitation, setInvitation] = useState<{
      id: string;
      token: string;
      role: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState("");
  const url = invitation ? `${session.url}/j/${invitation.token}` : "";
  const single = `Join this Harakiri mission: ${url}\nFetch this URL with your terminal to read the joining instructions. Register this session as ${role === "coordinator" ? "Coordinator" : "Agent"} using your runtime and a distinct name.\nRead context_read, including the mission and your participation state. Joining does not authorize work. In preparation, agents wait; the appointed coordinator may publish a plan and call coordinator_ready with the current startupRevision. Only the human starts the mission. After startup, follow your authorized direction and human instructions. Tasks are optional. Keep reading updates with the provided watch command while waiting.`;
  const validWorkspace =
    !!workspace.trim() &&
    !/[\x00-\x1f]/.test(workspace) &&
    (!workspace.startsWith("~") ||
      workspace === "~" ||
      workspace.startsWith("~/"));
  const cli = `${quote(session.node)} ${quote(session.cli)} launch \\\n  --board ${quote(url)} --runtime ${runtime} --count ${role === "coordinator" ? 1 : count} --role ${role} \\\n  --permissions ${permissions} --layout ${layout} \\\n  --workspace ${quote(workspace)}`;
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      setError(
        "Select and copy the text below. Clipboard access is unavailable.",
      );
    }
  }
  async function create() {
    setBusy(true);
    try {
      setInvitation(
        await rpc("invitation_create", {
          channel_id: context.mission.id,
          role,
          stream_id: stream,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dialog-body invitation">
      <div className="form-columns">
        <Field label="Role">
          <select
            value={role}
            disabled={!!invitation}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="agent">Agent</option>
            <option
              value="coordinator"
              disabled={
                !!context.mission.coordinatorId ||
                context.mission.coordinationMode === "peer"
              }
            >
              Coordinator
            </option>
          </select>
        </Field>
        <Field label="Initial workstream">
          <select
            value={stream}
            disabled={!!invitation}
            onChange={(e) => setStream(e.target.value)}
          >
            {context.workstreams
              .filter((w) => !w.archived)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      {invitation ? (
        <>
          <div className="field">
            <span className="label">Join URL</span>
            <div className="input-row">
              <input
                aria-label="Join URL"
                className="mono"
                readOnly
                value={url}
              />
              <button className="button primary" onClick={() => copy(url)}>
                {copied === url ? "Copied" : "Copy"}
              </button>
            </div>
            <small>
              This invitation grants access to this mission and expires in 24
              hours.
            </small>
          </div>
          <div className="tabs" role="tablist" aria-label="Invitation method">
            <button
              role="tab"
              aria-selected={tab === "single"}
              className={tab === "single" ? "selected" : ""}
              onClick={() => setTab("single")}
            >
              One agent
            </button>
            <button
              role="tab"
              aria-selected={tab === "many"}
              className={tab === "many" ? "selected" : ""}
              onClick={() => setTab("many")}
            >
              Launcher · many instances
            </button>
          </div>
          {tab === "single" ? (
            <>
              <p className="secondary">
                Paste into an existing Claude Code, Codex, or Grok Build
                session.
              </p>
              <pre className="code-block">{single}</pre>
              <button
                className="button copy-command"
                onClick={() => copy(single)}
              >
                {copied === single ? <Check size={14} /> : <Copy size={14} />}
                {copied === single ? "Copied invitation" : "Copy invitation"}
              </button>
              <p className="hint">
                The current session uses the provided CLI to read and write.
                Keep it watching for updates while participating.
              </p>
            </>
          ) : (
            <>
              <p className="secondary">
                Start independent instances. The launcher supplies MCP tools and
                delivers updates between turns.
              </p>
              <div className="form-columns">
                <Field label="Runtime">
                  <select
                    value={runtime}
                    onChange={(e) => setRuntime(e.target.value as RuntimeId)}
                  >
                    {Object.entries(runtimes).map(([id, spec]) => (
                      <option key={id} value={id}>
                        {spec.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Instances">
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={role === "coordinator" ? 1 : count}
                    disabled={role === "coordinator"}
                    onChange={(e) =>
                      setCount(
                        Math.max(
                          1,
                          Math.min(1000, Number(e.target.value) || 1),
                        ),
                      )
                    }
                  />
                </Field>
              </div>
              <div className="form-columns">
                <Field
                  label="Permissions"
                  hint={
                    permissions === "full"
                      ? "No runtime approval prompts or runtime sandbox. Runs with your OS user’s access; machine and organization policies still apply."
                      : runtimes[runtime].defaultAccess
                  }
                >
                  <select
                    value={permissions}
                    onChange={(e) => setPermissions(e.target.value)}
                  >
                    <option value="default">Runtime defaults</option>
                    <option value="full">Full access</option>
                  </select>
                </Field>
                <Field
                  label="Folder layout"
                  hint={
                    layout === "per-agent"
                      ? "Each instance gets its own folder, plus a shared folder for deliverables."
                      : "Every instance works in the same folder. Coordinate changes to shared files."
                  }
                >
                  <select
                    value={layout}
                    onChange={(e) => setLayout(e.target.value)}
                  >
                    <option value="per-agent">Separate agent folders</option>
                    <option value="shared">Shared folder</option>
                  </select>
                </Field>
              </div>
              <Field
                label="Workspace folder"
                hint="On the machine where you run the command. The launcher creates missing folders. ~/ means your home folder."
              >
                <input
                  className="mono"
                  value={workspace}
                  aria-invalid={!validWorkspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <p className="hint workspace-preview">
                {layout === "per-agent" ? (
                  <>
                    <code>agents/&lt;instance&gt;/</code> Working files{" "}
                    <span>·</span> <code>shared/</code> Shared deliverables
                  </>
                ) : (
                  "All instances use the workspace folder directly."
                )}
              </p>
              {validWorkspace ? (
                <pre className="code-block">{cli}</pre>
              ) : (
                <p className="error" role="alert">
                  Enter a valid workspace folder to generate the command.
                </p>
              )}
              <button
                className="button copy-command"
                disabled={!validWorkspace}
                onClick={() => copy(cli)}
              >
                {copied === cli ? <Check size={14} /> : <Copy size={14} />}
                {copied === cli
                  ? "Copied launch command"
                  : "Copy launch command"}
              </button>
              <p className="hint">
                Open an agent’s profile after launch to copy its working folder
                and follow its live logs. Credentials and logs stay in private
                launcher storage.
              </p>
            </>
          )}
          <button
            className="text-button danger"
            onClick={async () => {
              try {
                await rpc("invitation_revoke", {
                  channel_id: context.mission.id,
                  invitation_id: invitation.id,
                });
                setInvitation(null);
                setCopied("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Revoke this invitation
          </button>
        </>
      ) : (
        <button className="button primary" onClick={create} disabled={busy}>
          {busy ? "Creating…" : "Create invitation"}
        </button>
      )}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
