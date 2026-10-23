// Conservative Cargo dependency inventory, including available upstream notices.
// Missing notice texts are explicitly reported; this is not a completed release audit.
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function writeNodeInventory({
  output,
  binary,
  component,
  signature,
}) {
  const host = (await exec("rustc", ["-vV"], { cwd: root })).stdout.match(
    /^host: (.+)$/m,
  )?.[1];
  if (!host) throw new Error("The node build target is unknown.");
  const version = (await exec(binary, ["--version"])).stdout.trim();
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const { stdout } = await exec(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      host,
    ],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  const metadata = JSON.parse(stdout);
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const main = metadata.packages.find((pkg) => pkg.name === "harakiri-node");
  const selected = new Set();
  function visit(id) {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dep of nodes.get(id)?.deps || [])
      if (dep.dep_kinds.some((kind) => kind.kind !== "dev")) visit(dep.pkg);
  }
  visit(main.id);
  const components = [...selected]
    .map((id) => byId.get(id))
    .sort((a, b) =>
      `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
    );
  const notices = [];
  const missingNotices = [];
  const supplement = JSON.parse(
    await readFile(join(root, "licenses/cargo/supplemental.json"), "utf8"),
  );
  const supplementalSources = [];
  const noticeReviewRequired = [];
  for (const pkg of components) {
    const directory = dirname(pkg.manifest_path);
    const candidates = new Set(
      (await readdir(directory)).filter((name) =>
        /^(license|copying|notice)([.\-_]|$)/i.test(name),
      ),
    );
    if (pkg.license_file) candidates.add(pkg.license_file);
    let count = 0;
    for (const name of [...candidates].sort()) {
      const path = resolve(directory, name);
      if (!path.startsWith(directory + "/")) continue;
      try {
        const text = await readFile(path, "utf8");
        notices.push(`${pkg.name} ${pkg.version} — ${name}\n${text}`);
        count++;
      } catch (error) {
        if (error.code !== "EISDIR") throw error;
      }
    }
    if (
      !count &&
      !pkg.source &&
      pkg.manifest_path.startsWith(join(root, "crates") + "/")
    ) {
      for (const name of ["LICENSE", "NOTICE"])
        notices.push(
          `${pkg.name} ${pkg.version} — ${name}\n${await readFile(join(root, name), "utf8")}`,
        );
      count++;
    }
    if (!count) {
      const extra = supplement.packages.find(
        (p) => p.name === pkg.name && p.version === pkg.version,
      );
      if (extra) {
        const vcs = JSON.parse(
          await readFile(join(directory, ".cargo_vcs_info.json"), "utf8"),
        );
        if (vcs.git.sha1 !== extra.vcs || extra.license !== pkg.license)
          throw new Error(
            `Supplemental notice no longer matches ${pkg.name}@${pkg.version}`,
          );
        for (const file of extra.files) {
          if (!/^[a-f0-9]{64}\.txt$/.test(file.path))
            throw new Error("Invalid supplemental notice path");
          const bytes = await readFile(join(root, "licenses/cargo", file.path));
          if (digest(bytes) !== file.sha256)
            throw new Error("Supplemental notice digest mismatch");
          notices.push(
            `${pkg.name} ${pkg.version} — pinned upstream notice\nSource: ${file.source}\n${bytes.toString("utf8")}`,
          );
          count++;
          supplementalSources.push({
            package: `${pkg.name}@${pkg.version}`,
            source: file.source,
            sha256: file.sha256,
          });
        }
        if (extra.reviewRequired)
          noticeReviewRequired.push(`${pkg.name}@${pkg.version}`);
      }
    }
    if (!count) missingNotices.push(`${pkg.name}@${pkg.version}`);
  }
  const ref = (pkg) => `pkg:cargo/${pkg.name}@${pkg.version}`;
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: component,
        version: main.version,
      },
      properties: [
        { name: "harakiri:target", value: host },
        {
          name: "harakiri:cargo-lock-sha256",
          value: digest(await readFile(join(root, "Cargo.lock"))),
        },
      ],
    },
    components: components.map((pkg) => ({
      type: "library",
      "bom-ref": ref(pkg),
      name: pkg.name,
      version: pkg.version,
      purl: ref(pkg),
      ...(pkg.license ? { licenses: [{ expression: pkg.license }] } : {}),
    })),
    dependencies: components.map((pkg) => ({
      ref: ref(pkg),
      dependsOn: (nodes.get(pkg.id)?.deps || [])
        .filter(
          (dep) =>
            selected.has(dep.pkg) &&
            dep.dep_kinds.some((kind) => kind.kind !== "dev"),
        )
        .map((dep) => ref(byId.get(dep.pkg))),
    })),
  };
  await writeFile(
    join(output, "sbom.cdx.json"),
    JSON.stringify(sbom, null, 2) + "\n",
  );
  await writeFile(
    join(output, "THIRD-PARTY-NOTICES.txt"),
    notices.join("\n\n---\n\n"),
  );
  await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
  await copyFile(join(root, "NOTICE"), join(output, "NOTICE"));
  const manifest = {
    version,
    target: host,
    sha256: digest(await readFile(binary)),
    signature,
    dependencies: components.length,
    missingLicenseTexts: missingNotices,
    supplementalSources,
    noticeReviewRequired,
    cargoLockSha256: sbom.metadata.properties[1].value,
  };
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return { output, ...manifest };
}
