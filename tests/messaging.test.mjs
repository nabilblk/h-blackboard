import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Blackboard } from "../server/board.mjs";

function fixture(t, file) {
  const board = new Blackboard(file);
  t.after(() => board.close());
  const human = board.auth(board.ownerToken);
  const mission = board.execute(
    human,
    "mission_create",
    { name: "Messaging", objective: "Exercise conversations" },
    randomUUID(),
  );
  const act = (actor, op, input = {}) =>
    board.execute(
      actor,
      op,
      { channel_id: mission.id, ...input },
      randomUUID(),
    );
  const register = (name, role = "agent") => {
    const invite = act(human, "invitation_create", { role });
    const joined = board.join({
      invitation: invite.token,
      name,
      runtime: "codex",
    });
    return { ...joined, actor: board.auth(joined.token) };
  };
  const lead = register("lead", "coordinator"),
    one = register("one"),
    two = register("two");
  return { board, human, mission, act, lead, one, two };
}

test("Public addressing remains shared; private reads, search and context are restricted to participants", (t) => {
  const { act, human, one, two, lead } = fixture(t);
  const publicMessage = act(human, "message_post", {
    body: "Public instruction",
    audience: one.agent.id,
  });
  const privateMessage = act(human, "message_post", {
    body: "Private instruction",
    direct_agent_id: one.agent.id,
  });
  assert.equal(privateMessage.visibility, "private");
  assert.equal(privateMessage.streamId, null);
  assert.throws(
    () =>
      act(human, "message_post", {
        body: "Ambiguous recipient",
        direct_agent_id: one.agent.id,
        audience: two.agent.id,
      }),
    /audience must match/,
  );
  for (const actor of [one.actor, two.actor, lead.actor, human]) {
    const main = act(actor, "messages_read").messages;
    assert.ok(main.some((m) => m.id === publicMessage.id));
    assert.ok(!main.some((m) => m.id === privateMessage.id));
  }
  for (const actor of [two.actor, lead.actor]) {
    assert.throws(
      () => act(actor, "record_read", { id: privateMessage.id }),
      /not found/,
    );
    assert.throws(
      () => act(actor, "messages_read", { direct_agent_id: one.agent.id }),
      /between the human/,
    );
    assert.throws(
      () => act(actor, "messages_read", { thread_id: privateMessage.id }),
      /not found/,
    );
    assert.throws(
      () => act(actor, "messages_search", { direct_agent_id: one.agent.id }),
      /between the human/,
    );
    assert.deepEqual(
      act(actor, "messages_search", { query: "Private instruction" }).messages,
      [],
    );
    assert.doesNotMatch(
      JSON.stringify(act(actor, "context_read")),
      /Private instruction/,
    );
  }
  assert.ok(
    act(one.actor, "context_read").privateMessages.some(
      (m) => m.id === privateMessage.id,
    ),
  );
  assert.equal(
    act(one.actor, "record_read", { id: privateMessage.id }).body,
    "Private instruction",
  );
  assert.equal(
    act(human, "context_read").directMessages[0].agentId,
    one.agent.id,
  );
  assert.throws(
    () =>
      act(one.actor, "message_post", {
        body: "Cross-agent DM",
        direct_agent_id: two.agent.id,
      }),
    /between the human/,
  );
});

test("Private replies inherit privacy, including older clients that only know thread_id", (t) => {
  const { act, human, one, two, mission } = fixture(t);
  const root = act(human, "message_post", {
    body: "Confidential question",
    direct_agent_id: one.agent.id,
  });
  const reply = act(one.actor, "message_post", {
    body: "Confidential answer",
    thread_id: root.id,
  });
  assert.equal(reply.directAgentId, one.agent.id);
  assert.equal(reply.audience, "human");
  assert.equal(reply.streamId, null);
  assert.equal(
    act(human, "messages_read", { direct_agent_id: one.agent.id }).messages
      .length,
    2,
  );
  assert.equal(
    act(one.actor, "messages_read", { thread_id: root.id }).messages[0].id,
    reply.id,
  );
  assert.throws(
    () =>
      act(two.actor, "message_post", {
        body: "Join private thread",
        thread_id: root.id,
      }),
    /not found/,
  );
  const publicRoot = act(human, "message_post", { body: "Public question" });
  assert.throws(
    () =>
      act(human, "message_post", {
        body: "Ambiguous",
        thread_id: publicRoot.id,
        direct_agent_id: one.agent.id,
      }),
    /different conversation/,
  );
  assert.throws(
    () =>
      act(human, "message_post", {
        body: "Ambiguous",
        stream_id: mission.defaultStreamId,
        direct_agent_id: one.agent.id,
      }),
    /public workstream/,
  );
});

test("Private references cannot leak into public posts, plans, tasks or a different DM", (t) => {
  const { act, human, one, two, lead, mission } = fixture(t);
  const secret = act(human, "message_post", {
    body: "Private evidence",
    direct_agent_id: lead.agent.id,
  });
  const task = act(lead.actor, "task_create", { title: "Optional task" });
  for (const actor of [human, lead.actor]) {
    assert.throws(
      () =>
        act(actor, "message_post", {
          body: "Public reference",
          refs: [secret.id],
        }),
      /private message/,
    );
    assert.throws(
      () =>
        act(actor, "plan_update", {
          plan: "Plan",
          version: act(human, "context_read").mission.version,
          refs: [secret.id],
        }),
      /private message/,
    );
    assert.throws(
      () =>
        act(actor, "task_update", {
          task_id: task.id,
          version: task.version,
          status: "done",
          refs: [secret.id],
        }),
      /private message/,
    );
  }
  assert.throws(
    () =>
      act(human, "message_post", {
        body: "Different conversation",
        direct_agent_id: one.agent.id,
        refs: [secret.id],
      }),
    /private message/,
  );
  assert.throws(
    () =>
      act(two.actor, "message_post", {
        body: "Guess private record",
        refs: [secret.id],
      }),
    /not found/,
  );
  assert.equal(
    act(lead.actor, "message_post", {
      body: "Private reference",
      direct_agent_id: lead.agent.id,
      refs: [secret.id, mission.defaultStreamId],
    }).refs.length,
    2,
  );
});

test("Updates and edits reach only the private participant; coordinator handover grants no private access", (t) => {
  const { act, board, mission, human, one, two, lead } = fixture(t);
  const after = act(human, "context_read").cursor;
  const secret = act(human, "message_post", {
    body: "Keep this with one",
    direct_agent_id: one.agent.id,
  });
  act(human, "message_edit", {
    message_id: secret.id,
    body: "Revised private instruction",
  });
  act(human, "coordinator_set", {
    version: board.get(mission.id).version,
    agent_id: two.agent.id,
    reason: "Handover",
  });
  for (const actor of [two.actor, lead.actor]) {
    const events = act(actor, "updates_read", { after }).events;
    assert.ok(
      !events.some(
        (e) => e.data.id === secret.id || e.data.messageId === secret.id,
      ),
    );
    assert.throws(
      () => act(actor, "record_read", { id: secret.id }),
      /not found/,
    );
  }
  const received = act(one.actor, "updates_read", { after }).events;
  assert.ok(
    received.some((e) => e.data.id === secret.id && e.replyInstruction),
  );
  assert.ok(
    received.some(
      (e) => e.type === "message_edited" && e.data.messageId === secret.id,
    ),
  );
  act(human, "message_edit", { message_id: secret.id, remove: true });
  assert.equal(act(one.actor, "record_read", { id: secret.id }).removed, true);
});

test("Sent search finds old messages and threads across workstreams with visibility and recipient filters", (t) => {
  const { act, human, one, lead } = fixture(t);
  const stream = act(lead.actor, "stream_create", {
    name: "Alternative",
    goal: "Investigate",
  });
  const old = act(human, "message_post", {
    body: "Needle across streams",
    audience: one.agent.id,
    stream_id: stream.id,
  });
  for (let i = 0; i < 65; i++)
    act(one.actor, "message_post", { body: `Noise ${i}` });
  const dm = act(human, "message_post", {
    body: "Needle private",
    direct_agent_id: one.agent.id,
  });
  const thread = act(human, "message_post", {
    body: "Needle in reply",
    thread_id: old.id,
    audience: one.agent.id,
  });
  const result = act(human, "messages_search", {
    view: "sent",
    query: "needle",
    agent_id: one.agent.id,
    limit: 2,
  });
  assert.deepEqual(
    result.messages.map((m) => m.id),
    [thread.id, dm.id],
  );
  assert.equal(result.more, true);
  const page2 = act(human, "messages_search", {
    view: "sent",
    query: "needle",
    agent_id: one.agent.id,
    before: result.nextBefore,
  });
  assert.deepEqual(
    page2.messages.map((m) => m.id),
    [old.id],
  );
  assert.deepEqual(
    act(human, "messages_search", {
      view: "sent",
      visibility: "private",
    }).messages.map((m) => m.id),
    [dm.id],
  );
  assert.equal(
    act(human, "messages_search", { view: "sent", visibility: "public" })
      .messages.length,
    2,
  );
  assert.throws(
    () => act(one.actor, "messages_search", { view: "sent" }),
    /human/,
  );
});

test("Inbox groups incoming private, addressed and thread replies; read state does not wake agents", (t) => {
  const { act, board, human, one, two } = fixture(t);
  const root = act(human, "message_post", { body: "Public request" });
  const reply = act(one.actor, "message_post", {
    body: "Reply to human",
    thread_id: root.id,
  });
  const addressed = act(two.actor, "message_post", {
    body: "For you",
    audience: "human",
  });
  const dm = act(one.actor, "message_post", {
    body: "Private reply",
    direct_agent_id: one.agent.id,
  });
  act(two.actor, "message_post", { body: "Ordinary broadcast" });
  assert.equal(act(human, "context_read").inboxUnread, 3);
  assert.equal(act(human, "context_read").directMessages[0].unread, 1);
  let changes = 0;
  board.on("change", () => changes++);
  act(human, "messages_seen", { message_ids: [reply.id, dm.id] });
  assert.equal(changes, 0);
  assert.equal(act(human, "context_read").directMessages[0].unread, 0);
  assert.deepEqual(
    act(human, "messages_search", { view: "inbox", unread: true }).messages.map(
      (m) => m.id,
    ),
    [addressed.id],
  );
  assert.throws(
    () => act(one.actor, "messages_seen", { message_ids: [dm.id] }),
    /human/,
  );
});

test("Paused agents and closed missions still allow private replies to the human", (t) => {
  const { act, human, one } = fixture(t);
  const dm = act(human, "message_post", {
    body: "Please stop",
    direct_agent_id: one.agent.id,
  });
  act(human, "agent_control", {
    agent_id: one.agent.id,
    control: "pause",
    reason: "Stop work",
  });
  act(one.actor, "message_post", { body: "Stopped", thread_id: dm.id });
  act(human, "mission_state", { state: "closed", reason: "Complete" });
  const reply = act(one.actor, "message_post", {
    body: "Acknowledged",
    direct_agent_id: one.agent.id,
  });
  assert.equal(reply.visibility, "private");
  assert.throws(
    () => act(one.actor, "message_post", { body: "Continue public work" }),
    /paused/,
  );
});

test("Private history and read markers survive a database restart without changing legacy messages", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harakiri-messages-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "board.sqlite");
  const { act, board, human, mission, one, two } = fixture(t, path);
  const legacy = act(human, "message_post", {
    body: "Original addressed message",
    audience: one.agent.id,
  });
  delete legacy.directAgentId;
  delete legacy.visibility;
  board.put(legacy);
  const roleAddressed = act(human, "message_post", {
    body: "Legacy coordinator instruction",
    audience: "coordinator",
  });
  delete roleAddressed.addressedAgentId;
  board.put(roleAddressed);
  assert.ok(
    act(human, "messages_search", {
      view: "sent",
      audience: "coordinator",
    }).messages.some((m) => m.id === roleAddressed.id),
  );
  const dm = act(one.actor, "message_post", {
    body: "Persisted private message",
    direct_agent_id: one.agent.id,
  });
  act(human, "messages_seen", { message_ids: [dm.id] });
  const reopened = new Blackboard(path);
  try {
    const owner = reopened.auth(reopened.ownerToken);
    assert.equal(
      reopened.context(owner, mission.id).directMessages[0].unread,
      0,
    );
    assert.ok(
      reopened
        .messages(two.actor, { channel_id: mission.id })
        .messages.some((m) => m.id === legacy.id),
    );
    assert.ok(
      reopened
        .context(one.actor, mission.id)
        .privateMessages.some((m) => m.id === dm.id),
    );
    assert.doesNotMatch(
      JSON.stringify(reopened.context(two.actor, mission.id)),
      /Persisted private message/,
    );
  } finally {
    reopened.close();
  }
});
