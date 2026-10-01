import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { z } from "zod";
import { MissionPreview } from "./model.mjs";

const MAX_RESPONSE = 16 * 1024;
const TIMEOUT_MS = 8000;
const PreviewResponse = z.object({
  mission: z.string().trim().min(1).max(100),
  channelId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
  role: z.enum(["agent", "coordinator"]),
});

export function invitationURL(input, { allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Paste a complete Blackboard invitation URL.");
  }
  const local =
    allowLoopback && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error("Invitations must use HTTPS.");
  if (url.username || url.password || url.hash || url.search)
    throw new Error(
      "Use the original invitation URL, without credentials, query parameters or a fragment.",
    );
  if (!/^\/j\/[a-zA-Z0-9_-]{16,200}$/.test(url.pathname))
    throw new Error(
      "Expected a Blackboard invitation ending in /j/ followed by its token.",
    );
  if (!local && url.port && url.port !== "443")
    throw new Error("Remote invitations must use the standard HTTPS port.");
  return url;
}

function ipv4Number(address) {
  return address.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}
function inV4Range(address, base, bits) {
  const size = 2 ** (32 - bits);
  return (
    Math.floor(ipv4Number(address) / size) ===
    Math.floor(ipv4Number(base) / size)
  );
}

// Conservative public-network allowlist. Private, loopback, multicast, reserved,
// metadata and IPv4-mapped IPv6 addresses never reach the network request.
export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4)
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 3],
    ].some(([base, bits]) => inV4Range(address, base, bits));
  if (family !== 6 || address.includes("%")) return false;
  // Global unicast only, excluding protocol-assignment, documentation and
  // transition ranges. No NAT64, 6to4, Teredo or mapped local-address bypass.
  const groups = address.toLowerCase().split(":");
  const first = Number.parseInt(groups[0] || "0", 16);
  const second = Number.parseInt(groups[1] || "0", 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false;
  if (first === 0x2002 || (first === 0x3fff && second < 0x1000)) return false;
  return true;
}

export async function invitationTarget(
  url,
  { allowLoopback = false, resolveHost = lookup } = {},
) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolveHost(hostname, { all: true, verbatim: true });
  const localHost =
    allowLoopback && ["127.0.0.1", "::1", "localhost"].includes(hostname);
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        !(
          publicAddress(address) ||
          (localHost && ["127.0.0.1", "::1"].includes(address))
        ),
    )
  )
    throw new Error(
      "This invitation points to a private or reserved network address.",
    );
  return addresses[0];
}

// Pin the validated DNS result into the actual socket lookup. Checking DNS and
// then calling fetch(url) would allow a second lookup to rebind to localhost.
export function fetchPreview(url, target, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(
      url,
      {
        signal,
        agent: false,
        headers: { accept: "application/json", "accept-encoding": "identity" },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        },
      },
      (response) => {
        const fail = (message) => {
          response.destroy();
          reject(new Error(message));
        };
        if (response.statusCode !== 200)
          return fail(
            response.statusCode >= 300 && response.statusCode < 400
              ? "Invitation redirects are not allowed. Use a direct invitation URL."
              : "The board did not accept this invitation. It may have expired.",
          );
        if (
          !/^application\/json\b/i.test(
            response.headers["content-type"] || "",
          ) ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        )
          return fail(
            "The board must return an uncompressed JSON invitation preview.",
          );
        if (Number(response.headers["content-length"]) > MAX_RESPONSE)
          return fail("The invitation response is too large.");
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE)
            return fail("The invitation response is too large.");
          chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new Error("Could not read the invitation response.")),
        );
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("The board returned an invalid JSON preview."));
          }
        });
      },
    );
    // Never propagate raw networking errors: they can include the invite token.
    request.on("error", () =>
      reject(
        new Error(
          "Could not reach the board securely. Check the invitation and your connection.",
        ),
      ),
    );
    request.setTimeout(TIMEOUT_MS, () => request.destroy());
  });
}

export async function inspectInvitation(input, options = {}) {
  const url = invitationURL(input, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const target = await Promise.race([
      invitationTarget(url, options),
      new Promise((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("Invitation lookup timed out.")),
          { once: true },
        ),
      ),
    ]);
    url.search = "?format=json";
    const raw = await fetchPreview(url, target, { signal: controller.signal });
    const parsed = PreviewResponse.safeParse(raw);
    if (!parsed.success)
      throw new Error("The board returned an unsupported invitation preview.");
    // Invitation content stays text. No instructions, commands, API endpoints
    // or HTML supplied by a remote board are evaluated or persisted.
    return MissionPreview.parse({
      origin: url.origin,
      missionId: parsed.data.channelId,
      name: parsed.data.mission,
      role: parsed.data.role,
      inspectedAt: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timer);
  }
}
