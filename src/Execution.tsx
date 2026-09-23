import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge, Time } from "./ui";
import type { Agent } from "./model";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function CopyDetail({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState("");
  const [error, setError] = useState(false);
  return (
    <div className="execution-path">
      <div className="execution-path-heading">
        <span className="label">{label}</span>
        <button
          className="button small"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(value);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          {copied === value ? <Check size={12} /> : <Copy size={12} />}
          {copied === value ? "Copied" : "Copy"}
        </button>
      </div>
      <code>{value}</code>
      {error ? (
        <p className="error" role="alert">
          Select and copy the text. Clipboard access is unavailable.
        </p>
      ) : null}
    </div>
  );
}

export function AgentExecution({ agent }: { agent: Agent }) {
  const e = agent.execution;
  return (
    <section className="agent-execution">
      <h3 className="label">Local execution</h3>
      {e ? (
        <>
          <div className="execution-summary">
            <strong>{e.host}</strong>
            <Badge tone={e.permissions === "full" ? "accent" : ""}>
              {e.permissions === "full"
                ? "Full access"
                : e.permissions === "board-only"
                  ? "Board only"
                  : "Runtime defaults"}
            </Badge>
          </div>
          <p className="hint">
            {e.runtimeVersion || agent.runtime} · Launcher PID {e.pid}
          </p>
          <CopyDetail
            key={e.workspace}
            label="Working folder"
            value={e.workspace}
          />
          {e.shared && e.shared !== e.workspace ? (
            <CopyDetail
              key={e.shared}
              label="Shared mission folder"
              value={e.shared}
            />
          ) : null}
          <p className="hint">
            {e.layout === "legacy"
              ? "Existing session folder. Kept in place for this instance."
              : e.layout === "shared"
                ? "All instances in this launch use the same working folder."
                : "Separate folder for this instance; shared deliverables go in the mission folder."}
          </p>
          {e.lastError ? (
            <div className="execution-error" role="status">
              <h4>Runtime needs attention</h4>
              <pre>{e.lastError}</pre>
            </div>
          ) : null}
          <details className="execution-logs">
            <summary>Runtime logs</summary>
            <p className="hint">
              Output is written as it arrives on {e.host}. Run this command on
              that machine to follow both files. The launcher keeps up to 40 MiB
              per output stream.
            </p>
            <CopyDetail
              key={e.stdoutPath + e.stderrPath}
              label="Follow logs command"
              value={`tail -F ${quote(e.stdoutPath)} ${quote(e.stderrPath)}`}
            />
            <CopyDetail label="Output log" value={e.stdoutPath} />
            <CopyDetail label="Error log" value={e.stderrPath} />
          </details>
          <p className="hint">
            Launcher report · <Time at={e.reportedAt} />
            {!agent.online ? " · Last known settings; agent is offline." : ""}
          </p>
        </>
      ) : (
        <p className="hint">
          This instance has not reported its execution settings. New managed
          launches report their folder, permissions, and logs here. Existing
          sessions report them when resumed with the updated launcher.
        </p>
      )}
    </section>
  );
}
