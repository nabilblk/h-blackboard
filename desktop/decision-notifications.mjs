import { createHash } from "node:crypto";
import { missionDecisions } from "../shared/mission-presentation.mjs";
// Local, opt-in attention only. Never put conversation, provider or invitation
// text on the lock screen, and never perform a decision from a notification.
const messages = {
  admission: "Someone is waiting for your decision to join a mission.",
  start: "A mission has a Start review waiting for you.",
  results:
    "Mission criteria are reported met. Review the evidence and results.",
  contribution:
    "A saved contribution needs your review before it can continue.",
  setup: "Agent setup needs your attention. Your saved setup is available.",
};

export class DecisionNotifications {
  constructor({ node, agreements, onboarding, show }) {
    Object.assign(this, { node, agreements, onboarding, show });
    this.seen = new Map();
    this.cursor = 0;
  }
  async poll(snapshot, { enabled, focused }) {
    if (!enabled || !snapshot.identity) return;
    const missions = snapshot.missions;
    if (!missions.length) return;
    // Bound background work even for a node with many archived missions.
    const selected = Array.from(
      { length: Math.min(8, missions.length) },
      (_, i) => missions[(this.cursor + i) % missions.length],
    );
    this.cursor = (this.cursor + selected.length) % missions.length;
    let delivered = 0;
    for (const m of selected) {
      if (m.conflicted || ["closed", "archived"].includes(m.lifecycle.phase))
        continue;
      const decisions = [];
      if (m.owner === snapshot.identity.owner) {
        const [peers, ledger] = await Promise.all([
          this.node.handle("peers", { mission: m.id }),
          this.node.handle("governance", { mission: m.id }),
        ]);
        for (const decision of missionDecisions({
          mission: m,
          viewer: snapshot.identity.owner,
          requests: peers.requests,
          criteria: ledger.criteria,
          startJobs: this.agreements.startState?.(m.id) ?? [],
        }))
          decisions.push([decision.kind, decision.id]);
      }
      for (const a of this.agreements.list(m.id))
        if (["review", "interrupted", "expired"].includes(a.status))
          decisions.push(["contribution", `${a.id}:${a.status}`]);
      for (const j of this.onboarding.state(m.id))
        if (j.status === "failed") decisions.push(["setup", j.id]);
      const grouped = new Map();
      for (const [kind, value] of decisions) {
        if (!grouped.has(kind)) grouped.set(kind, []);
        grouped.get(kind).push(value);
      }
      for (const kind of Object.keys(messages))
        if (!grouped.has(kind)) this.seen.delete(`${m.id}:${kind}`);
      for (const [kind, values] of grouped) {
        const key = `${m.id}:${kind}`;
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(values.sort()))
          .digest("hex");
        if (this.seen.get(key) === fingerprint) continue;
        if (!focused && delivered >= 2) continue;
        // Seeing the same condition again or reopening a panel is not a new
        // decision. Reading the app never accepts or resolves the request.
        this.seen.set(key, fingerprint);
        while (this.seen.size > 2048)
          this.seen.delete(this.seen.keys().next().value);
        if (!focused) {
          delivered++;
          this.show({ mission: m.id, body: messages[kind] });
        }
      }
    }
  }
}
