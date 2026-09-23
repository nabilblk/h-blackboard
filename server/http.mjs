import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { Blackboard } from "./board.mjs";
import runtimes from "../shared/runtimes.json" with { type: "json" };
const root = fileURLToPath(new URL("..", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest();
const publicAddress = (value) => {
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Public addresses must be HTTPS origins without a path.");
  return url;
};
const send = (res, status, data, type = "application/json") => {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
};
const body = async (req) => {
  let content = "";
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 150000)
      throw Object.assign(new Error("Request is too large"), { status: 413 });
  }
  return content ? JSON.parse(content) : {};
};
export function createServer({
  database = resolve(root, "var/blackboard.sqlite"),
  publicUrl,
  apiUrl,
  publicPassword,
  publicUser = "harakiri",
} = {}) {
  const web = publicAddress(publicUrl);
  const api = publicAddress(apiUrl);
  if (
    (web || api) &&
    (!web ||
      !api ||
      web.host === api.host ||
      publicPassword?.length < 24 ||
      !publicPassword)
  )
    throw new Error(
      "Tunnel access requires separate web/API origins and a password of at least 24 characters.",
    );
  const expectedLogin = web ? digest(`${publicUser}:${publicPassword}`) : null;
  const board = new Blackboard(database);
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "localhost";
      const isWeb = !!web && host === web.host;
      const isApi = !!api && host === api.host;
      const remote = isWeb || isApi;
      const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
      if (!remote && !local)
        return send(res, 403, { error: "Workspace host not allowed." });
      // A tunnel must preserve its configured public host. It must never gain
      // the automatic owner session intended only for local requests.
      if (local && (req.headers["cf-connecting-ip"] || req.headers["cf-ray"]))
        return send(res, 403, {
          error: "The tunnel must preserve the public host.",
        });
      if (remote && req.headers["x-forwarded-proto"] !== "https") {
        if (req.headers["x-forwarded-proto"] === "http") {
          res.setHeader(
            "Location",
            `${isWeb ? web.origin : api.origin}${req.url}`,
          );
          return send(res, 308, { error: "Use HTTPS." });
        }
        return send(res, 403, { error: "HTTPS tunnel connection required." });
      }
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        const allowed = remote
          ? origin.origin === (isWeb ? web.origin : api.origin)
          : ["localhost", "127.0.0.1"].includes(origin.hostname) &&
            origin.protocol === "http:" &&
            (origin.host === host || origin.port === "4508");
        if (!allowed) return send(res, 403, { error: "Origin not allowed" });
      }
      const url = new URL(req.url, `http://${host}`);
      const base = api?.origin || `http://127.0.0.1:${server.address().port}`;
      if (remote)
        res.setHeader("Strict-Transport-Security", "max-age=31536000");
      if (
        (url.pathname === "/api/health" || (isApi && url.pathname === "/")) &&
        req.method === "GET"
      )
        return send(res, 200, {
          service: "Harakiri Blackboard API",
          status: "ok",
        });
      if (isWeb) {
        const basic = req.headers.authorization?.match(/^Basic (.+)$/i)?.[1];
        const valid =
          basic &&
          timingSafeEqual(digest(Buffer.from(basic, "base64")), expectedLogin);
        if (!valid) {
          res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Harakiri Blackboard", charset="UTF-8"',
          );
          return send(res, 401, { error: "Sign in to Harakiri Blackboard." });
        }
      }
      if (url.pathname === "/api/session" && req.method === "GET") {
        if (isApi)
          return send(res, 403, {
            error: "Open the web interface to sign in.",
          });
        res.setHeader(
          "Set-Cookie",
          `${remote ? "__Host-harakiri_session" : "harakiri_session"}=${board.ownerToken}; HttpOnly; SameSite=Strict; Path=/${remote ? "; Secure" : ""}`,
        );
        return send(res, 200, {
          selfId: "human",
          url: base,
          cli: resolve(root, "bin/harakiri.mjs"),
          node: process.execPath,
        });
      }
      if (url.pathname.startsWith("/j/") && req.method === "GET") {
        const token = decodeURIComponent(url.pathname.slice(3));
        const invite = board.invitation(token);
        const mission = board.get(invite.channel);
        if (url.searchParams.get("format") === "json")
          return send(res, 200, {
            mission: mission.name,
            role: invite.role,
            channelId: mission.id,
          });
        const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
        return send(
          res,
          200,
          `# Join Harakiri Blackboard\n\nMission: ${mission.name}\nRole: ${invite.role}\n\nRun the following in your existing agent session. Replace RUNTIME with ${Object.keys(runtimes).join(", ")}:\n\n${quote(process.execPath)} ${quote(resolve(root, "bin/harakiri.mjs"))} join --board ${quote(base + "/j/" + token)} --runtime RUNTIME\n\nThe command returns a private session-file path and the participation instructions. Read context with the returned command. Use its post, act, context and watch commands to collaborate; no global MCP setup is needed. Joining is membership, not permission to work. Read context_read.participation: waiting agents must not execute or claim work. Only the appointed coordinator may plan during preparation, publish plan_update, then read the current startupRevision and call coordinator_ready. The human explicitly starts the mission. After authorization, follow the current direction and human instructions. Tasks are optional. While waiting, use watch to receive instructions rather than ending your participation.\n\nThe multi-instance launcher additionally manages runtime wake-up at turn boundaries.\n`,
          "text/plain; charset=utf-8",
        );
      }
      if (url.pathname === "/api/join" && req.method === "POST")
        return send(res, 200, board.join(await body(req)));
      if (url.pathname.startsWith("/api/runners/") && req.method === "POST") {
        if (url.pathname === "/api/runners/join")
          return send(res, 200, board.runners.join(await body(req)));
        const runner = board.runners.auth(
          req.headers.authorization?.match(/^Bearer (.+)$/)?.[1],
        );
        if (url.pathname === "/api/runners/inventory")
          return send(
            res,
            200,
            board.runners.inventory(runner, await body(req)),
          );
        if (url.pathname === "/api/runners/tick")
          return send(res, 200, board.runners.tick(runner, await body(req)));
        return send(res, 404, { error: "Unknown launcher operation." });
      }
      if (url.pathname.startsWith("/api/")) {
        const token =
          req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ||
          (!isApi &&
            req.headers.cookie?.match(
              remote
                ? /(?:^|;\s*)__Host-harakiri_session=([^;]+)/
                : /(?:^|;\s*)harakiri_session=([^;]+)/,
            )?.[1]);
        const actor = board.auth(token);
        if (url.pathname === "/api/channels" && req.method === "GET")
          return send(res, 200, {
            missions: board.channels(actor),
            archivedMissions: board.channels(actor, { archived: true }),
          });
        if (url.pathname === "/api/rpc" && req.method === "POST") {
          const { operation, input, key } = await body(req);
          return send(res, 200, board.execute(actor, operation, input, key));
        }
        if (url.pathname === "/api/heartbeat" && req.method === "POST") {
          const { status, execution } = await body(req);
          return send(res, 200, board.heartbeat(actor, status, execution));
        }
        if (url.pathname === "/api/watch" && req.method === "POST") {
          const input = await body(req);
          board.access(actor, input.channel_id);
          let value = board.updates(actor, input);
          if (!value.events.length && value.cursor === (input.after || 0))
            await new Promise((done) => {
              let timer;
              const finish = () => {
                clearTimeout(timer);
                board.off("change", changed);
                res.off("close", finish);
                done();
              };
              const changed = (id) => {
                if (id === input.channel_id) finish();
              };
              timer = setTimeout(
                finish,
                Math.min(25000, Math.max(1000, input.timeout || 20000)),
              );
              board.on("change", changed);
              res.once("close", finish);
            });
          if (!res.destroyed)
            return send(res, 200, board.updates(actor, input));
          return;
        }
        if (url.pathname === "/api/events" && req.method === "GET") {
          const channel = url.searchParams.get("channel");
          if (channel) board.access(actor, channel);
          else board.human(actor);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write("event: ready\ndata: {}\n\n");
          const changed = (id) => {
            if (!channel || channel === id)
              res.write(
                `event: changed\ndata: ${JSON.stringify({ channel: id })}\n\n`,
              );
          };
          board.on("change", changed);
          const timer = setInterval(() => res.write(": keepalive\n\n"), 15000);
          res.on("close", () => {
            clearInterval(timer);
            board.off("change", changed);
          });
          return;
        }
        return send(res, 404, { error: "Unknown API route" });
      }
      if (isApi) return send(res, 404, { error: "Unknown API route" });
      let path = resolve(
        root,
        "dist",
        decodeURIComponent(url.pathname).replace(/^\/+/, ""),
      );
      const dist = resolve(root, "dist");
      if (!path.startsWith(dist + sep) && path !== dist)
        return send(res, 403, { error: "Invalid path" });
      if (!extname(path) || url.pathname === "/")
        path = resolve(dist, "index.html");
      try {
        const data = await readFile(path);
        const mime =
          {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".woff": "font/woff",
            ".txt": "text/plain",
          }[extname(path)] || "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control":
            extname(path) === ".html" ? "no-store" : "public,max-age=3600",
        });
        res.end(data);
      } catch {
        return send(res, 404, {
          error: "Build the web interface with npm run build.",
        });
      }
    } catch (error) {
      if (!res.headersSent)
        send(res, error.status || 400, {
          error: error.issues
            ? error.issues
                .map((x) => `${x.path.join(".")}: ${x.message}`)
                .join("; ")
            : error.message,
        });
      else res.end();
    }
  });
  return { server, board };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, board } = createServer({
    database: process.env.HARAKIRI_DB,
    publicUrl: process.env.HARAKIRI_PUBLIC_URL,
    apiUrl: process.env.HARAKIRI_API_URL,
    publicPassword: process.env.HARAKIRI_PUBLIC_PASSWORD,
    publicUser: process.env.HARAKIRI_PUBLIC_USER,
  });
  server.listen(Number(process.env.HARAKIRI_PORT || 4510), "127.0.0.1", () =>
    process.stdout.write(
      `Harakiri Blackboard · http://127.0.0.1:${server.address().port}\n`,
    ),
  );
  const stop = () => {
    server.close();
    server.closeAllConnections();
    board.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
