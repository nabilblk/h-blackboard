import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Undo2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Disclosure } from "../ui/Disclosure";
import { ViewTabs } from "../ui/ViewTabs";
import { DraftConversation } from "./DraftConversation";
import { DraftReview as MissionDraftReview } from "./DraftReview";
import { Heading, type Perform } from "./ui";
import { useApplication } from "./ApplicationProvider";
import { useMissionDraft } from "./useMissionDraft";
import { BriefEditor, DraftSettings } from "./BriefEditor";
import type {
  DraftReview,
  DraftRuntime,
  MissionDraft,
} from "../application/contracts/drafting";
import type { Runtime } from "../application/contracts/workspace";
import { briefLabels, briefReadiness } from "../../shared/mission-draft.mjs";
import "./mission-draft.css";

const names: Record<Runtime, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
};
export function CreateMission({
  cancel,
  complete,
  enrolled,
}: {
  busy: boolean;
  enrolled: boolean;
  perform: Perform;
  cancel: () => void;
  complete: (id: string) => Promise<void>;
}) {
  const { drafting: api } = useApplication();
  const {
    draft,
    edit,
    flush,
    receive,
    error: saveError,
    saving,
  } = useMissionDraft(api);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [runtimes, setRuntimes] = useState<DraftRuntime[]>([]);
  const [review, setReview] = useState<DraftReview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const imported = useRef(false);
  const refreshRuntimes = useCallback(async () => {
    try {
      setRuntimes(await api.runtimes());
      setRuntimeError("");
    } catch {
      setRuntimeError(
        "Could not check the installed runtimes. Retry or continue manually.",
      );
    }
  }, [api]);
  useEffect(() => {
    void refreshRuntimes();
  }, [refreshRuntimes]);
  const loginPending = runtimes.some(
    (r) => r.login && ["starting", "waiting"].includes(r.login.status),
  );
  useEffect(() => {
    if (!loginPending) return;
    const timer = setInterval(() => void refreshRuntimes(), 2500);
    return () => clearInterval(timer);
  }, [loginPending, refreshRuntimes]);
  useEffect(() => {
    if (!draft || imported.current) return;
    imported.current = true;
    if (
      draft.idea ||
      draft.brief.name ||
      draft.brief.objective ||
      draft.messages.length
    )
      return;
    // One-time, local-only migration of the old manual creation form.
    try {
      const raw = localStorage.getItem("harakiri.setup.v1:new-mission");
      if (!raw || raw.length > 32768) return;
      const old = JSON.parse(raw);
      if (!old.fields || typeof old.fields !== "object") return;
      const f = old.fields;
      if (typeof f.objective !== "string" && typeof f.name !== "string") return;
      edit({
        mode: "manual",
        name: String(f.name || "").slice(0, 120),
        objective: String(f.objective || "").slice(0, 4096),
        scope: String(f.scope || "").slice(0, 8192),
        criteria: [
          ...(Array.isArray(old.criteria)
            ? old.criteria.filter(
                (x: unknown) => typeof x === "string" && x.length <= 1024,
              )
            : []),
          ...(typeof old.criterion === "string" && old.criterion.trim()
            ? [old.criterion.trim()]
            : []),
        ].slice(0, 32),
        policy: {
          coordination: f.coordination === "peer" ? "peer" : "coordinated",
          participation:
            f.participation === "approval" ? "approval" : "private",
          budget: old.limited
            ? {
                mode: "limited",
                turns: Number(f.turns || 100),
                concurrency: f.concurrency ? Number(f.concurrency) : null,
                deadline_ms: f.deadline ? new Date(f.deadline).getTime() : null,
                tokens: null,
                model_cost_microusd: null,
              }
            : { mode: "unlimited" },
        },
      });
      void flush()
        .then(() => localStorage.removeItem("harakiri.setup.v1:new-mission"))
        .catch(() => {});
    } catch {
      /* Leave an unreadable old draft in place. */
    }
  }, [draft, edit, flush]);

  const act = async (operation: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await flush();
      await operation();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The action could not be completed.",
      );
    } finally {
      setWorking(false);
    }
  };
  const accept = (next: MissionDraft) => {
    receive(next);
    setReview(null);
  };
  if (!draft)
    return (
      <div className="d-panel">
        <p role={saveError ? "alert" : "status"}>
          {saveError || "Opening your saved draft…"}
        </p>
        <Button onClick={cancel}>Back to My missions</Button>
      </div>
    );
  const thinking = draft.status === "thinking";
  const frozen = ["creating", "created", "uncertain"].includes(draft.status);
  const readiness = briefReadiness(draft.brief, draft.policy);
  const runtime = runtimes.find((r) => r.runtime === draft.runtime);
  const lastChange = [...draft.changes].reverse().find((c) => !c.undone);
  const changed =
    lastChange?.fields.filter(
      (f) => draft.fieldRevisions[f] === lastChange.revision,
    ) ?? [];
  const send = (text: string) =>
    void act(async () => {
      accept(await api.send({ id: draft.id, text }));
    });
  const startAssisted = () => {
    edit({ mode: "assisted" });
    send(
      draft.idea.trim() ||
        "Help me shape a mission. Ask what I want to accomplish first.",
    );
  };
  const selectedRuntime = (
    <Field className="md-runtime">
      Use my
      <select
        aria-label="Drafting runtime"
        value={draft.runtime}
        disabled={thinking || working || frozen}
        onChange={(e) => edit({ runtime: e.target.value as Runtime })}
      >
        {Object.entries(names).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div
      className={`md-authoring ${draft.mode === "assisted" && !review && !frozen ? "md-authoring--assisted" : ""}`}
    >
      <div className="md-page-heading">
        <Button
          className="md-back"
          disabled={working || (frozen && draft.status === "creating")}
          onClick={() => void act(async () => cancel())}
        >
          <ArrowLeft size={14} /> My missions
        </Button>
        <Heading
          section="New mission · Private draft"
          title={
            draft.mode === "choice"
              ? "What would you like to accomplish?"
              : review
                ? "Review your mission."
                : "Shape your mission."
          }
          action={
            <span className="d-field-help" role="status">
              {saveError
                ? "Changes not saved"
                : saving
                  ? "Saving…"
                  : "Saved on this Mac"}
            </span>
          }
        />
      </div>
      {saveError || error ? (
        <div className="md-error" role="alert">
          <p>{saveError || error}</p>
          {saveError ? (
            <Button size="compact" onClick={() => void act(async () => {})}>
              Retry saving
            </Button>
          ) : null}
        </div>
      ) : null}
      {draft.status === "created" && draft.mission ? (
        <div className="d-panel">
          <h2>Mission created</h2>
          <p>Your mission is in Preparing.</p>
          <Button
            variant="primary"
            onClick={() =>
              void act(async () => {
                await api.discard(draft.id);
                await complete(draft.mission!);
              })
            }
          >
            Open mission <ArrowRight size={15} />
          </Button>
        </div>
      ) : draft.status === "uncertain" ? (
        <div className="d-panel">
          <p role="alert">{draft.error}</p>
          <Button onClick={cancel}>Check My missions</Button>
        </div>
      ) : review ? (
        <MissionDraftReview
          review={review}
          acknowledged={acknowledged}
          working={working}
          enrolled={enrolled}
          onAcknowledged={setAcknowledged}
          onBack={() => setReview(null)}
          onCreate={() =>
            void act(async () => {
              const created = await api.create({
                id: draft.id,
                review: review.id,
                acknowledgeOpenDecisions: acknowledged,
              });
              receive(created);
              if (created.mission) {
                await api.discard(created.id);
                await complete(created.mission);
              }
            })
          }
        />
      ) : draft.mode === "choice" ? (
        <div className="d-panel md-entry">
          <Field>
            Your idea
            <textarea
              aria-label="Your idea"
              value={draft.idea}
              onChange={(e) => edit({ idea: e.target.value })}
              rows={5}
              maxLength={8192}
              autoFocus
              placeholder="A rough idea is enough. What would a useful result look like?"
            />
          </Field>
          <div className="md-entry-actions">
            {selectedRuntime}
            <Button
              variant="primary"
              disabled={
                working || !draft.idea.trim() || runtime?.available === false
              }
              onClick={startAssisted}
            >
              Shape it with my agent <ArrowRight size={16} />
            </Button>
          </div>
          <p className="d-field-help">
            Start with a conversation. Your brief takes shape beside it, and you
            can edit anything.
          </p>
          <Button
            disabled={working}
            onClick={() =>
              edit({
                mode: "manual",
                ...(!draft.brief.objective && draft.idea
                  ? {
                      objective: draft.idea.slice(0, 4096),
                      ...(draft.idea.length > 4096 && !draft.brief.scope
                        ? { scope: draft.idea.slice(4096) }
                        : {}),
                    }
                  : {}),
              })
            }
          >
            Write the brief myself
          </Button>
          {runtime?.available === false || runtimeError ? (
            <p role="status" className="d-field-help">
              {runtimeError || runtime?.detail}{" "}
              <Button size="compact" onClick={() => void refreshRuntimes()}>
                Check again
              </Button>
            </p>
          ) : null}
          <p className="d-field-help md-local-note">
            Saved locally. Sending uses your selected provider’s subscription
            and data policy.
          </p>
        </div>
      ) : (
        <>
          <div className="md-toolbar">
            <ViewTabs
              label="Mission drafting mode"
              value={draft.mode}
              items={[
                { value: "assisted", label: "With my agent" },
                { value: "manual", label: "Write it myself" },
              ]}
              onChange={(mode) => edit({ mode })}
            />
            <span className="d-field-help">
              {thinking
                ? `${names[draft.runtime]} is shaping the brief…`
                : "Edit freely. You decide what becomes the mission."}
            </span>
          </div>
          <div
            className={`md-workspace ${draft.mode === "manual" ? "md-workspace--manual" : ""}`}
          >
            {draft.mode === "assisted" ? (
              <DraftConversation
                draft={draft}
                runtime={runtime}
                runtimeError={runtimeError}
                runtimePicker={selectedRuntime}
                working={working}
                onComposer={(composer) => edit({ composer })}
                onSend={send}
                onStop={() =>
                  void act(async () => accept(await api.stop(draft.id)))
                }
                onRefresh={() => void refreshRuntimes()}
                onSignIn={() =>
                  void act(async () => {
                    await api.signIn();
                    await refreshRuntimes();
                  })
                }
                onOpenLogin={() => void act(() => api.openLogin())}
                onCancelLogin={() =>
                  void act(async () => {
                    await api.cancelLogin();
                    await refreshRuntimes();
                  })
                }
              />
            ) : null}
            <section
              className="d-panel md-brief"
              aria-label="Editable mission brief"
            >
              <header>
                <div>
                  <div className="d-label">Mission brief</div>
                  <h2>
                    {readiness.valid
                      ? "Brief ready for review"
                      : "Your brief, taking shape"}
                  </h2>
                </div>
                {lastChange && changed.length ? (
                  <Button
                    size="compact"
                    disabled={working}
                    onClick={() =>
                      void act(async () =>
                        accept(
                          await api.undo({
                            id: draft.id,
                            change: lastChange.id,
                          }),
                        ),
                      )
                    }
                  >
                    <Undo2 size={14} /> Undo suggestion
                  </Button>
                ) : null}
              </header>
              <div className="md-brief-scroll">
                {draft.conflicts.map((p) => (
                  <div className="md-conflict" key={p.field}>
                    <h3>
                      You also edited {briefLabels[p.field].toLowerCase()}
                    </h3>
                    <p>Your version has been kept. Suggested alternative:</p>
                    <p className="md-preserve">
                      {Array.isArray(p.value) ? p.value.join("\n") : p.value}
                    </p>
                    <div className="md-choices">
                      <Button
                        disabled={working}
                        onClick={() =>
                          void act(async () =>
                            accept(
                              await api.resolve({
                                id: draft.id,
                                field: p.field,
                                accept: false,
                              }),
                            ),
                          )
                        }
                      >
                        Keep mine
                      </Button>
                      <Button
                        disabled={working}
                        onClick={() =>
                          void act(async () =>
                            accept(
                              await api.resolve({
                                id: draft.id,
                                field: p.field,
                                accept: true,
                              }),
                            ),
                          )
                        }
                      >
                        Use suggestion
                      </Button>
                    </div>
                  </div>
                ))}
                <BriefEditor
                  brief={draft.brief}
                  listInputs={draft.listInputs}
                  edit={edit}
                  changed={changed}
                  disabled={working || frozen}
                />
                <DraftSettings
                  policy={draft.policy}
                  edit={edit}
                  disabled={working || frozen}
                />
                <Disclosure title="Brief guidance and change history">
                  {draft.assessment ? (
                    <p className="d-field-help">
                      Helper’s assessment
                      {draft.assessment.revision !== draft.revision
                        ? " before your latest edits"
                        : ""}
                      : {draft.assessment.reason}
                    </p>
                  ) : null}
                  <p className="d-field-help">
                    Readiness means the brief can be reviewed. The Coordinator
                    prepares a plan after creation; only you start the mission.
                  </p>
                  {readiness.suggestions.length ? (
                    <ul className="d-field-help">
                      {readiness.suggestions.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  ) : null}
                  {[...draft.changes].reverse().map((c) => (
                    <div className="md-history" key={c.id}>
                      <span>
                        {c.fields.map((f) => briefLabels[f]).join(", ")}
                        {c.undone ? " · Undone" : ""}
                      </span>
                      {!c.undone &&
                      c.fields.some(
                        (f) => draft.fieldRevisions[f] === c.revision,
                      ) ? (
                        <Button
                          size="compact"
                          onClick={() =>
                            void act(async () =>
                              accept(
                                await api.undo({ id: draft.id, change: c.id }),
                              ),
                            )
                          }
                        >
                          Undo
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </Disclosure>
                {!readiness.valid ? (
                  <p className="d-field-help" role="status">
                    {readiness.errors[0]}
                  </p>
                ) : null}
              </div>
              <footer className="md-actions">
                <span className="d-field-help">
                  {thinking
                    ? "Finish or stop the reply before review."
                    : "Nothing starts until you say so."}
                </span>
                <Button
                  variant="primary"
                  disabled={
                    !readiness.valid ||
                    thinking ||
                    working ||
                    !!draft.conflicts.length ||
                    !!saveError
                  }
                  onClick={() =>
                    void act(async () => {
                      setReview(await api.review(draft.id));
                      setAcknowledged(false);
                    })
                  }
                >
                  Review mission <ArrowRight size={15} />
                </Button>
              </footer>
            </section>
          </div>
        </>
      )}
      {(!frozen || draft.status === "uncertain") && !review ? (
        <div className="md-draft-footer">
          {discarding ? (
            <>
              <span>
                {draft.status === "uncertain"
                  ? "Confirm you checked My missions. Discard this private draft? Any mission already created stays intact."
                  : "Discard this private brief and conversation?"}
              </span>
              <Button
                variant="danger"
                disabled={working}
                onClick={() =>
                  void act(async () => {
                    accept(await api.discard(draft.id));
                    setDiscarding(false);
                  })
                }
              >
                Discard draft
              </Button>
              <Button onClick={() => setDiscarding(false)}>Keep draft</Button>
            </>
          ) : (
            <>
              <Button
                size="compact"
                disabled={working}
                onClick={() => void act(async () => cancel())}
              >
                Save and leave
              </Button>
              <Button
                size="compact"
                disabled={working}
                onClick={() => setDiscarding(true)}
              >
                Discard…
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
