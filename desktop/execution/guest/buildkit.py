"""Apply the contributor's explicit, pinned authoring toolkit.

No npm install scripts, host credentials, or mission-controlled downloads. The
read-only /usr tree is already visible inside the worker jail. Network consent
continues to govern worker commands, including npm and curl.
"""
import base64
import hashlib
import json
import os
import pathlib
import shutil
import tarfile
import tempfile
import urllib.request

VERSION = "web-artifact-1"
ROOT = pathlib.Path("/usr/local/lib/harakiri-buildkit")
CONFIG = pathlib.Path("/opt/harakiri/capabilities.json")
BIN = pathlib.Path("/usr/local/bin")
LINKS = (("node", "node/bin/node"), ("npm", "node/lib/node_modules/npm/bin/npm-cli.js"), ("esbuild", "esbuild/bin/esbuild"))
PACKAGES = (
    ("node", "24.21.0", "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz",
     "sha256", "6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2", "node-v24.21.0-linux-arm64"),
    ("esbuild", "0.28.2", "https://registry.npmjs.org/@esbuild/linux-arm64/-/linux-arm64-0.28.2.tgz",
     "sha512", "pW4AC0P3it8c7do9MVM4p51FzHzdM/TZrerurgRcHJ2WTa1VQ1CIq18xncfpBJw4ojkiZZrKW2yIBWBP92j6Ug==", "package"),
    ("three", "0.186.1", "https://registry.npmjs.org/three/-/three-0.186.1.tgz",
     "sha512", "blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA==", "package"),
)


def selected_pack():
    # Missing legacy configuration never opts a contributor into extra tools.
    config = json.loads(CONFIG.read_text()) if CONFIG.exists() else {"pack": "general"}
    pack = config.get("pack")
    if pack not in ("general", "web-3d"):
        raise ValueError("Unknown authoring toolkit")
    return pack


def record_selection(value):
    ROOT.mkdir(parents=True, exist_ok=True)
    temporary = ROOT / ".selected.json"
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(temporary, 0o644)
    temporary.replace(ROOT / "selected.json")


def install():
    if os.geteuid() != 0:
        raise PermissionError("Only trusted guest preparation installs the build kit")
    pack = selected_pack()
    target = ROOT / VERSION
    if pack == "general":
        # Remove only this application's known kit. Preserve workspace files,
        # provider binaries/login, and unrelated system software.
        for name, relative in LINKS:
            link = BIN / name
            if link.is_symlink() and pathlib.Path(os.readlink(link)) == target / relative:
                link.unlink()
        if target.exists():
            shutil.rmtree(target)
        record_selection({"pack": pack, "buildkit": None, "packages": []})
        return
    manifest = {"version": VERSION, "packages": [
        {"name": name, "version": version, "url": url, algorithm: digest}
        for name, version, url, algorithm, digest, _ in PACKAGES]}
    if not target.exists():
        ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".install-", dir=ROOT) as directory:
            temporary = pathlib.Path(directory)
            for name, _, url, algorithm, expected, member in PACKAGES:
                archive = temporary / (name + ".archive")
                with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as stream:
                    size, digest = 0, hashlib.new(algorithm)
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > 100 * 1024 * 1024:
                            raise ValueError("Build kit archive exceeds limit")
                        digest.update(chunk)
                        stream.write(chunk)
                actual = digest.hexdigest() if algorithm == "sha256" else base64.b64encode(digest.digest()).decode()
                if actual != expected:
                    raise ValueError("Build kit checksum mismatch: " + name)
                extracted = temporary / (name + "-extract")
                with tarfile.open(archive) as source:
                    if sum(m.size for m in source.getmembers()) > 400 * 1024 * 1024:
                        raise ValueError("Build kit expanded archive exceeds limit")
                    source.extractall(extracted, filter="data")
                (extracted / member).rename(temporary / name)
                shutil.rmtree(extracted)
                archive.unlink()
            (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            os.chmod(temporary, 0o755)
            temporary.rename(target)
    if json.loads((target / "manifest.json").read_text()) != manifest:
        raise ValueError("Installed toolkit manifest does not match pinned packages")
    for name, relative in LINKS:
        link = BIN / name
        tmp = link.with_name(".hb-" + name)
        tmp.unlink(missing_ok=True)
        tmp.symlink_to(target / relative)
        tmp.replace(link)
    record_selection({"pack": pack, "buildkit": VERSION, **manifest})


if __name__ == "__main__":
    install()
