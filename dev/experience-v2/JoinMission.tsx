import { useState } from "react";
import {
  ArrowRight,
  Check,
  Clock3,
  Globe2,
  Link2,
  ShieldCheck,
} from "lucide-react";
import { Button, Details, PageTitle, Tag } from "./ui";
import type { Runtime } from "./model";

export function JoinMission({
  joined,
}: {
  joined: (
    runtime: Runtime,
    count: number,
    minutes: number,
    internet: boolean,
  ) => void;
}) {
  const [step, setStep] = useState<
    "link" | "review" | "waiting" | "offer" | "signin" | "consent"
  >("link");
  const [url, setUrl] = useState("");
  const [runtime, setRuntime] = useState<Runtime>("Grok Build"),
    [count, setCount] = useState(1),
    [minutes, setMinutes] = useState(60),
    [internet, setInternet] = useState(false),
    [approved, setApproved] = useState(false),
    [signed, setSigned] = useState(0);
  const title = {
    link: "Join something worthwhile.",
    review: "See what you’re joining.",
    waiting: "Your request is with Sam.",
    offer: "Choose what you contribute.",
    signin: "Connect your agents.",
    consent: "You’re in control.",
  };
  return (
    <div className="v-page v-join">
      <PageTitle
        eyebrow="JOIN A MISSION"
        title={title[step]}
        description={
          step === "link"
            ? "Bring an agent to a shared goal. You choose what runs on your Mac."
            : undefined
        }
      />
      <div className="v-join-grid">
        <section>
          {step === "link" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (url.trim()) setStep("review");
              }}
            >
              <label className="v-field">
                Mission invitation
                <input
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste an invitation"
                />
              </label>
              <Button type="submit" primary disabled={!url.trim()}>
                Inspect invitation
                <ArrowRight size={16} />
              </Button>
              <p className="v-help">
                You’ll see the brief before requesting to join.
              </p>
              <Button
                quiet
                onClick={() => {
                  setUrl("harakiri://sample-invitation");
                  setStep("review");
                }}
              >
                Use the sample invitation
              </Button>
            </form>
          ) : null}
          {step === "review" ? (
            <>
              <Tag tone="success">Invitation from Sam</Tag>
              <h2>Little Explorers</h2>
              <p className="v-lead">
                Make a two-day science festival that 120 families will love.
              </p>
              <p>
                We need help reviewing the programme and making the family
                timetable easy to use.
              </p>
              <Details title="Scope, owner and invitation details">
                <p>
                  No bookings or purchases. £12,000 planning budget. Sam
                  approves membership; every contributor controls their own
                  agents.
                </p>
                <p className="v-mono">
                  Sample identity · never a real invitation
                </p>
              </Details>
              <Button primary onClick={() => setStep("waiting")}>
                Request to join
                <ArrowRight size={16} />
              </Button>
            </>
          ) : null}
          {step === "waiting" ? (
            <>
              <div className="v-wait-icon">
                <Clock3 size={28} />
              </div>
              <p className="v-lead">Nothing is running on your Mac.</p>
              <p>
                You can leave this page. Your place here will be saved while the
                owner reviews the request.
              </p>
              <Button onClick={() => setStep("offer")}>
                Preview owner approval
                <ArrowRight size={16} />
              </Button>
              <Button quiet onClick={() => setStep("review")}>
                Cancel request
              </Button>
            </>
          ) : null}
          {step === "offer" ? (
            <>
              <Tag tone="success">Membership approved</Tag>
              <label className="v-field">
                Agent runtime
                <select
                  value={runtime}
                  onChange={(e) => setRuntime(e.target.value as Runtime)}
                >
                  <option>Grok Build</option>
                  <option>Claude Code</option>
                  <option>Codex</option>
                </select>
              </label>
              <div className="v-two-fields">
                <label className="v-field">
                  Agents
                  <select
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                  >
                    <option value={1}>1 agent</option>
                    <option value={2}>2 agents</option>
                    <option value={3}>3 agents</option>
                  </select>
                </label>
                <label className="v-field">
                  Time for each agent
                  <select
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                  >
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={120}>2 hours</option>
                  </select>
                </label>
              </div>
              <label className="v-check">
                <input
                  type="checkbox"
                  checked={internet}
                  onChange={(e) => setInternet(e.target.checked)}
                />
                <span>
                  Allow public internet access
                  <small>
                    Public HTTPS only. Local networks and host files remain
                    blocked.
                  </small>
                </span>
              </label>
              <Details title="Execution limits">
                <p>
                  Each agent gets up to 12 turns within your time limit.
                  Provider subscription limits still apply. This mission has no
                  shared usage cap.
                </p>
              </Details>
              <Button primary onClick={() => setStep("signin")}>
                Prepare {count === 1 ? "my agent" : `${count} agents`}
                <ArrowRight size={16} />
              </Button>
            </>
          ) : null}
          {step === "signin" ? (
            <>
              <div className="v-success-line">
                <ShieldCheck size={20} />
                <strong>Protected workspaces ready</strong>
              </div>
              <p className="v-lead">
                Sign in to {runtime} for agent {signed + 1} of {count}.
              </p>
              <p>
                We’ll handle one sign-in at a time. Completed sign-ins are kept.
              </p>
              <Button
                primary
                onClick={() => {
                  if (signed + 1 >= count) setStep("consent");
                  else setSigned(signed + 1);
                }}
              >
                Preview successful sign-in
                <ArrowRight size={16} />
              </Button>
              <p className="v-help">
                Demo only. This button never opens a real provider login.
              </p>
            </>
          ) : null}
          {step === "consent" ? (
            <>
              <Tag tone="success">Your agents are ready</Tag>
              <h2>Review your contribution</h2>
              <div className="v-permission-summary">
                <strong>
                  {count} {runtime} {count === 1 ? "agent" : "agents"} on this
                  Mac
                </strong>
                <span>Each: {minutes} minutes · up to 12 turns</span>
                <span>Public internet {internet ? "allowed" : "off"}</span>
              </div>
              <p>
                Assignment: review the family timetable against the mission
                brief. Your agents can follow further directions within that
                scope.
              </p>
              <label className="v-check">
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                />
                <span>I approve this contribution.</span>
              </label>
              <Button
                primary
                disabled={!approved}
                onClick={() => joined(runtime, count, minutes, internet)}
              >
                Start contributing
                <ArrowRight size={16} />
              </Button>
            </>
          ) : null}
        </section>
        <aside className="v-join-promise">
          <Link2 size={26} />
          <h2>
            A shared mission.
            <br />
            Your own agents.
          </h2>
          <ul>
            <li>
              <Check size={17} />
              You decide how much to contribute.
            </li>
            <li>
              <ShieldCheck size={17} />
              Work stays in protected workspaces.
            </li>
            <li>
              <Globe2 size={17} />
              The team can collaborate across computers.
            </li>
          </ul>
          <p>
            Stop your contribution whenever you need to. Saved work remains
            available to the mission.
          </p>
        </aside>
      </div>
    </div>
  );
}
