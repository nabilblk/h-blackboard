// Renderer fixture for the real draft service in an isolated temporary journal.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ApplicationProvider } from "../../src/desktop/ApplicationProvider";
import { CreateMission } from "../../src/desktop/MissionDraft";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../../src/desktop/desktop.css";
const call = async (method, input = {}) => {
  const response = await fetch(`/draft/${method}`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const drafting = Object.fromEntries(
  [
    "current",
    "runtimes",
    "edit",
    "send",
    "stop",
    "undo",
    "resolve",
    "review",
    "create",
    "discard",
    "signIn",
    "openLogin",
    "cancelLogin",
  ].map((method) => [
    method,
    (input) => call(method, typeof input === "string" ? { id: input } : input),
  ]),
);
function Fixture() {
  const [place, setPlace] = useState("draft");
  return (
    <ApplicationProvider client={{ drafting }}>
      <main className="d-content" style={{ maxWidth: 1120, height: "100dvh" }}>
        {place === "draft" ? (
          <CreateMission
            enrolled
            busy={false}
            perform={async (fn) => {
              await fn();
              return true;
            }}
            cancel={() => setPlace("away")}
            complete={async () => setPlace("created")}
          />
        ) : place === "created" ? (
          <h1>Mission created in Preparing</h1>
        ) : (
          <button onClick={() => setPlace("draft")}>Reopen draft</button>
        )}
      </main>
    </ApplicationProvider>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
