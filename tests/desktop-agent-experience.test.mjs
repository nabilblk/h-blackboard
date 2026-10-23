import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { draftingPrompt } from "../desktop/drafting/prompt.mjs";
import {
  DraftRuntimeService,
  parseDraftReply,
} from "../desktop/drafting/runtime.mjs";
import {
  effectiveConfiguration,
  browserReceipt,
} from "../desktop/execution/provenance.mjs";
import { guestTools } from "../desktop/execution/tools.mjs";
import { AgentOperation } from "../desktop/node-service.mjs";
import {
  readGuidance,
  guidanceCatalog,
} from "../desktop/execution/guidance.mjs";

test("drafting retains the complete human brief and latest instruction with bounded history", () => {
  const brief = {
    objective: "Keep the human's precise goal",
    scope: "Do not invent access to reference links",
    criteria: ["Explain the scientific assumptions"],
    assumptions: [],
    openQuestions: ["Audience to confirm"],
  };
  const messages = Array.from({ length: 80 }, (_, n) => ({
    role: n % 2 ? "user" : "assistant",
    text: `turn-${n} ` + "x".repeat(8100),
  }));
  const prompt = draftingPrompt({
    brief,
    idea: "A learning experience",
    revision: 15,
    messages,
  });
  assert.ok(Buffer.byteLength(prompt) < 50000);
  assert.ok(prompt.includes(JSON.stringify(brief)));
  assert.ok(prompt.includes("turn-79"));
  assert.ok(!prompt.includes("turn-0 "));
  assert.ok(prompt.includes("omitted_messages"));
});

test("a drafting schema failure retries once without promoting malformed output or editing the saved brief", async () => {
  const helper = new DraftRuntimeService({ directory: "/unused" });
  const draft = { brief: { objective: "Human edited" } };
  const calls = [];
  helper.runOnce = async (value) => {
    calls.push(structuredClone({ draft: value.draft, repair: value.repair }));
    return parseDraftReply("not JSON");
  };
  await assert.rejects(
    helper.run({ draft, signal: new AbortController().signal }),
    /invalid brief/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].repair, true);
  assert.deepEqual(calls[1].draft, draft);
  helper.runOnce = async () => {
    throw new Error("Subscription limit");
  };
  await assert.rejects(
    helper.run({ draft, signal: new AbortController().signal }),
    /Subscription limit/,
  );
});

test("the advertised catalog excludes transport internals and human-only acceptance", () => {
  const tools = guestTools();
  const board = tools.find((t) => t.name === "board");
  const schema = JSON.stringify(board.inputSchema);
  assert.ok(!schema.includes('"accept"'));
  assert.ok(!schema.includes('"artifact_transfer"'));
  assert.ok(
    !tools.some((t) => ["record_delivery", "checkpoint"].includes(t.name)),
  );
  const agentTools = guestTools("restricted", "agent");
  assert.ok(!agentTools.some((t) => t.name === "direct_agent"));
  assert.ok(agentTools.some((t) => t.name === "review_artifact"));
  const operations = agentTools.find((t) => t.name === "board").inputSchema
    .properties.operation.anyOf;
  assert.ok(
    operations.every(
      (operation) =>
        !["plan", "ready", "criterion", "direct"].includes(
          operation.properties.type.const,
        ),
    ),
  );
  const id = "a".repeat(64);
  const review = {
    type: "artifact_action",
    control: id,
    conversation: "main",
    action: {
      type: "review",
      revision: id,
      verdict: "verified",
      summary: "Looks fine",
      conditions: "None",
      evidence: [],
      checks: [],
    },
  };
  assert.equal(AgentOperation.safeParse(review).success, false);
  assert.equal(
    AgentOperation.safeParse({
      ...review,
      action: {
        ...review.action,
        checks: [
          {
            method: "source_inspection",
            result: "passed",
            details:
              "Inspected the exact published source; browser behavior untested.",
          },
        ],
      },
    }).success,
    true,
  );
});

test("effective configuration is reproducible; execution receipts never assert visual judgment", () => {
  const input = {
    runtime: "grok",
    prompt: "Private mission text",
    guide: readFileSync("desktop/execution/guest/agent.md", "utf8"),
  };
  const a = effectiveConfiguration(input);
  assert.deepEqual(a, effectiveConfiguration(input));
  assert.notEqual(
    a.promptSha256,
    effectiveConfiguration({ ...input, prompt: "changed" }).promptSha256,
  );
  assert.ok(!JSON.stringify(a).includes("Private mission text"));
  for (const item of guidanceCatalog()) {
    assert.equal(
      item.sha256,
      createHash("sha256").update(readGuidance(item.id).content).digest("hex"),
    );
  }
  const receipt = browserReceipt({
    revision: "a".repeat(64),
    files: [{ path: "index.html", hash: "b".repeat(64), size: 20 }],
    request: { width: 390 },
    result: {
      image: { data: Buffer.from("real screenshot bytes").toString("base64") },
      errors: [],
    },
    grant: "c".repeat(64),
    reservation: "d".repeat(64),
    now: 1,
  });
  assert.equal(
    receipt.imageSha256,
    createHash("sha256").update("real screenshot bytes").digest("hex"),
  );
  assert.ok(!Object.hasOwn(receipt, "verdict"));
  assert.match(receipt.judgment, /No quality verdict/);
});
