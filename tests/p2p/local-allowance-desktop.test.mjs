import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeService } from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { ExecutionManager } from "../../desktop/execution/manager.mjs";
import { ExecutionStore } from "../../desktop/execution/store.mjs";
import { ContributionAgreements } from "../../desktop/contribution-agreements.mjs";
import { OnboardingService } from "../../desktop/onboarding.mjs";
import {
  POLICY_DIGEST,
  POLICY_DIGESTS,
  INTERNET_POLICY_DIGESTS,
  newRecord,
} from "../../desktop/execution/contract.mjs";
import { executionBinding } from "../../desktop/execution/permissions.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

async function fixture(
  t,
  limits = { mode: "bounded", turns: 1, concurrency: 1, minutes: 60 },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-local-allowance-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const contributors = new ContributorService({
    store: new DesktopStore(join(root, "local")),
    chooseDirectory: async () => workspace,
    revealDirectory: async () => {},
  });
  const node = new NodeService({
    directory: join(root, "node"),
    binary: resolve("var/node/target/debug/harakiri-node"),
    secureStorage: secureStorage(),
  });
  node.contributors = contributors;
  const provider = {
    version: 2,
    policy: POLICY_DIGEST,
    policies: POLICY_DIGESTS,
    internetPolicies: INTERNET_POLICY_DIGESTS,
    maximum: 1,
    launches: 0,
    async prepare() {
      assert.fail("Allowance review must not prepare a VM");
    },
    async inspect() {
      return { stopped: true, authenticated: true };
    },
    async terminate() {
      return { stopped: true };
    },
    async interrupt() {},
    launch() {
      this.launches++;
      assert.fail("These accounting tests never launch a runtime");
    },
    resume() {
      this.launches++;
      assert.fail("These accounting tests never resume a runtime");
    },
    login() {},
    checkpoint() {},
    usage() {},
    exportFiles() {},
    importFiles() {},
  };
  const executions = new ExecutionManager({
    store: new ExecutionStore(join(root, "execution")),
    provider,
    node,
  });
  node.executions = executions;
  const agreements = new ContributionAgreements({
    directory: root,
    node,
    executions,
  });
  const onboarding = new OnboardingService({
    directory: join(root, "setup"),
    node,
    executions,
    provider,
  });
  t.after(async () => {
    await agreements.close();
    await onboarding.close();
    await executions.close();
    await node.close();
    rmSync(root, { recursive: true, force: true });
  });
  await node.handle("enroll", {});
  const owner = (await node.state()).identity.owner;
  const { mission } = await node.handle("createMission", {
    definition: {
      name: "Local allowance regression",
      objective:
        "Retain one real temporary contribution across explicit cap edits",
      scope: "Temporary profiles and accounting only; no runtime execution",
      criteria: [],
      policy: {
        coordination: "peer",
        participation: "private",
        budget: { mode: "unlimited" },
      },
    },
  });
  const review = await node.handle("reviewContribution", {
    mission,
    role: "agent",
  });
  const choice = await contributors.handle("chooseWorkspace", {});
  const prepared = await node.handle("prepareContribution", {
    reviewId: review.reviewId,
    workspaceChoiceId: choice.id,
    runtime: "grok",
    limits,
  });
  const id = prepared.contributions[0].id;
  await node.handle("shareAgent", {
    mission,
    contributionId: id,
    label: "Allowance fixture",
  });
  await node.handle("startMission", {
    mission,
    revision: mission,
    readiness: null,
  });
  const context = (await node.executionContext(id)).context;
  const control = context.lifecycle.revision;
  const contribution = () =>
    contributors.store.read().contributions.find((c) => c.id === id);
  executions.store.write({
    ...newRecord(id),
    status: "stopped",
    session: "retained-test-session",
  });
  const { event: allocation } = await node.handle("govern", {
    mission,
    control,
    action: { type: "allocate", node: owner, turns: null, slots: 1 },
  });
  const ledger = () => node.handle("governance", { mission });
  const cap = node.openResourceLedger(id);
  t.after(() => cap.close());
  const execution = "ad".repeat(32);
  const grant = async (generation, previous = null) =>
    (
      await node.handle("govern", {
        mission,
        control,
        action: {
          type: "grant",
          purpose: "work",
          previous,
          allocation,
          registration: context.agent.id,
          direction: context.agent.direction.id,
          execution,
          generation,
          turns: 10,
          expires_ms: Date.now() + 3600000,
          offline_ms: 600000,
        },
      })
    ).event;
  const consent = (grant, revision = contribution().limitsRevision ?? null) =>
    node.handle("consentGrant", {
      mission,
      grant,
      contributionId: id,
      limitsRevision: revision,
    });
  const approval = (revision = contribution().limitsRevision ?? null) => ({
    id: randomUUID(),
    mission,
    terms: contribution().nodeBinding.revision,
    coordinator: null,
    plan: null,
    registration: context.agent.id,
    contributionId: id,
    limitsRevision: revision,
    ownerPermission: true,
    minutes: 10,
    leaseMinutes: 5,
    offlineMinutes: 5,
    turns: 3,
    followDirections: true,
  });
  return {
    root,
    node,
    contributors,
    executions,
    provider,
    agreements,
    onboarding,
    id,
    mission,
    control,
    context,
    contribution,
    ledger,
    cap,
    grant,
    consent,
    approval,
    execution,
  };
}

test(
  "native lifetime turns survive local edits, stale consent rejects, and fresh exact consent retains identity",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const before = f.contribution();
    const path = join(before.workspace, "saved.txt");
    writeFileSync(path, "Saved source for the same contribution.\n");
    const first = await f.grant(1);
    await f.consent(first);
    const originalGrant = (await f.ledger()).grants.find((g) => g.id === first);
    const firstReservation = await f.cap.reserve({
      grant: first,
      nonce: "11".repeat(32),
    });
    assert.deepEqual(
      await f.cap.reserve({ grant: first, nonce: "11".repeat(32) }),
      firstReservation,
    );
    await f.cap.receipt({
      reservation: firstReservation.event,
      used: 1,
      stopped: true,
      summary: "One temporary test turn charged",
    });
    const firstSeal = await f.cap.seal(first);
    f.executions.store.update(f.id, {
      grant: first,
      execution: f.execution,
      generation: 1,
    });
    assert.equal((await f.node.executionContext(f.id)).localAllowance.used, 1);
    await assert.rejects(
      f.agreements.approve(f.approval()),
      /turn cap is used/,
    );

    await f.executions.setLimits(
      f.id,
      { mode: "bounded", turns: 2, concurrency: 1, minutes: 120 },
      null,
    );
    const secondRevision = f.contribution().limitsRevision;
    assert.equal(
      (await f.node.executionContext(f.id)).localAllowance.deadline,
      originalGrant.issued_ms + 120 * 60000,
    );
    const second = await f.grant(2, firstSeal.event);
    const beforeStale = await f.ledger();
    await assert.rejects(f.consent(second, null), /allowance changed/);
    await assert.rejects(
      f.agreements.approve(f.approval(null)),
      /allowance changed/,
    );
    assert.deepEqual(await f.ledger(), beforeStale);
    assert.equal(f.agreements.local(f.id), null);

    const approved = await f.agreements.approve(f.approval(secondRevision));
    assert.equal(approved.binding, executionBinding(f.contribution()));
    assert.equal(approved.request.limitsRevision, secondRevision);
    await f.consent(second, secondRevision);
    assert.equal(
      (await f.node.executionContext(f.id, second)).grant.id,
      second,
    );
    await f.agreements.cancel(approved.id);
    const secondReservation = await f.cap.reserve({
      grant: second,
      nonce: "22".repeat(32),
    });
    await f.cap.receipt({
      reservation: secondReservation.event,
      used: 1,
      stopped: true,
      summary: "Second lifetime turn charged",
    });
    const beforeExhaustion = await f.ledger();
    const stillPermitted = beforeExhaustion.grants.find((g) => g.id === second);
    assert.equal(stillPermitted.turns, 10);
    assert.equal(stillPermitted.charged, 1);
    assert.equal(stillPermitted.reserved, 0);
    await assert.rejects(
      f.cap.reserve({ grant: second, nonce: "33".repeat(32) }),
      (error) => error.code === "operation_rejected",
    );
    assert.deepEqual(await f.ledger(), beforeExhaustion);
    const secondSeal = await f.cap.seal(second);
    const cumulative = (await f.node.executionContext(f.id)).localAllowance;
    assert.equal(cumulative.used, 2);
    assert.equal(cumulative.remaining, 0);
    await assert.rejects(
      f.agreements.approve(f.approval(secondRevision)),
      /turn cap is used/,
    );
    f.executions.store.update(f.id, { grant: second, generation: 2 });

    await f.executions.setLimits(
      f.id,
      { mode: "unlimited", concurrency: 1 },
      secondRevision,
    );
    const unlimitedRevision = f.contribution().limitsRevision;
    const third = await f.grant(3, secondSeal.event);
    await assert.rejects(f.consent(third, secondRevision), /allowance changed/);
    await f.consent(third, unlimitedRevision);
    const finiteApproval = await f.agreements.approve(
      f.approval(unlimitedRevision),
    );
    assert.equal(finiteApproval.request.minutes, 10);
    assert.equal(finiteApproval.request.turns, 3);
    assert.equal((await f.node.executionContext(f.id)).localAllowance.used, 2);

    await f.executions.setLimits(f.id, before.limits, unlimitedRevision);
    const restored = f.contribution();
    assert.deepEqual(restored.limits, before.limits);
    assert.notEqual(executionBinding(restored), executionBinding(before));
    await assert.rejects(
      f.node.executionContext(f.id, third),
      /current permission with consent/,
    );
    await assert.rejects(
      f.agreements.check(finiteApproval, (await f.node.state()).missions[0]),
      /Local limits or isolation policy changed/,
    );
    assert.equal((await f.node.executionContext(f.id)).localAllowance.used, 2);
    assert.match(
      (await f.node.executionContext(f.id)).localAllowance.issue,
      /turn cap is used/,
    );
    const history = await f.ledger();
    assert.equal(
      history.grants.find((g) => g.id === first).consent,
      originalGrant.consent,
    );
    assert.equal(history.grants.find((g) => g.id === first).charged, 1);
    assert.equal(history.grants.find((g) => g.id === second).charged, 1);
    assert.deepEqual(restored.sharedAgent, before.sharedAgent);
    assert.deepEqual(restored.workspaceIdentity, before.workspaceIdentity);
    assert.deepEqual(restored.nodeBinding, before.nodeBinding);
    assert.equal(restored.id, before.id);
    assert.equal(restored.workspace, before.workspace);
    assert.equal(
      f.executions.store.read(f.id).session,
      "retained-test-session",
    );
    assert.equal(
      readFileSync(path, "utf8"),
      "Saved source for the same contribution.\n",
    );
    assert.equal(f.provider.launches, 0);
  },
);

test(
  "expired cumulative time blocks every new finite approval before consent or resource writes",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t, {
      mode: "bounded",
      turns: 20,
      concurrency: 1,
      minutes: 1,
    });
    const first = await f.grant(1);
    await f.consent(first);
    const original = (await f.ledger()).grants.find((g) => g.id === first);
    const firstSeal = await f.cap.seal(first);
    f.executions.store.update(f.id, {
      grant: first,
      execution: f.execution,
      generation: 1,
    });
    const second = await f.grant(2, firstSeal.event);
    const before = await f.ledger();
    // Only this test process's host clock advances. Native time, system time and
    // all real profiles remain untouched; native lifetime records stay intact.
    const advanced = Date.now() + 90000;
    t.mock.method(Date, "now", () => advanced);
    try {
      const current = await f.node.executionContext(f.id);
      assert.equal(current.localAllowance.deadline, original.issued_ms + 60000);
      assert.match(current.localAllowance.issue, /time cap has expired/);
      await assert.rejects(
        f.agreements.approve(f.approval()),
        /time cap has expired/,
      );
      await assert.rejects(f.consent(second), /time cap has expired/);
      await assert.rejects(
        f.onboarding.permission({
          id: randomUUID(),
          contributionId: f.id,
          limitsRevision: null,
          control: f.control,
          direction: f.context.agent.direction.id,
          turns: 3,
          minutes: 10,
        }),
        /time cap has expired/,
      );
      assert.deepEqual(
        await f.ledger(),
        before,
        "Expired reviews must not consume allocations or append consent",
      );
      assert.equal(f.agreements.local(f.id), null);
      assert.equal(f.onboarding.state(f.mission).length, 0);

      await f.executions.setLimits(
        f.id,
        { mode: "bounded", turns: 20, concurrency: 1, minutes: 5 },
        null,
      );
      const revision = f.contribution().limitsRevision;
      const renewed = await f.node.executionContext(f.id);
      assert.equal(
        renewed.localAllowance.deadline,
        original.issued_ms + 5 * 60000,
        "Increasing the cap extends the original deadline, not a fresh five-minute window",
      );
      assert.equal(renewed.localAllowance.issue, null);
      await assert.rejects(
        f.agreements.approve(f.approval(null)),
        /allowance changed/,
      );
      await assert.rejects(
        f.onboarding.permission({
          id: randomUUID(),
          contributionId: f.id,
          limitsRevision: null,
          control: f.control,
          direction: f.context.agent.direction.id,
          turns: 3,
          minutes: 1,
        }),
        /allowance changed/,
      );
      const unchanged = await f.ledger();
      assert.equal(unchanged.grants.length, before.grants.length);
      assert.equal(
        unchanged.grants.find((g) => g.id === first).consent,
        original.consent,
      );
      const approved = await f.agreements.approve(f.approval(revision));
      assert.equal(approved.status, "active");
      assert.equal(approved.binding, executionBinding(f.contribution()));
      await f.consent(second, revision);
      assert.equal(
        (await f.node.executionContext(f.id, second)).grant.expires_ms,
        renewed.localAllowance.deadline,
      );
      assert.equal(f.provider.launches, 0);
    } finally {
      t.mock.restoreAll();
    }
  },
);
