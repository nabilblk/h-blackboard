// Real browser checks against the reusable catalogue. No native bridges or DB.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const evidence = resolve("var/desktop/component-system-2026-10-08");
const session = `hb-components-${process.pid}`;
const browser = async (...args) =>
  (
    await promisify(execFile)(
      "agent-browser",
      ["--session", session, ...args],
      { timeout: 20000 },
    )
  ).stdout;
const evaluate = async (code) => JSON.parse(await browser("eval", code));
const server = await createServer({
  configFile: "vite.ui.config.mjs",
  server: { port: 0, strictPort: false },
});
try {
  await mkdir(evidence, { recursive: true });
  await server.listen();
  const port = server.httpServer.address().port;
  await browser("set", "viewport", "1280", "1000");
  await browser("open", `http://127.0.0.1:${port}`);
  await browser("wait", "--fn", "!!document.querySelector('.hb-disclosure')");
  assert.equal(await evaluate("typeof window.blackboardNode"), "undefined");
  const selector = ".hb-disclosure--sidebar > summary";
  await browser("focus", selector);
  await browser("press", "Enter");
  assert.equal(
    await evaluate("document.querySelector('.hb-disclosure--sidebar').open"),
    true,
  );
  const styles = await evaluate(
    `(() => {const el=document.querySelector('${selector}'); const s=getComputedStyle(el); return {height:el.getBoundingClientRect().height, list:s.listStyleType,font:s.fontFamily,focus:s.outlineStyle,count:el.querySelector('.hb-count').textContent}})()`,
  );
  assert.ok(styles.height >= 36);
  assert.equal(styles.list, "none");
  assert.match(styles.font, /IBM Plex Sans/);
  assert.equal(styles.focus, "solid");
  assert.equal(styles.count, "3");
  assert.equal(
    await evaluate(
      "document.querySelector('.d-button[data-size=compact]').getBoundingClientRect().height",
    ),
    28,
  );
  await browser("press", "Space");
  assert.equal(
    await evaluate("document.querySelector('.hb-disclosure--sidebar').open"),
    false,
  );
  // Drafts survive collapse, reopen and unrelated view changes.
  const settings =
    ".catalog-section:first-child > details:nth-of-type(1) > summary";
  await browser("click", settings);
  await browser(
    "fill",
    "textarea[placeholder='Describe the direction…']",
    "Keep this direction.",
  );
  await browser("click", settings);
  await browser("click", settings);
  assert.equal(
    await evaluate(
      "document.querySelector('textarea[placeholder=\"Describe the direction…\"]').value",
    ),
    "Keep this direction.",
  );
  await browser("focus", ".hb-view-tabs button:first-child");
  await browser("press", "End");
  assert.equal(
    await evaluate("document.activeElement.textContent"),
    "Technical",
  );
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-pressed')"),
    "true",
  );
  await browser("press", "ArrowRight");
  assert.equal(
    await evaluate("document.activeElement.textContent"),
    "Overview",
  );
  await browser("click", ".hb-action-popover > button");
  await browser("press", "Tab");
  assert.equal(
    await evaluate("document.activeElement.textContent"),
    "Mission details",
  );
  await browser("press", "Escape");
  assert.equal(
    await evaluate(
      "document.querySelector('.hb-action-popover > button').getAttribute('aria-expanded')",
    ),
    "false",
  );
  assert.equal(
    await evaluate("document.activeElement.textContent.trim()"),
    "More",
  );
  await browser("click", ".hb-action-popover > button");
  await browser("click", "h1");
  assert.equal(
    await evaluate(
      "document.querySelector('.hb-action-popover > button').getAttribute('aria-expanded')",
    ),
    "false",
  );
  await browser("click", ".hb-action-popover > button");
  await browser("click", ".hb-action-popover-content button:last-child");
  assert.match(
    await evaluate("document.querySelector('[role=status]').textContent"),
    /Budget selected/,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.hb-action-popover-content').hidden",
    ),
    true,
  );
  await browser("fill", "input[name=mission-name]", "A component example");
  await browser("scrollintoview", "button[type=submit]");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Save example",
    "--exact",
  );
  assert.match(
    await evaluate("document.querySelector('[role=status]').textContent"),
    /Form submitted/,
  );
  await browser("scroll", "up", "2000");
  await browser(
    "screenshot",
    "--full",
    resolve(evidence, "component-catalogue.png"),
  );
  for (const width of [500, 390]) {
    await browser("set", "viewport", String(width), "1000");
    await browser("click", selector);
    assert.equal(
      await evaluate("document.documentElement.scrollWidth > innerWidth"),
      false,
      `no page overflow at ${width}`,
    );
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('.hb-disclosure-trigger')].some(e=>e.scrollWidth>e.clientWidth)",
      ),
      false,
      `no clipped disclosure label at ${width}`,
    );
    await browser(
      "screenshot",
      "--full",
      resolve(evidence, `component-catalogue-${width}.png`),
    );
  }
  await writeFile(
    resolve(evidence, "components.json"),
    JSON.stringify(
      {
        passed: true,
        styles,
        checks: [
          "isolated UI",
          "keyboard disclosure",
          "visible focus",
          "draft preservation",
          "view keyboard navigation",
          "popover Tab/Escape/outside/action",
          "form submission",
          "500px/390px overflow",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "Component interactions, focus, draft preservation and responsive layouts passed.",
  );
} finally {
  await browser("close").catch(() => {});
  await server.close();
}
