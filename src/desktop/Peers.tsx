import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { useApplication } from "./ApplicationProvider";
import { useEffect, useState } from "react";
import { ArrowLeft, Copy, Link, Network, ShieldCheck } from "lucide-react";
import {
  type NodeState,
  type PeerState,
} from "../application/contracts/workspace";
import type {
  InvitationReview,
  NetworkMode,
} from "../application/contracts/node";
import { Heading, Status, date, type Perform } from "./ui";

export function NetworkSettings({
  state,
  busy,
  perform,
  updated,
}: {
  state: NodeState | null;
  busy: boolean;
  perform: Perform;
  updated: () => Promise<void>;
}) {
  const { missions: node } = useApplication();
  const config = state?.connection?.config;
  const [mode, setMode] = useState<NetworkMode>(config?.mode ?? "offline");
  const [lan, setLan] = useState(config?.allow_lan ?? false);
  const [relays, setRelays] = useState(config?.relays.join("\n") ?? "");
  useEffect(() => {
    setMode(config?.mode ?? "offline");
    setLan(config?.allow_lan ?? false);
    setRelays(config?.relays.join("\n") ?? "");
  }, [config?.mode, config?.allow_lan, config?.relays.join("\n")]);
  return (
    <section className="d-panel n-network" aria-label="Peer network">
      <header>
        <Network size={19} />
        <h2>Peer network</h2>
        <Status muted={!state?.connection?.running}>
          {state?.connection?.running ? "Networking on" : "Offline"}
        </Status>
      </header>
      <p>
        Connect this Mac to other participants. Missions and keys remain on your
        device.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            if (state?.status !== "ready") await node.enroll();
            await node.configureNetwork({
              mode,
              allow_lan: lan,
              relays:
                mode === "custom"
                  ? relays
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : [],
            });
            await updated();
          });
        }}
      >
        <fieldset className="n-fields" disabled={busy}>
          <Field>
            Connection mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as NetworkMode)}
            >
              <option value="offline">
                Offline · keep work on this computer
              </option>
              <option value="public_relays">Direct + public Iroh relays</option>
              <option value="direct">Direct connections only</option>
              <option value="custom">Direct + my own relays</option>
            </select>
          </Field>
          {mode === "public_relays" ? (
            <p className="d-field-help">
              This contacts Iroh’s public relay servers. They can observe
              connection metadata; they cannot read your encrypted mission
              traffic. No Harakiri server or account is required.
            </p>
          ) : null}
          {mode === "custom" ? (
            <Field>
              Relay URLs
              <textarea
                rows={3}
                value={relays}
                onChange={(e) => setRelays(e.target.value)}
                placeholder="https://relay.example.org/"
                required
              />
              <span className="d-field-help">
                One HTTPS URL per line, up to four. Use relays you trust;
                invitations cannot add a relay to this list.
              </span>
            </Field>
          ) : null}
          {mode !== "offline" ? (
            <label className="n-check">
              <input
                type="checkbox"
                checked={lan}
                onChange={(e) => setLan(e.target.checked)}
              />
              Allow local IP addresses in peer invitations and contacts
            </label>
          ) : null}
          <p className="d-field-help">
            The app remembers this choice. Going offline stops peer connections;
            your saved history stays available.
          </p>
          <div className="n-action-row">
            <Button variant="primary" type="submit">
              {busy ? "Applying…" : "Save network settings"}
            </Button>
          </div>
        </fieldset>
      </form>
      {state?.connection?.error ? (
        <p role="alert">
          The peer service could not connect. Your local records are available;
          review the connection settings and retry.
        </p>
      ) : null}
    </section>
  );
}

export function JoinMission({
  state,
  busy,
  perform,
  updated,
  back,
  open,
  initialTicket = "",
  initialReview = null,
}: {
  state: NodeState | null;
  busy: boolean;
  perform: Perform;
  updated: () => Promise<void>;
  back: () => void;
  open: (mission: string, contribute?: boolean) => void;
  initialTicket?: string;
  initialReview?: InvitationReview | null;
}) {
  const { missions: node } = useApplication();
  const [ticket, setTicket] = useState(initialTicket);
  const [review, setReview] = useState<InvitationReview | null>(initialReview);
  const [submitted, setSubmitted] = useState(false);
  const [reviewedAgain, setReviewedAgain] = useState(false);
  const [advancedNetwork, setAdvancedNetwork] = useState(false);
  const inspect = async () => {
    if (!state?.connection?.running) {
      if (state?.status !== "ready") await node.enroll();
      await node.configureNetwork({
        mode: "public_relays",
        allow_lan: false,
        relays: [],
      });
      await updated();
    }
    setReview(await node.inspectInvitation(ticket.trim()));
    setSubmitted(false);
    setReviewedAgain(true);
  };
  const status = state?.joins.find(
    (j) => j.mission === review?.mission,
  )?.status;
  useEffect(() => {
    if (status) setSubmitted(true);
  }, [status]);
  return (
    <>
      <button className="d-back" disabled={busy} onClick={back}>
        <ArrowLeft size={15} />
        My missions
      </button>
      <Heading section="Peer invitation" title="Join a shared mission.">
        Review the mission and its owner, then choose whether to request a
        place.
      </Heading>
      {!state?.connection?.running ? (
        <section className="d-panel">
          <h2>Connect to the mission</h2>
          <p>
            Enable encrypted peer connections to inspect this invitation. Public
            Iroh relays can help your computers connect and can observe
            connection metadata. This does not join, publish a mission or start
            an agent.
          </p>
          {!ticket.trim() ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (state?.status !== "ready") await node.enroll();
                  await node.configureNetwork({
                    mode: "public_relays",
                    allow_lan: false,
                    relays: [],
                  });
                  await updated();
                })
              }
            >
              Enable peer connections
            </Button>
          ) : null}
          <Button
            onClick={() => setAdvancedNetwork((v) => !v)}
            aria-expanded={advancedNetwork}
          >
            Connection options
          </Button>
          {advancedNetwork ? (
            <NetworkSettings
              state={state}
              busy={busy}
              perform={perform}
              updated={updated}
            />
          ) : null}
        </section>
      ) : null}
      {!initialReview ? (
        <section className="d-panel n-join" aria-label="Mission invitation">
          <header>
            <h2>Mission invitation</h2>
            <Link size={20} />
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(inspect);
            }}
          >
            <Field>
              Invitation link
              <input
                type="text"
                value={ticket}
                onChange={(e) => {
                  setTicket(e.target.value);
                  setReview(null);
                  setSubmitted(false);
                  setReviewedAgain(false);
                }}
                placeholder="harakiri://join/…"
                maxLength={16384}
                spellCheck={false}
                disabled={busy}
                required
              />
            </Field>
            <p className="d-field-help">
              Ask the mission’s creator for the link from Members → People &amp;
              invitations → Create invitation in their desktop app.
            </p>
            <Button
              variant="primary"
              disabled={busy || !ticket.trim()}
              type="submit"
            >
              {busy
                ? "Inspecting…"
                : state?.connection?.running
                  ? "Inspect invitation"
                  : "Connect and review"}
            </Button>
          </form>
          <div className="d-explainer">
            <ShieldCheck size={17} />
            <p>
              Inspection contacts the creator to read the signed mission brief.
              It does not join the mission or start an agent.
            </p>
          </div>
        </section>
      ) : null}
      {review ? (
        <section className="d-panel n-review" aria-label="Reviewed mission">
          <header>
            <h2>{review.definition.name}</h2>
            <Status tone="success">Signature verified</Status>
          </header>
          <h3>{review.definition.objective}</h3>
          <p className="n-preserve">{review.definition.scope}</p>
          {review.definition.criteria.length ? (
            <ul className="n-success-criteria">
              {review.definition.criteria.map((criterion, i) => (
                <li key={i}>
                  <span className="n-square" />
                  {criterion}
                </li>
              ))}
            </ul>
          ) : null}
          <Disclosure title={<>Owner and mission verification</>}>
            <dl className="d-facts">
              <div>
                <dt>Owner public key</dt>
                <dd className="d-mono n-key">{review.owner}</dd>
              </div>
              <div>
                <dt>Mission identity</dt>
                <dd className="d-mono n-key">{review.mission}</dd>
              </div>
              <div>
                <dt>Current review expires</dt>
                <dd>{date(new Date(review.expires_ms).toISOString())}</dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>
                  {review.definition.policy?.budget.mode === "unlimited"
                    ? "No budget · Unlimited"
                    : "Limited · no execution is authorized by joining"}
                </dd>
              </div>
            </dl>
          </Disclosure>
          <p className="d-field-help">
            A verified signature identifies a key, not a person. Compare the
            owner key through a channel you trust. Requesting to join shares
            your public identity and connection addresses with the owner;
            admission shares them with other mission participants.
          </p>
          <div className="n-action-row">
            {status === "review_required" && !reviewedAgain ? (
              <>
                <p>
                  The mission changed. Review the current instructions before
                  requesting again.
                </p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      setReview(await node.inspectInvitation(ticket.trim()));
                      setSubmitted(false);
                      setReviewedAgain(true);
                    })
                  }
                >
                  Review updated mission
                </Button>
              </>
            ) : submitted ? (
              <Status muted>
                {status === "admitted"
                  ? "Admitted · your mission is available"
                  : status && status !== "pending"
                    ? `Request ${status}`
                    : "Request saved · waiting for owner approval"}
              </Status>
            ) : (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await node.requestJoin(
                      ticket.trim(),
                      review.mission,
                      review.reviewed_revision,
                    );
                    setSubmitted(true);
                    setReviewedAgain(false);
                    await updated();
                  })
                }
              >
                Request to join
              </Button>
            )}
          </div>
          {!submitted && status !== "admitted" ? (
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  setReview(await node.inspectInvitation(ticket.trim()));
                  setReviewedAgain(true);
                })
              }
            >
              Refresh mission review
            </Button>
          ) : null}
          {status === "admitted" ? (
            <div className="n-action-row">
              <Button
                variant="primary"
                onClick={() => open(review.mission, true)}
              >
                Contribute an agent
              </Button>
              <Button onClick={() => open(review.mission)}>Open mission</Button>
              <p className="d-field-help">
                You can join the conversation without contributing an agent.
              </p>
            </div>
          ) : null}
          {status === "pending" ? (
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await node.withdrawMission(review.mission);
                  await updated();
                })
              }
            >
              Withdraw join request
            </Button>
          ) : null}
          <p className="d-field-help">
            Joining synchronizes authorized mission history. Open the mission
            and choose Add agents when you want to contribute. You can also
            participate as a human without running an agent.
          </p>
        </section>
      ) : null}
    </>
  );
}

export function People({
  mission,
  owner,
  localKey,
  enabled,
  busy,
  perform,
  network,
  privateMessage,
}: {
  mission: string;
  owner: string;
  localKey: string;
  enabled: boolean;
  busy: boolean;
  perform: Perform;
  network: () => void;
  privateMessage: (author: string) => void;
}) {
  const { missions: node } = useApplication();
  const [peers, setPeers] = useState<PeerState | null>(null);
  const [ticket, setTicket] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const refresh = async () => setPeers(await node.peers(mission));
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await node.peers(mission);
        if (!cancelled) {
          setPeers(result);
          setError("");
        }
      } catch (failure) {
        if (!cancelled)
          setError(
            failure instanceof Error
              ? failure.message
              : "Unable to read peer status.",
          );
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mission, node]);
  const own = owner === localKey;
  const pending = peers?.requests.filter((r) => r.status === "pending") ?? [];
  return (
    <section className="d-panel n-people" aria-label="People and invitations">
      <header>
        <h2>People and invitations</h2>
        <Status muted={!enabled}>
          {enabled ? "Networking on" : "Offline"}
        </Status>
      </header>
      <p>
        People join with their own node. Approval shares mission history; it
        never authorizes an agent to run.
      </p>
      {!enabled ? (
        <div>
          <p>
            Enable encrypted peer connections using public Iroh relays to invite
            people. Relays can observe connection metadata; this does not
            publish your mission.
          </p>
          <div className="n-action-row">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await node.configureNetwork({
                    mode: "public_relays",
                    allow_lan: false,
                    relays: [],
                  });
                  await refresh();
                })
              }
            >
              Enable peer connections
            </Button>
            <Button onClick={network}>Advanced connection options</Button>
          </div>
        </div>
      ) : own ? (
        <div className="n-action-row">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                setTicket((await node.issueInvitation(mission)).ticket);
                setCopied(false);
              })
            }
          >
            <Link size={16} />
            Create invitation
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await node.revokeInvitations(mission);
                setTicket("");
              })
            }
          >
            Expire all invitation links
          </Button>
        </div>
      ) : null}
      {ticket ? (
        <div className="n-invite-copy">
          <Field>
            Share this invitation
            <textarea
              value={ticket}
              readOnly
              rows={2}
              spellCheck={false}
              onFocus={(e) => e.target.select()}
            />
          </Field>
          <Button
            onClick={() =>
              void perform(async () => {
                await node.copyInvitation(mission);
                setCopied(true);
              })
            }
          >
            <Copy size={15} />
            {copied ? "Copied" : "Copy invitation"}
          </Button>
          <p className="d-field-help">
            Valid for seven days. Anyone with this link can inspect the brief
            and request admission; you decide who joins.
          </p>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {pending.length ? (
        <section className="n-requests" aria-label="Join requests">
          <h3>Waiting for approval · {pending.length}</h3>
          {pending.map((request) => (
            <article key={request.author} className="n-peer-row">
              <div>
                <strong>New participant</strong>
                <code className="n-key">{request.author}</code>
                <span className="d-field-help">
                  Compare this key with the person you invited.
                </span>
              </div>
              <div className="n-action-row">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await node.decideJoin(mission, request.author, false);
                      await refresh();
                    })
                  }
                >
                  Decline
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await node.decideJoin(mission, request.author, true);
                      await refresh();
                    })
                  }
                >
                  Approve
                </Button>
              </div>
            </article>
          ))}
        </section>
      ) : null}
      <div className="n-peer-list">
        {peers?.members.map((member) => {
          const delivery = peers.delivery.find(
            (d) => d.endpoint === member.endpoint,
          );
          const self = member.author === localKey;
          const recent =
            enabled &&
            !!delivery?.last_success_ms &&
            Date.now() - delivery.last_success_ms < 30_000 &&
            !delivery.last_error;
          return (
            <article key={member.author} className="n-peer-row">
              <div>
                <strong>
                  {self ? "You" : `Participant ${member.author.slice(0, 8)}`}
                  {member.author === owner ? " · Mission owner" : ""}
                </strong>
                <Disclosure
                  className="n-peer-identity"
                  title={<>Connection details</>}
                >
                  <span className="d-field-help">Participant signing key</span>
                  <code className="n-key">{member.author}</code>
                  <span className="d-field-help">Device endpoint</span>
                  <code className="n-key">{member.endpoint}</code>
                </Disclosure>
                <span className="d-field-help">
                  {member.withdrawn
                    ? "Participation withdrawn"
                    : member.revoked
                      ? "Membership revoked"
                      : self
                        ? "Your local replica"
                        : delivery?.last_success_ms
                          ? `Last exchange ${date(new Date(delivery.last_success_ms).toISOString())}${delivery.pending ? " · changes pending" : " · peer acknowledged Main"}`
                          : "Awaiting first exchange"}
                </span>
              </div>
              <div className="n-peer-actions">
                <Status muted={!recent}>
                  {member.withdrawn
                    ? "Withdrawn"
                    : member.revoked
                      ? "Revoked"
                      : self
                        ? "Local"
                        : recent
                          ? "Reached recently"
                          : "Not reached recently"}
                </Status>
                {!self && !member.revoked ? (
                  <Button
                    disabled={busy}
                    onClick={() => privateMessage(member.author)}
                  >
                    Message privately
                  </Button>
                ) : null}
                {own && !self && !member.revoked ? (
                  <Button
                    disabled={busy}
                    onClick={() => setConfirmRevoke(member.author)}
                  >
                    Revoke access…
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {confirmRevoke ? (
        <div className="d-alert n-revoke" role="alert">
          <p>
            Revoke this node’s mission access? Already delivered history stays
            on its computer. Other peers enforce revocation after receiving it.
          </p>
          <div className="n-action-row">
            <Button onClick={() => setConfirmRevoke(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await node.revokeMember(mission, confirmRevoke);
                  setConfirmRevoke(null);
                  await refresh();
                })
              }
            >
              Revoke access
            </Button>
          </div>
        </div>
      ) : null}
      <p className="d-field-help">
        Acknowledged means a peer reported saving the records. It does not mean
        a person or agent has read or acted on them.
      </p>
    </section>
  );
}
