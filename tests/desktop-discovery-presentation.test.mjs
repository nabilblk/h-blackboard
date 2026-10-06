import test from "node:test";
import assert from "node:assert/strict";
import { discoveryPresentation } from "../shared/discovery-presentation.mjs";
test("discovery distinguishes loading, consent, absent routes, failed exchange and empty catalog", () => {
  const input = { state: null, online: true, now: 5000 };
  const view = () => discoveryPresentation(input);
  assert.equal(view().title, "Checking discovery…");
  input.state = {
    config: { enabled: false, bootstrap: [] },
    listings: [],
    health: { peers: [] },
  };
  assert.equal(view().title, "Discovery is off");
  input.state.config.enabled = true;
  assert.equal(view().title, "No discovery sources");
  input.state.config.bootstrap = ["opaque-ticket"];
  input.state.health.peers = [
    {
      name: "Community peer 1",
      outcome: "expired_address",
      last_success_ms: null,
    },
  ];
  assert.equal(view().title, "No recent peer exchange");
  input.state.health.peers[0] = {
    name: "Community peer 1",
    outcome: "ok",
    last_success_ms: 4500,
  };
  assert.equal(view().title, "No public briefs received");
  input.online = false;
  assert.equal(view().title, "Peer networking is off");
  assert.equal(view().action, "network");
});
test("search trims input, preserves cached results offline and never counts stale exchange as current", () => {
  const state = {
    config: { enabled: true, bootstrap: ["opaque"] },
    health: { peers: [{ outcome: "ok", last_success_ms: 1000 }] },
    listings: [
      {
        status: "available",
        advertisement: { title: "Festival", summary: "Plan", capabilities: [] },
      },
      {
        status: "unlisted",
        advertisement: { title: "Private", summary: "", capabilities: [] },
      },
    ],
  };
  const input = { state, online: true, now: 40000, query: "  FESTIVAL  " };
  assert.equal(discoveryPresentation(input).visible.length, 1);
  assert.equal(discoveryPresentation(input).recent, 0);
  input.query = "missing";
  assert.equal(discoveryPresentation(input).action, "clear");
  input.online = false;
  input.query = "  ";
  assert.equal(discoveryPresentation(input).visible.length, 1);
});
