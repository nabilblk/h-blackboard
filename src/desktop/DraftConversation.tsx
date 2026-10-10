import { useEffect, useRef, type ReactNode } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Disclosure } from "../ui/Disclosure";
import { Text } from "../Markdown";
import type {
  MissionDraft,
  DraftRuntime,
} from "../application/contracts/drafting";

const names = { claude: "Claude Code", codex: "Codex", grok: "Grok Build" };
export function DraftConversation({
  draft,
  runtime,
  runtimeError,
  runtimePicker,
  working,
  onSend,
  onComposer,
  onStop,
  onRefresh,
  onSignIn,
  onOpenLogin,
  onCancelLogin,
}: {
  draft: MissionDraft;
  runtime?: DraftRuntime;
  runtimeError: string;
  runtimePicker: ReactNode;
  working: boolean;
  onSend: (text: string) => void;
  onComposer: (text: string) => void;
  onStop: () => void;
  onRefresh: () => void;
  onSignIn: () => void;
  onOpenLogin: () => void;
  onCancelLogin: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const thinking = draft.status === "thinking";
  const blocked =
    thinking ||
    working ||
    !!draft.conflicts.length ||
    runtime?.available === false;
  const savedLogin = ["saved", "signed_in"].includes(
    runtime?.login?.status ?? "",
  );
  useEffect(() => {
    const container = log.current;
    if (!container) return;
    // A complete response arrives at once. Start at its beginning instead of
    // jumping past a long reply/question to the last choice.
    const latest =
      draft.status === "idle"
        ? container.querySelector(".md-message:last-child")
        : null;
    container.scrollTop = latest
      ? container.scrollTop +
        latest.getBoundingClientRect().top -
        container.getBoundingClientRect().top
      : container.scrollHeight;
  }, [draft.messages.length, draft.status]);
  return (
    <section
      className="d-panel md-conversation"
      aria-label="Private drafting conversation"
    >
      <header>
        {runtimePicker}
        {thinking ? (
          <Button size="compact" onClick={onStop} disabled={working}>
            <Square size={12} /> Stop
          </Button>
        ) : null}
      </header>
      <div className="md-chat-scroll" ref={log}>
        <div
          className="md-messages"
          role="log"
          aria-label="Drafting messages"
          aria-relevant="additions"
        >
          {!draft.messages.length ? (
            <p className="d-field-help">
              Tell your helper what you want to accomplish. Your current brief
              travels with your message.
            </p>
          ) : null}
          {draft.messages.map((m) => (
            <article key={m.id} className={`md-message md-message--${m.role}`}>
              <div className="md-message-author">
                {m.role === "user" ? "You" : names[m.runtime]}
              </div>
              <Text value={m.text} links="text" />
            </article>
          ))}
        </div>
        {thinking ? (
          <p className="d-field-help" role="status">
            Shaping your brief… You can keep editing.
          </p>
        ) : null}
        {draft.error ? (
          <div className="md-recovery" role="status">
            <p>{draft.error}</p>
            {draft.status === "error" ? (
              <Button
                size="compact"
                disabled={blocked}
                onClick={() =>
                  onSend(
                    "Please retry the last request, preserving my current brief and edits.",
                  )
                }
              >
                Retry last request
              </Button>
            ) : null}
          </div>
        ) : null}
        {draft.question && !thinking ? (
          <div className="md-question">
            <h3>{draft.question.text}</h3>
            <div className="md-choices">
              {draft.question.choices.map((choice) => (
                <Button
                  key={choice}
                  disabled={blocked}
                  onClick={() => onSend(`${draft.question!.text}\n${choice}`)}
                >
                  {choice}
                </Button>
              ))}
            </div>
            <div className="md-choices">
              <Button
                size="compact"
                disabled={blocked}
                onClick={() =>
                  onSend(
                    `${draft.question!.text}\nI don't know. Suggest an option and label it as a proposed assumption.`,
                  )
                }
              >
                Suggest something
              </Button>
              <Button
                size="compact"
                disabled={blocked}
                onClick={() =>
                  onSend(
                    `${draft.question!.text}\nLet the team investigate. Keep this as an open question in the brief.`,
                  )
                }
              >
                Let the team investigate
              </Button>
            </div>
          </div>
        ) : null}
        {runtime?.privateLogin && !savedLogin ? (
          <div className="md-recovery">
            <p className="d-field-help">
              Sign in once for private Grok drafting. Your usual hooks and
              plugins stay out of this session.
            </p>
            {runtime.login?.status === "waiting" ? (
              <>
                <p className="d-mono">Code: {runtime.login.code}</p>
                <Button disabled={working || thinking} onClick={onOpenLogin}>
                  Open Grok sign-in
                </Button>
                <Button onClick={onCancelLogin}>Cancel sign-in</Button>
              </>
            ) : (
              <Button
                disabled={
                  runtime.login?.status === "starting" || working || thinking
                }
                onClick={onSignIn}
              >
                {runtime.login?.status === "starting"
                  ? "Requesting sign-in…"
                  : "Sign in to private drafting"}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <form
        className="md-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked && draft.composer.trim()) onSend(draft.composer.trim());
        }}
      >
        <Field>
          <span className="d-label">Your message</span>
          <textarea
            aria-label="Message your drafting helper"
            rows={3}
            value={draft.composer}
            maxLength={8192}
            placeholder="Add context, answer, or change direction…"
            onChange={(e) => onComposer(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === "Enter" &&
                draft.composer.trim() &&
                !blocked
              ) {
                e.preventDefault();
                onSend(draft.composer.trim());
              }
            }}
          />
        </Field>
        <div className="md-actions">
          <span className="d-field-help">Private · {names[draft.runtime]}</span>
          <Button
            variant="primary"
            type="submit"
            disabled={blocked || !draft.composer.trim()}
          >
            Send <Send size={14} />
          </Button>
        </div>
      </form>
      <Disclosure title="Runtime and privacy">
        <p className="d-field-help">
          {runtime?.detail || runtimeError || "Checking your installed CLI…"}
        </p>
        <p className="d-field-help">
          This text-only helper uses a restricted local CLI profile. Mission
          agents still execute in isolated VMs. Your idea, brief and this
          conversation are sent to the selected provider.
        </p>
        <Button size="compact" onClick={onRefresh}>
          Check runtime again
        </Button>
        {runtime?.privateLogin && savedLogin ? (
          <Button
            size="compact"
            disabled={working || thinking}
            onClick={onSignIn}
          >
            Refresh Grok sign-in
          </Button>
        ) : null}
      </Disclosure>
    </section>
  );
}
