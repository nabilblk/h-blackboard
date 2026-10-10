import {
  access,
  mkdir,
  writeFile,
  chmod,
  stat,
  rename,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Response } from "./contract.mjs";
import { draftingPrompt, draftingInstructions } from "./prompt.mjs";
import {
  JsonLines,
  collect,
  startProcess,
  publicError,
  runtimeFailure,
} from "./transport.mjs";
import {
  cleanLoginOutput,
  loginPresentation,
  loginURL,
} from "../execution/authentication.mjs";

const labels = { claude: "Claude Code", codex: "Codex", grok: "Grok Build" };
// Native CLIs, not a shell or a command provided by renderer/peer/model.
export async function findRuntime(
  runtime,
  home = homedir(),
  path = process.env.PATH ?? "",
) {
  const folders = [
    join(home, ".local/bin"),
    join(home, ".grok/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...path.split(":").filter(isAbsolute),
  ];
  for (const directory of [...new Set(folders)]) {
    const file = join(directory, runtime);
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}
export function draftingEnvironment(home = homedir()) {
  // No API keys, token exports, NODE_OPTIONS, proxy injection or inherited
  // agent settings. Each CLI owns and refreshes its existing account itself.
  const env = {
    HOME: home,
    USER: process.env.USER || "",
    LOGNAME: process.env.LOGNAME || "",
    PATH: `${join(home, ".local/bin")}:${join(home, ".grok/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}
const disabledCodexFeatures = [
  "goals",
  "sleep_tool",
  "shell_tool",
  "view_image",
  "unified_exec",
  "shell_snapshot",
  "js_repl",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "apply_patch_freeform",
  "multi_agent",
  "multi_agent_v2",
  "enable_fanout",
  "apps",
  "plugins",
  "hooks",
  "plugin_hooks",
  "memories",
  "external_agent_memory_import",
  "skill_mcp_dependency_install",
  "executor_capability_discovery",
  "tool_search",
  "browser_use",
  "computer_use",
  "image_generation",
];
export function codexArguments() {
  const settings = [
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'web_search="disabled"',
    'model_reasoning_effort="low"',
    "mcp_servers={}",
    "notify=[]",
    "skills.include_instructions=false",
    "skills.bundled.enabled=false",
    "features.skip_host_skill_discovery=true",
    ...disabledCodexFeatures.map((f) => `features.${f}=false`),
  ];
  return [
    "app-server",
    "--strict-config",
    "--listen",
    "stdio://",
    ...settings.flatMap((v) => ["-c", v]),
  ];
}
export function claudeArguments() {
  return [
    "--print",
    "--verbose",
    "--effort",
    "low",
    "--safe-mode",
    "--restricted",
    "--tools",
    "",
    "--permission-prompts",
    "none",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    '{"disableAllHooks":true,"autoMemoryEnabled":false,"enabledPlugins":{}}',
    "--output-format",
    "stream-json",
    "--session-id",
    randomUUID(),
    "--no-session-persistence",
    "--system-prompt",
    draftingInstructions,
  ];
}
const grokEnvironment = (home) => ({
  ...draftingEnvironment(home),
  GROK_SUBAGENTS: "0",
  GROK_MEMORY: "0",
  GROK_WEB_FETCH: "0",
  GROK_TOOL_SEARCH: "0",
  GROK_WRITE_FILE: "0",
  GROK_LSP_TOOLS: "0",
  GROK_DISABLE_AUTOUPDATER: "1",
  ...Object.fromEntries(
    ["CURSOR", "CLAUDE"].flatMap((x) =>
      ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS"].map((y) => [
        `GROK_${x}_${y}_ENABLED`,
        "0",
      ]),
    ),
  ),
});
export function grokConfigurationIsClean(inspect) {
  return [
    "hooks",
    "plugins",
    "mcpServers",
    "lspServers",
    "projectInstructions",
  ].every((key) => Array.isArray(inspect[key]) && inspect[key].length === 0);
}
export function parseDraftReply(text) {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "");
  try {
    return Response.parse(JSON.parse(raw));
  } catch {
    throw publicError(
      "The helper returned an invalid brief. Your existing work is safe. Ask it to try again or continue manually.",
    );
  }
}

export class DraftRuntimeService {
  constructor({ directory, home = homedir(), find = findRuntime }) {
    this.directory = directory;
    this.home = home;
    this.find = find;
    this.loginJob = null;
  }
  async configuration(runtime, signal) {
    const binary = await this.find(runtime, this.home);
    if (!binary)
      throw publicError(
        `Install ${labels[runtime]} on this Mac to use it here. You can keep writing the brief manually.`,
      );
    const cwd = join(this.directory, "work");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await chmod(cwd, 0o700);
    const env = draftingEnvironment(this.home);
    const version = (
      await collect(
        startProcess(binary, ["--version"], {
          cwd,
          env,
          signal,
          timeout: 10000,
        }),
      )
    ).trim();
    const supported = {
      claude: /\b2\.1\.(\d+)/,
      codex: /\b0\.(\d+)\./,
      grok: /\b1\.0\.(\d+)/,
    };
    const match = version.match(supported[runtime]);
    if (
      !match ||
      Number(match[1]) < { claude: 295, codex: 162, grok: 41 }[runtime]
    )
      throw publicError(
        `Update ${labels[runtime]} to a supported version for restricted drafting (Claude 2.1.295+, Codex 0.162+, Grok 1.0.41+).`,
      );
    if (runtime !== "grok")
      return { binary, cwd, env, version, privateLogin: false };
    let grokEnv = grokEnvironment(this.home);
    const inspect = async (e) =>
      JSON.parse(
        await collect(
          startProcess(binary, ["--no-auto-update", "inspect", "--json"], {
            cwd,
            env: e,
            signal,
            timeout: 15000,
          }),
        ),
      );
    let privateLogin = !grokConfigurationIsClean(await inspect(grokEnv));
    if (privateLogin) {
      const home = join(this.directory, "grok-private");
      await mkdir(home, { recursive: true, mode: 0o700 });
      grokEnv = grokEnvironment(home);
      if (!grokConfigurationIsClean(await inspect(grokEnv)))
        throw publicError(
          "Managed Grok extensions prevent a text-only session. Choose another runtime or continue manually.",
        );
    }
    const profile = join(this.directory, "grok-drafting.md");
    const temporaryProfile = `${profile}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryProfile,
      `---\nname: harakiri-mission-drafting\ndescription: Private text-only mission authoring\ntools: []\ninjectDefaultTools: false\ndiscoverSkills: false\ninheritSkills: false\nagentsMd: false\n---\n${draftingInstructions}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryProfile, profile);
    return { binary, cwd, env: grokEnv, version, privateLogin, profile };
  }
  async list() {
    return Promise.all(
      Object.keys(labels).map(async (runtime) => {
        try {
          const c = await this.configuration(runtime);
          let savedLogin = false;
          if (runtime === "grok" && c.privateLogin) {
            try {
              savedLogin = (
                await stat(join(c.env.HOME, ".grok/auth.json"))
              ).isFile();
            } catch {}
          }
          return {
            runtime,
            label: labels[runtime],
            available: true,
            version: c.version,
            privateLogin: c.privateLogin,
            detail: c.privateLogin
              ? "Grok has extensions in your usual profile. Private drafting uses a separate local sign-in; your existing settings stay intact."
              : "Uses this CLI's signed-in subscription. Availability is confirmed when you send.",
            login:
              runtime === "grok"
                ? (this.loginState() ??
                  (savedLogin
                    ? { status: "saved", url: null, code: null }
                    : null))
                : null,
          };
        } catch (e) {
          return {
            runtime,
            label: labels[runtime],
            available: false,
            version: null,
            privateLogin: false,
            detail:
              e.publicMessage ||
              "This runtime could not be checked. Continue manually or retry.",
            login: null,
          };
        }
      }),
    );
  }
  async run({ draft, signal }) {
    const c = await this.configuration(draft.runtime, signal);
    if (signal.aborted) throw publicError("Stopped. Your draft is saved.");
    const prompt = draftingPrompt(draft);
    if (draft.runtime === "claude") {
      const status = JSON.parse(
        await collect(
          startProcess(c.binary, ["auth", "status"], {
            ...c,
            signal,
            timeout: 10000,
          }),
        ),
      );
      if (!["claude.ai", "oauth_token"].includes(status.authMethod))
        throw publicError(
          "Sign in with your Claude subscription using `claude auth login`, then retry. Drafting does not switch to paid API credentials.",
        );
      const child = startProcess(c.binary, claudeArguments(), {
        ...c,
        signal,
        env: {
          ...c.env,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      });
      let initialized = false,
        result,
        text = "";
      const wire = new JsonLines(child, (m) => {
        if (m.type === "system" && m.subtype === "init") {
          if (
            !Array.isArray(m.tools) ||
            m.tools.some((t) => t !== "EndConversation") ||
            m.mcp_servers?.length
          )
            throw publicError(
              "Claude exposed an unexpected tool. The drafting session was stopped.",
            );
          initialized = true;
        }
        if (m.type === "assistant")
          for (const block of m.message?.content ?? []) {
            if (block.type === "tool_use")
              throw publicError(
                "Claude attempted a tool call. The drafting session was stopped.",
              );
            if (block.type === "text") text += block.text;
          }
        if (m.type === "result") result = m;
      });
      const done = wire.wait((m) => m.type === "result");
      child.stdin.end(prompt);
      try {
        await done;
        if (!initialized || result.is_error || result.subtype !== "success")
          throw runtimeFailure(JSON.stringify(result?.errors ?? []));
        return parseDraftReply(result.result || text);
      } finally {
        await wire.close();
      }
    }
    if (draft.runtime === "codex") {
      let text = "";
      const wire = new JsonLines(
        startProcess(c.binary, codexArguments(), { ...c, signal }),
        (m) => {
          if (m.method === "item/agentMessage/delta") text += m.params.delta;
          if (
            m.method === "item/started" &&
            ![
              "userMessage",
              "agentMessage",
              "reasoning",
              "plan",
              "contextCompaction",
            ].includes(m.params.item?.type)
          )
            throw publicError(
              "Codex exposed an unexpected capability. The drafting session was stopped.",
            );
        },
      );
      try {
        await wire.request("initialize", {
          clientInfo: { name: "harakiri-drafting", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        });
        wire.send({ method: "initialized" });
        const account = await wire.request("account/read", {
          refreshToken: false,
        });
        if (account.account?.type !== "chatgpt")
          throw publicError(
            "Sign in with your ChatGPT subscription using `codex login`, then retry. Drafting does not switch to paid API credentials.",
          );
        const opened = await wire.request("thread/start", {
          cwd: c.cwd,
          environments: [],
          selectedCapabilityRoots: [],
          runtimeWorkspaceRoots: [],
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          baseInstructions: draftingInstructions,
        });
        const threadId = opened.thread?.id;
        if (typeof threadId !== "string")
          throw publicError("Codex did not open a drafting session.");
        const done = wire.wait(
          (m) =>
            m.method === "turn/completed" && m.params.threadId === threadId,
        );
        const start = await wire.request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          environments: [],
          runtimeWorkspaceRoots: [],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        });
        const result = (await done).params.turn;
        if (
          result.id !== start.turn.id ||
          result.status !== "completed" ||
          result.error
        )
          throw runtimeFailure(JSON.stringify(result.error));
        return parseDraftReply(text);
      } finally {
        await wire.close();
      }
    }
    let text = "",
      sessionId;
    const wire = new JsonLines(
      startProcess(
        c.binary,
        [
          "--no-auto-update",
          "agent",
          "--no-leader",
          "--reasoning-effort",
          "low",
          "--agent-profile",
          c.profile,
          "stdio",
        ],
        { ...c, signal },
      ),
      (m) => {
        if (m.method !== "session/update" || m.params.sessionId !== sessionId)
          return;
        const u = m.params.update;
        if (["tool_call", "tool_call_update"].includes(u.sessionUpdate))
          throw publicError(
            "Grok attempted a tool call. The drafting session was stopped.",
          );
        if (
          u.sessionUpdate === "agent_message_chunk" &&
          u.content?.type === "text"
        )
          text += u.content.text;
      },
    );
    try {
      const init = await wire.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "harakiri-drafting", version: "1.0.0" },
        _meta: { startupHints: { nonInteractive: true } },
      });
      if (init.protocolVersion !== 1)
        throw publicError("Grok uses an unsupported protocol. Update the CLI.");
      if (init._meta?.defaultAuthMethodId !== "cached_token")
        throw publicError(
          c.privateLogin
            ? "Sign in to private Grok drafting below, then retry your saved message."
            : "Sign in to Grok using `grok login`, then retry. Drafting uses subscription authentication.",
        );
      await wire.request("authenticate", {
        methodId: "cached_token",
        _meta: { headless: true },
      });
      const session = await wire.request("session/new", {
        cwd: c.cwd,
        mcpServers: [],
        _meta: { sessionKind: "headless", yoloMode: false },
      });
      sessionId = session.sessionId;
      if (typeof sessionId !== "string")
        throw publicError("Grok did not open a drafting session.");
      const result = await wire.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      if (result.stopReason !== "end_turn")
        throw runtimeFailure(result.stopReason);
      return parseDraftReply(text);
    } finally {
      await wire.close();
    }
  }
  loginState() {
    return this.loginJob?.view ?? null;
  }
  async signIn() {
    if (this.loginJob?.active) return this.loginState();
    const c = await this.configuration("grok");
    if (!c.privateLogin)
      throw publicError(
        "Your normal Grok login is already used. Run `grok login` to refresh it if needed.",
      );
    const child = startProcess(
      c.binary,
      ["--no-auto-update", "login", "--device-auth"],
      { ...c, timeout: 600000 },
    );
    const job = {
      active: true,
      child,
      view: { status: "starting", url: null, code: null },
      output: "",
      startedAt: Date.now(),
    };
    this.loginJob = job;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (!job.active) return;
        job.output = (job.output + cleanLoginOutput(chunk)).slice(-16384);
        const p = loginPresentation(
          "grok",
          job.output,
          job.startedAt,
          job.view,
        );
        job.view = {
          status: p.failure || (p.url ? "waiting" : "starting"),
          url: p.failure ? null : p.url,
          code: p.failure ? null : p.code,
        };
      });
    }
    child.on("error", () => {
      job.active = false;
      job.view = { status: "failed", url: null, code: null };
    });
    child.on("close", (code) => {
      job.active = false;
      job.output = "";
      job.view = {
        status: code === 0 ? "signed_in" : "stopped",
        url: null,
        code: null,
      };
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
    return job.view;
  }
  async openLogin(open) {
    const j = this.loginJob;
    if (
      !j?.active ||
      j.view.status !== "waiting" ||
      !loginURL("grok", j.view.url)
    )
      throw publicError(
        "This sign-in link is no longer active. Start a new sign-in.",
      );
    await open(j.view.url);
  }
  async cancelLogin() {
    const j = this.loginJob;
    if (!j?.active) return;
    const done = once(j.child, "close");
    j.child.stop();
    await done;
  }
}
