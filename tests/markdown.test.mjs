import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let Text;
before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  ({ Text } = await vite.ssrLoadModule("/src/Markdown.tsx"));
});
after(async () => vite?.close());
const render = (value) => renderToStaticMarkup(createElement(Text, { value }));

test("An agent report renders headings, emphasis, and an aligned comparison table", () => {
  const html = render(`## Mission comparison

### Provisional ranking
All totals are **estimates**.

| Scenario | Total | Score |
| --- | ---: | ---: |
| **Option A** | $13,600 | 87 |
| Option B | $12,000 | 76 |`);
  assert.match(html, /<h2>Mission comparison<\/h2>/);
  assert.match(html, /<h3>Provisional ranking<\/h3>/);
  assert.match(html, /<strong>estimates<\/strong>/);
  assert.match(
    html,
    /role="region" aria-label="Scrollable table" tabindex="0"/,
  );
  assert.match(html, /<table><thead>/);
  assert.match(html, /<td style="text-align:right">87<\/td>/);
  assert.match(html, /<td><strong>Option A<\/strong><\/td>/);
});

test("Messages preserve line breaks, nested lists, checklists, quotes, and literal code", () => {
  const html = render(
    'First line\nSecond line\n\n> Shared constraint\n\n- Direction one\n  - Supporting evidence\n- Direction two\n\n- [x] Checked\n- [ ] Pending\n\nUse `context_read`.\n\n```html\n<script>alert("example")</script>\n```',
  );
  assert.match(html, /First line<br\/>\nSecond line/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<ul[^>]*>[\s\S]*<ul>/);
  assert.match(html, /type="checkbox" disabled="" checked=""/);
  assert.match(html, /<code>context_read<\/code>/);
  assert.match(
    html,
    /<pre tabindex="0" role="region" aria-label="Code block">/,
  );
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("Untrusted Markdown cannot inject HTML, executable URLs, or automatically loaded images", () => {
  const html = render(
    '[Unsafe](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n![Evidence image](https://example.test/tracker.png)\n\n[Source](https://example.test/source)',
  );
  assert.doesNotMatch(html, /<script|<img|onerror=|href="javascript:/i);
  assert.match(html, /<span>Unsafe<\/span>/);
  assert.match(html, /href="https:\/\/example.test\/tracker.png"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, />Source<\/a>/);
});

test("Footnotes keep unique references across messages and stay in the same tab", () => {
  const markdown = "A claim[^source].\n\n[^source]: Supporting evidence.";
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(Text, { value: markdown }),
      createElement(Text, { value: markdown }),
    ),
  );
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  // The visible reference and footnote are namespaced for each message.
  const refs = ids.filter((id) => id.includes("-fn"));
  assert.equal(refs.length, 4);
  assert.equal(new Set(refs).size, 4);
  for (const link of html.matchAll(/<a [^>]*href="#[^>]+>/g)) {
    assert.doesNotMatch(link[0], /target="_blank"/);
  }
});
