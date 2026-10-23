import { z } from "zod";
import { compactBriefing } from "./prompt.mjs";
import { guidanceCatalog, readGuidance } from "./guidance.mjs";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(12000);
const references = z.array(hash).max(8).default([]);
export const AgentTools = {
  guidance: z.object({ module: z.string().max(80).optional() }).strict(),
  read_briefing: z
    .object({
      section: z
        .enum([
          "overview",
          "mission",
          "updates",
          "priority",
          "clarifications",
          "workforce",
          "workstreams",
          "tasks",
          "artifacts",
          "criteria",
        ])
        .default("overview"),
      after: hash.nullable().optional(),
      search: z.string().max(512).optional(),
    })
    .strict(),
  read_conversation: z
    .object({
      conversation: z.string().min(1).max(80),
      thread: hash.nullable().optional(),
      before: hash.nullable().optional(),
      search: z.string().max(512).optional(),
    })
    .strict(),
  reply: z.object({ message: hash, text, references }).strict(),
  post_message: z
    .object({
      text,
      conversation: z.string().max(80).optional(),
      to: hash.nullable().optional(),
      references,
    })
    .strict(),
  inspect_artifact: z.object({ revision: hash }).strict(),
  direct_agent: z
    .object({
      registration: hash,
      control: hash,
      direction: z.string().trim().min(1).max(2048),
      mode: z.enum(["clarify", "replace"]).default("clarify"),
    })
    .strict(),
  acknowledge_update: z.object({ control: hash, clarification: hash }).strict(),
  review_artifact: z
    .object({
      revision: hash,
      control: hash,
      verdict: z.enum(["verified", "changes_requested", "inconclusive"]),
      summary: z.string().trim().min(1).max(4096),
      conditions: z.string().trim().min(1).max(4096),
      evidence: z.array(hash).max(16).default([]),
      checks: z
        .array(
          z
            .object({
              method: z.enum([
                "source_inspection",
                "executed_tests",
                "browser_check",
                "visual_inspection",
              ]),
              result: z.enum(["passed", "failed", "not_run"]),
              details: z.string().trim().min(1).max(1024),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
};

const markdownLabel = (s) =>
  String(s)
    .replace(/[\\\[\]()*_`<>]/g, "\\$&")
    .replace(/[\r\n]/g, " ");

// A task-oriented adapter over the bound native capability. No mutation takes
// an ambient mission, human identity, policy, execution grant or host path.
export class AgentFacade {
  constructor({ request, snapshot, delivery }) {
    this.request = request;
    this.snapshot = snapshot;
    this.delivery = delivery;
  }
  async linkedText(text, references, conversation) {
    const links = [];
    for (const revision of references) {
      const detail = await this.request({ type: "artifact_detail", revision });
      const scope = detail.artifact.conversation;
      if (scope.startsWith("private:") && scope !== conversation)
        throw new Error(
          "A private artifact cannot be referenced in a different conversation.",
        );
      links.push(
        `[${markdownLabel(detail.document.title)}](harakiri://artifact/${revision})`,
      );
    }
    return [text, ...links].join("\n\n");
  }
  async call(name, input) {
    const args = AgentTools[name].parse(input ?? {});
    switch (name) {
      case "direct_agent": {
        const target = await this.request({
          type: "agent",
          registration: args.registration,
        });
        if (args.mode === "clarify" && target.direction) {
          return this.request({
            type: "clarify",
            control: args.control,
            registration: args.registration,
            direction: target.direction.id,
            text: args.direction,
          });
        }
        return this.request({
          type: "direct",
          control: args.control,
          registration: args.registration,
          text: args.direction,
        });
      }
      case "acknowledge_update":
        return this.request({ type: "acknowledge_update", ...args });
      case "review_artifact": {
        const detail = await this.request({
          type: "artifact_detail",
          revision: args.revision,
        });
        if (detail.revision !== args.revision)
          throw new Error(
            "Choose an exact inspected revision, not an artifact identity resolved to a newer revision.",
          );
        const { control, ...review } = args;
        return this.request({
          type: "artifact_action",
          control,
          conversation: detail.artifact.conversation,
          action: { type: "review", ...review },
        });
      }
      case "guidance":
        return args.module
          ? readGuidance(args.module)
          : { modules: guidanceCatalog() };
      case "read_briefing": {
        switch (args.section) {
          case "clarifications":
            return this.request({ type: "clarifications" });
          case "overview": {
            const snapshot = await this.snapshot();
            const compact = compactBriefing(snapshot);
            return this.delivery.issue(compact, compact, snapshot);
          }
          case "mission":
            return this.request({ type: "context" });
          case "updates": {
            const value = await this.request({
              type: "updates",
              after: args.after ?? this.delivery.cursor,
            });
            return this.delivery.issue(value, { updates: value });
          }
          case "priority": {
            const value = await this.request({
              type: "priority_updates",
              after: args.after ?? this.delivery.priorityCursor,
            });
            return this.delivery.issue(value, { priority: value });
          }
          case "workforce": {
            const [agents, observations] = await Promise.all([
              this.request({ type: "agents", after: args.after }),
              this.request({ type: "observations" }),
            ]);
            const observed = new Map(
              observations.map((o) => [o.report.registration, o]),
            );
            return {
              ...agents,
              items: agents.items.map((agent) => ({
                ...agent,
                execution: observed.has(agent.id)
                  ? {
                      state: observed.get(agent.id).report.state,
                      reported_by: observed.get(agent.id).contributor,
                      valid_for_ms: observed.get(agent.id).remaining_ms,
                      interpretation:
                        "Attributed report; not proof of progress or output quality.",
                    }
                  : {
                      state: "unknown",
                      interpretation:
                        "No fresh report observed here. This does not establish a crash.",
                    },
              })),
            };
          }
          case "workstreams":
            return this.request({ type: "workstreams" });
          case "tasks":
            return this.request({
              type: "tasks",
              query: { after: args.after, search: args.search },
            });
          case "artifacts":
            return this.request({
              type: "artifacts",
              query: { after: args.after, search: args.search },
            });
          case "criteria":
            return { criteria: (await this.snapshot()).criteria };
        }
        break;
      }
      case "read_conversation": {
        const value = await this.request({
          type: "messages",
          query: {
            view: "conversation",
            audience: args.conversation,
            thread: args.thread ?? null,
            before: args.before ?? null,
            search: args.search ?? null,
          },
        });
        const key =
          args.conversation === "main"
            ? "main"
            : args.conversation.startsWith("private:")
              ? "inbox"
              : "workstream";
        return this.delivery.issue(value, { [key]: value });
      }
      case "inspect_artifact":
        return this.request({
          type: "artifact_detail",
          revision: args.revision,
        });
      case "reply": {
        const message = await this.request({
          type: "message",
          id: args.message,
        });
        const current = await this.request({ type: "context" });
        const value = await this.request({
          type: "post",
          audience: message.audience,
          text: await this.linkedText(
            args.text,
            args.references,
            message.audience,
          ),
          thread: message.thread ?? message.id,
          to:
            message.author === current.agent.identity.author
              ? null
              : message.author,
        });
        return {
          sent: true,
          conversation: message.audience,
          thread: message.thread ?? message.id,
          event: value.id ?? value.event ?? value,
        };
      }
      case "post_message": {
        const context = await this.request({ type: "context" });
        const stream = context.agent.assignment?.workstream;
        const conversation =
          args.conversation ??
          (stream && stream !== "main" ? `workstream:${stream}` : "main");
        const value = await this.request({
          type: "post",
          audience: conversation,
          text: await this.linkedText(args.text, args.references, conversation),
          to: args.to ?? null,
          thread: null,
        });
        return {
          sent: true,
          conversation,
          used_assignment_default: args.conversation === undefined,
          event: value.id ?? value.event ?? value,
        };
      }
    }
    throw new Error("Unknown agent tool.");
  }
}
