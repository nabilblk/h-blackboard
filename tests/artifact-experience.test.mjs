import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Blackboard } from "../server/board.mjs";

function fixture(t) {
  const b = new Blackboard(":memory:");
  t.after(() => b.close());
  const human = b.auth(b.ownerToken);
  const m = b.execute(
    human,
    "mission_create",
    {
      name: "Artifact experience",
      objective: "Deliver usable results",
      coordination_mode: "peer",
    },
    randomUUID(),
  );
  const act = (actor, op, p = {}) =>
    b.execute(actor, op, { channel_id: m.id, ...p }, randomUUID());
  const invitation = act(human, "invitation_create");
  const agents = ["Builder", "Checker"].map((name) =>
    b.auth(
      b.join({ invitation: invitation.token, runtime: "grok", name }).token,
    ),
  );
  act(human, "mission_state", {
    state: "active",
    version: b.get(m.id).version,
    reason: "Isolated test",
  });
  const publish = (p = {}, actor = agents[0]) =>
    act(actor, "artifact_publish", {
      title: "Family timetable",
      description: "Find an activity for each child.",
      summary: "Implementation notes and checks",
      kind: "application",
      outcome: "complete",
      files: [
        {
          name: "index.html",
          media_type: "text/html",
          content: "<!doctype html><title>Timetable</title><h1>Activities</h1>",
        },
      ],
      ...p,
    });
  const review = (revision, verdict, actor = agents[1], refs = []) =>
    act(actor, "artifact_review", {
      revision_id: revision.id,
      verdict,
      summary: "Recorded assessment",
      conditions: "Test fixture only",
      refs,
    });
  const read = (artifact) =>
    act(human, "artifact_read", { artifact_id: artifact.id });
  return { b, human, m, agents, act, publish, review, read };
}

test("The list separates completion, self-review, independent assessment and human acceptance", (t) => {
  const f = fixture(t),
    a = f.publish();
  const status = () => f.read(a.artifact).artifact.revision.assessment;
  assert.equal(status().status, "unreviewed");
  f.review(a.revision, "verified", f.agents[0]);
  assert.equal(status().status, "self_reviewed");
  assert.equal(status().independentCount, 0);
  f.review(a.revision, "verified");
  assert.equal(status().status, "verified");
  assert.equal(status().accepted, false);
  assert.throws(() => f.review(a.revision, "accepted"), /human/);
  f.review(a.revision, "accepted", f.human);
  assert.equal(status().accepted, true);
  f.review(a.revision, "rejected");
  assert.equal(status().status, "changes_requested");
  assert.equal(
    status().accepted,
    true,
    "Acceptance remains a separate recorded decision",
  );
  f.review(a.revision, "verified");
  assert.equal(
    status().status,
    "verified",
    "A reviewer's latest assessment supersedes its older verdict",
  );
  assert.equal(status().reviewCount, 5);
  const revised = f.publish({
    artifact_id: a.artifact.id,
    version: a.artifact.version,
    summary: "Updated behavior",
  });
  assert.equal(
    f.read(revised.artifact).artifact.revision.assessment.status,
    "unreviewed",
  );
  assert.equal(
    f.read(revised.artifact).artifact.revision.assessment.accepted,
    false,
  );
  const historical = f.act(f.human, "artifact_read", {
    artifact_id: a.artifact.id,
    revision_id: a.revision.id,
  });
  assert.equal(
    historical.revisions.find((r) => r.id === a.revision.id).assessment
      .accepted,
    true,
  );
});

test("Changed review evidence invalidates its assessment even when the output itself has not changed", (t) => {
  const f = fixture(t),
    output = f.publish();
  const checks = f.publish(
    { title: "Browser checks", kind: "validation", refs: [output.revision.id] },
    f.agents[1],
  );
  f.review(output.revision, "verified", f.agents[1], [checks.revision.id]);
  assert.equal(
    f.read(output.artifact).artifact.revision.assessment.status,
    "verified",
  );
  f.publish(
    {
      artifact_id: checks.artifact.id,
      version: checks.artifact.version,
      title: "Browser checks",
      kind: "validation",
      summary: "A missed problem was found",
      refs: [output.revision.id],
    },
    f.agents[1],
  );
  const detail = f.read(output.artifact);
  assert.equal(detail.artifact.stale, false);
  assert.equal(detail.artifact.revision.assessment.status, "needs_recheck");
  assert.equal(detail.reviews[0].stale, true);
});

test("Search and review filters run before pagination, highlights sort first, and private outputs stay private", (t) => {
  const f = fixture(t);
  const early = f.publish({
    title: "Rare reference",
    description: "Find the needle",
  });
  for (let i = 0; i < 55; i++)
    f.publish({ title: `Output ${i}`, description: "A regular result" });
  const stream = f.act(f.human, "stream_create", {
    name: "Data",
    goal: "Compare schedules",
  });
  const data = f.publish(
    { title: "Schedule data", kind: "data", stream_id: stream.id },
    f.agents[1],
  );
  const secret = f.publish({
    title: "Private needle",
    direct_agent_id: f.agents[0].id,
  });
  f.review(early.revision, "verified");
  f.act(f.human, "artifact_highlight", {
    artifact_id: early.artifact.id,
    version: early.artifact.version,
    highlighted: true,
  });
  const page = f.act(f.human, "artifacts_read", { limit: 2 });
  assert.equal(page.items[0].id, early.artifact.id);
  assert.equal(page.total, 57);
  assert.equal(page.nextOffset, 2);
  const search = f.act(f.human, "artifacts_read", {
    query: "needle",
    limit: 1,
  });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].id, early.artifact.id);
  assert.equal(
    f.act(f.human, "artifacts_read", { review_status: "verified" }).total,
    1,
  );
  assert.equal(
    f.act(f.human, "artifacts_read", {
      kind: "data",
      author_id: f.agents[1].id,
      stream_id: stream.id,
    }).items[0].id,
    data.artifact.id,
  );
  assert.equal(
    f.act(f.human, "artifacts_read", {
      direct_agent_id: f.agents[0].id,
      query: "needle",
    }).items[0].id,
    secret.artifact.id,
  );
  assert.throws(
    () =>
      f.act(f.agents[1], "artifacts_read", { direct_agent_id: f.agents[0].id }),
    /Private/,
  );
});

test("Highlights have coordinator/human authority, optimistic concurrency, update delivery and archive protection", (t) => {
  const f = fixture(t),
    a = f.publish();
  const change = {
    artifact_id: a.artifact.id,
    version: a.artifact.version,
    highlighted: true,
  };
  assert.throws(
    () => f.act(f.agents[0], "artifact_highlight", change),
    /Only the human/,
  );
  const before = f.act(f.human, "context_read").cursor;
  const highlighted = f.act(f.human, "artifact_highlight", change);
  assert.ok(f.act(f.human, "context_read").cursor > before);
  assert.throws(
    () =>
      f.act(f.human, "artifact_highlight", { ...change, highlighted: false }),
    /changed/,
  );
  assert.equal(f.read(a.artifact).artifact.revisionCount, 1);
  assert.equal(f.read(a.artifact).artifact.headId, a.revision.id);
  assert.equal(
    f.read(a.artifact).artifact.revision.assessment.status,
    "unreviewed",
  );
  f.act(f.human, "coordinator_set", {
    agent_id: f.agents[1].id,
    version: f.b.get(f.m.id).version,
    reason: "Choose a coordinator",
  });
  f.act(f.agents[1], "artifact_highlight", {
    ...change,
    version: highlighted.version,
    highlighted: false,
  });
  f.act(f.human, "mission_archive", {
    version: f.b.get(f.m.id).version,
    archived: true,
  });
  assert.throws(
    () =>
      f.act(f.human, "artifact_highlight", {
        ...change,
        version: f.b.get(a.artifact.id).version,
      }),
    /archived/,
  );
});

test("Primary files and short descriptions are versioned and legacy outputs get a usable default", (t) => {
  const f = fixture(t);
  const files = [
    { name: "notes.md", media_type: "text/markdown", content: "# Notes" },
    { name: "app.html", media_type: "text/html", content: "<h1>App</h1>" },
  ];
  const a = f.publish({ description: undefined, files });
  assert.equal(f.read(a.artifact).artifact.revision.entrypoint, "app.html");
  assert.equal(f.read(a.artifact).artifact.revision.description, "");
  assert.throws(
    () => f.publish({ files, entrypoint: "missing.html" }),
    /entrypoint/,
  );
  const changed = f.publish({
    artifact_id: a.artifact.id,
    version: a.artifact.version,
    files,
    entrypoint: "notes.md",
    description: "Read the guide first.",
  });
  assert.equal(
    f.read(changed.artifact).artifact.revision.entrypoint,
    "notes.md",
  );
  assert.equal(f.read(changed.artifact).revisions[0].entrypoint, "app.html");
  assert.equal(
    f.act(f.human, "artifact_file", {
      revision_id: a.revision.id,
      name: "app.html",
    }).content,
    Buffer.from("<h1>App</h1>").toString("base64"),
  );
});

test("Conversation links and feedback retain exact revision and original private visibility", (t) => {
  const f = fixture(t),
    a = f.publish(),
    privateA = f.publish({ direct_agent_id: f.agents[0].id });
  f.publish({
    artifact_id: a.artifact.id,
    version: a.artifact.version,
    summary: "Newer version",
  });
  const feedback = f.act(f.human, "message_post", {
    body: "Please simplify the old layout",
    refs: [a.revision.id],
    audience: f.agents[0].id,
  });
  const privateFeedback = f.act(f.human, "message_post", {
    body: "Private feedback",
    refs: [privateA.revision.id],
    direct_agent_id: f.agents[0].id,
  });
  const found = f
    .act(f.human, "messages_read")
    .messages.find((m) => m.id === feedback.id);
  assert.deepEqual(found.artifactLinks, [
    {
      id: a.revision.id,
      artifactId: a.artifact.id,
      title: a.revision.title,
      number: 1,
      kind: "application",
    },
  ]);
  assert.equal(
    f.act(f.agents[0], "record_read", { id: privateFeedback.id })
      .artifactLinks[0].id,
    privateA.revision.id,
  );
  assert.throws(
    () => f.act(f.agents[1], "record_read", { id: privateFeedback.id }),
    /not found/,
  );
  assert.equal(
    f.act(f.agents[1], "messages_search", { query: "Private feedback" })
      .messages.length,
    0,
  );
  assert.equal(
    f.act(f.human, "messages_search", { query: "Private feedback" }).messages[0]
      .artifactLinks[0].id,
    privateA.revision.id,
  );
  assert.throws(
    () =>
      f.act(f.human, "message_post", {
        body: "Leak",
        refs: [privateA.revision.id],
      }),
    /private/,
  );
});
