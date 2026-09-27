import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildArtifact } from "../bin/artifact-build.mjs";
import { dataTable } from "../shared/artifact-preview.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "blackboard-artifact-build-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("Multi-file browser code, styles and imported assets become a functioning self-contained artifact", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "data.json"), JSON.stringify({ count: 4 }));
  await writeFile(
    join(dir, "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>',
  );
  await writeFile(
    join(dir, "styles.css"),
    'body { background: url("./logo.svg"); }',
  );
  await writeFile(
    join(dir, "main.ts"),
    'import data from "./data.json"; import "./styles.css"; document.getElementById("root").textContent = `For ${data.count} children: </script> is safe`;',
  );
  const result = await buildArtifact({
    entry: join(dir, "main.ts"),
    out: join(dir, "index.html"),
    title: "Families <script> & friends",
  });
  const html = await readFile(result.path, "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const element = { textContent: "" };
  runInNewContext(script, { document: { getElementById: () => element } });
  assert.equal(element.textContent, "For 4 children: </script> is safe");
  assert.match(html, /data:image\/svg\+xml/);
  assert.match(html, /Families &lt;script&gt; &amp; friends/);
  assert.match(html, /connect-src 'none'/);
  assert.equal(result.size, Buffer.byteLength(html));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});
test("The bundler rejects remote dependencies, missing files, oversized outputs and source overwrite", async (t) => {
  const dir = await fixture(t),
    entry = join(dir, "main.js"),
    out = join(dir, "index.html");
  await writeFile(entry, 'import "https://example.com/package.js";');
  await assert.rejects(buildArtifact({ entry, out }), /External resource/);
  await writeFile(entry, 'import "./missing.js";');
  await assert.rejects(buildArtifact({ entry, out }), /resolve/);
  await writeFile(
    entry,
    `document.title = ${JSON.stringify("x".repeat(2 * 1024 * 1024))};`,
  );
  await assert.rejects(buildArtifact({ entry, out }), /2 MiB/);
  await assert.rejects(buildArtifact({ entry, out: entry }), /distinct/);
});
test("Data previews preserve CSV quoting, Unicode and JSON keys while bounding the table", () => {
  assert.deepEqual(
    dataTable(
      'Name,Notes\r\n"Zoé","Line 1\nLine 2, said ""hello"""\r\n',
      "text/csv",
    ),
    {
      headers: ["Name", "Notes"],
      rows: [["Zoé", 'Line 1\nLine 2, said "hello"']],
      truncated: false,
    },
  );
  const json = dataTable(
    JSON.stringify([
      { name: "A", count: 0 },
      { name: "B", info: { checked: true } },
    ]),
    "application/json",
  );
  assert.deepEqual(json.headers, ["name", "count", "info"]);
  assert.deepEqual(json.rows, [
    ["A", "0", ""],
    ["B", "", '{"checked":true}'],
  ]);
  assert.equal(dataTable("x\n".repeat(102), "text/csv").truncated, true);
  assert.equal(dataTable('x\n"unterminated', "text/csv"), null);
  assert.equal(dataTable("not JSON", "application/json"), null);
});
