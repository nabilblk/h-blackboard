import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { useApplication } from "./ApplicationProvider";
import { useEffect, useState } from "react";
import {
  discoveryPresentation,
  discoveryOutcomes,
} from "../../shared/discovery-presentation.mjs";
import { Compass, Copy, Radio, ShieldCheck } from "lucide-react";
import {
  type DiscoveryState,
  type NodeState,
} from "../application/contracts/workspace";
import type {
  InvitationReview,
  MissionView,
} from "../application/contracts/node";
import { Heading, Status, date, type Perform } from "./ui";

function useDiscovery(ready: boolean) {
  const { missions: node } = useApplication();
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
  }, [ready, node]);
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
  const { missions: node } = useApplication();
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
      <p>Choose where this Mac receives public mission briefs.</p>
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
          <Field>
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
          </Field>
          <div className="n-action-row">
            <Button variant="primary" type="submit">
              Save discovery settings
            </Button>
          </div>
        </fieldset>
      </form>
      {value.peer_ticket ? (
        <Disclosure
          className="n-secondary-section"
          title={<>Share this Mac’s discovery address</>}
        >
          <div className="n-invite-copy">
            <Field>
              This node’s community address
              <input
                value={value.peer_ticket}
                readOnly
                onFocus={(e) => e.target.select()}
              />
            </Field>
            <Button
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
            </Button>
            <p className="d-field-help">
              This shares a discovery route, not mission membership. You can
              replace any peer or relay.
            </p>
          </div>
        </Disclosure>
      ) : null}
      {value.config.blocked.length ? (
        <Disclosure
          title={<>Hidden publishers · {value.config.blocked.length}</>}
        >
          {value.config.blocked.map((key) => (
            <div className="n-peer-row" key={key}>
              <code className="n-key">{key}</code>
              <Button
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
              </Button>
            </div>
          ))}
        </Disclosure>
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
  const { missions: node } = useApplication();
  const discovery = useDiscovery(state?.status === "ready");
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const presentation = discoveryPresentation({
    state: discovery.state,
    online: !!state?.connection?.running,
    query,
    error: discovery.error,
  });
  const visible = presentation.visible;
  const fix = () =>
    presentation.action === "network"
      ? network()
      : presentation.action === "clear"
        ? setQuery("")
        : setSettings(true);
  return (
    <>
      <Heading
        section="Your space / Discover"
        title="Find a mission to join."
        action={
          <Button
            onClick={() => setSettings((v) => !v)}
            aria-expanded={settings}
          >
            Discovery settings
          </Button>
        }
      >
        Find a shared mission and request to join.
      </Heading>
      <section
        className={`d-panel n-discovery-health ${visible.length && !presentation.action ? "compact" : ""}`}
        aria-label="Discovery connection status"
      >
        <h2 role="status">{presentation.title}</h2>
        <p>{presentation.detail}</p>
        {presentation.action && !settings ? (
          <Button onClick={fix}>
            {presentation.action === "network"
              ? "Connect to peers"
              : presentation.action === "clear"
                ? "Clear search"
                : "Configure discovery"}
          </Button>
        ) : null}
        {presentation.peers.length ? (
          <Disclosure
            title={<>Discovery connections · {presentation.peers.length}</>}
          >
            {presentation.peers.map((peer) => (
              <div className="n-peer-row" key={peer.name}>
                <div>
                  <strong>{peer.name}</strong>
                  <p>
                    {discoveryOutcomes[peer.outcome]}
                    {peer.checking && peer.outcome !== "contacting"
                      ? " · retrying"
                      : ""}
                  </p>
                  <p className="d-field-help">
                    {peer.last_success_ms
                      ? `Last exchange ${new Date(peer.last_success_ms).toLocaleTimeString()} · ${peer.received} briefs in that page`
                      : "No successful exchange observed"}
                    {peer.last_attempt_ms
                      ? ` · Last attempt ${new Date(peer.last_attempt_ms).toLocaleTimeString()}`
                      : ""}
                  </p>
                </div>
              </div>
            ))}
          </Disclosure>
        ) : null}
      </section>
      {discovery.error ? <p role="alert">{discovery.error}</p> : null}
      {discovery.state && settings ? (
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
      <Field>
        Find a public mission
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search received titles, briefs and capabilities"
        />
      </Field>
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
            <Disclosure
              title={<>Signed publisher · {item.publisher.slice(0, 12)}</>}
            >
              <code className="n-key">{item.publisher}</code>
              <p className="d-field-help">
                The signature identifies this key. Live review checks its
                authority over the mission; it does not verify a person’s
                identity.
              </p>
            </Disclosure>
            <p className="d-field-help">
              Listing v{item.advertisement.revision} · expires{" "}
              {date(new Date(item.advertisement.expires_ms).toISOString())}
            </p>
            <div className="n-action-row">
              <Button
                variant="primary"
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
              </Button>
              {item.publisher !== state?.identity?.owner ? (
                <Button
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
                </Button>
              ) : null}
            </div>
          </article>
        ))}
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
  const { missions: node } = useApplication();
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
          <Button onClick={network}>Enable discovery in This device</Button>
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
          <Field>
            Public summary
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={2000}
              required
              placeholder="What can people help with?"
            />
          </Field>
          <Field>
            Requested capabilities · optional
            <input
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="Research, accessibility, testing"
            />
            <span className="d-field-help">
              Up to eight, separated by commas.
            </span>
          </Field>
          <div className="n-action-row">
            <Button
              variant="primary"
              disabled={!discovery.state?.config.enabled}
              type="submit"
            >
              {item?.status === "available"
                ? "Update public brief"
                : "Publish public brief"}
            </Button>
            {item?.advertisement.active ? (
              <Button
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
              </Button>
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
