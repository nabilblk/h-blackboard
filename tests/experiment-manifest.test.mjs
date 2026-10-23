import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExperimentManifest,
  fingerprintFiles,
} from "../experiments/evidence-manifest.mjs";

test("experiment evidence rejects ambiguous topology and unobserved live versions", () => {
  const hash = "a".repeat(64);
  const value = {
    schema: 1,
    run: "00000000-0000-4000-8000-000000000001",
    startedAt: "2026-10-10T00:00:00.000Z",
    kind: "protocol_rehearsal",
    code: { commit: "a".repeat(40), dirty: true, sourceSha256: hash },
    versions: {
      app: "fixture",
      protocol: 12,
      schema: 16,
      host: process.version,
      toolsSha256: hash,
    },
    topology: {
      computers: 1,
      operators: 1,
      nodes: 1,
      agents: [
        {
          alias: "A",
          node: "one",
          role: "coordinator",
          harness: null,
          model: null,
        },
      ],
    },
    policies: {
      transport: "direct",
      workspace: "restricted",
      permissionSha256: hash,
      budget: "unlimited",
    },
    inputs: [{ name: "brief", sha256: hash }],
    acceptance: ["Scoped histories converge"],
    evidence: {
      timeline: "timeline.jsonl",
      artifactIds: "exact-revision",
      interventions: "record-every-operator-action",
      usage: "native-counters-or-unknown",
    },
  };
  assert.ok(ExperimentManifest.safeParse(value).success);
  assert.ok(
    !ExperimentManifest.safeParse({ ...value, kind: "live_agents" }).success,
  );
  assert.ok(
    !ExperimentManifest.safeParse({
      ...value,
      topology: {
        ...value.topology,
        agents: [...value.topology.agents, ...value.topology.agents],
      },
    }).success,
  );
  assert.ok(
    !ExperimentManifest.safeParse({ ...value, credentials: "never collect" })
      .success,
  );
});

test("fingerprints include input names/bytes and reject links or traversal", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hb-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "a"), "first");
  writeFileSync(join(root, "b"), "second");
  const before = fingerprintFiles(root, ["a", "b"]);
  assert.equal(fingerprintFiles(root, ["b", "a"]), before);
  writeFileSync(join(root, "b"), "changed");
  assert.notEqual(fingerprintFiles(root, ["a", "b"]), before);
  assert.throws(() => fingerprintFiles(root, ["../outside"]), /relative/);
  symlinkSync(join(root, "a"), join(root, "link"));
  assert.throws(() => fingerprintFiles(root, ["link"]), /links/);
});
