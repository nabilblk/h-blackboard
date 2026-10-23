import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopStore } from "../../desktop/store.mjs";
import { ExecutionStore } from "../../desktop/execution/store.mjs";
import { ExecutionManager } from "../../desktop/execution/manager.mjs";
import {
  POLICY_DIGEST,
  POLICY_DIGESTS,
  INTERNET_POLICY_DIGESTS,
  newRecord,
} from "../../desktop/execution/contract.mjs";
const h = (c) => c.repeat(64);
export function executionFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "hb-environment-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const local = new DesktopStore(join(directory, "local"));
  const id = randomUUID();
  local.update((s) =>
    s.contributions.push({
      id,
      contributorId: s.contributor.id,
      deviceId: s.device.id,
      mission: {
        origin: "harakiri://node/owner",
        missionId: h("a"),
        name: "Isolated network test",
        role: "agent",
        inspectedAt: new Date().toISOString(),
      },
      nodeBinding: { owner: h("b"), revision: h("c") },
      runtime: "grok",
      sharedAgent: {
        registration: h("d"),
        author: h("e"),
        label: "Fixture",
        withdrawn: false,
      },
      limits: { mode: "unlimited", concurrency: 1 },
      workspace: directory,
      workspaceIdentity: { device: "1", inode: "2" },
      status: "prepared",
      createdAt: new Date().toISOString(),
      revokedAt: null,
    }),
  );
  const contribution = () => local.read().contributions[0];
  const store = new ExecutionStore(join(directory, "execution"));
  store.write({
    ...newRecord(id),
    status: "stopped",
    session: "saved-session",
    grant: h("f"),
  });
  const calls = {
    prepare: 0,
    terminate: 0,
    launch: 0,
    stopped: true,
    fail: false,
  };
  const provider = {
    version: 2,
    policy: POLICY_DIGEST,
    policies: POLICY_DIGESTS,
    internetPolicies: INTERNET_POLICY_DIGESTS,
    async prepare() {
      calls.prepare++;
      if (calls.fail) throw new Error("Provisioning interrupted");
      return { authenticated: true };
    },
    async terminate() {
      calls.terminate++;
      return { stopped: calls.stopped };
    },
    async inspect() {
      return { stopped: true, running: false };
    },
    launch() {
      calls.launch++;
    },
    resume() {
      calls.launch++;
    },
    login() {},
    interrupt() {},
    checkpoint() {},
    usage() {},
    exportFiles() {},
    importFiles() {},
  };
  const node = {
    contributors: { store: local },
    executionContext: async () => ({ contribution: contribution() }),
  };
  const manager = new ExecutionManager({ store, provider, node });
  return { id, local, contribution, store, provider, manager, calls };
}
