import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  safeStorage,
  clipboard,
} from "electron";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopStore } from "./store.mjs";
import { ContributorService } from "./service.mjs";
import { inspectInvitation } from "./invitations.mjs";
import { Requests } from "./model.mjs";
import { NodeService, NodeRequests } from "./node-service.mjs";
import { createArtifactViewer } from "./artifact-viewer.mjs";
import {
  APP_URL,
  CONTENT_SECURITY_POLICY,
  isTrustedFrame,
  staticAsset,
} from "./security.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
app.setName("Harakiri Desktop");
// Development/QA can use an isolated profile. Packaged builds never accept an
// environment override for profile or private-network access.
if (!app.isPackaged && process.env.HARAKIRI_DESKTOP_DATA)
  app.setPath("userData", process.env.HARAKIRI_DESKTOP_DATA);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "harakiri-artifact",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "harakiri",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window;
  let nodeService;
  let isolatedSession;
  let quitting = false;
  app.on("before-quit", (event) => {
    isolatedSession?.flushStorageData();
    if (!nodeService || quitting) return;
    event.preventDefault();
    quitting = true;
    nodeService
      .close()
      .catch(() => {})
      .finally(() => app.quit());
  });
  app.on("second-instance", () => {
    if (window) {
      window.restore();
      window.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  // Electron waits for ESM evaluation before ready. Awaiting whenReady() at
  // module scope would prevent the readiness event from ever being emitted.
  app.whenReady().then(async () => {
    try {
      const store = new DesktopStore(
        join(app.getPath("userData"), "contributor"),
      );
      nodeService = new NodeService({
        directory: join(app.getPath("userData"), "node-v1"),
        binary: app.isPackaged
          ? join(process.resourcesPath, "node/harakiri-node")
          : join(directory, "node/harakiri-node"),
        secureStorage: safeStorage,
        writeClipboard: (value) => clipboard.writeText(value),
      });
      // Only the trusted workspace retains local drafts. Artifact viewers use
      // separate in-memory sessions and never share this storage or preload.
      isolatedSession = session.fromPartition("persist:harakiri-desktop");
      isolatedSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.on("will-download", (event) => event.preventDefault());
      isolatedSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !details.url.startsWith("harakiri://desktop/") });
      });
      const mime = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".svg": "image/svg+xml",
      };
      isolatedSession.protocol.handle("harakiri", async (request) => {
        if (request.method !== "GET")
          return new Response(null, { status: 405 });
        try {
          const file = staticAsset(join(directory, "ui"), request.url);
          return new Response(await readFile(file), {
            headers: {
              "Content-Type": mime[extname(file)] || "application/octet-stream",
              "Content-Security-Policy": CONTENT_SECURITY_POLICY,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            },
          });
        } catch {
          return new Response(null, { status: 404 });
        }
      });

      window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 650,
        title: "Harakiri · Contributor desktop",
        backgroundColor: "#0d0d0c",
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          session: isolatedSession,
          preload: join(directory, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          navigateOnDragDrop: false,
          devTools: !app.isPackaged,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const artifacts = createArtifactViewer(nodeService, () => window);
      nodeService.openArtifact = artifacts.open;
      nodeService.saveArtifact = artifacts.save;
      window.on("closed", () => artifacts.close());
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      const service = new ContributorService({
        store,
        inspect: (input) =>
          inspectInvitation(input, {
            allowLoopback:
              !app.isPackaged &&
              process.env.HARAKIRI_DESKTOP_ALLOW_LOOPBACK === "1",
          }),
        chooseDirectory: async () => {
          const result = await dialog.showOpenDialog(window, {
            title: "Choose where to keep this contribution",
            message:
              "Harakiri will create a dedicated, empty folder here. Only that folder will be eligible for a future agent workspace.",
            buttonLabel: "Choose location",
            properties: ["openDirectory", "createDirectory"],
          });
          return result.canceled ? null : result.filePaths[0];
        },
        revealDirectory: async (path) => {
          const error = await shell.openPath(path);
          if (error)
            throw new Error("The system could not open this workspace folder.");
        },
      });
      nodeService.contributors = service;
      for (const method of Object.keys(Requests)) {
        ipcMain.handle(`contributor:${method}`, async (event, input) => {
          if (!isTrustedFrame(event, window))
            return {
              ok: false,
              error: "This page cannot access desktop controls.",
            };
          try {
            return { ok: true, value: await service.handle(method, input) };
          } catch (error) {
            // System errors and validation internals do not cross the bridge.
            return {
              ok: false,
              error:
                error.code || error.name === "ZodError"
                  ? "The operation could not be completed. Check your folder access or invitation and try again."
                  : error.message || "The operation could not be completed.",
            };
          }
        });
      }
      for (const method of Object.keys(NodeRequests)) {
        ipcMain.handle(`node:${method}`, async (event, input) => {
          if (!isTrustedFrame(event, window))
            return {
              ok: false,
              error: "This page cannot access node controls.",
            };
          try {
            return { ok: true, value: await nodeService.handle(method, input) };
          } catch (error) {
            return {
              ok: false,
              error:
                error.code || error.name === "ZodError"
                  ? "The node request could not be validated. Check the mission fields and local profile access."
                  : error.message || "The local node is unavailable.",
            };
          }
        });
      }
      window.once("ready-to-show", () => window.show());
      await window.loadURL(APP_URL);
    } catch (error) {
      dialog.showErrorBox("Harakiri could not start", error.message);
      app.quit();
    }
  });
}
