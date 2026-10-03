import assert from "node:assert/strict";
import { join } from "node:path";
export async function governanceProof(
  a,
  b,
  c,
  { evidence, closePanel, people, rosterProof },
) {
  const state = (n) => n.evaluate("window.blackboardNode.state()").missions[0];
  const mission = state(a).id;
  const ownerKey = a.evaluate("window.blackboardNode.state()").identity.owner;
  const call = (n, method, ...args) =>
    n.evaluate(`window.blackboardNode.${method}(...${JSON.stringify(args)})`);
  const ledger = (n) => call(n, "governance", mission);
  const panel = (n) => {
    closePanel(n);
    n.button("Budget & permissions");
  };
  closePanel(a);
  call(a, "setCoordination", mission, state(a).lifecycle.revision, "peer");
  await rosterProof(a, b);
  closePanel(a);
  a.button("Start mission");
  await b.wait(
    "document.querySelector('.n-control-bar .d-label')?.textContent==='Active'",
    "Mission start missing",
  );
  const peerKey = b.evaluate("window.blackboardNode.state()").identity.owner;
  panel(a);
  a.button("Allocate allowance");
  a.browser("select", ".n-governance form select", peerKey);
  a.browser("fill", ".n-governance form input[name=turns]", "6");
  a.button("Save allocation");
  await b.wait(
    `window.blackboardNode.governance(${JSON.stringify(mission)}).then(v=>v.allocations.length===1)`,
    "Allowance did not replicate",
  );
  a.button("Issue permission");
  a.browser("fill", ".n-governance form input[name=turns]", "3");
  a.button("Save permission");
  panel(b);
  await b.wait(
    "document.querySelector('.n-governance')?.textContent.includes('Awaiting local consent')",
    "Permission not visible",
  );
  b.button("Consent with my local terms");
  await a.wait(
    `window.blackboardNode.governance(${JSON.stringify(mission)}).then(v=>!!v.grants[0]?.consent)`,
    "Consent did not replicate",
  );
  assert.equal(ledger(a).execution_available, false);
  assert.equal(ledger(a).grants[0].turns, 3);
  await a.wait(
    "document.querySelector('.n-governance')?.textContent.includes('Consented · not executing')",
    "Consent state did not refresh in the panel",
  );
  a.browser("screenshot", join(evidence, "budget-permissions.png"));
  b.button("Seal permission");
  await a.wait(
    `window.blackboardNode.governance(${JSON.stringify(mission)}).then(v=>v.grants[0]?.sealed)`,
    "Permission seal did not replicate",
  );
  b.button("Seal allowance");
  await a.wait(
    `window.blackboardNode.governance(${JSON.stringify(mission)}).then(v=>!!v.allocations[0]?.sealed)`,
    "Allowance seal did not replicate",
  );
  await a.wait(
    "[...document.querySelectorAll('.n-governance button')].some(b=>b.textContent==='Reclaim unused allowance')",
    "Ledger panel did not refresh the contributor seal",
  );
  a.button("Reclaim unused allowance");
  await b.wait(
    `window.blackboardNode.governance(${JSON.stringify(mission)}).then(v=>v.allocations[0]?.reclaimed)`,
    "Unused allowance did not reconcile",
  );
  // Exact artifact fixture through the same host transfer used by the file picker.
  const control = state(a).lifecycle.revision;
  const bytes = Buffer.from(
    "# Verified schedule\nEvery activity has an age range and materials.\n",
  );
  const upload = call(a, "artifactTransfer", mission, {
    type: "begin",
    control,
    conversation: "main",
    path: "schedule.md",
    media_type: "text/markdown",
    size: bytes.length,
  }).upload;
  call(a, "artifactTransfer", mission, {
    type: "chunk",
    upload,
    offset: 0,
    hex: bytes.toString("hex"),
  });
  const published = call(a, "artifactTransfer", mission, {
    type: "publish",
    control,
    conversation: "main",
    artifact: null,
    parents: [],
    document: {
      title: "Verified schedule",
      summary: "Evidence for the activity criterion",
      kind: "report",
      stage: "complete",
      limitations: "Native fixture; no real festival.",
      entrypoint: null,
      inputs: [],
      files: [],
    },
    uploads: [upload],
    retain: [],
  }).event;
  closePanel(a);
  a.button("Mission controls");
  a.button("Human override");
  a.browser(
    "fill",
    ".n-governance form textarea",
    "Reviewed the exact saved schedule.",
  );
  a.browser("check", ".n-governance form input[name=criterionMet]");
  a.browser(
    "check",
    `.n-governance form input[name=criterionEvidence][value="${published}"]`,
  );
  a.button("Save progress report");
  await c.wait(
    `window.blackboardNode.governance(${JSON.stringify(mission)}).then(v=>v.criteria[0]?.met)`,
    "Criterion report did not replicate",
  );
  a.browser("screenshot", join(evidence, "mission-progress.png"));
  closePanel(b);
  b.browser("fill", "#main-message", "Keep this draft across a restart");
  await b.stop();
  await b.start();
  b.click(".n-mission-row");
  assert.equal(
    b.evaluate("document.querySelector('#main-message').value"),
    "Keep this draft across a restart",
  );
  b.browser("set", "viewport", "900", "650");
  panel(b);
  assert.equal(
    b.evaluate("document.documentElement.scrollWidth>innerWidth"),
    false,
  );
  b.browser("screenshot", join(evidence, "budget-narrow.png"));
  closePanel(b);
  // Human close/archive does not claim process termination or erase history.
  a.button("Close mission");
  a.browser(
    "fill",
    ".n-governance form textarea",
    "Reviewed evidence and ending this fixture.",
  );
  a.button("Confirm close");
  await c.wait(
    "document.querySelector('.n-control-bar .d-label')?.textContent==='Closed'",
    "Close did not replicate",
  );
  a.button("Archive channel");
  a.browser(
    "fill",
    ".n-governance form textarea",
    "Retain the completed experiment.",
  );
  a.button("Confirm archive");
  await b.wait(
    "document.querySelector('.n-control-bar .d-label')?.textContent==='Archived'",
    "Archive did not replicate",
  );
  assert.equal(
    b.evaluate("document.querySelector('#main-message').disabled"),
    true,
  );
  assert.ok(
    b.evaluate(
      "document.querySelector('.n-conversation-nav')?.textContent.includes('Direct messages')",
    ),
    "Archived missions retain conversation navigation",
  );
  assert.ok(
    a.evaluate(
      "document.querySelector('aside').textContent.includes('Archived channels')",
    ),
  );
  a.browser("screenshot", join(evidence, "archived-channel.png"));
  a.button("Restore channel");
  await c.wait(
    "document.querySelector('.n-control-bar .d-label')?.textContent==='Closed'",
    "Restore lost the closed status",
  );
  await b.wait(
    "document.querySelector('.n-control-bar .d-label')?.textContent==='Closed' && !!document.querySelector('.n-conversation-nav [data-audience]')",
    "Restore lost private conversation navigation",
  );
  assert.equal(ledger(a).criteria[0].met, true);
  assert.equal(ledger(a).criteria[0].evidence[0], published);
  for (const n of [a, b, c]) {
    assert.equal(
      n.evaluate("window.blackboardNode.state()").execution,
      "unavailable",
    );
    closePanel(n);
  }
  const privateScope = call(b, "audiences", mission).find(
    (s) => !s.agent_registration,
  ).id;
  const cKey = c.evaluate("window.blackboardNode.state()").identity.owner;
  const message = call(
    c,
    "postMessage",
    mission,
    "Private route evidence to retain.",
    privateScope,
    null,
    null,
  );
  await b.wait(
    `window.blackboardNode.queryMessages(${JSON.stringify(mission)},{view:"conversation",audience:${JSON.stringify(privateScope)}}).then(p=>p.items.some(m=>m.id===${JSON.stringify(message.event)}))`,
    "Private message did not arrive before revocation",
  );
  people(a);
  a.button(
    "Revoke access…",
    `[...document.querySelectorAll('.n-peer-list .n-peer-row')].find(e=>e.textContent.includes(${JSON.stringify(cKey)}))`,
  );
  a.click(".n-revoke button.primary");
  b.click(`.n-conversation-nav [data-audience="${privateScope}"]`);
  await b.wait(
    "document.querySelector('.n-review-needed summary')?.textContent==='Review provisional private history'",
    "Private reconciliation UI did not appear",
  );
  b.click(".n-review-needed summary");
  b.browser("select", ".n-review-needed select", message.event);
  b.button("Record accepted private history");
  await b.wait(
    `window.blackboardNode.privateRecovery(${JSON.stringify(mission)},${JSON.stringify(privateScope)}).then(v=>v.length===0)`,
    "Private frontier was not recorded",
  );
  assert.deepEqual(call(a, "audiences", mission), []);
  b.browser("screenshot", join(evidence, "private-history-reviewed.png"));
  people(a);
  return {
    resourceAllocationConsentAndReconciliation: true,
    criterionExactArtifact: true,
    closeArchiveRestore: true,
    durableDraftAfterRestart: true,
    privateAcceptedFrontierThroughUI: true,
    sourceProtocol: 8,
    executionUnavailable: true,
    profiles: 3,
    owner: ownerKey.slice(0, 10),
  };
}
