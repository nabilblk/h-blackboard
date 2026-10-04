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
import { ExecutionRequests } from "./execution/contract.mjs";
import { ExecutionStore } from "./execution/store.mjs";
import { ExecutionManager } from "./execution/manager.mjs";
import { LimaProvider } from "./execution/lima.mjs";
import { exportWorkspace, readImportFiles } from "./execution/files.mjs";
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
      nodeService.inspectArtifact = artifacts.inspect;
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
              "Harakiri will create a dedicated folder for explicit workspace exports. Agents work inside their VM; this folder is never mounted into it.",
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
      const executions = new ExecutionManager({
        store: new ExecutionStore(
          join(app.getPath("userData"), "execution-v2"),
        ),
        provider: new LimaProvider({
          // Lima creates UNIX sockets alongside VM files. Application Support
          // paths exceed macOS' 104-byte limit. Profile-scoped instance names
          // in a private short root retain separate consent and credentials.
          directory: join(app.getPath("home"), ".harakiri", "vms"),
          namespace: app.getPath("userData"),
          resources: join(directory, "guest"),
        }),
        node: nodeService,
        exportWorkspace,
        importWorkspace: async () => {
          const result = await dialog.showOpenDialog(window, {
            title: "Share files with this isolated agent",
            message:
              "The agent can read every selected file. Imported files replace files with the same name in its VM workspace.",
            buttonLabel: "Import selected files",
            properties: ["openFile", "multiSelections"],
          });
          return result.canceled ? null : readImportFiles(result.filePaths);
        },
      });
      nodeService.executions = executions;
      // Recover saved launch intents without ever starting a new process.
      void executions.recover().catch(() => {});
      for (const [method, schema] of Object.entries(ExecutionRequests)) {
        ipcMain.handle(`execution:${method}`, async (event, input) => {
          if (!isTrustedFrame(event, window))
            return {
              ok: false,
              error: "This page cannot control local execution.",
            };
          try {
            const request = schema.parse(input);
            const id = request.contributionId;
            const actions = {
              executionState: () => executions.state(id),
              executionPrepare: () => executions.prepare(id),
              executionLogin: () => executions.login(id),
              executionStart: () => executions.start(id, request.grant),
              executionStop: () => executions.stop(id),
              executionExport: () => executions.transfer(id, "export"),
              executionImport: () => executions.transfer(id, "import"),
            };
            return { ok: true, value: await actions[method]() };
          } catch (error) {
            return {
              ok: false,
              error:
                error.name === "ZodError"
                  ? "Invalid execution request."
                  : error.message,
            };
          }
        });
      }
      for (const method of Object.keys(Requests)) {
        ipcMain.handle(`contributor:${method}`, async (event, input) => {
          if (!isTrustedFrame(event, window))
            return {
              ok: false,
              error: "This page cannot access desktop controls.",
            };
          try {
            if (method === "revoke") {
              const { contributionId } = Requests.revoke.parse(input);
              await executions.stop(contributionId, "Local consent revoked.");
            }
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
