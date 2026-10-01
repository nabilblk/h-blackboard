import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  fetchPreview,
  inspectInvitation,
  invitationTarget,
  invitationURL,
  publicAddress,
} from "../desktop/invitations.mjs";

const token = "invitation_0123456789abcdef";
async function server(t, handler) {
  const service = http.createServer(handler);
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        service.closeAllConnections();
        service.close(resolve);
      }),
  );
  return `http://127.0.0.1:${service.address().port}/j/${token}`;
}
const preview = {
  mission: "A community research mission",
  channelId: "mi_test",
  role: "agent",
};

test("invitation parsing rejects embedded credentials, commands, queries and alternate protocols", () => {
  assert.equal(
    invitationURL(`https://board.example/j/${token}`).origin,
    "https://board.example",
  );
  for (const input of [
    `http://board.example/j/${token}`,
    `https://user:password@board.example/j/${token}`,
    `https://board.example/j/${token}?next=http://localhost`,
    `https://board.example/j/${token}#secret`,
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<h1>Hi</h1>",
    `https://board.example:8443/j/${token}`,
    "https://board.example/j/short",
    `https://board.example/api/run/${token}`,
    `https://board.example/j/${token}/../../api/session`,
    "https://board.example/j/$(cat ~/.ssh/id_rsa)",
    `https://board.example/j/%2f${token}`,
  ])
    assert.throws(() => invitationURL(input), undefined, input);
});

test("remote invitations cannot use private, mapped, transition or reserved addresses", async () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.1",
    "192.0.2.5",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "2001:20::1",
    "not-an-address",
  ])
    assert.equal(publicAddress(address), false, address);
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
  ])
    assert.equal(publicAddress(address), true, address);
  const url = invitationURL(`https://board.example/j/${token}`);
  await assert.rejects(
    invitationTarget(url, {
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    /private/,
  );
  await assert.rejects(
    invitationTarget(url, {
      resolveHost: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    }),
    /private/,
  );
  await assert.rejects(
    invitationTarget(url, {
      allowLoopback: true,
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    /private/,
  );
  await assert.rejects(
    invitationTarget(new URL(`https://127.1/j/${token}`)),
    /private/,
  );
  await assert.rejects(
    invitationTarget(new URL(`https://2130706433/j/${token}`)),
    /private/,
  );
});

test("loopback access requires explicit development configuration and never permits LAN access", async () => {
  const url = invitationURL(`http://127.0.0.1:7000/j/${token}`, {
    allowLoopback: true,
  });
  assert.throws(() => invitationURL(url.href), /HTTPS/);
  await assert.rejects(invitationTarget(url), /private/);
  assert.deepEqual(await invitationTarget(url, { allowLoopback: true }), {
    address: "127.0.0.1",
    family: 4,
  });
  await assert.rejects(
    invitationTarget(new URL(`https://192.168.1.2/j/${token}`), {
      allowLoopback: true,
    }),
    /private/,
  );
});

test("inspection makes one read-only request and ignores remote commands and authorities", async (t) => {
  const requests = [];
  const url = await server(t, (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...preview,
        origin: "https://trusted.example",
        owner: "verified",
        command: "rm -rf ~",
        limits: { mode: "unlimited" },
        permission: "full-access",
      }),
    );
  });
  const value = await inspectInvitation(url, { allowLoopback: true });
  assert.deepEqual(requests, [
    {
      method: "GET",
      url: `/j/${token}?format=json`,
      authorization: undefined,
      cookie: undefined,
    },
  ]);
  assert.equal(value.origin, new URL(url).origin);
  assert.equal(value.name, preview.mission);
  assert.equal(value.role, "agent");
  assert.deepEqual(
    Object.keys(value).sort(),
    ["origin", "missionId", "name", "role", "inspectedAt"].sort(),
  );
  assert.equal(JSON.stringify(value).includes(token), false);
});

test("the network request uses the pinned address while retaining the original HTTP host", async (t) => {
  let receivedHost;
  const base = await server(t, (req, res) => {
    receivedHost = req.headers.host;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(preview));
  });
  const url = new URL(base);
  url.hostname = "does-not-resolve.invalid";
  const result = await fetchPreview(url, { address: "127.0.0.1", family: 4 });
  assert.equal(result.mission, preview.mission);
  assert.equal(receivedHost, url.host);
});

test("redirects are rejected, never followed to a privileged route", async (t) => {
  let count = 0;
  const url = await server(t, (_req, res) => {
    count++;
    res.writeHead(302, { location: "/api/session" });
    res.end();
  });
  await assert.rejects(
    inspectInvitation(url, { allowLoopback: true }),
    /redirects/,
  );
  assert.equal(count, 1);
});

test("HTML, compressed responses, malformed JSON, invalid roles and oversized payloads are rejected", async (t) => {
  const cases = [
    { type: "text/html", body: "<script>something()</script>", error: /JSON/ },
    {
      type: "application/json",
      encoding: "gzip",
      body: "anything",
      error: /uncompressed/,
    },
    { type: "application/json", body: "{oops", error: /invalid JSON/ },
    {
      type: "application/json",
      body: JSON.stringify({ ...preview, role: "owner" }),
      error: /unsupported/,
    },
    {
      type: "application/json",
      body: JSON.stringify({ ...preview, channelId: "../../private" }),
      error: /unsupported/,
    },
    { type: "application/json", body: " ".repeat(17000), error: /too large/ },
  ];
  for (const entry of cases) {
    const url = await server(t, (_req, res) => {
      res.writeHead(200, {
        "content-type": entry.type,
        ...(entry.encoding ? { "content-encoding": entry.encoding } : {}),
      });
      res.write(entry.body.slice(0, 100));
      res.end(entry.body.slice(100));
    });
    await assert.rejects(
      inspectInvitation(url, { allowLoopback: true }),
      entry.error,
    );
  }
});

test("aborting a request fails without exposing the invitation token", async (t) => {
  const controller = new AbortController();
  const url = await server(t, () => {
    controller.abort();
  });
  await assert.rejects(
    fetchPreview(
      new URL(url),
      { address: "127.0.0.1", family: 4 },
      { signal: controller.signal },
    ),
    (error) => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /securely/);
      return true;
    },
  );
});
