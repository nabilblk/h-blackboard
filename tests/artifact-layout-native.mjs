// Opt-in actual Electron confinement/layout proof. No model calls or real data.
import assert from "node:assert/strict";
import { app, protocol, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createArtifactViewer } from "../desktop/artifact-viewer.mjs";
const profile = await mkdtemp(join(tmpdir(), "hb-layout-"));
app.setPath("userData", profile);
// Several hidden windows are inspected in sequence; closing one must not end
// the test application before the next measurement starts.
app.on("window-all-closed", () => {});
protocol.registerSchemesAsPrivileged([
  {
    scheme: "harakiri-artifact",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app
  .whenReady()
  .then(async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end("denied");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const revision = "a".repeat(64),
      input = { mission: "fixture", revision, path: "index.html" };
    const detail = {
      document: { title: "Layout fixture", files: [{ path: "index.html" }] },
    };
    let page;
    const viewer = createArtifactViewer(
      {
        async readArtifactFile(request) {
          assert.deepEqual(request, input);
          return Buffer.from(page);
        },
      },
      () => null,
    );
    const evidence = {};
    try {
      page =
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;overflow-wrap:anywhere}pre{white-space:pre-wrap}</style><h1>Usable guide</h1><pre>' +
        "a".repeat(200) +
        "</pre>";
      evidence.fitting = await viewer.inspect(input, detail);
      assert.deepEqual(
        evidence.fitting.checks.map((c) => c.viewport),
        [1440, 390],
      );
      assert.ok(
        evidence.fitting.checks.every(
          (c) => c.documentWidth <= c.viewport && !c.nodeAccess,
        ),
      );
      page = "<style>pre{width:900px}</style><pre>Overflow fixture</pre>";
      evidence.overflow = await viewer.inspect(input, detail);
      assert.ok(evidence.overflow.checks[1].documentWidth > 390);
      assert.ok(evidence.overflow.checks[1].overflow.length);
      const url = `http://127.0.0.1:${server.address().port}`;
      page = `<h1>Hostile fixture</h1><script>fetch('${url}/network');fetch('file:///etc/hosts');window.open('${url}/popup');window.onbeforeunload=()=>false;console.error('Deliberate fixture error');</script>`;
      evidence.confined = await viewer.inspect(input, detail);
      assert.equal(hits, 0);
      assert.ok(
        evidence.confined.checks.every(
          (c) =>
            !c.nodeAccess &&
            c.errors.some((e) => e.includes("Deliberate fixture error")),
        ),
      );
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      page = "<script>while(true){}</script>";
      await assert.rejects(viewer.inspect(input, detail), /timed out/);
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      evidence.hungRendererStopped = true;
      page = "<h1>After timeout</h1>";
      await viewer.inspect(input, detail);
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      evidence.externalRequests = hits;
      await mkdir(resolve("var/desktop"), { recursive: true });
      await writeFile(
        resolve("var/desktop/layout-inspection.json"),
        JSON.stringify(evidence, null, 2),
        { mode: 0o600 },
      );
      console.log(
        "PASS actual layout measurements, overflow, network/host denial, bounded hung renderer and cleanup",
      );
    } finally {
      viewer.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(profile, { recursive: true, force: true });
    }
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
