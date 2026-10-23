import { useState } from "react";
import { useApplication } from "../desktop/ApplicationProvider";
import type { LocalState, NodeState } from "../application/contracts/workspace";
import { date, type Perform } from "../desktop/ui";
import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import { ViewTabs } from "../ui/ViewTabs";
import { Disclosure } from "../ui/Disclosure";
import { NetworkSettings } from "../desktop/Peers";
import { DeviceDiscovery } from "../desktop/Discovery";
import { BackgroundSetting } from "../desktop/BackgroundSetting";
import { NodeRecovery } from "../desktop/NodeRecovery";

export function Settings({
  state,
  node,
  busy,
  perform,
  updated,
  renamed,
  inspect,
  initialTab = "profile",
}: {
  state: LocalState;
  node: NodeState | null;
  busy: boolean;
  perform: Perform;
  updated: () => Promise<void>;
  renamed: (state: LocalState) => void;
  inspect: (id: string) => void;
  initialTab?: "profile" | "connection" | "security" | "activity";
}) {
  const { workspace } = useApplication();
  const [tab, setTab] = useState(initialTab);
  const [saved, setSaved] = useState(false);
  return (
    <section className="w-page w-settings">
      <header className="w-page-title">
        <div>
          <span className="w-eyebrow">{state.device.name}</span>
          <h1>Settings</h1>
          <p>Your identity, connections and local preferences.</p>
        </div>
      </header>
      <ViewTabs
        label="Settings sections"
        value={tab}
        onChange={setTab}
        items={[
          { value: "profile", label: "Profile" },
          { value: "connection", label: "Connections" },
          { value: "security", label: "Security & recovery" },
          { value: "activity", label: "Activity" },
        ]}
      />
      <div hidden={tab !== "profile"}>
        <section className="w-settings-section">
          <h2>How people see you</h2>
          <p>Use a name your collaborators will recognize.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(
                new FormData(event.currentTarget).get("name"),
              );
              void perform(async () => {
                renamed(await workspace.rename(name));
                setSaved(true);
              });
            }}
          >
            <Field>
              Display name
              <input
                key={state.contributor.name}
                name="name"
                defaultValue={state.contributor.name}
                required
                maxLength={100}
                onChange={() => setSaved(false)}
              />
            </Field>
            <Button type="submit" disabled={busy}>
              Save name
            </Button>
            {saved ? (
              <span className="w-inline-confirmation" role="status">
                Saved on this Mac
              </span>
            ) : null}
          </form>
        </section>
        <BackgroundSetting />
      </div>
      {tab === "connection" ? (
        <>
          <NetworkSettings
            state={node}
            busy={busy}
            perform={perform}
            updated={updated}
          />
          <DeviceDiscovery
            state={node}
            busy={busy}
            perform={perform}
            updated={updated}
          />
        </>
      ) : null}
      <div hidden={tab !== "security"}>
        <section className="w-settings-section">
          <h2>Your keys stay here</h2>
          <p>
            Your identity is protected by macOS Keychain. Other people can
            direct shared work; they cannot grant access to your computer.
          </p>
          <NodeRecovery
            enrolled={!!node?.identity}
            perform={perform}
            updated={updated}
          />
        </section>
        <Disclosure title="Public identity and device details">
          <dl className="d-facts">
            <div>
              <dt>Contributor ID</dt>
              <dd className="d-mono">{state.contributor.id}</dd>
            </div>
            <div>
              <dt>Device ID</dt>
              <dd className="d-mono">{state.device.id}</dd>
            </div>
            <div>
              <dt>Owner public key</dt>
              <dd className="d-mono">
                {node?.identity?.owner ?? "Not created yet"}
              </dd>
            </div>
            <div>
              <dt>Node public key</dt>
              <dd className="d-mono">
                {node?.identity?.endpoint ?? "Not created yet"}
              </dd>
            </div>
          </dl>
          <p>
            Public keys identify signed records. They are not proof of a
            person’s identity.
          </p>
        </Disclosure>
        <section className="w-settings-section">
          <h2>Separate workspaces and accounts</h2>
          <p>
            Agents use their own sign-in inside isolated Lima environments. Your
            Mac’s folders and credentials are not mounted. Choose internet
            access and inspect permissions in My agents.
          </p>
        </section>
      </div>
      <div hidden={tab !== "activity"}>
        <h2>Your local decisions</h2>
        <p className="w-subtle">
          Saved on this device. Shared progress lives in mission conversations.
          This list is not a signed network audit.
        </p>
        {state.activity.length ? (
          <div className="w-activity-list">
            {state.activity.map((entry) => (
              <article key={entry.id}>
                <div>
                  <strong>{entry.label}</strong>
                  <time dateTime={entry.at}>{date(entry.at)}</time>
                </div>
                {entry.contributionId ? (
                  <Button onClick={() => inspect(entry.contributionId!)}>
                    Open contribution
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="w-empty">No local changes recorded yet.</p>
        )}
      </div>
    </section>
  );
}
