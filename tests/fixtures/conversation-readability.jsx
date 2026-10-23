import { createRoot } from "react-dom/client";
import { Message } from "../../src/desktop/ConversationMessage";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../../src/desktop/desktop.css";
const hash = "a".repeat(64);
window.calls = [];
const text = `The first circuit experience is ready for review.\n\n- The switch now changes the current immediately.\n- Keyboard controls and reduced motion still need an independent check.\n\n[Open Circuit explorer](harakiri://artifact/${hash})\n\nExact input: ${"b".repeat(64)}.\n\n[Unsafe link](javascript:alert(1))`;
createRoot(document.getElementById("root")).render(
  <main style={{ maxWidth: 900, margin: "24px auto", padding: 24 }}>
    <p className="d-label">Renderer fixture · Main</p>
    <Message
      message={{
        id: hash,
        author: "author",
        author_agent: "agent",
        author_label: "Grok builder",
        kind: "message",
        text,
        created_at_ms: Date.now(),
        audience: "main",
        unread: false,
        provisional: false,
        replies: 2,
      }}
      role="coordinator"
      runtime="grok"
      owner="owner"
      label={(id) => id}
      profile={(id) => window.calls.push({ kind: "agent", id })}
      reply={() => window.calls.push({ kind: "reply" })}
      openWork={(kind, id) => window.calls.push({ kind, id })}
    />
  </main>,
);
