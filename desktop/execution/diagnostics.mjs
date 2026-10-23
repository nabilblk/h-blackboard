// Deliberate allowlist, not redaction of arbitrary provider prose. This export
// can be shared without including prompts, paths, identities or auth codes.
import errors from "../../shared/node-errors.json" with { type: "json" };
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { Id } from "../model.mjs";
const diagnosticTypes = new Set([
  "tool_outcome",
  "browser_check",
  "turn_completed",
  "runtime_ready",
  "dependency_wait",
  "effective_configuration",
  "context_delivery",
]);

// Read only the two bounded application-owned rotations, never arbitrary paths.
// Parse structured events without exposing raw logs to the renderer/export.
export function retainedDiagnosticEvents(directory, id) {
  Id.parse(id);
  const events = [];
  let files = 0;
  let malformed = 0;
  for (const suffix of [".events.jsonl.previous", ".events.jsonl"]) {
    const path = join(directory, id + suffix);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw new Error(
        "Execution diagnostics require bounded local event files.",
      );
    const content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content) > 2 * 1024 * 1024)
      throw new Error("Execution event file grew beyond the export limit.");
    files++;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (diagnosticTypes.has(value?.type)) events.push(value);
      } catch {
        malformed++;
      }
    }
  }
  return {
    events,
    coverage: {
      files,
      malformed,
      retainedEvents: events.length,
      limit: 4000,
      completeHistory: false,
    },
  };
}
const operations = new Set([
  "snapshot",
  "context",
  "agents",
  "governance",
  "messages",
  "post",
  "workstreams",
  "tasks",
  "work",
  "acknowledge",
  "plan",
  "plan_artifact",
  "ready",
  "direct",
  "criterion",
  "artifacts",
  "artifact_detail",
  "artifact_action",
  "artifact_transfer",
  "guidance",
  "read_briefing",
  "read_conversation",
  "reply",
  "post_message",
  "inspect_artifact",
  "direct_agent",
  "review_artifact",
]);
const states = new Set([
  "preparing",
  "login_required",
  "ready",
  "reserving",
  "launching",
  "running",
  "waiting",
  "stopping",
  "stopped",
  "recovery_required",
  "failed",
]);
const stateName = (value) => (states.has(value) ? value : "unknown");
const time = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
export function executionDiagnostics(state, retained = null) {
  const aliases = new Map();
  const correlate = (value) => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return null;
    if (!aliases.has(value)) aliases.set(value, `record-${aliases.size + 1}`);
    return aliases.get(value);
  };
  const outcomes = [];
  for (const event of (retained?.events ?? state.events ?? []).slice(
    retained ? -4000 : -80,
  )) {
    if (!diagnosticTypes.has(event.type)) continue;
    let value;
    try {
      value = JSON.parse(event.message);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (event.type === "context_delivery")
      outcomes.push({
        at: time(event.at),
        type: event.type,
        paths: time(value.paths),
        seen: time(value.seen),
        cursor: correlate(value.cursor),
        priorityCursor: correlate(value.priorityCursor),
        grant: correlate(value.grant),
        reservation: correlate(value.reservation),
      });
    if (event.type === "effective_configuration") {
      const digest = (input) =>
        typeof input === "string" && /^[a-f0-9]{64}$/.test(input)
          ? input
          : null;
      outcomes.push({
        at: time(event.at),
        type: event.type,
        runtime: ["grok", "claude", "codex"].includes(value.runtime)
          ? value.runtime
          : null,
        runtimeVersion: /^[0-9.]{1,32}$/.test(value.runtimeVersion)
          ? value.runtimeVersion
          : null,
        briefing: /^[0-9.-]{1,40}$/.test(value.briefing)
          ? value.briefing
          : null,
        networkAccess: ["restricted", "internet"].includes(value.networkAccess)
          ? value.networkAccess
          : null,
        capabilityPack: ["general", "web-3d"].includes(value.authoring?.pack)
          ? value.authoring.pack
          : null,
        buildkit: value.buildkit === "web-artifact-1" ? value.buildkit : null,
        promptSha256: digest(value.promptSha256),
        guideSha256: digest(value.guideSha256),
        toolSchemaSha256: digest(value.toolSchemaSha256),
        runtimeDistributionSha256: digest(value.runtimeDistributionSha256),
        promptBytes: time(value.promptBytes),
        role: ["agent", "coordinator"].includes(value.role) ? value.role : null,
        reasoningEffort:
          value.modelSettings?.reasoningEffort === "medium" ? "medium" : null,
        nativeTools: value.nativeTools === true,
        personalSkills: value.personalSkills === true,
      });
    }
    if (event.type === "tool_outcome" && operations.has(value.operation))
      outcomes.push({
        at: time(event.at),
        type: event.type,
        operation: value.operation,
        outcome: value.outcome === "ok" ? "ok" : "rejected",
        code: Object.hasOwn(errors, value.code) ? value.code : null,
        milliseconds: time(value.milliseconds),
        grant: correlate(value.grant),
        reservation: correlate(value.reservation),
        control: correlate(value.control),
        direction: correlate(value.direction),
      });
    if (event.type === "browser_check")
      outcomes.push({
        at: time(event.at),
        type: event.type,
        revision: correlate(value.revision),
        control: correlate(value.control),
        grant: correlate(value.grant),
        reservation: correlate(value.reservation),
        width: time(value.width),
        height: time(value.height),
        reducedMotion: value.reducedMotion === true,
        webglDisabled: value.webglDisabled === true,
        steps: time(value.steps),
        errors: time(value.errors),
      });
    if (event.type === "turn_completed")
      outcomes.push({
        at: time(event.at),
        type: event.type,
        turns: time(value.turns),
        tokens: time(value.tokens),
        inputTokens: time(value.inputTokens),
        outputTokens: time(value.outputTokens),
        cachedInputTokens: time(value.cachedInputTokens),
        elapsedMs: time(value.elapsedMs),
        grant: correlate(value.grant),
        reservation: correlate(value.reservation),
      });
    if (["runtime_ready", "dependency_wait"].includes(event.type))
      outcomes.push({
        at: time(event.at),
        type: event.type,
        milliseconds: time(value.milliseconds),
        resumed: event.type === "runtime_ready" ? value.resumed === true : null,
        artifacts: time(value.artifacts),
        reviews: time(value.reviews),
        grant: correlate(value.grant),
        reservation: correlate(value.reservation),
      });
  }
  return {
    schema: 2,
    outcomes,
    coverage: retained?.coverage ?? { limit: 80, completeHistory: false },
    configuredRuntime: ["grok", "claude", "codex"].includes(
      state.policy?.runtime,
    )
      ? state.policy.runtime
      : null,
    configuredRuntimeVersion: /^\d+\.\d+\.\d+$/.test(
      state.policy?.runtimeVersion ?? "",
    )
      ? state.policy.runtimeVersion
      : null,
    usageNote:
      "Provider-reported tokens only; unknown counters are null. Cached input is a subset of input, not extra tokens. Subscription usage is not a dollar invoice.",
    observedAt: time(state.observedAt),
    observationAvailable: !state.error,
    status: stateName(state.record?.status),
    savedSession: !!state.record?.session,
    capacity: Number.isSafeInteger(state.capacity) ? state.capacity : null,
    authentication: [
      "starting",
      "waiting",
      "complete",
      "failed",
      "cancelled",
    ].includes(state.authentication?.status)
      ? state.authentication.status
      : null,
    authenticationFailure: ["expired", "denied", "connection"].includes(
      state.authentication?.failure,
    )
      ? state.authentication.failure
      : null,
    transitions: (state.record?.transitions ?? []).slice(-80).map((t) => ({
      at: time(t.at),
      from: stateName(t.from),
      to: stateName(t.to),
    })),
  };
}
