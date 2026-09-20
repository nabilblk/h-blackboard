import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { createServer } from "../server/http.mjs";

const password = "test-password-for-isolated-tunnel-fixture";
const login = `Basic ${Buffer.from(`harakiri:${password}`).toString("base64")}`;
const publicUrl = "https://board.example.test";
const apiUrl = "https://api.example.test";

async function fixture(t) {
  const { server, board } = createServer({
    database: ":memory:",
    publicUrl,
    apiUrl,
    publicPassword: password,
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    board.close();
  });
  const send = (host, path, { headers = {}, body } = {}) =>
    new Promise((done, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: host,
            "X-Forwarded-Proto": "https",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () =>
            done({
              status: res.statusCode,
              headers: res.headers,
              text,
              data: res.headers["content-type"]?.startsWith("application/json")
                ? JSON.parse(text)
                : null,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { board, send };
}

test("The public interface requires login before issuing a secure owner session", async (t) => {
  const { board, send } = await fixture(t);
  for (const path of ["/", "/api/session", "/api/channels", "/api/events"]) {
    const denied = await send("board.example.test", path);
    assert.equal(denied.status, 401);
    assert.match(denied.headers["www-authenticate"], /^Basic /);
    assert.equal(denied.headers["set-cookie"], undefined);
  }
  assert.equal(
    (
      await send("board.example.test", "/api/session", {
        headers: { Authorization: "Basic d3Jvbmc6d3Jvbmc=" },
      })
    ).status,
    401,
  );
  const signedIn = await send("board.example.test", "/api/session", {
    headers: { Authorization: login, Origin: publicUrl },
  });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.url, apiUrl);
  const cookie = signedIn.headers["set-cookie"][0];
  assert.match(cookie, /^__Host-harakiri_session=/);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/; Secure/);
  assert.doesNotMatch(cookie, /Domain=/);
  const channels = await send("board.example.test", "/api/channels", {
    headers: { Authorization: login, Cookie: cookie.split(";")[0] },
  });
  assert.equal(channels.status, 200);
  assert.deepEqual(channels.data.missions, []);
  assert.equal(
    (
      await send("board.example.test", "/api/channels", {
        headers: { Cookie: cookie.split(";")[0] },
      })
    ).status,
    401,
    "The public gate remains required even with an owner cookie",
  );
  assert.equal(
    (
      await send("api.example.test", "/api/channels", {
        headers: {
          Cookie: `harakiri_session=${board.ownerToken}; ${cookie.split(";")[0]}`,
        },
      })
    ).status,
    401,
    "The agent API ignores browser cookies",
  );
});

test("Public hosts cannot bypass login through local headers, HTTP, or foreign origins", async (t) => {
  const { send } = await fixture(t);
  const local = await send("127.0.0.1", "/api/session");
  assert.equal(local.status, 200);
  assert.equal(local.data.url, apiUrl);
  assert.equal(
    (
      await send("127.0.0.1", "/api/session", {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      })
    ).status,
    403,
  );
  assert.equal((await send("outside.example", "/api/session")).status, 403);
  for (const origin of [
    "https://outside.example",
    "https://example.test",
    apiUrl,
    "http://board.example.test",
    "null",
  ]) {
    const denied = await send("board.example.test", "/api/session", {
      headers: { Authorization: login, Origin: origin },
    });
    assert.ok([400, 403].includes(denied.status));
    assert.equal(denied.headers["set-cookie"], undefined);
  }
  const redirect = await send("board.example.test", "/api/session", {
    headers: { "X-Forwarded-Proto": "http" },
  });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, publicUrl + "/api/session");
  assert.equal(redirect.headers["set-cookie"], undefined);
  assert.equal(
    (
      await send("board.example.test", "/api/session", {
        headers: { Authorization: login, "X-Forwarded-Proto": "" },
      })
    ).status,
    403,
  );
});

test("The public API accepts invitations and scoped agents without exposing owner bootstrap", async (t) => {
  const { board, send } = await fixture(t);
  assert.equal((await send("api.example.test", "/")).data.status, "ok");
  assert.equal((await send("api.example.test", "/api/health")).status, 200);
  assert.equal((await send("api.example.test", "/api/session")).status, 403);
  assert.equal((await send("api.example.test", "/favicon.svg")).status, 404);
  const human = board.auth(board.ownerToken);
  const mission = board.execute(
    human,
    "mission_create",
    {
      name: "Tunnel fixture",
      objective: "Verify agent access in an isolated database",
    },
    randomUUID(),
  );
  const invitation = board.execute(
    human,
    "invitation_create",
    {
      channel_id: mission.id,
    },
    randomUUID(),
  );
  const instructions = await send("api.example.test", `/j/${invitation.token}`);
  assert.equal(instructions.status, 200);
  assert.ok(instructions.text.includes(`${apiUrl}/j/${invitation.token}`));
  assert.ok(!instructions.text.includes(password));
  const joined = await send("api.example.test", "/api/join", {
    body: {
      invitation: invitation.token,
      name: "tunnel-agent",
      runtime: "codex",
    },
  });
  assert.equal(joined.status, 200);
  const headers = { Authorization: `Bearer ${joined.data.token}` };
  const input = { channel_id: mission.id };
  const context = await send("api.example.test", "/api/rpc", {
    headers,
    body: { operation: "context_read", input },
  });
  assert.equal(context.status, 200);
  assert.equal(context.data.selfId, joined.data.agent.id);
  const post = await send("api.example.test", "/api/rpc", {
    headers,
    body: {
      operation: "message_post",
      input: { ...input, body: "An authenticated contribution" },
      key: randomUUID(),
    },
  });
  assert.equal(post.status, 200);
  assert.equal(post.data.authorId, joined.data.agent.id);
  assert.equal(
    (
      await send("api.example.test", "/api/rpc", {
        body: { operation: "context_read", input },
      })
    ).status,
    401,
  );
  assert.equal(
    (await send("api.example.test", "/api/channels", { headers })).status,
    403,
  );
});

test("Public configuration fails closed without distinct HTTPS origins and a strong password", () => {
  for (const config of [
    { publicUrl },
    { publicUrl, apiUrl },
    { publicUrl, apiUrl, publicPassword: "short" },
    { publicUrl, apiUrl: publicUrl, publicPassword: password },
    {
      publicUrl: "http://board.example.test",
      apiUrl,
      publicPassword: password,
    },
  ]) {
    assert.throws(() => createServer({ database: ":memory:", ...config }));
  }
});
