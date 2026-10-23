import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  MessageSquare,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { Brief, Runtime } from "./model";
import { Button, Details, PageTitle, Tag } from "./ui";

export function CreateMission({
  create,
  cancel,
}: {
  create: (brief: Brief) => void;
  cancel: () => void;
}) {
  const [assisted, setAssisted] = useState(true),
    [idea, setIdea] = useState(""),
    [shaped, setShaped] = useState(false);
  const [brief, setBrief] = useState<Brief>({
    name: "",
    goal: "",
    scope: "",
    criteria: [],
  });
  const [criterion, setCriterion] = useState("");
  const update = (key: keyof Brief, value: string | string[]) =>
    setBrief((b) => ({ ...b, [key]: value }));
  const ready =
    !!brief.name.trim() &&
    !!brief.goal.trim() &&
    !!brief.scope.trim() &&
    brief.criteria.length > 0;
  function shape() {
    if (!idea.trim()) return;
    setBrief((b) => ({
      ...b,
      name: b.name || "A new shared mission",
      goal: idea.trim(),
      scope:
        b.scope ||
        "Create a usable first version. Work with the information provided and flag assumptions before making consequential decisions.",
    }));
    setShaped(true);
  }
  return (
    <div className="v-page v-create">
      <Button quiet onClick={cancel}>
        <ArrowLeft size={16} />
        Back to workspace
      </Button>
      <PageTitle
        eyebrow="NEW MISSION"
        title="What would you like to accomplish?"
        description="Start with an idea. Give the team a clear destination."
      />
      <div className="v-create-grid">
        <section className="v-drafting">
          <div className="v-segment" aria-label="Drafting method">
            <button aria-pressed={assisted} onClick={() => setAssisted(true)}>
              <MessageSquare size={16} />
              With an agent
            </button>
            <button aria-pressed={!assisted} onClick={() => setAssisted(false)}>
              Write it myself
            </button>
          </div>
          {assisted ? (
            <>
              <div className="v-drafting-heading">
                <span className="v-agent-symbol">G</span>
                <div>
                  <strong>Your drafting partner</strong>
                  <span>Grok Build · private to this Mac</span>
                </div>
                <Tag>Preview</Tag>
              </div>
              <p className="v-drafting-question">
                Tell me what you have in mind. Who is it for, and what would
                make the result useful?
              </p>
              <label className="v-field">
                Your idea
                <textarea
                  rows={5}
                  autoFocus
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  placeholder="I want to plan a two-day science festival for families…"
                />
              </label>
              <Button primary disabled={!idea.trim()} onClick={shape}>
                Shape my brief
                <ArrowRight size={16} />
              </Button>
              {shaped ? (
                <div className="v-follow-up">
                  <Sparkles size={18} />
                  <div>
                    <strong>Let’s make “done” clear.</strong>
                    <p>
                      I’ve carried your goal into the brief. Add the constraints
                      that matter, then name one thing you could inspect to
                      decide whether this succeeded.
                    </p>
                    <small>
                      Scripted example response. This preview does not call a
                      model.
                    </small>
                  </div>
                </div>
              ) : (
                <p className="v-help">
                  Your brief stays editable. Nothing starts until you review it.
                </p>
              )}
            </>
          ) : (
            <div className="v-manual-note">
              <span className="v-label">A GOOD START</span>
              <h2>Outcome. Boundaries. Evidence.</h2>
              <p>
                You don’t need to design a task list. Describe what you want,
                what the agents may do, and what you’ll inspect when they
                finish.
              </p>
              <p>The Coordinator can work out the approach with you.</p>
            </div>
          )}
        </section>
        <section className="v-brief-draft" aria-label="Mission brief">
          <div className="v-section-title">
            <h2>Your mission brief</h2>
            <span className="v-label">EDITABLE</span>
          </div>
          <label className="v-field">
            Name
            <input
              value={brief.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="A short, memorable name"
            />
          </label>
          <label className="v-field">
            What should the team achieve?
            <textarea
              rows={3}
              value={brief.goal}
              onChange={(e) => update("goal", e.target.value)}
              placeholder="Describe a useful result…"
            />
          </label>
          <label className="v-field">
            What are the boundaries?
            <textarea
              rows={3}
              value={brief.scope}
              onChange={(e) => update("scope", e.target.value)}
              placeholder="Audience, constraints, permissions, and what’s out of scope…"
            />
          </label>
          <fieldset className="v-criteria-editor">
            <legend>How will you know it worked?</legend>
            {brief.criteria.map((c, i) => (
              <div key={i}>
                <Check size={16} />
                <span>{c}</span>
                <button
                  aria-label={`Remove criterion ${i + 1}`}
                  onClick={() =>
                    update(
                      "criteria",
                      brief.criteria.filter((_, j) => j !== i),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (criterion.trim()) {
                  update("criteria", [...brief.criteria, criterion.trim()]);
                  setCriterion("");
                }
              }}
            >
              <input
                aria-label="New completion criterion"
                value={criterion}
                onChange={(e) => setCriterion(e.target.value)}
                placeholder="One observable outcome"
              />
              <Button type="submit" disabled={!criterion.trim()}>
                Add
              </Button>
            </form>
          </fieldset>
          <Details title="Coordination and budget">
            <p>
              A Coordinator helps the team organise its work. A Main-only
              mission is valid; workstreams and tasks can be added when useful.
            </p>
            <p>
              No shared budget limit. Each person still chooses their own
              contribution limits.
            </p>
          </Details>
          <footer className="v-form-footer">
            <span>
              {ready
                ? "Ready for your review"
                : "Add a name, goal, scope and an outcome."}
            </span>
            <Button primary disabled={!ready} onClick={() => create(brief)}>
              Create mission
              <ArrowRight size={16} />
            </Button>
          </footer>
        </section>
      </div>
    </div>
  );
}

export function CoordinatorSetup({
  brief,
  start,
}: {
  brief: Brief;
  start: (runtime: Runtime) => void;
}) {
  const [runtime, setRuntime] = useState<Runtime>("Grok Build");
  const [step, setStep] = useState<
    "choose" | "signin" | "planning" | "plan" | "start"
  >("choose");
  const [consent, setConsent] = useState(false);
  const labels = {
    choose: "Choose your Coordinator",
    signin: "Connect your subscription",
    planning: "Let’s prepare a plan",
    plan: "Your plan is ready",
    start: "Start your mission",
  };
  return (
    <div className="v-page v-setup">
      <div className="v-setup-path">
        <span className="done">
          <Check size={14} />
          Mission defined
        </span>
        <span
          className={step === "plan" || step === "start" ? "done" : "current"}
        >
          Coordinator
        </span>
        <span className={step === "start" ? "current" : ""}>
          Review & start
        </span>
      </div>
      <PageTitle
        eyebrow={brief.name.toUpperCase()}
        title={labels[step]}
        description={
          step === "choose"
            ? "One agent helps turn the goal into a plan and keeps the team moving."
            : undefined
        }
      />
      <div className="v-setup-content">
        {step === "choose" ? (
          <>
            <div className="v-runtime-options">
              {(["Grok Build", "Claude Code", "Codex"] as Runtime[]).map(
                (r) => (
                  <button
                    key={r}
                    aria-pressed={runtime === r}
                    onClick={() => setRuntime(r)}
                  >
                    <span className="v-agent-symbol">{r.slice(0, 1)}</span>
                    <strong>{r}</strong>
                    {runtime === r ? <Check size={18} /> : null}
                  </button>
                ),
              )}
            </div>
            <p className="v-help">
              The agent runs in its own protected workspace on this Mac.
            </p>
            <Button primary onClick={() => setStep("signin")}>
              Set up {runtime}
              <ArrowRight size={16} />
            </Button>
          </>
        ) : null}
        {step === "signin" ? (
          <>
            <div className="v-success-line">
              <ShieldCheck size={20} />
              <div>
                <strong>Protected workspace ready</strong>
                <p>
                  Sign in to {runtime} for this workspace. Your Mac’s
                  credentials stay separate.
                </p>
              </div>
            </div>
            <div className="v-login-example">
              <span className="v-label">PROVIDER SIGN-IN · DEMO</span>
              <h2>Continue with {runtime}</h2>
              <p>
                The real application opens your provider’s sign-in page here.
              </p>
              <Button primary onClick={() => setStep("planning")}>
                Preview successful sign-in
                <ArrowRight size={16} />
              </Button>
              <small>
                No sign-in or credentials are used in this prototype.
              </small>
            </div>
            <Details title="If a sign-in link expires">
              <p>
                Keep this workspace and request a new link. Completed sign-ins
                remain available; expiry does not restart preparation.
              </p>
            </Details>
          </>
        ) : null}
        {step === "planning" ? (
          <>
            <p className="v-lead">
              Allow your Coordinator to read the brief and propose an approach.
            </p>
            <div className="v-permission-summary">
              <span>{runtime} on this Mac</span>
              <strong>Up to 10 minutes · 2 turns</strong>
              <span>Public internet off · protected workspace</span>
            </div>
            <Button primary onClick={() => setStep("plan")}>
              Allow planning
              <ArrowRight size={16} />
            </Button>
            <p className="v-help">
              Implementation begins only after you review the plan and start.
            </p>
          </>
        ) : null}
        {step === "plan" ? (
          <>
            <Tag tone="success">Ready for your review</Tag>
            <h2>{brief.goal}</h2>
            <ol className="v-plan-steps">
              <li>
                <strong>Establish the approach</strong>
                <p>
                  Check constraints and identify the assumptions that could
                  change the result.
                </p>
              </li>
              <li>
                <strong>Build a useful first version</strong>
                <p>
                  Share the work early. Add specialists or workstreams only
                  where they help.
                </p>
              </li>
              <li>
                <strong>Review and improve</strong>
                <p>
                  Test the result against your criteria and bring the final
                  version back to you.
                </p>
              </li>
            </ol>
            <div className="v-action-row">
              <Button onClick={() => setStep("planning")}>
                Request a different approach
              </Button>
              <Button primary onClick={() => setStep("start")}>
                Review and start
                <ArrowRight size={16} />
              </Button>
            </div>
          </>
        ) : null}
        {step === "start" ? (
          <>
            <p className="v-lead">
              The mission is ready. Decide what this Mac may contribute.
            </p>
            <div className="v-permission-summary">
              <strong>1 Coordinator · {runtime}</strong>
              <span>30 minutes · up to 6 turns</span>
              <span>
                Follow directions within this brief · public internet off
              </span>
            </div>
            <label className="v-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>I approve this plan and contribution.</span>
            </label>
            <Button primary disabled={!consent} onClick={() => start(runtime)}>
              Start mission
              <ArrowRight size={16} />
            </Button>
            <p className="v-help">
              You can pause the mission or stop your agent at any time.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
