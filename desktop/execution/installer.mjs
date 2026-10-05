import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
  lstat,
  statfs,
  access,
} from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);
// Official release digests. No peer/renderer-selected download or executable.
export const LIMA_RELEASE = Object.freeze({
  version: "2.1.1",
  files: [
    {
      name: "lima-2.1.1-Darwin-arm64.tar.gz",
      sha256:
        "b6b0e6701189cd8c4e549cc39e6d054dc681487798b9b774ad2cbd30c08b2bd8",
    },
    {
      name: "lima-additional-guestagents-2.1.1-Darwin-arm64.tar.gz",
      sha256:
        "03dbbe32c3a6df909a1022111af2c8c79a63be30aff52f14d7edadeb502fc7eb",
    },
  ],
});
export class LimaInstaller {
  status = { stage: "idle", bytes: 0, total: null, error: null };
  pending = null;
  controller = null;
  constructor(directory) {
    this.directory = directory;
  }
  get path() {
    return join(this.directory, LIMA_RELEASE.version, "bin/limactl");
  }
  async available() {
    return access(this.path).then(
      () => this.path,
      () => null,
    );
  }
  async install() {
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    this.pending = this.perform().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async cancel() {
    this.controller?.abort();
    await this.pending?.catch(() => {});
  }
  async perform() {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error("Isolated execution requires Apple Silicon macOS.");
    if (await this.available()) return this.path;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink())
      throw new Error("Invalid provider storage.");
    const disk = await statfs(this.directory);
    if (disk.bavail * disk.bsize < 2 * 1024 ** 3)
      throw new Error(
        "At least 2 GB free disk space is required to install Lima.",
      );
    const temporary = await mkdtemp(join(this.directory, ".install-"));
    const staging = join(temporary, "release");
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const asset of LIMA_RELEASE.files) {
        this.status = {
          stage: `Downloading ${asset.name}`,
          bytes: 0,
          total: null,
          error: null,
        };
        const response = await fetch(
          `https://github.com/lima-vm/lima/releases/download/v${LIMA_RELEASE.version}/${asset.name}`,
          {
            signal: AbortSignal.any([
              this.controller.signal,
              AbortSignal.timeout(600000),
            ]),
          },
        );
        if (!response.ok || !response.body)
          throw new Error(
            "The official Lima release could not be downloaded. Retry when connected.",
          );
        this.status.total =
          Number(response.headers.get("content-length")) || null;
        const chunks = [];
        const hash = createHash("sha256");
        for await (const chunk of response.body) {
          this.status.bytes += chunk.length;
          if (this.status.bytes > 300 * 1024 * 1024)
            throw new Error("Provider download exceeds the permitted size.");
          hash.update(chunk);
          chunks.push(chunk);
        }
        if (hash.digest("hex") !== asset.sha256)
          throw new Error(
            "Lima release checksum did not match. Nothing was installed.",
          );
        const archive = join(temporary, asset.name);
        await writeFile(archive, Buffer.concat(chunks), { mode: 0o600 });
        this.status.stage = "Verifying and unpacking the pinned Lima release";
        const { stdout } = await exec("/usr/bin/tar", ["-tzf", archive], {
          maxBuffer: 4 * 1024 * 1024,
          signal: this.controller.signal,
        });
        if (
          stdout
            .split("\n")
            .some((p) => p.startsWith("/") || p.split("/").includes(".."))
        )
          throw new Error("Invalid release archive paths.");
        await exec("/usr/bin/tar", ["-xzf", archive, "-C", staging], {
          timeout: 60000,
          signal: this.controller.signal,
        });
      }
      const { stdout } = await exec(
        join(staging, "bin/limactl"),
        ["--version"],
        { timeout: 10000 },
      );
      if (!stdout.includes(`version ${LIMA_RELEASE.version}`))
        throw new Error("Unexpected Lima release version.");
      await writeFile(
        join(staging, "harakiri-release.json"),
        JSON.stringify(LIMA_RELEASE),
        { mode: 0o600 },
      );
      await rename(staging, join(this.directory, LIMA_RELEASE.version));
      this.status = { stage: "Installed", bytes: 0, total: null, error: null };
      return this.path;
    } catch (error) {
      this.status.error = this.controller.signal.aborted
        ? "Installation cancelled. Retry to download and verify the provider again."
        : error.message;
      throw error;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
