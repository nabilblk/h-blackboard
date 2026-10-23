// Opt-in actual Electron confinement/layout proof. No model calls or real data.
import assert from "node:assert/strict";
import { app, protocol, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
    const assets = new Map();
    const viewer = createArtifactViewer(
      {
        async readArtifactFile(request) {
          assert.equal(request.mission, input.mission);
          assert.equal(request.revision, input.revision);
          if (request.path === input.path) return Buffer.from(page);
          assert.ok(
            assets.has(request.path),
            "Only the revision's files are available",
          );
          return assets.get(request.path);
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
      console.log("PASS fitting layout");
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
      console.log("PASS overflow detection");
      assert.ok(evidence.overflow.checks[1].documentWidth > 390);
      assert.ok(evidence.overflow.checks[1].overflow.length);
      const url = `http://127.0.0.1:${server.address().port}`;
      page = `<h1>Hostile fixture</h1><script>fetch('${url}/network');fetch('file:///etc/hosts');window.open('${url}/popup');window.onbeforeunload=()=>false;console.error('Deliberate fixture error');</script>`;
      evidence.confined = await viewer.inspect(input, detail);
      console.log("PASS confined renderer");
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
      console.log("PASS recovery after hung renderer");
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      evidence.externalRequests = hits;
      page =
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><label>Distance<input id="distance" value="2"></label><button id="check" onclick="document.querySelector(\'#answer\').textContent=document.querySelector(\'#distance\').value">Check</button><p id="answer">Not checked</p>';
      const browser = await viewer.browse(
        {
          ...input,
          width: 390,
          height: 700,
          steps: [
            { type: "fill", selector: "#distance", value: "7" },
            { type: "click", selector: "#check" },
          ],
        },
        detail,
      );
      console.log("PASS interactive browser");
      assert.ok(browser.steps.every((s) => s.ok));
      assert.match(browser.dom.text, /7/);
      assert.equal(browser.image.mimeType, "image/jpeg");
      assert.ok(Buffer.from(browser.image.data, "base64").length > 1000);
      assert.equal(browser.layout.nodeAccess, false);
      await assert.rejects(
        viewer.browse(
          {
            ...input,
            width: 390,
            height: 700,
            steps: [],
            script: 'fetch("file:///etc/hosts")',
          },
          detail,
        ),
      );
      evidence.interactive = {
        ...browser,
        image: {
          mimeType: browser.image.mimeType,
          bytes: Buffer.from(browser.image.data, "base64").length,
        },
      };
      await mkdir(resolve("var/desktop"), { recursive: true });
      page =
        '<h1>Browser conditions</h1><button id="keyboard">Keyboard target</button><p id="graphics"></p><script>document.querySelector("#graphics").textContent = document.createElement("canvas").getContext("webgl2") ? "WebGL available" : "WebGL unavailable"</script>';
      const fallback = await viewer.browse(
        {
          ...input,
          width: 390,
          height: 700,
          reducedMotion: true,
          disableWebgl: true,
          steps: [{ type: "press", key: "Tab" }],
        },
        detail,
      );
      console.log("PASS fallback conditions");
      assert.equal(fallback.dom.reducedMotion, true);
      assert.equal(fallback.dom.focus, "keyboard");
      assert.match(fallback.dom.text, /WebGL unavailable/);
      assert.equal(fallback.conditions.webglDisabled, true);
      assert.deepEqual(fallback.steps, [
        { type: "press", key: "Tab", ok: true },
      ]);
      evidence.fallback = {
        conditions: fallback.conditions,
        dom: fallback.dom,
      };

      // Native buttons must activate by keyboard without a custom key handler.
      // Focus-only assertions miss a browser tool that omits character events.
      page =
        '<button id="activate" onclick="document.querySelector(\'#count\').textContent=++window.clicks">Activate</button><p id="count">0</p><script>window.clicks=0</script>';
      evidence.keyboardActivation = [];
      for (const key of ["Enter", "Space"]) {
        const activated = await viewer.browse(
          {
            ...input,
            width: 390,
            height: 700,
            steps: [
              { type: "press", key: "Tab" },
              { type: "press", key },
            ],
          },
          detail,
        );
        assert.equal(activated.dom.focus, "activate");
        assert.match(activated.dom.text, /\b1\b/, `${key} activates once`);
        evidence.keyboardActivation.push({ key, dom: activated.dom });
      }
      console.log("PASS native Enter/Space activation");

      // Load the actual optional quality-pack renderer and its model module,
      // rather than a DOM stand-in that repeats the expected answers.
      page = await readFile(
        new URL(
          "../examples/quality-packs/science/fixture.html",
          import.meta.url,
        ),
        "utf8",
      );
      assets.set(
        "model-contract.mjs",
        await readFile(
          new URL(
            "../examples/quality-packs/science/model-contract.mjs",
            import.meta.url,
          ),
        ),
      );
      detail.document.files.push({ path: "model-contract.mjs" });
      evidence.science = [];
      for (const scenario of [
        {
          name: "baseline-wide",
          width: 1100,
          values: {},
          expected: /Average speed: 5 m\/s/,
        },
        {
          name: "baseline-fallback",
          width: 390,
          values: {},
          expected: /Average speed: 5 m\/s/,
        },
        {
          name: "negative-distance",
          width: 390,
          values: { distance: "-1" },
          expected: /Distance must be between 0 and 1000 m/,
        },
        {
          name: "zero-time",
          width: 390,
          values: { time: "0" },
          expected: /Choose a time greater than zero/,
        },
        {
          name: "blank-time",
          width: 390,
          values: { time: "" },
          expected: /Time must be a finite number/,
        },
        {
          name: "valid-zero-distance",
          width: 390,
          values: { distance: "0" },
          expected: /Average speed: 0 m\/s/,
        },
      ]) {
        console.log(`CHECK science ${scenario.name}`);
        const result = await viewer.browse(
          {
            ...input,
            width: scenario.width,
            height: 1000,
            reducedMotion: true,
            disableWebgl: true,
            steps: [
              ...Object.entries(scenario.values).map(([key, value]) => ({
                type: "fill",
                selector: `#${key}`,
                value,
              })),
              { type: "click", selector: "button[type=submit]" },
            ],
          },
          detail,
        );
        assert.deepEqual(result.errors, [], scenario.name);
        assert.ok(
          result.steps.every((s) => s.ok),
          scenario.name,
        );
        assert.match(result.dom.text, scenario.expected, scenario.name);
        assert.match(result.dom.text, /Distance \(m\)/);
        assert.match(result.dom.text, /Time \(s\)/);
        assert.ok(result.layout.documentWidth <= scenario.width, scenario.name);
        if (
          ["negative-distance", "zero-time", "blank-time"].includes(
            scenario.name,
          )
        ) {
          assert.match(result.dom.text, /Average speed: not available/);
          assert.match(result.dom.text, /Showing the last valid trial/);
        }
        await writeFile(
          resolve(`var/desktop/science-${scenario.name}.jpg`),
          Buffer.from(result.image.data, "base64"),
          { mode: 0o600 },
        );
        evidence.science.push({
          name: scenario.name,
          ...result,
          image: {
            mimeType: result.image.mimeType,
            file: `science-${scenario.name}.jpg`,
          },
        });
      }
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      await writeFile(
        resolve("var/desktop/layout-inspection.json"),
        JSON.stringify(evidence, null, 2),
        { mode: 0o600 },
      );
      console.log(
        "PASS actual layout, interaction, keyboard/reduced-motion/no-WebGL, science model/renderer regressions, network/host denial, bounded hung renderer and cleanup",
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
