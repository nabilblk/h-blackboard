import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function closePreview(target, port) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = j;
  });
  socket.send(JSON.stringify({ id: 1, method: "Page.close" }));
  for (let i = 0; i < 100; i++) {
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })
    ).json();
    if (!targets.some((t) => t.id === target.id)) break;
    await wait(50);
  }
  socket.close();
}
export async function artifactProof(
  a,
  b,
  c,
  { root, evidence, closePanel, people },
) {
  const mission = a.evaluate("window.blackboardNode.state()").missions[0].id;
  const state = (n) => n.evaluate("window.blackboardNode.state()").missions[0];
  const list = (n) =>
    n.evaluate(`window.blackboardNode.artifacts(${JSON.stringify(mission)})`);
  for (const n of [a, b, c]) {
    closePanel(n);
    n.browser("set", "viewport", "1440", "900");
    n.button("Main", "document.querySelector('.n-conversation-nav')");
  }
  let networkHits = 0;
  const canary = createServer((_req, res) => {
    networkHits++;
    res.end("unexpected network access");
  });
  await new Promise((r) => canary.listen(0, "127.0.0.1", r));
  const canaryURL = `http://127.0.0.1:${canary.address().port}`;
  const html = `<!doctype html><meta charset="utf-8"><title>Family event guide</title><link rel="stylesheet" href="guide.css"><h1>Family event guide</h1><p>North entrance · level access · 240 m</p><button id="show">Show activity</button><p id="activity"></p><script>
 document.querySelector('#show').onclick=()=>document.querySelector('#activity').textContent='Build a paper bridge · ages 6–12';
 window.probe={require:typeof require,bridge:typeof blackboardNode,popup:window.open('${canaryURL}/popup')===null};
 Promise.all(['${canaryURL}/fetch','file:///etc/hosts','harakiri://desktop/index.html'].map(u=>fetch(u).then(()=>false,()=>true))).then(blocked=>window.probe.fetchBlocked=blocked);
 try {const ws=new WebSocket('${canaryURL.replace("http:", "ws:")}/ws');ws.onerror=()=>window.probe.websocketBlocked=true;} catch {window.probe.websocketBlocked=true;}
 const img=new Image();img.src='${canaryURL}/pixel';img.onerror=()=>window.probe.imageBlocked=true;
 const iframe=document.createElement('iframe');iframe.src='harakiri://desktop/index.html';document.body.append(iframe);
 </script>`;
  const source = join(root, "index.html"),
    css = join(root, "guide.css");
  await writeFile(source, html);
  await writeFile(
    css,
    "body{font:18px/1.7 sans-serif;padding:48px;background:#f6f2e9;color:#252823}h1{font-size:40px}button{padding:12px 20px}iframe{display:none}",
  );
  const panel = (n) => {
    closePanel(n);
    n.button("Artifacts", "document.querySelector('.n-conversation-nav')");
  };
  const publish = async (
    n,
    { title, files = [source, css], revision = false, inputs = "", channel },
  ) => {
    if (!revision) {
      panel(n);
      n.button("Publish", "document.querySelector('.n-context-panel')");
    } else n.button("Publish revision");
    n.browser("fill", "input[name=title]", title);
    n.browser(
      "fill",
      "textarea[name=summary]",
      "A practical guide to activities and step-free access.",
    );
    n.browser("select", "select[name=kind]", "application");
    n.browser("select", "select[name=stage]", "complete");
    if (channel)
      n.browser("select", ".n-artifact-publish select:not([name])", channel);
    if (files.length)
      n.browser(
        "upload",
        ".n-artifact-publish input[type=file]:not([webkitdirectory])",
        ...files,
      );
    n.browser(
      "fill",
      "textarea[name=limitations]",
      "Fixture only. Venue measurements need a real visit.",
    );
    if (inputs) {
      n.click(".n-artifact-publish details > summary");
      n.browser("fill", "textarea[name=inputs]", inputs);
    }
    assert.equal(
      n.evaluate('document.querySelector("select[name=entrypoint]").value'),
      "index.html",
    );
    n.button("Publish", "document.querySelector('.n-artifact-publish')");
    await n.wait(
      '!!document.querySelector(".n-artifacts:has(.n-artifact-eyebrow)")',
      "Publication did not open exact details",
    );
    return list(n).items.find((x) => x.title === title).revision;
  };
  try {
    a.browser(
      "fill",
      "#main-message",
      "Draft preserved while checking artifacts.",
    );
    const first = await publish(a, { title: "Family event guide" });
    a.button("Copy revision reference");
    await a.wait(
      "document.querySelector('.n-artifacts:has(.n-artifact-eyebrow)').textContent.includes('Copied')",
      "Copy failed",
    );
    assert.equal(execFileSync("/usr/bin/pbpaste", { encoding: "utf8" }), first);
    a.browser("screenshot", join(evidence, "artifact-details.png"));
    panel(b);
    await b.wait(
      "document.querySelector('.n-artifact-row')?.textContent.includes('Family event guide')",
      "Artifact did not replicate",
    );
    // Primary title is one click; this also retrieves exact verified bytes from A.
    b.click(".n-artifact-row-title button");
    let target;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      target = (
        await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json()
      ).find((t) => t.url.startsWith("harakiri-artifact://"));
      if (target) break;
      await wait(100);
    }
    assert.ok(target, "Isolated viewer target missing");
    const browser = b.browser;
    browser("tab", "1");
    const evaluate = b.evaluate;
    assert.equal(evaluate("location.href"), target.url);
    browser("click", "#show");
    assert.equal(
      evaluate('document.querySelector("#activity").textContent'),
      "Build a paper bridge · ages 6–12",
    );
    assert.equal(
      evaluate("getComputedStyle(document.body).padding"),
      "48px",
      "Relative stylesheet must load offline",
    );
    const probes = evaluate("window.probe");
    assert.equal(probes.require, "undefined");
    assert.equal(probes.bridge, "undefined");
    assert.equal(probes.popup, true);
    assert.deepEqual(probes.fetchBlocked, [true, true, true]);
    assert.equal(probes.websocketBlocked, true);
    assert.equal(probes.imageBlocked, true);
    assert.equal(
      evaluate('document.querySelector("iframe").contentDocument'),
      null,
    );
    assert.equal(networkHits, 0);
    browser("screenshot", join(evidence, "artifact-isolated-preview.png"));
    // A new native window becomes the browser automation session's active page.
    // Explicitly return that session to the original workspace.
    b.browser("tab", "0");
    assert.equal(b.evaluate("location.href"), "harakiri://desktop/index.html");
    b.button("Details", "document.querySelector('.n-artifact-row')");
    await b.wait(
      '!!document.querySelector(".n-artifacts:has(.n-artifact-eyebrow)")',
      "Details missing",
    );
    b.click(".n-artifact-files > div:nth-child(2) .n-artifact-file");
    let reader;
    for (let i = 0; i < 100; i++) {
      reader = (
        await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json()
      ).find((t) => t.url.includes("/__reader_"));
      if (reader) break;
      await wait(100);
    }
    assert.ok(reader);
    browser("tab", "2");
    assert.ok(
      evaluate('document.querySelector("pre").textContent').includes(
        "background:#f6f2e9",
      ),
    );
    assert.equal(
      evaluate(
        `document.fonts.ready.then(()=>document.fonts.check('14px "IBM Plex Mono"'))`,
      ),
      true,
    );
    browser("screenshot", join(evidence, "artifact-text-reader.png"));
    await closePreview(reader, b.port);
    browser("tab", "0");
    b.button("Add review");
    b.browser(
      "fill",
      "textarea[name=summary]",
      "Checked the exact guide and interactive activity.",
    );
    b.browser(
      "fill",
      "textarea[name=conditions]",
      "Offline native preview; local files and interactions; no real visitors.",
    );
    b.button("Save review");
    await a.wait(
      "document.querySelector('.n-artifact-reviews')?.textContent.includes('Checked the exact guide')",
      "Review did not replicate",
    );
    a.button("Record acceptance");
    a.browser(
      "fill",
      "textarea[name=reason]",
      "Accept the reviewed fixture as the initial guide.",
    );
    a.button("Save decision");
    await a.wait(
      "document.querySelector('.n-artifacts:has(.n-artifact-eyebrow)')?.textContent.includes('Accepted by')",
      "Acceptance missing",
    );
    a.button("Highlight");
    await a.wait(
      "document.querySelector('.n-artifacts:has(.n-artifact-eyebrow)')?.textContent.includes('Remove highlight')",
      "Highlight missing",
    );
    a.browser("screenshot", join(evidence, "artifact-reviewed-accepted.png"));
    // Reuse bytes under the same identity; exact old review/acceptance stay behind.
    const second = await publish(a, {
      title: "Family event guide — revised",
      revision: true,
      files: [],
    });
    assert.notEqual(first, second);
    const secondDetail = a.evaluate(
      `window.blackboardNode.artifactDetail('${mission}','${second}')`,
    );
    assert.equal(secondDetail.reviews.length, 0);
    assert.equal(secondDetail.acceptance, null);
    assert.equal(secondDetail.history.length, 2);
    browser("tab", "1");
    assert.equal(
      evaluate('document.querySelector("h1").textContent'),
      "Family event guide",
    );
    browser("tab", "0");
    // Exact input changes visibly invalidate dependent evidence.
    const report = await publish(a, {
      title: "Volunteer briefing",
      inputs: second,
    });
    const revised = a.evaluate(
      `window.blackboardNode.artifactTransfer('${mission}',{type:'publish',control:'${state(a).lifecycle.revision}',conversation:'main',artifact:'${first}',parents:['${second}'],document:{title:'Family event guide — venue changed',summary:'Updated venue constraint',kind:'application',stage:'complete',limitations:'Fixture',entrypoint:'index.html',inputs:[],files:[]},uploads:[],retain:[{revision:'${second}',path:'index.html'},{revision:'${second}',path:'guide.css'}]})`,
    );
    assert.ok(revised.event);
    for (
      let i = 0;
      i < 100 &&
      !a.evaluate(
        "document.querySelector('.n-artifacts:has(.n-artifact-eyebrow)')?.textContent.includes('Review this revision again.')",
      );
      i++
    )
      await wait(100);
    assert.equal(
      a.evaluate(
        "document.querySelector('.n-artifacts:has(.n-artifact-eyebrow)')?.textContent.includes('Review this revision again.')",
      ),
      true,
    );
    assert.equal(
      a.evaluate(
        `window.blackboardNode.artifactDetail('${mission}','${report}')`,
      ).stale,
      true,
    );
    a.browser("screenshot", join(evidence, "artifact-stale-input.png"));
    panel(a);
    a.browser("screenshot", join(evidence, "artifact-list.png"));
    a.browser("set", "viewport", "900", "650");
    assert.equal(
      a.evaluate("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
    a.browser("screenshot", join(evidence, "artifact-list-narrow.png"));
    closePanel(a);
    assert.equal(
      a.evaluate('document.querySelector("#main-message").value'),
      "Draft preserved while checking artifacts.",
    );
    a.browser("set", "viewport", "1440", "900");
    // B/C private files never appear in the creator's artifact list or reader.
    const privateScope = b
      .evaluate(`window.blackboardNode.audiences('${mission}')`)
      .find((s) => !s.agent_registration).id;
    closePanel(b);
    b.click(`.n-conversation-nav [data-audience="${privateScope}"]`);
    const secret = await publish(b, {
      title: "Private access notes",
      channel: privateScope,
    });
    assert.equal(
      list(a).items.some((x) => x.revision === secret),
      false,
    );
    assert.equal(
      a.evaluate(
        `window.blackboardNode.artifactDetail('${mission}','${secret}').then(()=>false,()=>true)`,
      ),
      true,
    );
    await c.wait(
      `window.blackboardNode.artifacts('${mission}').then(p=>p.items.some(x=>x.revision==='${secret}'))`,
      "Private reader missing file",
    );
    const chunk = c.evaluate(
      `window.blackboardNode.artifactTransfer('${mission}',{type:'read',revision:'${secret}',path:'index.html',offset:0})`,
    );
    assert.equal(Buffer.from(chunk.hex, "hex").toString(), html);
    await a.stop();
    const relayed = c.evaluate(
      `window.blackboardNode.artifactTransfer('${mission}',{type:'read',revision:'${first}',path:'index.html',offset:0})`,
    );
    assert.equal(
      Buffer.from(relayed.hex, "hex").toString(),
      html,
      "Authorized cached output survives creator disconnect",
    );
    await a.start();
    a.click(".n-mission-row");
    const restored = a.evaluate(
      `window.blackboardNode.artifactDetail('${mission}','${first}')`,
    );
    assert.equal(restored.acceptance.accepted, true);
    // Close just the separate preview through CDP, leaving the workspace running.
    await closePreview(target, b.port);
    b.browser("tab", "0");
    closePanel(b);
    b.button("Main", "document.querySelector('.n-conversation-nav')");
    people(a);
    return {
      publishAndReviewThroughUI: true,
      oneClickOfflinePreview: true,
      exactRevisionHistory: true,
      staleInputs: true,
      privateFileIsolation: true,
      creatorOfflineArtifactRetrieval: true,
      previewNetworkHits: networkHits,
      previewNoHostBridge: true,
      previewScriptAndRelativeAssetsWork: true,
      copyRevision: true,
      conversationDraftPreserved: true,
      overflowAt900: false,
    };
  } finally {
    await new Promise((r) => canary.close(r));
  }
}
