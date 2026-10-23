import test from "node:test";
import assert from "node:assert/strict";
import { AgentFacade, AgentTools } from "../desktop/execution/facade.mjs";
import { ContextDelivery } from "../desktop/execution/delivery.mjs";

const hash = (n) => String(n).repeat(64);
function fixture() {
  const writes = [];
  const state = {
    agent: {
      identity: { author: hash(1) },
      assignment: { workstream: hash(2) },
    },
  };
  const message = {
    id: hash(3),
    author: hash(4),
    audience: `private:${hash(5)}`,
    thread: hash(6),
  };
  const facade = new AgentFacade({
    delivery: new ContextDelivery(),
    snapshot: async () => ({ context: state }),
    request: async (op) => {
      if (op.type === "agent")
        return { id: op.registration, direction: state.targetDirection };
      if (op.type === "context") return state;
      if (op.type === "message") return message;
      if (op.type === "artifact_detail")
        return {
          revision: hash(8),
          artifact: { conversation: message.audience, revision_count: 2 },
          document: { title: "Lesson" },
        };
      if (
        [
          "post",
          "direct",
          "clarify",
          "acknowledge_update",
          "artifact_action",
        ].includes(op.type)
      ) {
        writes.push(op);
        return { id: hash(7) };
      }
      throw new Error(`Unexpected ${op.type}`);
    },
  });
  return { facade, writes, state, message };
}
test("guidance defaults to a non-interrupting clarification; replacement is explicit", async () => {
  const { facade, writes, state } = fixture();
  state.targetDirection = { id: hash(9) };
  const args = {
    registration: hash(4),
    control: hash(2),
    direction: "Check the boundary value in the current review.",
  };
  await facade.call("direct_agent", args);
  assert.deepEqual(writes[0], {
    type: "clarify",
    control: hash(2),
    registration: hash(4),
    direction: hash(9),
    text: args.direction,
  });
  await facade.call("direct_agent", { ...args, mode: "replace" });
  assert.equal(writes[1].type, "direct");
  await facade.call("acknowledge_update", {
    control: hash(2),
    clarification: hash(7),
  });
  assert.equal(writes[2].type, "acknowledge_update");
});
test("reply keeps exact private conversation, root and intended recipient", async () => {
  const { facade, writes, message } = fixture();
  const result = await facade.call("reply", {
    message: hash(3),
    text: "The review is ready.",
  });
  assert.equal(result.conversation, message.audience);
  assert.equal(writes[0].thread, message.thread);
  assert.equal(writes[0].to, message.author);
  assert.throws(() =>
    AgentTools.reply.parse({
      message: hash(3),
      text: "x",
      conversation: "main",
    }),
  );
});

test("reviews keep the exact revision and original private audience, directions use registrations", async () => {
  const { facade, writes, message } = fixture();
  const review = {
    revision: hash(8),
    control: hash(2),
    verdict: "inconclusive",
    summary: "Keyboard behavior needs checking",
    conditions: "Source inspected; browser unavailable",
    checks: [
      {
        method: "browser_check",
        result: "not_run",
        details: "Browser unavailable",
      },
    ],
  };
  await facade.call("review_artifact", review);
  assert.equal(writes[0].conversation, message.audience);
  assert.equal(writes[0].action.revision, review.revision);
  await assert.rejects(
    facade.call("review_artifact", { ...review, revision: hash(7) }),
    /exact inspected revision/,
  );
  assert.equal(writes.length, 1);
  await facade.call("direct_agent", {
    registration: hash(4),
    control: hash(2),
    direction: "Check keyboard access; do not rebuild the lesson.",
  });
  assert.equal(writes[1].registration, hash(4));
  assert.equal(writes[1].control, hash(2));
});
test("a new post uses the assignment unless Main is deliberately selected", async () => {
  const { facade, writes } = fixture();
  await facade.call("post_message", { text: "Trying the second approach." });
  await facade.call("post_message", {
    text: "This affects the shared plan.",
    conversation: "main",
  });
  assert.equal(writes[0].audience, `workstream:${hash(2)}`);
  assert.equal(writes[1].audience, "main");
});
test("a readable artifact link cannot export a private reference into Main", async () => {
  const { facade, writes } = fixture();
  await assert.rejects(
    facade.call("post_message", {
      text: "See result",
      conversation: "main",
      references: [hash(8)],
    }),
    /private artifact/,
  );
  assert.equal(writes.length, 0);
  await facade.call("reply", {
    message: hash(3),
    text: "See result",
    references: [hash(8)],
  });
  assert.match(writes[0].text, /\[Lesson\]\(harakiri:\/\/artifact\//);
});
