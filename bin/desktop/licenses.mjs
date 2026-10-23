// Inventory what the two bundlers actually include, rather than maintaining a
// hand-written list that silently misses Markdown and other transitive code.
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";
export async function writeBundledInventory({ root, output, modules }) {
  const lockBytes = await readFile(join(root, "package-lock.json"));
  const lock = JSON.parse(lockBytes),
    directories = new Set();
  for (const input of modules) {
    const path = resolve(root, input.split("?")[0]);
    const index = path.lastIndexOf("/node_modules/");
    if (index < 0) continue;
    const rest = path.slice(index + 14).split("/");
    const count = rest[0].startsWith("@") ? 2 : 1;
    directories.add(path.slice(0, index + 14) + rest.slice(0, count).join("/"));
  }
  const components = [],
    notices = [],
    missing = [];
  for (const directory of [...directories].sort()) {
    const pkg = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const files = (await readdir(directory))
      .filter((f) =>
        /^(license|licence|notice|copying|copyright)([._-]|$)/i.test(f),
      )
      .sort();
    let count = 0;
    for (const name of files) {
      const path = join(directory, name),
        info = await stat(path);
      if (!info.isFile() || info.size > 1024 * 1024) continue;
      notices.push(
        `${pkg.name} ${pkg.version} — ${name}\n${await readFile(path, "utf8")}`,
      );
      count++;
    }
    if (!count) missing.push(`${pkg.name}@${pkg.version}`);
    const entry = lock.packages[relative(root, directory)];
    components.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? null,
      integrity: entry?.integrity ?? null,
    });
  }
  const inventory = {
    version: 1,
    scope:
      "JavaScript and assets included by desktop renderer/host bundlers; Electron, Rust and downloaded VM runtimes have separate inventories",
    packageLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    components,
    missingLicenseTexts: missing,
  };
  await writeFile(
    join(output, "bundled-dependencies.json"),
    JSON.stringify(inventory, null, 2) + "\n",
  );
  await writeFile(
    join(output, "THIRD-PARTY-NOTICES.txt"),
    notices.join("\n\n---\n\n"),
  );
  return inventory;
}
