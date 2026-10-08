import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { parsers } from "prettier/plugins/typescript";

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory()
          ? sources(path)
          : /\.(ts|tsx)$/.test(path)
            ? [path]
            : [];
      }),
    )
  ).flat();
}

function visit(node, check) {
  if (!node || typeof node !== "object") return;
  if (node.type) check(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "range", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => visit(item, check));
    else visit(value, check);
  }
}

test("frontend boundaries: screens use application ports; components have no application dependency", async () => {
  for (const directory of ["src/desktop", "src/ui", "src/application"]) {
    for (const file of await sources(directory)) {
      // This is the one composition root: selecting a host is its job.
      if (file === resolve("src/desktop/main.tsx")) continue;
      const ast = await parsers.typescript.parse(await readFile(file, "utf8"), {
        jsx: true,
      });
      visit(ast, (node) => {
        if (
          [
            "ImportDeclaration",
            "ExportNamedDeclaration",
            "ExportAllDeclaration",
          ].includes(node.type) &&
          node.source
        ) {
          const from = node.source.value;
          assert.ok(
            !/^(node:|electron$)/.test(from),
            `${file}: native import ${from}`,
          );
          assert.ok(
            !/(^|\/)platform\//.test(from),
            `${file}: platform import ${from}`,
          );
          const target = from.startsWith(".")
            ? resolve(file, "..", from)
            : from;
          for (const backend of ["desktop", "server", "crates"]) {
            assert.ok(
              !target.startsWith(resolve(backend) + "/"),
              `${file}: backend implementation import ${from}`,
            );
          }
          if (directory === "src/ui") {
            assert.ok(
              !/(application|desktop|shared)/.test(from),
              `${file}: components cannot depend on mission/application code`,
            );
          }
          if (directory === "src/application") {
            assert.ok(
              from.startsWith("."),
              `${file}: application contracts cannot depend on a framework`,
            );
          }
        }
        if (node.type === "MemberExpression" && node.object.name === "window") {
          const property = node.property.name ?? node.property.value;
          assert.ok(
            !/^(contributor|blackboard|electron)/.test(property),
            `${file}: direct native bridge access`,
          );
        }
        if (directory === "src/desktop" && node.type === "JSXOpeningElement") {
          assert.ok(
            !["details", "summary"].includes(node.name.name),
            `${file}: use the shared Disclosure/ActionPopover`,
          );
        }
      });
    }
  }
});

test("Electron adapter preserves exact commands, errors and independent clients without browser globals", async () => {
  const { outputFiles } = await build({
    entryPoints: ["src/platform/electron/client.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { createElectronClient } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
  const calls = [];
  const failure = new Error("Revision changed; review the current plan.");
  const first = createElectronClient({
    contributor: { state: async () => "workspace A" },
    blackboardNode: {
      startMission: async (...args) => {
        calls.push(args);
        throw failure;
      },
    },
    blackboardExecution: {
      stop: async (id) => {
        calls.push(["stop", id]);
      },
    },
    blackboardSetup: {},
  });
  const second = createElectronClient({
    contributor: { state: async () => "workspace B" },
    blackboardNode: {},
    blackboardExecution: {},
    blackboardSetup: {},
  });
  assert.equal(await first.workspace.state(), "workspace A");
  assert.equal(await second.workspace.state(), "workspace B");
  await assert.rejects(
    first.missions.startMission(
      "mission",
      "exact-revision",
      "signed-readiness",
    ),
    (error) => error === failure,
  );
  await first.execution.stop("local-contribution");
  assert.deepEqual(calls, [
    ["mission", "exact-revision", "signed-readiness"],
    ["stop", "local-contribution"],
  ]);
  assert.ok(Object.isFrozen(first));
});
