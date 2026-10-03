"""Install a pinned vendor binary after verifying its entire distribution."""
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from runtimes import BASE, private_directory, spec

value = spec()
target = BASE + "/" + value["runtime"]
receipt = target + ".sha256"
# A binary receipt is local installation evidence, not a vendor signature.
# The first installation verifies the pinned vendor distribution hash.
existing = None
if os.path.isfile(receipt) and os.path.isfile(target):
    with open(receipt) as f:
        existing = json.load(f)
    with open(target, "rb") as f:
        actual = hashlib.file_digest(f, "sha256").hexdigest()
    if existing != {"distribution": value["sha256"], "binary": actual}:
        raise ValueError("Installed runtime changed; refusing to execute it")
if existing is None:
    with tempfile.TemporaryDirectory(dir=BASE) as directory:
        download = directory + "/download"
        subprocess.run(["curl", "--proto", "=https", "--tlsv1.2", "--fail", "--location",
                        "--max-time", "360", value["url"], "-o", download], check=True)
        with open(download, "rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() != value["sha256"]:
                raise ValueError("Runtime distribution checksum mismatch")
        if value["archive"]:
            with tarfile.open(download, "r:gz") as archive:
                member = archive.getmember(value["archive"])
                if not member.isfile() or member.size > 512 * 1024 * 1024:
                    raise ValueError("Invalid runtime archive")
                with archive.extractfile(member) as source, open(directory + "/binary", "wb") as output:
                    shutil.copyfileobj(source, output)
            download = directory + "/binary"
        os.chmod(download, 0o755)
        os.replace(download, target)
        with open(target, "rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        with open(receipt, "w") as f:
            json.dump({"distribution": value["sha256"], "binary": digest}, f)
subprocess.run(["install", "-d", "-m", "0700", "-o", "hb-runtime", "-g", "hb-runtime", private_directory()], check=True)
with open(BASE + "/mcp.json", "w") as f:
    json.dump({"mcpServers": {"harakiri": {"command": "/usr/bin/python3", "args": [BASE + "/mcp.py"]}}}, f)
with open(BASE + "/claude-settings.json", "w") as f:
    json.dump({"disableAllHooks": True, "autoMemoryEnabled": False, "enabledPlugins": {}}, f)
if value["runtime"] == "codex":
    with open(private_directory() + "/config.toml", "w") as f:
        f.write('''approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
cli_auth_credentials_store = "file"
model_reasoning_effort = "medium"
[skills]
include_instructions = false
[skills.bundled]
enabled = false
[features]
goals = false
sleep_tool = false
shell_tool = false
view_image = false
unified_exec = false
shell_snapshot = false
js_repl = false
code_mode = false
code_mode_host = false
code_mode_only = false
apply_patch_freeform = false
multi_agent = false
multi_agent_v2 = false
enable_fanout = false
apps = false
plugins = false
hooks = false
plugin_hooks = false
memories = false
external_agent_memory_import = false
skill_mcp_dependency_install = false
skip_host_skill_discovery = true
executor_capability_discovery = false
tool_search = false
non_prefixed_mcp_tool_names = false
browser_use = false
computer_use = false
image_generation = false
[mcp_servers.harakiri]
command = "/usr/bin/python3"
args = ["/opt/harakiri/mcp.py"]
required = true
# Keep the small scoped API directly available; do not route it through
# native discovery/code execution even when the model prefers those modes.
omit_tools_from = ["deferred", "code_mode"]
[mcp_servers.harakiri.tools.board]
approval_mode = "approve"
[mcp_servers.harakiri.tools.workspace_exec]
approval_mode = "approve"
[mcp_servers.harakiri.tools.workspace_read]
approval_mode = "approve"
[mcp_servers.harakiri.tools.workspace_write]
approval_mode = "approve"
[mcp_servers.harakiri.tools.publish_artifact]
approval_mode = "approve"
''')
