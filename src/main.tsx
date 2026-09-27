import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import App from "./App";
import "./style.css";
const ArtifactViewer = lazy(() => import("./ArtifactViewer"));
const artifactRoute = location.pathname.match(
  /^\/artifacts\/([^/]+)\/([^/]+)\/?$/,
);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {artifactRoute ? (
      <Suspense fallback={<p role="status">Opening artifact…</p>}>
        <ArtifactViewer
          channelId={decodeURIComponent(artifactRoute[1])}
          artifactId={decodeURIComponent(artifactRoute[2])}
        />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
