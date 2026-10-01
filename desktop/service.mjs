import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  executionReadiness,
  MissionPreview,
  Requests,
  REVIEW_TTL_MS,
} from "./model.mjs";
import { inspectInvitation } from "./invitations.mjs";
import { isWithin } from "./security.mjs";

function identity(path) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory())
    throw new Error("Choose a directory for this contribution.");
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}
function sameIdentity(a, b) {
  return a.device === b.device && a.inode === b.inode;
}

function event(state, type, label, contributionId = null) {
  state.activity.unshift({
    id: randomUUID(),
    at: new Date().toISOString(),
    type,
    label,
    contributionId,
  });
  state.activity = state.activity.slice(0, 1000);
}

export class ContributorService {
  constructor({
    store,
    chooseDirectory,
    revealDirectory,
    inspect = inspectInvitation,
    now = Date.now,
  }) {
    this.store = store;
    this.chooseDirectory = chooseDirectory;
    this.revealDirectory = revealDirectory;
    this.inspect = inspect;
    this.now = now;
    this.reviews = new Map();
    this.choices = new Map();
    this.inspecting = false;
    this.choosing = false;
  }

  snapshot() {
    const state = this.store.read();
    return {
      ...state,
      contributions: state.contributions.map((item) => {
        const { workspaceIdentity: _identity, ...publicItem } = item;
        return { ...publicItem, execution: executionReadiness(item) };
      }),
    };
  }

  cache(map, data) {
    for (const [id, entry] of map)
      if (entry.expires <= this.now()) map.delete(id);
    if (map.size >= 10) map.delete(map.keys().next().value);
    const id = randomUUID();
    map.set(id, { ...data, expires: this.now() + REVIEW_TTL_MS });
    return id;
  }

  reviewed(map, id, label) {
    const entry = map.get(id);
    if (!entry || entry.expires <= this.now())
      throw new Error(`${label} expired. Please review it again.`);
    return entry;
  }

  async handle(method, raw) {
    if (!Object.hasOwn(Requests, method))
      throw new Error("Unsupported desktop operation.");
    const schema = Requests[method];
    const result = schema.safeParse(raw);
    if (!result.success)
      throw new Error(
        "Invalid desktop request. Check your input and try again.",
      );
    const input = result.data;
    switch (method) {
      case "state":
        return this.snapshot();
      case "inspect": {
        if (this.inspecting)
          throw new Error("An invitation is already being inspected.");
        this.inspecting = true;
        try {
          const mission = MissionPreview.parse(
            await this.inspect(input.invitation),
          );
          // The bearer invitation is used only for this request. It is not
          // written to disk, returned to the renderer, or kept in this cache.
          return { reviewId: this.cache(this.reviews, { mission }), mission };
        } finally {
          this.inspecting = false;
        }
      }
      case "chooseWorkspace": {
        if (this.choosing) throw new Error("A folder chooser is already open.");
        this.choosing = true;
        try {
          const selected = await this.chooseDirectory();
          if (!selected) return null;
          const path = realpathSync(selected);
          if (isWithin(realpathSync(this.store.directory), path))
            throw new Error(
              "Choose a folder outside the desktop application's private data.",
            );
          const parentIdentity = identity(path);
          return {
            id: this.cache(this.choices, { path, parentIdentity }),
            path,
          };
        } finally {
          this.choosing = false;
        }
      }
      case "prepare": {
        const { mission } = this.reviewed(
          this.reviews,
          input.reviewId,
          "The invitation review",
        );
        const choice = this.reviewed(
          this.choices,
          input.workspaceChoiceId,
          "The workspace choice",
        );
        if (mission.role === "coordinator" && input.limits.concurrency !== 1)
          throw new Error(
            "A coordinator invitation supports one coordinator. Set concurrency to one.",
          );
        const current = this.store.read();
        if (current.contributions.length >= 500)
          throw new Error(
            "This desktop has reached its limit of 500 saved contributions.",
          );
        if (
          current.contributions.some(
            (item) =>
              item.status === "prepared" &&
              item.mission.origin === mission.origin &&
              item.mission.missionId === mission.missionId &&
              item.runtime === input.runtime,
          )
        )
          throw new Error(
            "A contribution for this mission and runtime is already prepared. Revoke it before replacing its terms.",
          );
        if (
          realpathSync(choice.path) !== choice.path ||
          !sameIdentity(identity(choice.path), choice.parentIdentity)
        )
          throw new Error(
            "The chosen folder changed. Select it again before saving.",
          );
        const id = randomUUID();
        const workspace = join(choice.path, `harakiri-${id}`);
        mkdirSync(workspace, { mode: 0o700 });
        try {
          const item = {
            id,
            contributorId: current.contributor.id,
            deviceId: current.device.id,
            mission,
            runtime: input.runtime,
            limits: input.limits,
            workspace,
            workspaceIdentity: identity(workspace),
            status: "prepared",
            createdAt: new Date(this.now()).toISOString(),
            revokedAt: null,
          };
          this.store.update((next) => {
            next.contributions.unshift(item);
            event(next, "contribution_prepared", mission.name, id);
          });
        } catch (error) {
          // Remove only the empty directory this operation just made. Never
          // recursively delete a contributor's files during a failed save.
          if (
            !this.store.read().contributions.some((entry) => entry.id === id)
          ) {
            try {
              rmdirSync(workspace);
            } catch {
              /* A non-empty workspace is preserved. */
            }
          }
          throw error;
        }
        this.reviews.delete(input.reviewId);
        this.choices.delete(input.workspaceChoiceId);
        return this.snapshot();
      }
      case "revoke": {
        this.store.update((next) => {
          const item = next.contributions.find(
            (entry) => entry.id === input.contributionId,
          );
          if (!item) throw new Error("Contribution not found on this device.");
          if (item.status === "revoked") return;
          item.status = "revoked";
          item.revokedAt = new Date(this.now()).toISOString();
          event(next, "consent_revoked", item.mission.name, item.id);
        });
        return this.snapshot();
      }
      case "reveal": {
        const item = this.store
          .read()
          .contributions.find((entry) => entry.id === input.contributionId);
        if (!item) throw new Error("Contribution not found on this device.");
        if (
          realpathSync(item.workspace) !== item.workspace ||
          !sameIdentity(identity(item.workspace), item.workspaceIdentity)
        )
          throw new Error(
            "The workspace was moved or replaced. Its original folder binding is no longer valid.",
          );
        await this.revealDirectory(item.workspace);
        return null;
      }
      case "rename":
        this.store.update((next) => {
          next.contributor.name = input.name;
          event(next, "contributor_named", input.name);
        });
        return this.snapshot();
      default:
        throw new Error("Unsupported desktop operation.");
    }
  }
}
