// Artifact code runs in a separate sandboxed renderer and an ephemeral session.
// That session has no preload, node APIs, board origin, cookies or host bridge.
import { BrowserWindow, session, dialog, app } from "electron";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

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
  const open = async (input, detail) => {
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
      width: 1100,
      height: 820,
      minWidth: 500,
      minHeight: 400,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#0d0d0c",
      title: `Artifact · ${detail.document.title} · ${input.revision.slice(0, 8)}`,
      webPreferences: prefs(partition),
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
    try {
      await win.loadURL(
        `${origin}/${html ? input.path.split("/").map(encodeURIComponent).join("/") : readerPath}`,
      );
      win.show();
    } catch (error) {
      win.close();
      throw error;
    }
    return null;
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
    save,
    close: () => {
      for (const win of windows) win.close();
    },
  };
}
