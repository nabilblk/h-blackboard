import { createElectronClient } from "../platform/electron/client";
import { ApplicationProvider } from "./ApplicationProvider";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Workspace from "../workspace/Workspace";
import "./desktop.css";
import "../workspace/workspace.css";

const client = createElectronClient(window);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApplicationProvider client={client}>
      <Workspace />
    </ApplicationProvider>
  </StrictMode>,
);
