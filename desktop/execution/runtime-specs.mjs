import { runtimePolicy } from "./contract.mjs";

export const RUNTIME_LABELS = Object.freeze({
  grok: "Grok Build",
  claude: "Claude Code",
  codex: "Codex",
});

// Downloaded only during explicit preparation, never selected by a peer.
export function runtimeSpec(runtime, networkAccess = "restricted") {
  const policy = runtimePolicy(runtime, networkAccess);
  return {
    runtime,
    networkAccess,
    hosts: policy.runtimeHosts,
    sha256: policy.runtimeSha256,
    url: {
      grok: `https://x.ai/cli/grok-${policy.runtimeVersion}-linux-aarch64`,
      claude: `https://downloads.claude.ai/claude-code-releases/${policy.runtimeVersion}/linux-arm64/claude`,
      codex: `https://github.com/openai/codex/releases/download/rust-v${policy.runtimeVersion}/codex-aarch64-unknown-linux-musl.tar.gz`,
    }[runtime],
    archive: runtime === "codex" ? "codex-aarch64-unknown-linux-musl" : null,
  };
}
