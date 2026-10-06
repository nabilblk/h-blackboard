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
  Tray,
  Menu,
  nativeImage,
  powerMonitor,
  Notification,
} from "electron";
import { readFile, statfs, writeFile } from "node:fs/promises";
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
import { OnboardingService, OnboardingRequests } from "./onboarding.mjs";
import {
  ContributionAgreements,
  AgreementRequests,
} from "./contribution-agreements.mjs";
import { BackgroundPreference, BackgroundRequests } from "./background.mjs";
import { JourneyDiagnostics } from "./journey-diagnostics.mjs";
import { DecisionNotifications } from "./decision-notifications.mjs";
import { CompletionService, CompletionRequests } from "./completion.mjs";
import { LimaInstaller } from "./execution/installer.mjs";
import { invitationLink } from "./invitation-links.mjs";
import { LimaProvider } from "./execution/lima.mjs";
import { exportWorkspace, readImportFiles } from "./execution/files.mjs";
import { executionDiagnostics } from "./execution/diagnostics.mjs";
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
  let onboarding;
  let agreements;
  let completion;
  let observationTimer;
  let tray;
  let background;
  let closeReview = false;
  let pendingInvitation =
    process.argv.map(invitationLink).find(Boolean) ?? null;
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const link = invitationLink(url);
    if (link) {
      pendingInvitation = link;
      window?.show();
      window?.focus();
    }
  });
  let isolatedSession;
  let quitting = false;
  app.on("before-quit", (event) => {
    isolatedSession?.flushStorageData();
    if (!nodeService || quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(observationTimer);
    Promise.resolve(agreements?.close())
      .then(() => completion?.close())
      .then(() => onboarding?.close())
      .catch(() => {})
      .then(() => nodeService.close())
      .catch(() => {})
      .finally(() => app.quit());
  });
  app.on("second-instance", (_event, argv) => {
    const link = argv.map(invitationLink).find(Boolean);
    if (link) pendingInvitation = link;
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
        exportDirectory: join(app.getPath("documents"), "Harakiri Exports"),
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
      const installer = new LimaInstaller(
        join(app.getPath("userData"), "tools/lima"),
      );
      const provider = new LimaProvider({
        directory: join(app.getPath("home"), ".harakiri", "vms"),
        namespace: app.getPath("userData"),
        resources: join(directory, "guest"),
        installer,
      });
      const executions = new ExecutionManager({
        store: new ExecutionStore(
          join(app.getPath("userData"), "execution-v2"),
        ),
        provider,
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
      background = new BackgroundPreference(
        join(app.getPath("userData"), "app-preferences"),
      );
      const capacityCeiling = provider.maximum;
      const journey = new JourneyDiagnostics(
        join(app.getPath("userData"), "journey-diagnostics"),
      );
      provider.maximum = Math.min(
        capacityCeiling,
        background.capacity() ?? capacityCeiling,
      );
      const stopAll = async (reason) => {
        const setupStops = Promise.allSettled(
          [...(onboarding?.active ?? [])]
            .filter(([, job]) => job.done)
            .map(([id]) => onboarding.cancel(id)),
        );
        await Promise.allSettled(
          service.store.read().contributions.map(async (c) => {
            await Promise.allSettled([
              agreements?.cancelLocal(c.id),
              executions.cancelLogin(c.id),
              executions.preparations.has(c.id)
                ? executions.cancelSetup(c.id)
                : undefined,
            ]);
            if (executions.store.read(c.id))
              await executions.stop(c.id, reason);
          }),
        );
        await setupStops;
        await installer.cancel();
      };
      tray = new Tray(nativeImage.createEmpty());
      tray.setTitle("HB");
      tray.setToolTip("Harakiri Blackboard · Your local contributions");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: "Open Harakiri Blackboard",
            click: () => {
              window.show();
              window.focus();
            },
          },
          {
            label: "Stop all my agents",
            click: () =>
              void stopAll("Stopped from the menu bar.").catch(() => {}),
          },
          { type: "separator" },
          { label: "Stop agents and quit", click: () => app.quit() },
        ]),
      );
      window.on("close", (event) => {
        if (quitting) return;
        if (background.read()) {
          event.preventDefault();
          window.hide();
          return;
        }
        if (
          executions.jobs.size ||
          executions.busy.size ||
          onboarding?.active.size ||
          installer.pending
        ) {
          event.preventDefault();
          if (closeReview) return;
          closeReview = true;
          void dialog
            .showMessageBox(window, {
              type: "question",
              title: "Keep contributing?",
              message: "Agents or setup are still active on this Mac.",
              detail:
                "Keep contributing leaves Harakiri in the menu bar. Your approved limits still apply. You can stop all agents there at any time.",
              buttons: ["Stop and quit", "Keep contributing", "Cancel"],
              defaultId: 2,
              cancelId: 2,
            })
            .then(({ response }) => {
              if (response === 0) app.quit();
              if (response === 1) {
                background.set(true);
                window.hide();
              }
            })
            .finally(() => {
              closeReview = false;
            });
        }
      });
      powerMonitor.on(
        "suspend",
        () =>
          void stopAll(
            "Mac is sleeping. Review and resume the saved contribution after waking.",
          ).catch(() => {}),
      );
      onboarding = new OnboardingService({
        directory: join(app.getPath("userData"), "onboarding-v1"),
        node: nodeService,
        executions,
        provider,
      });
      agreements = new ContributionAgreements({
        directory: join(app.getPath("userData"), "continuation-v1"),
        node: nodeService,
        executions,
      });
      executions.agreements = agreements;
      completion = new CompletionService({
        directory: join(app.getPath("userData"), "completion-v1"),
        node: nodeService,
      });
      let pendingNotification = null;
      const notifications = new DecisionNotifications({
        node: nodeService,
        agreements,
        onboarding,
        show: ({ mission, body }) => {
          if (!Notification.isSupported()) return;
          const notice = new Notification({
            title: "Harakiri Blackboard · Your decision",
            body,
            silent: true,
          });
          notice.on("click", () => {
            pendingNotification = { mission };
            window.show();
            window.focus();
          });
          notice.on("failed", () => {}); // Inbox remains available if OS blocks it.
          notice.show();
        },
      });
      for (const [method, schema] of Object.entries({
        ...OnboardingRequests,
        ...AgreementRequests,
        ...BackgroundRequests,
        ...CompletionRequests,
      })) {
        ipcMain.handle(`onboarding:${method}`, async (event, input) => {
          if (!isTrustedFrame(event, window))
            return { ok: false, error: "This page cannot access setup." };
          try {
            const request = schema.parse(input);
            const actions = {
              completeMission: () => completion.complete(request),
              completionState: () => completion.state(request.mission),
              discardCompletion: () => completion.discard(request.id),
              appPreferences: () => ({
                background: background.read(),
                notifications: background.notifications(),
                notificationsSupported: Notification.isSupported(),
              }),
              setNotifications: () => ({
                notifications: background.setNotifications(request.enabled),
              }),
              takeNotification: () => {
                const target = pendingNotification;
                pendingNotification = null;
                return target;
              },
              journeyDiagnostics: () => ({
                enabled: background.diagnostics(),
                ...journey.summary(),
              }),
              setJourneyDiagnostics: () => {
                background.setDiagnostics(request.enabled);
                journey.seen.clear();
                return { enabled: background.diagnostics() };
              },
              clearJourneyDiagnostics: () => journey.clear(),
              setCapacity: () => {
                if (request.maximum > capacityCeiling)
                  throw new Error(
                    `Choose no more than ${capacityCeiling} environment slots on this Mac.`,
                  );
                background.setCapacity(request.maximum);
                provider.maximum = request.maximum;
                return { maximum: provider.maximum };
              },
              setBackground: () => ({
                background: background.set(request.enabled),
              }),
              approveContribution: () => agreements.approve(request),
              agreements: () => agreements.list(request.mission),
              cancelAgreement: () => agreements.cancel(request.id),
              continueAgreement: () => agreements.continue(request.id),
              reviewedStart: () => agreements.startReviewed(request),
              startState: () => agreements.startState(request.mission),
              cancelStart: () => agreements.cancelStart(request.id),
              state: () => onboarding.state(request.mission),
              setup: () => onboarding.setup(request),
              permission: () => onboarding.permission(request),
              cancel: () => onboarding.cancel(request.id),
              takeInvitation: () => {
                const link = pendingInvitation;
                pendingInvitation = null;
                return link;
              },
              preflight: async () => {
                const disk = await statfs(app.getPath("home"));
                return {
                  supported:
                    process.platform === "darwin" && process.arch === "arm64",
                  available: await provider.binary().then(
                    () => true,
                    () => false,
                  ),
                  capacity: provider.maximum,
                  capacityCeiling,
                  freeDiskBytes: disk.bavail * disk.bsize,
                  minimumDiskBytes: 4 * 1024 ** 3,
                  installer: {
                    ...installer.status,
                    active: !!installer.pending,
                  },
                };
              },
              installProvider: () => installer.install().then(() => null),
              cancelInstall: () => installer.cancel(),
            };
            return { ok: true, value: await actions[method]() };
          } catch (error) {
            return {
              ok: false,
              error:
                error.name === "ZodError"
                  ? "Invalid setup request."
                  : error.message,
            };
          }
        });
      }
      // Recover saved launch intents without ever starting a new process.
      void executions
        .recover()
        .then(() => {
          agreements.start();
          let publishing = false;
          observationTimer = setInterval(async () => {
            if (publishing || quitting) return;
            publishing = true;
            try {
              await nodeService.publishExecutionObservations();
              const records = [...executions.jobs.keys()].map((id) =>
                executions.store.read(id),
              );
              tray.setToolTip(
                `Harakiri Blackboard · ${records.filter((r) => r?.status === "running").length} running · ${records.filter((r) => r?.status === "waiting").length} idle · ${executions.busy.size} setting up`,
              );
              if (background.diagnostics() || background.notifications()) {
                const snapshot = await nodeService.state();
                await notifications.poll(snapshot, {
                  enabled: background.read() && background.notifications(),
                  focused: window.isFocused() && window.isVisible(),
                });
                if (!background.diagnostics()) return;
                for (const m of snapshot.missions) {
                  journey.transition(m.id, "mission", m.lifecycle.phase);
                  for (const j of onboarding.state(m.id))
                    journey.transition(j.id, "setup", j.status);
                  for (const j of agreements.list(m.id))
                    journey.transition(j.id, "contribution", j.status);
                  for (const j of agreements.startState(m.id))
                    journey.transition(j.id, "start_review", j.phase);
                  for (const j of completion.state(m.id))
                    journey.transition(j.id, "result_review", j.status);
                }
                for (const [id, a] of executions.authentications)
                  journey.transition(id, "sign_in", a.view.status);
              }
            } catch {
              /* next exchange retries */
            } finally {
              publishing = false;
            }
          }, 5000);
        })
        .catch(() => {});
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
              executionOverview: () => executions.overview(request.mission),
              executionState: () => executions.state(id),
              executionPrepare: () => executions.prepare(id),
              executionLogin: () => executions.login(id),
              executionCancelSetup: () => executions.cancelSetup(id),
              executionSignIn: () => executions.signIn(id),
              executionLoginInput: () =>
                executions.loginInput(id, request.text),
              executionCancelLogin: () => executions.cancelLogin(id),
              executionOpenLogin: () =>
                executions.openLogin(id, request.url, (url) =>
                  shell.openExternal(url),
                ),
              executionStart: () => executions.start(id, request.grant),
              executionStop: async () => {
                await agreements.cancelLocal(id);
                return executions.stop(id);
              },
              executionExport: () => executions.transfer(id, "export"),
              executionDiagnostics: async () => {
                const diagnostic = executionDiagnostics(
                  await executions.state(id),
                );
                const picked = await dialog.showSaveDialog(window, {
                  title: "Export execution diagnostics",
                  defaultPath: "harakiri-agent-diagnostics.json",
                  filters: [{ name: "JSON", extensions: ["json"] }],
                });
                if (picked.canceled || !picked.filePath)
                  return { cancelled: true };
                await writeFile(
                  picked.filePath,
                  JSON.stringify(diagnostic, null, 2) + "\n",
                  { mode: 0o600 },
                );
                return { cancelled: false };
              },
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
