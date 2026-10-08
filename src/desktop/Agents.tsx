import { Field } from "../ui/Field";
import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { useApplication } from "./ApplicationProvider";
import { ContributionConsent } from "./ContributionApproval";
import { useEffect, useState } from "react";
import { Users, Plus, FolderOpen } from "lucide-react";
import { type Contribution } from "../application/contracts/workspace";
import type {
  AgentView,
  AgentStatus,
  MissionView,
} from "../application/contracts/node";
import { type Perform } from "./ui";
import { AgentState } from "./ExecutionStatus";
import { ExecutionPanel } from "./ExecutionPanel";
import { agentContributorLabel } from "../../shared/agent-lifecycle.mjs";

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
  permissions,
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
  permissions: (agent: AgentView) => void;
}) {
  const { missions: node, workspace: desktop } = useApplication();
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
        <Button onClick={prepare} disabled={busy}>
          <Plus size={15} /> Add agents
        </Button>
      </header>
      {selected ? (
        <Button onClick={() => setSelected(null)}>← All agents</Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {available.length && !selected ? (
        <Disclosure
          className="n-secondary-section"
          title={<>Share a prepared agent · {available.length}</>}
        >
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
            <Field>
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
                    {c.mission.role === "coordinator" ? "Coordinator" : "Agent"}{" "}
                    · {c.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              Agent name
              <input
                name="label"
                required
                maxLength={120}
                placeholder="For example, accessibility-researcher"
                disabled={busy}
              />
            </Field>
            <p className="d-field-help">
              Shares this name, your display name, runtime and role with the
              mission. Your workspace and local allowance stay on this device.
            </p>
            <Button variant="primary" type="submit" disabled={busy || !choice}>
              Share agent
            </Button>
          </form>
        </Disclosure>
      ) : null}
      {agents.length && !selected ? (
        <Field className="n-agent-filter">
          <span className="sr-only">Find an agent</span>
          <input
            type="search"
            placeholder="Find an agent, contributor or runtime"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Field>
      ) : null}
      {!loaded && !error ? <p role="status">Loading agents…</p> : null}
      {loaded && !agents.length ? (
        <div className="n-empty-members">
          <p>No agents yet. Add an agent to contribute from this Mac.</p>
        </div>
      ) : null}
      {loaded && agents.length > 0 && !filtered.length ? (
        <p>No matching agents.</p>
      ) : null}
      <div className="n-agent-list">
        {(selected ? agents.filter((a) => a.id === selected) : filtered).map(
          (a) => {
            const c = local.find((c) => c.sharedAgent?.registration === a.id);
            const expanded = selected === a.id;
            const canDirect =
              isOwner &&
              mission.lifecycle.phase === "active" &&
              ["direction_assigned", "waiting_for_direction"].includes(
                a.status,
              );
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
                      {agentContributorLabel(
                        a,
                        mission,
                        a.contributor === localKey,
                      )}
                    </span>
                    <span
                      className={`n-agent-state ${a.status === "waiting_for_direction" ? "waiting" : ""}`}
                    >
                      <AgentState
                        agent={a}
                        contribution={c}
                        mission={mission}
                      />
                    </span>
                  </span>
                </button>
                {expanded ? (
                  <div className="n-agent-detail">
                    {c ? (
                      <ExecutionPanel item={c} mission={mission} />
                    ) : (
                      <section aria-label="Remote execution source">
                        <h4>Contributor report</h4>
                        <AgentState agent={a} mission={mission} />
                        <p className="d-field-help">
                          Execution belongs to{" "}
                          {agentContributorLabel(a, mission)}. Message them for
                          device-level recovery.
                        </p>
                      </section>
                    )}
                    {a.direction || a.status === "waiting_for_direction" ? (
                      <>
                        <h4>Current direction</h4>
                        <p className="n-preserve">
                          {a.direction?.text ??
                            (a.status === "waiting_for_direction"
                              ? "The Coordinator or mission owner must give this late arrival a direction."
                              : "")}
                        </p>
                      </>
                    ) : null}
                    {isOwner && !c ? (
                      <ContributionConsent
                        mission={mission}
                        agent={a}
                        isOwner
                      />
                    ) : null}
                    <div className="n-action-row">
                      <Button
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
                      </Button>
                      <Button
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
                      </Button>
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
                          ? "Direction acknowledged by this agent. Process status is reported by its contributor."
                          : "Awaiting agent acknowledgment."}
                      </p>
                    ) : null}
                    {canDirect ? (
                      <Button
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
                      </Button>
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
                        <Field>
                          Direction in Main
                          <textarea
                            required
                            rows={4}
                            maxLength={2048}
                            value={direction.text}
                            onChange={(e) =>
                              setDirection({
                                ...direction,
                                text: e.target.value,
                              })
                            }
                          />
                        </Field>
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
                          <Button
                            type="button"

                            onClick={() => setDirection(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="primary"
                            type="submit"
                            disabled={
                              busy ||
                              !direction.text.trim() ||
                              direction.revision !== mission.lifecycle.revision
                            }
                          >
                            Assign direction
                          </Button>
                        </div>
                      </form>
                    ) : null}
                    {c ? (
                      <Disclosure
                        className="n-agent-device"
                        title={<>On your computer</>}
                      >
                        <p className="d-mono n-key">{c.workspace}</p>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await desktop.reveal(c.id);
                            })
                          }
                        >
                          <FolderOpen size={15} /> Open exported files
                        </Button>
                        <p className="d-field-help">
                          Local consent:{" "}
                          {c.status === "prepared" ? "prepared" : "revoked"}.
                          Runtime controls apply only on this device.
                        </p>
                        {c.status === "prepared" ? (
                          <Button
                            disabled={busy}
                            onClick={() => setWithdraw(c.id)}
                          >
                            Withdraw agent…
                          </Button>
                        ) : null}
                      </Disclosure>
                    ) : null}
                    {withdraw === c?.id && c ? (
                      <div className="n-withdraw-confirm">
                        <p>
                          Revoke this contribution and tell the mission it is
                          withdrawn? Its workspace and previous history are
                          preserved.
                        </p>
                        <div className="n-action-row">
                          <Button onClick={() => setWithdraw(null)}>
                            Cancel
                          </Button>
                          <Button
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
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    <Disclosure
                      className="n-agent-device"
                      title={<>Identity details</>}
                    >
                      <p className="d-field-help">
                        Display names are chosen by contributors. This signing
                        identity distinguishes agents with the same name.
                      </p>
                      <code className="n-key">{a.identity.author}</code>
                    </Disclosure>
                  </div>
                ) : null}
              </article>
            );
          },
        )}
      </div>
    </section>
  );
}
