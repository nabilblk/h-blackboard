import { useEffect, useState } from "react";
import { Users, Plus, FolderOpen } from "lucide-react";
import { desktop, node, type Contribution } from "./bridge";
import type { AgentView, AgentStatus, MissionView } from "./node-contract";
import { type Perform } from "./ui";

const runtimes = { grok: "Grok Build", claude: "Claude Code", codex: "Codex" };
const runtimeName = (runtime: string) =>
  runtimes[runtime as keyof typeof runtimes] ?? runtime;
const statuses: Record<AgentStatus, string> = {
  waiting_for_start: "Waiting for mission start",
  waiting_for_direction: "Waiting for direction",
  waiting_for_appointment: "Awaiting Coordinator appointment",
  direction_assigned: "Direction assigned",
  paused: "Mission paused",
  review_required: "Instructions changed · review required",
  withdrawn: "Withdrawn",
  revoked: "Contributor access revoked",
  conflict: "Conflicting identity · review required",
};

export function AgentRoster({
  mission,
  localKey,
  contributions,
  busy,
  perform,
  updated,
  prepare,
  selectedAgent,
  message,
}: {
  mission: MissionView;
  localKey: string;
  contributions: Contribution[];
  busy: boolean;
  perform: Perform;
  updated: () => Promise<void>;
  prepare: () => void;
  selectedAgent?: string | null;
  message: (agent: AgentView, privateChat: boolean) => void;
}) {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [sharing, setSharing] = useState("");
  const [selected, setSelected] = useState<string | null>(
    selectedAgent ?? null,
  );
  useEffect(() => {
    if (selectedAgent) {
      setSelected(selectedAgent);
      setSearch("");
    }
  }, [selectedAgent]);
  const [direction, setDirection] = useState<{
    id: string;
    revision: string;
    text: string;
  } | null>(null);
  const [withdraw, setWithdraw] = useState<string | null>(null);
  const read = async () => {
    const all: AgentView[] = [];
    let after: string | null = null;
    do {
      const page = await node.agents(mission.id, after);
      all.push(...page.items);
      after = page.after;
    } while (after);
    return all;
  };
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const all = await read();
        if (!cancelled) {
          setAgents(all);
          setLoaded(true);
          setError("");
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Unable to read mission agents.",
          );
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Each poll reads a bounded roster for this mission, with no overlapping requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission.id]);
  const refresh = async () => {
    setAgents(await read());
    await updated();
  };
  const local = contributions.filter((c) => c.mission.missionId === mission.id);
  const available = local.filter(
    (c) =>
      c.status === "prepared" &&
      !c.sharedAgent &&
      c.nodeBinding?.revision === mission.lifecycle.terms_revision,
  );
  const choice = available.find((c) => c.id === sharing) ?? available[0];
  const filtered = agents.filter((a) =>
    `${a.identity.label} ${a.identity.contributor_name} ${runtimeName(a.identity.runtime)} ${a.identity.role} ${statuses[a.status]}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const isOwner = mission.owner === localKey;
  return (
    <section className="n-agents" aria-label="Mission agents">
      <header className="n-section-heading">
        <h3>
          <Users size={17} /> Agents{" "}
          <span className="d-count">{agents.length}</span>
        </h3>
        <button className="d-button" onClick={prepare} disabled={busy}>
          <Plus size={15} /> Prepare agent
        </button>
      </header>
      <p>
        Shared contributions and their direction. Agent execution is unavailable
        in this preview.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {available.length ? (
        <form
          className="n-share-agent"
          onSubmit={(event) => {
            event.preventDefault();
            const label = String(
              new FormData(event.currentTarget).get("label") ?? "",
            ).trim();
            if (choice)
              void perform(async () => {
                await node.shareAgent(mission.id, choice.id, label);
                await refresh();
              });
          }}
        >
          <h4>Share a prepared agent</h4>
          <label className="d-field">
            Local contribution
            <select
              aria-label="Prepared agent"
              value={choice?.id ?? ""}
              onChange={(e) => setSharing(e.target.value)}
              disabled={busy}
            >
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {runtimes[c.runtime]} ·{" "}
                  {c.mission.role === "coordinator" ? "Coordinator" : "Agent"} ·{" "}
                  {c.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="d-field">
            Agent name
            <input
              name="label"
              required
              maxLength={120}
              placeholder="For example, accessibility-researcher"
              disabled={busy}
            />
          </label>
          <p className="d-field-help">
            Shares this name, your display name, runtime and role with the
            mission. Your workspace and local allowance stay on this device.
          </p>
          <button className="d-button primary" disabled={busy || !choice}>
            Share agent
          </button>
        </form>
      ) : null}
      {agents.length ? (
        <label className="d-field n-agent-filter">
          <span className="sr-only">Find an agent</span>
          <input
            type="search"
            placeholder="Find an agent, contributor or runtime"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      ) : null}
      {!loaded && !error ? <p role="status">Loading agents…</p> : null}
      {loaded && !agents.length ? (
        <div className="n-empty-members">
          <p>
            No agents shared yet. Prepare a contribution, then share it here so
            everyone can see its role and direction.
          </p>
        </div>
      ) : null}
      {loaded && agents.length > 0 && !filtered.length ? (
        <p>No matching agents.</p>
      ) : null}
      <div className="n-agent-list">
        {filtered.map((a) => {
          const c = local.find((c) => c.sharedAgent?.registration === a.id);
          const expanded = selected === a.id;
          const canDirect =
            isOwner &&
            mission.lifecycle.phase === "active" &&
            ["direction_assigned", "waiting_for_direction"].includes(a.status);
          return (
            <article key={a.id} className="n-agent-row" data-agent={a.id}>
              <button
                className="n-agent-summary"
                aria-expanded={expanded}
                onClick={() => {
                  setSelected(expanded ? null : a.id);
                  setDirection(null);
                  setWithdraw(null);
                }}
              >
                <span className="n-avatar">
                  {a.identity.runtime === "grok"
                    ? "GR"
                    : a.identity.runtime === "claude"
                      ? "CC"
                      : "CX"}
                </span>
                <span>
                  <strong>{a.identity.label}</strong>
                  <span className="d-field-help">
                    {runtimeName(a.identity.runtime)} ·{" "}
                    {a.identity.role === "coordinator"
                      ? "Coordinator"
                      : "Agent"}
                  </span>
                  <span className="d-field-help">
                    Contributed by{" "}
                    {a.contributor === localKey
                      ? "you"
                      : a.identity.contributor_name === "You"
                        ? `Participant ${a.contributor.slice(0, 8)}`
                        : a.identity.contributor_name}
                  </span>
                  <span
                    className={`n-agent-state ${a.status === "waiting_for_direction" ? "waiting" : ""}`}
                  >
                    {statuses[a.status]}
                  </span>
                </span>
              </button>
              {expanded ? (
                <div className="n-agent-detail">
                  <h4>Direction · Main</h4>
                  <p className="n-preserve">
                    {a.direction?.text ??
                      (a.status === "waiting_for_direction"
                        ? "The Coordinator or mission owner must give this late arrival a direction."
                        : "No active direction.")}
                  </p>
                  <div className="n-action-row">
                    <button
                      className="d-button"
                      disabled={
                        busy ||
                        [
                          "revoked",
                          "withdrawn",
                          "conflict",
                          "review_required",
                        ].includes(a.status)
                      }
                      onClick={() => message(a, false)}
                    >
                      Address in Main
                    </button>
                    <button
                      className="d-button"
                      disabled={
                        busy ||
                        [
                          "revoked",
                          "withdrawn",
                          "conflict",
                          "review_required",
                        ].includes(a.status)
                      }
                      onClick={() => message(a, true)}
                    >
                      Message privately
                    </button>
                  </div>
                  {a.assignment ? (
                    <p className="d-field-help">
                      Workstream · {a.assignment.name}
                      {a.assignment.stale
                        ? " · Goal changed; new direction needed"
                        : ""}
                    </p>
                  ) : null}
                  {a.direction ? (
                    <p className="d-field-help">
                      {a.direction.author === mission.owner
                        ? "Mission owner"
                        : "Coordinator"}{" "}
                      ·{" "}
                      {a.direction.source === "individual"
                        ? "Individual direction"
                        : a.direction.source === "workstream"
                          ? "Workstream direction"
                          : "Shared mission direction"}
                      .{" "}
                      {a.acknowledgment
                        ? "Direction acknowledged by this agent; execution remains unavailable."
                        : "Awaiting agent acknowledgment; no process has started."}
                    </p>
                  ) : null}
                  {canDirect ? (
                    <button
                      className="d-button"
                      disabled={busy}
                      onClick={() =>
                        setDirection({
                          id: a.id,
                          revision: mission.lifecycle.revision,
                          text:
                            a.direction?.source === "individual"
                              ? a.direction.text
                              : "",
                        })
                      }
                    >
                      Give direction
                    </button>
                  ) : null}
                  {direction?.id === a.id ? (
                    <form
                      className="n-agent-direction"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void perform(async () => {
                          await node.directAgent(
                            mission.id,
                            direction.revision,
                            a.id,
                            direction.text,
                          );
                          setDirection(null);
                          await refresh();
                        });
                      }}
                    >
                      <label className="d-field">
                        Direction in Main
                        <textarea
                          required
                          rows={4}
                          maxLength={2048}
                          value={direction.text}
                          onChange={(e) =>
                            setDirection({ ...direction, text: e.target.value })
                          }
                        />
                      </label>
                      <p className="d-field-help">
                        Visible to the mission. Your instruction takes
                        precedence over Coordinator direction.
                      </p>
                      {direction.revision !== mission.lifecycle.revision ? (
                        <p role="status">
                          Mission instructions changed. Reopen this editor
                          before assigning.
                        </p>
                      ) : null}
                      <div className="n-action-row">
                        <button
                          type="button"
                          className="d-button"
                          onClick={() => setDirection(null)}
                        >
                          Cancel
                        </button>
                        <button
                          className="d-button primary"
                          disabled={
                            busy ||
                            !direction.text.trim() ||
                            direction.revision !== mission.lifecycle.revision
                          }
                        >
                          Assign direction
                        </button>
                      </div>
                    </form>
                  ) : null}
                  {c ? (
                    <details className="n-agent-device">
                      <summary>On your computer</summary>
                      <p className="d-mono n-key">{c.workspace}</p>
                      <button
                        className="d-button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await desktop.reveal(c.id);
                          })
                        }
                      >
                        <FolderOpen size={15} /> Open workspace
                      </button>
                      <p className="d-field-help">
                        Local consent:{" "}
                        {c.status === "prepared" ? "prepared" : "revoked"}.
                        Execution remains unavailable.
                      </p>
                      {c.status === "prepared" ? (
                        <button
                          className="d-button"
                          disabled={busy}
                          onClick={() => setWithdraw(c.id)}
                        >
                          Withdraw agent…
                        </button>
                      ) : null}
                    </details>
                  ) : null}
                  {withdraw === c?.id && c ? (
                    <div className="n-withdraw-confirm">
                      <p>
                        Revoke this contribution and tell the mission it is
                        withdrawn? Its workspace and previous history are
                        preserved.
                      </p>
                      <div className="n-action-row">
                        <button
                          className="d-button"
                          onClick={() => setWithdraw(null)}
                        >
                          Cancel
                        </button>
                        <button
                          className="d-button"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await node.withdrawAgent(mission.id, c.id);
                              setWithdraw(null);
                              await refresh();
                            })
                          }
                        >
                          Withdraw agent
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <details className="n-agent-device">
                    <summary>Identity details</summary>
                    <p className="d-field-help">
                      Display names are chosen by contributors. This signing
                      identity distinguishes agents with the same name.
                    </p>
                    <code className="n-key">{a.identity.author}</code>
                  </details>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
