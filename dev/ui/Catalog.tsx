import { useState } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { Button, IconButton } from "../../src/ui/Button";
import { Disclosure } from "../../src/ui/Disclosure";
import { Field } from "../../src/ui/Field";
import { Status } from "../../src/ui/Status";
import { ViewTabs } from "../../src/ui/ViewTabs";
import { ActionPopover } from "../../src/ui/ActionPopover";

/** Visual/interaction reference only. No node, database, network or agent. */
export function Catalog() {
  const [view, setView] = useState("overview");
  const [lastAction, setLastAction] = useState("No action selected.");
  return (
    <main className="catalog">
      <header className="catalog-heading">
        <span className="d-label">Harakiri / Component library</span>
        <h1>One system. Every screen.</h1>
        <p>
          The designer’s IBM Plex typography, warm surfaces, quiet borders and
          vermilion actions. These are the components used by the desktop.
        </p>
      </header>
      <div className="catalog-grid">
        <section className="catalog-section" aria-labelledby="disclosures">
          <header>
            <span className="d-label">01 / Navigation</span>
            <h2 id="disclosures">Disclosures</h2>
          </header>
          <div className="catalog-sidebar">
            <span className="d-label">Mission channels</span>
            <div className="catalog-channel"># community-science-day</div>
            <Disclosure variant="sidebar" title="Archived channels" count={3}>
              {[
                "summer-festival",
                "delivery-dispatch",
                "learning-playground",
              ].map((name) => (
                <button
                  type="button"
                  className="catalog-channel"
                  key={name}
                  onClick={() => setLastAction(`Opened ${name}.`)}
                >
                  # {name}
                </button>
              ))}
            </Disclosure>
          </div>
          <Disclosure title="Mission settings">
            <Field>
              Shared plan
              <textarea placeholder="Describe the direction…" rows={3} />
            </Field>
            <p className="d-field-help">
              Collapse and reopen: your draft stays here.
            </p>
          </Disclosure>
          <Disclosure title="Revision history" count={4}>
            <p>Exact revisions remain available for inspection.</p>
          </Disclosure>
          <Disclosure
            title="A long section title that must wrap clearly on a narrow screen without hiding the control"
            count={12}
          >
            <p>Long labels wrap, the count and chevron keep their place.</p>
          </Disclosure>
        </section>
        <section className="catalog-section" aria-labelledby="actions">
          <header>
            <span className="d-label">02 / Actions</span>
            <h2 id="actions">Buttons &amp; secondary actions</h2>
          </header>
          <div className="catalog-actions">
            <Button
              variant="primary"
              onClick={() => setLastAction("Primary action selected.")}
            >
              Set up Coordinator
              <ArrowRight size={14} aria-hidden="true" />
            </Button>
            <Button onClick={() => setLastAction("Edit action selected.")}>
              Edit instructions
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                setLastAction("Stop action selected (component demo only).")
              }
            >
              Stop environment
            </Button>
            <Button disabled>Preparing…</Button>
            <Button
              size="compact"
              onClick={() => setLastAction("Thread selected.")}
            >
              Reply in thread
            </Button>
            <IconButton
              aria-label="Add criterion"
              onClick={() => setLastAction("Add criterion selected.")}
            >
              <Plus size={16} aria-hidden="true" />
            </IconButton>
            <ActionPopover label="More">
              <Button
                onClick={() => setLastAction("Mission details selected.")}
              >
                Mission details
              </Button>
              <Button onClick={() => setLastAction("Budget selected.")}>
                Budget &amp; permissions
              </Button>
            </ActionPopover>
          </div>
          <p className="d-field-help" role="status">
            {lastAction}
          </p>
          <div className="catalog-actions">
            <Status tone="success">Active</Status>
            <Status muted>Waiting for direction</Status>
          </div>
        </section>
        <section className="catalog-section" aria-labelledby="views">
          <header>
            <span className="d-label">03 / Views</span>
            <h2 id="views">Contextual navigation</h2>
          </header>
          <ViewTabs
            label="Example inspector views"
            value={view}
            onChange={setView}
            items={[
              { value: "overview", label: "Overview" },
              { value: "decisions", label: "Needs you · 1" },
              { value: "technical", label: "Technical" },
            ]}
          />
          <p aria-live="polite">
            {view === "overview"
              ? "One current step, then the details that support it."
              : view === "decisions"
                ? "Human decisions stay explicit and easy to find."
                : "Connection, identity and execution details remain inspectable."}
          </p>
        </section>
        <section className="catalog-section" aria-labelledby="fields">
          <header>
            <span className="d-label">04 / Inputs</span>
            <h2 id="fields">Fields &amp; forms</h2>
          </header>
          <form
            className="catalog-form"
            onSubmit={(e) => {
              e.preventDefault();
              setLastAction("Form submitted.");
            }}
          >
            <Field>
              Mission name
              <input
                name="mission-name"
                autoComplete="off"
                placeholder="Community science day…"
                required
              />
            </Field>
            <Field>
              Runtime
              <select name="runtime">
                <option>Grok Build</option>
                <option>Claude Code</option>
                <option>Codex</option>
              </select>
            </Field>
            <Field>
              Scope
              <textarea
                name="scope"
                rows={3}
                placeholder="What is included, excluded, and allowed…"
              />
            </Field>
            <Button type="submit">Save example</Button>
          </form>
        </section>
      </div>
      <footer>
        <span className="d-label">
          Local component reference · No mission or agent is created
        </span>
      </footer>
    </main>
  );
}
