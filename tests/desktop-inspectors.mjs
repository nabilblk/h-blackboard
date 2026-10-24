// Optional renderer integration checks alongside the native desktop journeys.
// Uses real React components and isolated renderer fixtures; never starts agents.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const directory = await mkdtemp(join(tmpdir(), "hb-inspector-ui-"));
const evidence = resolve("var/desktop/inspector-ui");
const session = `hb-inspectors-${process.pid}`;
const browser = async (...args) =>
  (
    await promisify(execFile)(
      "agent-browser",
      ["--session", session, ...args],
      { encoding: "utf8", timeout: 20000 },
    )
  ).stdout;
const evaluate = async (source) => JSON.parse(await browser("eval", source));
let server;
try {
  await mkdir(evidence, { recursive: true });
  await build({
    entryPoints: ["tests/fixtures/desktop-inspectors.jsx"],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    outdir: directory,
    loader: { ".woff2": "file", ".woff": "file", ".svg": "dataurl" },
  });
  server = createServer(async (request, response) => {
    try {
      const file = basename(new URL(request.url, "http://localhost").pathname);
      if (!file) {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/desktop-inspectors.css"></head><body><div id="root"></div><script type="module" src="/desktop-inspectors.js"></script></body></html>',
        );
      } else {
        response.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "font/woff2",
        );
        response.end(await readFile(join(directory, file)));
      }
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const buttons = () =>
    evaluate(
      "[...document.querySelectorAll('button')].filter(b => b.checkVisibility()).map(b=>b.textContent.trim())",
    );
  const results = [];
  const click = async (name) => {
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(name)})`,
    );
    await evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(name)})?.scrollIntoView({block:'center', behavior:'instant'})`,
    );
    return browser(
      "find",
      "role",
      "button",
      "click",
      "--name",
      name,
      "--exact",
    );
  };
  const selectDeliverable = async () => {
    const selector =
      '[aria-label="Mission completion review"] input[type="checkbox"]';
    await browser("wait", selector);
    await browser("scrollintoview", selector);
    await browser("check", selector);
  };
  const calls = () => evaluate("window.completionFixture.calls");
  const completionScene = async (scene) => {
    await browser("open", `${origin}/?scene=${scene}`);
    await browser("wait", "--fn", "!!window.completionFixture");
    await evaluate("localStorage.clear()");
    await browser("open", `${origin}/?scene=${scene}`);
    await browser("wait", "--text", "Success criteria");
    await browser("wait", "--text", "Open shared plan artifact");
  };
  for (const scene of [
    "sign-in",
    "signing-in",
    "expired",
    "planning",
    "plan-ready",
    "terms-review",
    "running",
    "budget",
    "budget-reserved",
    "budget-expired",
  ]) {
    await browser("open", `${origin}/?scene=${scene}`);
    await browser(
      "wait",
      "--fn",
      scene.startsWith("budget")
        ? "!!document.querySelector('.n-governance nav')"
        : "document.querySelector('.n-execution h3')?.textContent.trim() !== 'Unknown'",
    );
    if (scene === "sign-in")
      assert.equal(
        (await buttons()).filter((b) => b.startsWith("Sign in to")).length,
        1,
      );
    if (scene === "signing-in") {
      assert.ok((await buttons()).includes("Open provider sign-in"));
      assert.equal(
        (await buttons()).some((b) => b.startsWith("Sign in to")),
        false,
      );
    }
    if (scene === "expired") {
      assert.equal(
        (await buttons()).filter((b) => b === "Get a fresh sign-in").length,
        1,
      );
      assert.equal(
        (await buttons()).some(
          (b) => b.startsWith("Sign in to") || b === "Open provider sign-in",
        ),
        false,
      );
      assert.equal(
        await evaluate(
          "!!document.querySelector('input[value=\"EXPIRED-FIXTURE\"]')",
        ),
        false,
      );
    }
    if (scene === "planning")
      assert.ok((await buttons()).includes("Review planning session"));
    if (scene === "plan-ready")
      assert.ok((await buttons()).includes("Revise plan with Coordinator"));
    if (scene === "terms-review") {
      assert.ok((await buttons()).includes("Review updated instructions"));
      assert.equal(
        (await buttons()).includes("Review planning session"),
        false,
      );
      await click("Review updated instructions");
      await browser(
        "wait",
        "--text",
        "Six activities, accessible spaces and a practical afternoon schedule.",
      );
      assert.equal(
        await evaluate(
          "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Accept updated instructions').disabled",
        ),
        true,
      );
      await browser(
        "screenshot",
        join(evidence, "terms-review-before-acceptance.png"),
      );
      await browser(
        "check",
        '[aria-label="Updated mission instructions"] input[type="checkbox"]',
      );
      await click("Accept updated instructions");
      await browser("wait", "--text", "Updated instructions accepted.");
      assert.deepEqual(await evaluate("window.networkFixture.calls"), [
        { type: "review-terms", id: "fixture-mission", role: "coordinator" },
        {
          type: "renew-terms",
          input: {
            contributionId: "fixture-local",
            reviewId: "review-fixture",
          },
        },
      ]);
      assert.equal(
        (await buttons()).includes("Review updated instructions"),
        false,
      );
    }
    if (scene === "running") {
      assert.ok((await buttons()).includes("Stop environment"));
      await browser(
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Technical",
        "--exact",
      );
      assert.ok(
        (await buttons()).includes("Stop environment"),
        "Stop remains reachable when inspecting details",
      );
    }
    if (scene === "budget") {
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('No execution permissions issued.')",
        ),
        false,
      );
      await browser(
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Technical",
        "--exact",
      );
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('No execution permissions issued.')",
        ),
        true,
      );
    }
    if (scene === "budget-reserved" || scene === "budget-expired") {
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('Contributor distant-co')",
        ),
        true,
        "Budget includes contributors absent from the current agent roster",
      );
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('Execution needs reconciliation')",
        ),
        scene === "budget-expired",
        "A valid running reservation is not a recovery failure",
      );
    }
    assert.equal(
      await evaluate("document.documentElement.scrollWidth > innerWidth"),
      false,
    );
    await browser("screenshot", join(evidence, `${scene}.png`));
    results.push({ scene, passed: true });
  }

  // Network consent is explicit and cannot be changed during execution.
  for (const scene of ["network-stopped", "network-running"]) {
    await browser("open", `${origin}/?scene=${scene}`);
    await browser("wait", "--text", "Access & limits");
    await click("Access & limits");
    await browser("wait", '[aria-label="Workspace internet access"] select');
    assert.equal(
      await evaluate(
        "document.querySelector('[aria-label=\"Workspace internet access\"] select').value",
      ),
      "restricted",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('[aria-label=\"Workspace internet access\"] select').disabled",
      ),
      scene === "network-running",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('select[name=capabilityPack]').value",
      ),
      "general",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('select[name=capabilityPack]').disabled",
      ),
      scene === "network-running",
    );
    if (scene === "network-stopped") {
      await browser(
        "select",
        '[aria-label="Workspace internet access"] select',
        "internet",
      );
      assert.deepEqual(
        await evaluate("window.networkFixture.calls"),
        [],
        "selecting alone never changes permission",
      );
      await click("Apply internet setting");
      await browser("wait", "--text", "Internet setting applied.");
      assert.deepEqual(await evaluate("window.networkFixture.calls"), [
        {
          type: "network",
          id: "fixture-local",
          networkAccess: "internet",
          expectedRevision: null,
        },
      ]);
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('Access changed since this review')",
        ),
        false,
      );
    }
    if (scene === "network-stopped") {
      await browser("select", 'select[name="capabilityPack"]', "web-3d");
      assert.equal((await evaluate("window.networkFixture.calls")).length, 1);
      await click("Apply toolkit");
      await browser("wait", "--text", "Toolkit applied.");
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('The toolkit changed since this review')",
        ),
        false,
      );
      assert.deepEqual((await evaluate("window.networkFixture.calls"))[1], {
        type: "toolkit",
        id: "fixture-local",
        capabilityPack: "web-3d",
        expectedRevision: null,
      });
      assert.equal(
        await evaluate(
          "document.querySelector('select[name=networkAccess]').value",
        ),
        "internet",
      );
    }
    await browser("screenshot", join(evidence, `${scene}.png`));
    results.push({ scene, passed: true });
  }
  await browser("open", `${origin}/?scene=network-setup`);
  await browser("wait", "--text", "Workspace internet");
  await evaluate("localStorage.clear()");
  await browser("open", `${origin}/?scene=network-setup`);
  await browser("wait", "--text", "Workspace internet");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('select')].find(s=>s.closest('label')?.textContent.includes('Workspace internet')).value",
    ),
    "restricted",
  );
  await browser("select", 'select[name="networkAccess"]', "internet");
  assert.equal(
    await evaluate(
      "document.querySelector('select[name=capabilityPack]').value",
    ),
    "general",
  );
  await browser("select", 'select[name="capabilityPack"]', "web-3d");
  await browser("check", 'input[type="checkbox"][required]');
  await click("Prepare agents");
  await browser("wait", "--fn", "window.networkFixture.calls.length === 1");
  assert.equal(
    (await evaluate("window.networkFixture.calls"))[0].request.networkAccess,
    "internet",
  );
  assert.equal(
    (await evaluate("window.networkFixture.calls"))[0].request.capabilityPack,
    "web-3d",
  );
  results.push({ scene: "network-setup", passed: true });

  // A plan marked complete never becomes an early mission-closing prompt.
  for (const scene of ["completion-plan-preparing", "completion-plan-active"]) {
    await completionScene(scene);
    assert.equal(
      await evaluate(
        "!!document.querySelector('[aria-label=\"Mission completion review\"]')",
      ),
      false,
    );
    await click("Open shared plan artifact");
    await browser("wait", "--text", "Human acceptance");
    await click("Record acceptance");
    assert.equal(
      await evaluate(
        "document.querySelector('textarea[name=reason]').required",
      ),
      false,
    );
    await click("Save decision");
    await browser("wait", "--text", "Accepted this artifact revision.");
    assert.deepEqual(
      (await calls()).map((c) => c.type),
      ["artifact"],
    );
    assert.equal(
      await evaluate("window.completionFixture.phase"),
      scene.endsWith("preparing") ? "preparing" : "active",
    );
    results.push({ scene, passed: true });
  }

  // Readiness can arrive while the panel is open, without remounting it.
  await completionScene("completion-plan-active");
  await evaluate("window.completionFixture.meetCriteria()");
  await browser("wait", "--text", "Review deliverables");
  assert.deepEqual(await calls(), []);

  await completionScene("completion-results");
  await click("Review deliverables");
  await selectDeliverable();
  assert.equal(
    await evaluate("document.querySelector('textarea').required"),
    false,
  );
  await click("Review mission completion");
  await browser("wait", "--text", "Finish this mission?");
  assert.deepEqual(
    await calls(),
    [],
    "Reviewing, without a message, cannot close the mission",
  );
  await browser("screenshot", join(evidence, "completion-confirmation.png"));
  await click("Back to review");
  assert.deepEqual(await calls(), []);
  await click("Review mission completion");
  await click("Accept deliverables and finish mission");
  await browser("wait", "--fn", "window.completionFixture.phase === 'closed'");
  assert.equal((await calls()).length, 1);
  assert.equal((await calls())[0].request.closeConfirmed, true);
  assert.ok((await calls())[0].request.reason.trim());
  results.push({ scene: "completion-explicit-confirmation", passed: true });

  // A mission change after review cannot be confirmed against a new revision.
  await completionScene("completion-results");
  await click("Review deliverables");
  await selectDeliverable();
  await click("Review mission completion");
  await evaluate("window.completionFixture.changeControl()");
  await browser("wait", "--text", "The mission changed.");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('button')].find(b => b.textContent === 'Accept deliverables and finish mission').disabled",
    ),
    true,
  );
  assert.deepEqual(await calls(), []);
  await click("Back to review");
  await click("Review mission completion");
  await evaluate("window.completionFixture.staleArtifact()");
  await browser("wait", "--text", "A selected deliverable changed.");
  assert.deepEqual(await calls(), []);
  results.push({ scene: "completion-changed-inputs", passed: true });

  await completionScene("completion-saved");
  await browser("wait", "--text", "Unfinished completion review");
  assert.deepEqual(
    await calls(),
    [],
    "Restoring a pending legacy job is not close consent",
  );
  await click("Review mission completion");
  assert.deepEqual(await calls(), []);
  await click("Discard unfinished completion review");
  assert.deepEqual(
    (await calls()).map((c) => c.type),
    ["discard"],
  );
  assert.equal(await evaluate("window.completionFixture.phase"), "active");
  results.push({ scene: "completion-saved", passed: true });

  await browser("open", `${origin}/?scene=completion-closed`);
  await browser("wait", "--text", "Mission closed; this agent is stopped.");
  assert.equal(
    await evaluate(
      "document.body.innerText.includes('Current plan not yet acknowledged')",
    ),
    false,
  );
  await browser("screenshot", join(evidence, "completion-closed.png"));
  results.push({ scene: "completion-closed", passed: true });
  await browser("set", "viewport", "390", "844");
  await browser("open", `${origin}/?scene=signing-in`);
  await browser("wait", "--text", "Open provider sign-in");
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  await browser("screenshot", join(evidence, "sign-in-narrow.png"));
  await browser("open", `${origin}/?scene=network-stopped`);
  await browser("wait", "--text", "Access & limits");
  await click("Access & limits");
  await browser("select", 'select[name="networkAccess"]', "internet");
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  await browser("screenshot", join(evidence, "network-narrow.png"));
  for (const width of [1100, 390]) {
    await browser("set", "viewport", String(width), "900");
    await browser("open", `${origin}/?scene=coordination-artifacts`);
    await browser("wait", ".n-artifact-candidate");
    assert.match(await browser("get", "text", "body"), /source, tests/);
    await click("Open result");
    assert.equal(
      (
        await evaluate(
          "window.coordinationFixture.calls.filter(c=>c.type==='open')",
        )
      )[0].revision,
      "e".repeat(64),
    );
    assert.equal(
      await evaluate("document.documentElement.scrollWidth > innerWidth"),
      false,
    );
    await browser("screenshot", join(evidence, `candidate-${width}.png`));
    await browser("find", "text", "Filter artifacts", "click", "--exact");
    await browser("select", 'select[name="artifactKind"]', "report");
    await browser(
      "wait",
      "--fn",
      "window.coordinationFixture.calls.some(c=>c.query?.kind==='report')",
    );
    await click("Review details");
    await browser("wait", "--text", "Choose for delivery");
    await click("Choose for delivery");
    assert.deepEqual(
      (
        await evaluate(
          "window.coordinationFixture.calls.filter(c=>c.type==='action')",
        )
      )[0].action,
      {
        type: "candidate",
        revision: "e".repeat(64),
        previous: ["3".repeat(64)],
      },
    );
    await browser("open", `${origin}/?scene=coordination-peers`);
    await browser("wait", "--text", "Sync stalled");
    const peerText = await browser("get", "text", "body");
    assert.match(peerText, /Riley/);
    assert.match(peerText, /Current mission control not yet confirmed/);
    assert.doesNotMatch(peerText, /Up to date/);
    assert.equal(
      await evaluate("document.documentElement.scrollWidth > innerWidth"),
      false,
    );
    await browser("screenshot", join(evidence, `stalled-peer-${width}.png`));
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        fixturesOnly: true,
        results,
        narrow: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Inspector states, internet access setup/changes, plan acceptance, explicit mission completion, stale/recovered reviews and narrow layouts passed. No native actions or providers used.",
  );
} catch (error) {
  try {
    await browser("screenshot", join(evidence, "failure.png"));
    console.error(await browser("get", "text", "body"));
    console.error(
      await browser(
        "eval",
        "({ calls: window.completionFixture?.calls, phase: window.completionFixture?.phase })",
      ),
    );
    console.error(await browser("errors"));
  } catch {
    /* Preserve the original test failure. */
  }
  throw error;
} finally {
  try {
    await browser("close");
  } catch {}
  if (server) await new Promise((r) => server.close(r));
  await rm(directory, { recursive: true, force: true });
}
