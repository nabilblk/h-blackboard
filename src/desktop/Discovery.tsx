import { useEffect, useState } from "react";
import { Compass, Copy, Radio, ShieldCheck } from "lucide-react";
import { node, type DiscoveryState, type NodeState } from "./bridge";
import type { InvitationReview, MissionView } from "./node-contract";
import { Heading, Status, date, type Perform } from "./ui";

function useDiscovery(ready: boolean) {
  const [state, setState] = useState<DiscoveryState | null>(null);
  const [error, setError] = useState("");
  const refresh = async () => setState(await node.discoveryState());
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await node.discoveryState();
        if (!stopped) {
          setState(value);
          setError("");
        }
      } catch (e) {
        if (!stopped)
          setError(
            e instanceof Error ? e.message : "Discovery is unavailable.",
          );
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [ready]);
  return { state, error, refresh };
}

export function DiscoverySettings({
  value,
  busy,
  perform,
  updated,
  allowLan,
}: {
  value: DiscoveryState;
  busy: boolean;
  perform: Perform;
  updated: () => Promise<void>;
  allowLan: boolean;
}) {
  const [enabled, setEnabled] = useState(value.config.enabled);
  const [lan, setLan] = useState(value.config.lan);
  const [bootstrap, setBootstrap] = useState(value.config.bootstrap.join("\n"));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setEnabled(value.config.enabled);
    setLan(value.config.lan);
    setBootstrap(value.config.bootstrap.join("\n"));
  }, [
    value.config.enabled,
    value.config.lan,
    value.config.bootstrap.join("\n"),
  ]);
  return (
    <section
      className="d-panel n-discovery-settings"
      aria-label="Discovery settings"
    >
      <header>
        <Compass size={19} />
        <h2>Your discovery network</h2>
        <Status muted={!value.config.enabled}>
          {value.config.enabled ? "On" : "Off"}
        </Status>
      </header>
      <p>
        Choose how this node exchanges public mission listings. No central
        directory or Harakiri account is required.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            await node.configureDiscovery({
              enabled,
              lan: enabled && lan,
              bootstrap: bootstrap
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              blocked: value.config.blocked,
            });
            await updated();
            setCopied(false);
          });
        }}
      >
        <fieldset className="n-fields" disabled={busy}>
          <label className="n-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Exchange signed public listings
          </label>
          <p className="d-field-help">
            Other connected discovery peers can read and forward cached public
            listings. Your private missions and conversations are excluded.
            Publishing a mission is a separate choice.
          </p>
          <label className="n-check">
            <input
              type="checkbox"
              checked={lan}
              disabled={!enabled || !allowLan}
              onChange={(e) => setLan(e.target.checked)}
            />
            Find and announce Blackboard nodes on this local network
          </label>
          <p className="d-field-help">
            LAN discovery broadcasts your node identity and connection addresses
            to nearby devices. Enable local IP routes in Peer network first.
          </p>
          <label className="d-field">
            Community peer addresses
            <textarea
              value={bootstrap}
              rows={3}
              onChange={(e) => setBootstrap(e.target.value)}
              spellCheck={false}
              placeholder="harakiri://peer/…"
            />
            <span className="d-field-help">
              Optional: paste up to eight peer addresses, one per line. Each
              peer can forward listings from others. Addresses expire; ask for a
              fresh one if a route no longer works.
            </span>
          </label>
          <div className="n-action-row">
            <button className="d-button primary" type="submit">
              Save discovery settings
            </button>
          </div>
        </fieldset>
      </form>
      {value.peer_ticket ? (
        <div className="n-invite-copy">
          <label className="d-field">
            This node’s community address
            <input
              value={value.peer_ticket}
              readOnly
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button
            className="d-button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await node.copyPeerTicket();
                setCopied(true);
              })
            }
          >
            <Copy size={15} />
            {copied ? "Copied" : "Copy peer address"}
          </button>
          <p className="d-field-help">
            This shares a discovery route, not mission membership. You can
            replace any peer or relay.
          </p>
        </div>
      ) : null}
      {value.config.blocked.length ? (
        <details>
          <summary>Hidden publishers · {value.config.blocked.length}</summary>
          {value.config.blocked.map((key) => (
            <div className="n-peer-row" key={key}>
              <code className="n-key">{key}</code>
              <button
                className="d-button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await node.configureDiscovery({
                      ...value.config,
                      blocked: value.config.blocked.filter((k) => k !== key),
                    });
                    await updated();
                  })
                }
              >
                Show again
              </button>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

export function Discover({
  state,
  busy,
  perform,
  updated,
  network,
  review,
}: {
  state: NodeState | null;
  busy: boolean;
  perform: Perform;
  updated: () => Promise<void>;
  network: () => void;
  review: (reference: string, value: InvitationReview) => void;
}) {
  const discovery = useDiscovery(state?.status === "ready");
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const visible =
    discovery.state?.listings.filter(
      (v) =>
        v.status !== "unlisted" &&
        `${v.advertisement.title} ${v.advertisement.summary} ${v.advertisement.capabilities.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Heading
        section="Your space / Discover"
        title="Find a mission to join."
        action={
          <button
            className="d-button"
            onClick={() => setSettings((v) => !v)}
            aria-expanded={settings}
          >
            Discovery settings
          </button>
        }
      >
        Public briefs from your community and nearby nodes. Review a live
        mission before requesting a place.
      </Heading>
      {!state?.connection?.running ? (
        <section className="d-panel">
          <h2>Connect your node</h2>
          <p>
            Enable peer networking on this device to discover and inspect
            missions.
          </p>
          <button className="d-button primary" onClick={network}>
            Open network settings
          </button>
        </section>
      ) : null}
      {discovery.error ? <p role="alert">{discovery.error}</p> : null}
      {discovery.state && (settings || !discovery.state.config.enabled) ? (
        <DiscoverySettings
          value={discovery.state}
          busy={busy}
          perform={perform}
          allowLan={!!state?.connection?.config.allow_lan}
          updated={async () => {
            await discovery.refresh();
            await updated();
          }}
        />
      ) : null}
      <label className="d-field">
        Find a public mission
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles, briefs and capabilities"
        />
      </label>
      <section className="n-discovery-list" aria-label="Discovered missions">
        {visible.map((item) => (
          <article
            className="d-panel n-listing"
            key={`${item.publisher}:${item.advertisement.mission}`}
          >
            <header>
              <h2>{item.advertisement.title}</h2>
              <Status muted>
                {item.status === "available"
                  ? "Approval required"
                  : item.status === "stale"
                    ? "Listing expired"
                    : "Conflicting listing"}
              </Status>
            </header>
            <p>{item.advertisement.summary}</p>
            {item.advertisement.capabilities.length ? (
              <p className="d-mono">
                Looking for · {item.advertisement.capabilities.join(" / ")}
              </p>
            ) : null}
            <details>
              <summary>
                Signed publisher · {item.publisher.slice(0, 12)}
              </summary>
              <code className="n-key">{item.publisher}</code>
              <p className="d-field-help">
                The signature identifies this key. Live review checks its
                authority over the mission; it does not verify a person’s
                identity.
              </p>
            </details>
            <p className="d-field-help">
              Listing v{item.advertisement.revision} · expires{" "}
              {date(new Date(item.advertisement.expires_ms).toISOString())}
            </p>
            <div className="n-action-row">
              <button
                className="d-button primary"
                disabled={
                  busy ||
                  !state?.connection?.running ||
                  item.status !== "available"
                }
                onClick={() =>
                  void perform(async () => {
                    const checked = await node.inspectInvitation(
                      item.reference,
                    );
                    review(item.reference, checked);
                  })
                }
              >
                Review mission
              </button>
              {item.publisher !== state?.identity?.owner ? (
                <button
                  className="d-button"
                  disabled={
                    busy ||
                    !discovery.state ||
                    discovery.state.config.blocked.length >= 64
                  }
                  onClick={() =>
                    void perform(async () => {
                      if (!discovery.state) return;
                      await node.configureDiscovery({
                        ...discovery.state.config,
                        blocked: [
                          ...discovery.state.config.blocked,
                          item.publisher,
                        ],
                      });
                      await discovery.refresh();
                    })
                  }
                >
                  Hide publisher
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {!visible.length ? (
          <div className="d-empty">
            <Compass size={28} />
            <h2>
              {query ? "No matching missions" : "No public missions found yet"}
            </h2>
            <p>
              Connect to a community peer or enable LAN discovery. Only missions
              whose owners publish a brief appear here.
            </p>
          </div>
        ) : null}
      </section>
      <div className="d-explainer">
        <ShieldCheck size={17} />
        <p>
          A listing can outlive the creator’s connection. Inspection checks
          availability now. Joining always requires owner approval and never
          starts an agent.
        </p>
      </div>
    </>
  );
}

export function PublishMission({
  mission,
  busy,
  perform,
  network,
}: {
  mission: MissionView;
  busy: boolean;
  perform: Perform;
  network: () => void;
}) {
  const discovery = useDiscovery(true);
  const [summary, setSummary] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const item = discovery.state?.listings.find(
    (v) =>
      v.publisher === mission.owner && v.advertisement.mission === mission.id,
  );
  const publishedSummary = item?.advertisement.summary;
  const publishedCapabilities = item?.advertisement.capabilities.join(", ");
  useEffect(() => {
    // Automatic expiry/route renewal must not erase an unfinished edit.
    if (publishedSummary !== undefined) {
      setSummary(publishedSummary);
      setCapabilities(publishedCapabilities ?? "");
    }
  }, [publishedSummary, publishedCapabilities]);
  if (mission.definition.policy?.participation !== "approval")
    return (
      <p className="d-field-help">
        This is a private mission. It never appears in discovery.
      </p>
    );
  return (
    <section className="d-panel n-publish" aria-label="Publish a public brief">
      <header>
        <Radio size={18} />
        <h2>Public mission brief</h2>
        <Status muted>
          {item?.status === "available"
            ? "Listed"
            : item?.status === "stale"
              ? "Expired"
              : "Not listed"}
        </Status>
      </header>
      <p>
        Share the mission title and a summary you choose. People can inspect its
        objective, scope, criteria and budget before asking to join.
        Conversations and artifacts stay within the mission.
      </p>
      {discovery.error ? <p role="alert">{discovery.error}</p> : null}
      {!discovery.state?.config.enabled ? (
        <div className="n-action-row">
          <button className="d-button" onClick={network}>
            Enable discovery in This device
          </button>
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            await node.publishListing({
              mission: mission.id,
              summary: summary.trim(),
              capabilities: capabilities
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              active: true,
            });
            await discovery.refresh();
          });
        }}
      >
        <fieldset className="n-fields" disabled={busy}>
          <label className="d-field">
            Public summary
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={2000}
              required
              placeholder="What can people help with?"
            />
          </label>
          <label className="d-field">
            Requested capabilities · optional
            <input
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="Research, accessibility, testing"
            />
            <span className="d-field-help">
              Up to eight, separated by commas.
            </span>
          </label>
          <div className="n-action-row">
            <button
              className="d-button primary"
              disabled={!discovery.state?.config.enabled}
              type="submit"
            >
              {item?.status === "available"
                ? "Update public brief"
                : "Publish public brief"}
            </button>
            {item?.advertisement.active ? (
              <button
                className="d-button"
                type="button"
                onClick={() =>
                  void perform(async () => {
                    await node.publishListing({
                      mission: mission.id,
                      summary: item.advertisement.summary,
                      capabilities: item.advertisement.capabilities,
                      active: false,
                    });
                    await discovery.refresh();
                  })
                }
              >
                Stop listing
              </button>
            ) : null}
          </div>
        </fieldset>
      </form>
      <p className="d-field-help">
        Listings expire after 30 minutes and renew while your node is online
        with discovery enabled. Unlisting propagates when peers reconnect;
        cached briefs cannot be recalled.
      </p>
    </section>
  );
}

export function DeviceDiscovery({
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
  const d = useDiscovery(state?.status === "ready");
  return (
    <>
      {d.error ? <p role="alert">{d.error}</p> : null}
      {d.state ? (
        <DiscoverySettings
          value={d.state}
          busy={busy}
          perform={perform}
          allowLan={!!state?.connection?.config.allow_lan}
          updated={async () => {
            await d.refresh();
            await updated();
          }}
        />
      ) : null}
    </>
  );
}
