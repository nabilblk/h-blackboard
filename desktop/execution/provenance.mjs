import { authoringPack } from "../../shared/authoring-packs.mjs";
import { createHash } from "node:crypto";
import { guestTools } from "./tools.mjs";
import { guidanceCatalog } from "./guidance.mjs";
import { BRIEFING_VERSION } from "./prompt.mjs";
import { runtimePolicy } from "./contract.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export function effectiveConfiguration({
  runtime,
  role = "coordinator",
  networkAccess = "restricted",
  capabilityPack = "general",
  prompt,
  guide,
}) {
  const policy = runtimePolicy(runtime, networkAccess);
  return {
    version: 1,
    protocol: 13,
    briefing: BRIEFING_VERSION,
    runtime,
    runtimeVersion: policy.runtimeVersion,
    runtimeDistributionSha256: policy.runtimeSha256,
    networkAccess,
    promptSha256: hash(prompt),
    promptBytes: Buffer.byteLength(prompt),
    guideSha256: hash(guide),
    role,
    toolSchemaSha256: hash(guestTools(networkAccess, role)),
    guidance: guidanceCatalog().map(({ id, version, sha256 }) => ({
      id,
      version,
      sha256,
    })),
    authoring: authoringPack(capabilityPack),
    buildkit: authoringPack(capabilityPack).buildkit,
    nativeTools: false,
    personalSkills: false,
    modelSettings: {
      reasoningEffort: runtime === "codex" ? "medium" : null,
      unknown:
        runtime === "codex"
          ? ["resolved_model"]
          : ["resolved_model", "reasoning_effort"],
    },
    model:
      "provider default; exact selection is reported by the runtime when available",
  };
}

export function browserReceipt({
  revision,
  files,
  request,
  result,
  grant,
  reservation,
  now = Date.now(),
}) {
  const observation = { ...result };
  delete observation.image;
  return {
    version: 1,
    method: "browser_check",
    tool: "artifact_browser",
    toolVersion: BRIEFING_VERSION,
    environment: {
      chromium: process.versions.chrome ?? null,
      electron: process.versions.electron ?? null,
    },
    scope: "local host execution receipt",
    at: now,
    revision,
    files: files.map(({ path, hash, size }) => ({ path, hash, size })),
    grant,
    reservation,
    request,
    observationSha256: hash(observation),
    imageSha256: result.image?.data
      ? createHash("sha256")
          .update(Buffer.from(result.image.data, "base64"))
          .digest("hex")
      : null,
    judgment:
      "No quality verdict or proof that an agent inspected the image. Publish these bytes as evidence for an attributed review.",
  };
}
