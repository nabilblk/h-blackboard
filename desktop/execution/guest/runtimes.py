"""Root-owned runtime configuration. No workspace configuration is loaded."""
import json
import os
import re

BASE = "/opt/harakiri"
RUNTIME_HOME = "/home/hb-runtime"


def spec():
    with open(BASE + "/runtime.json", encoding="utf8") as f:
        value = json.load(f)
    if value["runtime"] not in ("grok", "claude", "codex"):
        raise ValueError("Unsupported runtime")
    return value


def private_directory():
    return RUNTIME_HOME + "/." + spec()["runtime"]


def environment():
    return {"HOME": RUNTIME_HOME, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
            "GROK_SUBAGENTS": "0", "CODEX_HOME": RUNTIME_HOME + "/.codex",
            "CLAUDE_CONFIG_DIR": RUNTIME_HOME + "/.claude",
            "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1", "ENABLE_TOOL_SEARCH": "false"}


def command(session=None):
    runtime = spec()["runtime"]
    if runtime == "grok":
        args = [BASE + "/grok", "--no-auto-update", "agent", "--no-leader",
                "--agent-profile", BASE + "/agent.md", "stdio"]
        if os.path.isfile(BASE + "/debug-enabled"):
            args[-1:-1] = ["--debug", "--debug-file", RUNTIME_HOME + "/.grok/harakiri-debug.log"]
        return args
    if runtime == "codex":
        return [BASE + "/codex", "app-server", "--strict-config", "--listen", "stdio://"]
    if not session or not re.fullmatch(r"[a-f0-9-]{36}", session[1]):
        raise ValueError("Claude requires a host-selected session UUID")
    with open(BASE + "/agent.md", encoding="utf8") as f:
        instructions = f.read().split("---", 2)[-1].strip()
    return [BASE + "/claude", "--print", "--verbose", "--restricted",
            "--input-format", "stream-json", "--output-format", "stream-json",
            "--tools", "", "--allowedTools", "mcp__harakiri__*",
            "--permission-prompts", "none", "--setting-sources", "",
            "--strict-mcp-config", "--mcp-config", BASE + "/mcp.json",
            "--settings", BASE + "/claude-settings.json",
            "--system-prompt", instructions, "--system-prompt-snapshot", "off",
            "--resume" if session[0] else "--session-id", session[1]]


def authenticated():
    name = {"grok": "auth.json", "claude": ".credentials.json", "codex": "auth.json"}[spec()["runtime"]]
    # Presence is intentionally not a claim that a subscription has capacity.
    return os.path.isfile(private_directory() + "/" + name)
