// Artifact code runs in a separate sandboxed renderer and an ephemeral session.
// That session has no preload, node APIs, board origin, cookies or host bridge.
import { BrowserWindow, session, dialog, app } from "electron";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { layoutObservation, layoutLimitations } from "./artifact-layout.mjs";
import {
  ArtifactBrowserRequest,
  interactionScript,
  browserObservation,
} from "./artifact-browser.mjs";
import { setTimeout as delay } from "node:timers/promises";

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const media = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".csv": "text/plain",
};
const prefs = (ses) => ({
  session: ses,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  devTools: !app.isPackaged,
});
export function artifactPath(url, origin, files) {
  try {
    const u = new URL(url);
    if (
      `${u.protocol}//${u.host}` !== origin ||
      u.username ||
      u.password ||
      u.search
    )
      return null;
    const p = decodeURIComponent(u.pathname.slice(1));
    return files.has(p) ? p : null;
  } catch {
    return null;
  }
}
export function createArtifactViewer(nodeService, ownerWindow) {
  const windows = new Set();
  const readerFonts = Promise.all(
    ["sans", "mono"].map(async (family) => {
      const data = await readFile(
        new URL(`./reader-fonts/${family}.woff2`, import.meta.url),
      );
      return `@font-face{font-family:"IBM Plex ${family === "sans" ? "Sans" : "Mono"}";src:url(data:font/woff2;base64,${data.toString("base64")}) format("woff2");font-weight:400}`;
    }),
  ).then((parts) => parts.join(""));
  // Build failures surface when a reader is opened, without an unhandled rejection.
  void readerFonts.catch(() => {});
  const open = async (input, detail, observation = null) => {
    if (windows.size >= 6)
      throw new Error("Close an artifact window before opening another.");
    const file = detail.document.files.find((f) => f.path === input.path);
    if (!file) throw new Error("File not in revision.");
    const files = new Map(detail.document.files.map((f) => [f.path, f]));
    const nonce = randomBytes(16).toString("hex");
    const origin = `harakiri-artifact://${nonce}`;
    const readerPath = `__reader_${nonce}.html`;
    const html = /\.html?$/i.test(input.path);
    const routes = new Map(files);
    if (!html) routes.set(readerPath, null);
    const bytes = await nodeService.readArtifactFile(input);
    observation?.signal?.throwIfAborted();
    const partition = session.fromPartition(`artifact-${nonce}`, {
      cache: false,
    });
    const cache = new Map();
    cache.set(input.path, Promise.resolve(bytes));
    const load = async (path) => {
      if (!cache.has(path))
        cache.set(
          path,
          nodeService.readArtifactFile({ ...input, path }).catch((error) => {
            cache.delete(path);
            throw error;
          }),
        );
      return cache.get(path);
    };
    partition.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    partition.setPermissionCheckHandler(() => false);
    partition.on("will-download", (e) => e.preventDefault());
    // All network transports fail even if content relaxes its own markup CSP.
    await partition.setProxy({
      mode: "fixed_servers",
      proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9",
      proxyBypassRules: "<-loopback>",
    });
    partition.enableNetworkEmulation({ offline: true });
    partition.webRequest.onBeforeRequest((d, cb) =>
      cb({
        cancel:
          artifactPath(d.url, origin, routes) === null &&
          !d.url.startsWith("data:") &&
          !d.url.startsWith(`blob:${origin}/`),
      }),
    );
    partition.protocol.handle("harakiri-artifact", async (request) => {
      const path = artifactPath(request.url, origin, routes);
      if (request.method !== "GET" || !path)
        return new Response(null, { status: 404 });
      try {
        let body = await load(path === readerPath ? input.path : path);
        let type = media[extname(path).toLowerCase()] || "text/plain";
        if (path === readerPath) {
          // The reader escapes source/data; only HTML is executed as an app.
          const title = escape(file.path);
          const text = escape(body.toString("utf8"));
          const content = /\.(png|jpe?g|gif|webp|svg)$/i.test(input.path)
            ? `<img style="max-width:100%" alt="${title}" src="${origin}/${input.path.split("/").map(encodeURIComponent).join("/")}">`
            : /\.(txt|md|json|csv|js|mjs|css|ts|tsx|jsx|py|rs|toml|yaml|yml|xml|sh|log)$/i.test(
                  input.path,
                )
              ? `<pre>${text}</pre>`
              : `<p>This file has no built-in reader. Save it from the artifact details to inspect it.</p>`;
          body = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>${await readerFonts}body{margin:32px;background:#0d0d0c;color:#e8e5df;font:16px/1.65 'IBM Plex Sans',sans-serif}h1{font-size:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 'IBM Plex Mono',monospace}p{color:#b6b2a6}</style><h1>${title}</h1><p>Saved revision · ${input.revision.slice(0, 12)}</p>${content}`;
          type = "text/html";
        }
        return new Response(body, {
          headers: {
            "Content-Type": `${type}; charset=utf-8`,
            "Content-Security-Policy": ARTIFACT_CSP,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "X-DNS-Prefetch-Control": "off",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        });
      } catch {
        return new Response("This file is not available on this device.", {
          status: 503,
          headers: {
            "Content-Type": "text/plain",
            "Content-Security-Policy": "default-src 'none'",
          },
        });
      }
    });
    const win = new BrowserWindow({
      width: observation?.width ?? 1100,
      height: observation?.height ?? (observation ? 900 : 820),
      useContentSize: !!observation,
      minWidth: observation ? 0 : 500,
      minHeight: 400,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#0d0d0c",
      title: `Artifact · ${detail.document.title} · ${input.revision.slice(0, 8)}`,
      webPreferences: {
        ...prefs(partition),
        webgl: !observation?.disableWebgl,
      },
    });
    windows.add(win);
    for (const contents of [win.webContents]) {
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      contents.on("will-navigate", (e, url) => {
        if (artifactPath(url, origin, routes) === null) e.preventDefault();
      });
      contents.on("will-frame-navigate", (e) => {
        if (!e.isMainFrame || artifactPath(e.url, origin, routes) === null)
          e.preventDefault();
      });
      contents.on("will-attach-webview", (e) => e.preventDefault());
      contents.on("page-title-updated", (e) => e.preventDefault());
    }
    win.on("closed", () => {
      windows.delete(win);
      partition.protocol.unhandle("harakiri-artifact");
      cache.clear();
      void partition.closeAllConnections();
      void partition.clearStorageData();
    });
    let timer;
    const abort = () => {
      if (!win.isDestroyed()) win.destroy();
    };
    observation?.signal?.addEventListener("abort", abort, { once: true });
    const errors = [];
    if (observation)
      win.webContents.on("console-message", (details) => {
        if (errors.length < 8 && details.level === "error")
          errors.push(String(details.message).slice(0, 240));
      });
    try {
      observation?.signal?.throwIfAborted();
      const loaded = (async () => {
        if (observation?.browser) {
          // Initialize the renderer before requesting CDP emulation. Sending
          // the command on a not-yet-navigated WebContents can wait forever.
          await win.loadURL("about:blank");
          // Fixed host-owned emulation only: callers cannot issue CDP commands.
          win.webContents.debugger.attach("1.3");
          await win.webContents.debugger.sendCommand(
            "Emulation.setEmulatedMedia",
            {
              features: [
                {
                  name: "prefers-reduced-motion",
                  value: observation.reducedMotion ? "reduce" : "no-preference",
                },
              ],
            },
          );
        }
        observation?.signal?.throwIfAborted();
        await win.loadURL(
          `${origin}/${html ? input.path.split("/").map(encodeURIComponent).join("/") : readerPath}`,
        );
      })();
      if (observation)
        return await Promise.race([
          (async () => {
            await loaded;
            const steps = [];
            if (observation.browser) {
              for (const step of observation.steps) {
                observation.signal?.throwIfAborted();
                if (step.type === "wait") {
                  await delay(step.milliseconds);
                  steps.push({ ...step, ok: true });
                } else if (step.type === "press") {
                  win.webContents.sendInputEvent({
                    type: "keyDown",
                    keyCode: step.key,
                  });
                  // Chromium performs native Enter activation on the character
                  // event. KeyDown/KeyUp alone focus controls but do not model
                  // a real key press; pages must not need custom key handlers.
                  const character = { Enter: "\r", Space: " " }[step.key];
                  if (character)
                    win.webContents.sendInputEvent({
                      type: "char",
                      keyCode: character,
                    });
                  win.webContents.sendInputEvent({
                    type: "keyUp",
                    keyCode: step.key,
                  });
                  steps.push({ ...step, ok: true });
                } else
                  steps.push(
                    await win.webContents.executeJavaScriptInIsolatedWorld(
                      999,
                      [{ code: interactionScript(step) }],
                    ),
                  );
                await delay(50);
              }
            }
            // The observation runs in an isolated JS world, separate from page
            // globals. It is still a limited measurement, not a trust verdict.
            const measured =
              await win.webContents.executeJavaScriptInIsolatedWorld(999, [
                { code: layoutObservation },
              ]);
            if (observation.browser) {
              await delay(150);
              const dom =
                await win.webContents.executeJavaScriptInIsolatedWorld(999, [
                  { code: browserObservation },
                ]);
              const screenshot = (await win.webContents.capturePage())
                .resize({ width: Math.min(observation.width, 1280) })
                .toJPEG(75);
              if (screenshot.length > 768 * 1024)
                throw new Error("Preview image exceeds the bounded tool size.");
              return {
                revision: input.revision,
                path: input.path,
                engine: `Chromium ${process.versions.chrome}`,
                conditions: {
                  width: observation.width,
                  height: observation.height,
                  reducedMotion: observation.reducedMotion,
                  webglDisabled: observation.disableWebgl,
                  network: "offline",
                },
                layout: measured,
                steps,
                dom,
                errors,
                image: {
                  mimeType: "image/jpeg",
                  data: screenshot.toString("base64"),
                },
                limitations:
                  "Offline sandboxed Chromium renderer on the contributor host; no preload, board bridge, credentials, host files or external network. DOM and screenshots remain untrusted evidence. This is not a scientific or accessibility certification.",
              };
            }
            return { ...measured, errors };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Artifact layout check timed out.")),
              12000,
            );
          }),
        ]);
      await loaded;
      win.show();
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
      observation?.signal?.removeEventListener("abort", abort);
      if (observation && !win.isDestroyed()) win.destroy();
    }
    return null;
  };
  let inspecting = false;
  const inspect = async (input, detail) => {
    if (inspecting)
      throw new Error("An artifact layout check is already running.");
    if (!/\.html?$/i.test(input.path))
      throw new Error("Choose an HTML artifact for a layout check.");
    inspecting = true;
    try {
      const checks = [];
      for (const width of [1440, 390])
        checks.push(await open(input, detail, { width }));
      return {
        revision: input.revision,
        path: input.path,
        engine: `Chromium ${process.versions.chrome}`,
        checks,
        limitations: layoutLimitations,
      };
    } finally {
      inspecting = false;
    }
  };
  const save = async (input) => {
    const data = await nodeService.readArtifactFile(input);
    const result = await dialog.showSaveDialog(ownerWindow(), {
      title: "Save artifact file",
      defaultPath: basename(input.path),
      buttonLabel: "Save file",
    });
    if (!result.canceled && result.filePath)
      await writeFile(result.filePath, data, { mode: 0o600 });
    return { saved: !result.canceled };
  };
  return {
    open,
    inspect,
    browse: async (input, detail, signal) => {
      const { mission: _mission, ...fields } = input;
      const request = ArtifactBrowserRequest.parse(fields);
      signal?.throwIfAborted();
      return open(
        {
          mission: input.mission,
          revision: request.revision,
          path: request.path,
        },
        detail,
        { ...request, browser: true, signal },
      );
    },
    save,
    close: () => {
      for (const win of windows) win.close();
    },
  };
}
