import { createElectronClient } from "../platform/electron/client";
import { ApplicationProvider } from "./ApplicationProvider";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Desktop from "./Desktop";
import "./desktop.css";

const client = createElectronClient(window);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApplicationProvider client={client}>
      <Desktop />
    </ApplicationProvider>
  </StrictMode>,
);
