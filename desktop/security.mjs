import { isAbsolute, relative, resolve, sep } from "node:path";
import { DESKTOP_ORIGIN } from "./model.mjs";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function isWithin(directory, candidate) {
  const rel = relative(directory, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

export function isTrustedFrame(event, window) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents)
    return false;
  const frame = event.senderFrame;
  if (!frame || frame !== window.webContents.mainFrame) return false;
  try {
    const url = new URL(frame.url);
    return (
      url.protocol === "harakiri:" &&
      url.host === "desktop" &&
      !url.username &&
      !url.password &&
      url.pathname === "/index.html"
    );
  } catch {
    return false;
  }
}

export function staticAsset(root, input) {
  const url = new URL(input);
  if (
    url.protocol !== "harakiri:" ||
    url.host !== "desktop" ||
    url.username ||
    url.password
  )
    throw new Error("Unknown application origin.");
  const pathname = decodeURIComponent(url.pathname);
  // Only packaged UI files are routable. No file://, app source, user data,
  // remote document or arbitrary filesystem path can be served by the scheme.
  if (
    !/^\/(?:index\.html|assets\/[a-zA-Z0-9_.-]+\.(?:js|css|woff2?|svg))$/.test(
      pathname,
    )
  )
    throw new Error("Unknown application asset.");
  const file = resolve(root, `.${pathname}`);
  if (!isWithin(root, file)) throw new Error("Unknown application asset.");
  return file;
}

export const APP_URL = `${DESKTOP_ORIGIN}/index.html`;
