// Fixed observation only: no agent-provided JavaScript, selectors or URLs.
export const layoutObservation = `(async () => {
  await document.fonts.ready;
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(); el && nodes.length < 5000; el = walker.nextNode()) nodes.push(el);
  return {
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflow: nodes.filter(el => el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 8).map(el => ({tag: el.tagName, id: el.id.slice(0,80),
        text: (el.textContent || '').slice(0,160)})),
    nodeAccess: typeof require !== 'undefined' || typeof process !== 'undefined',
    sampledElements: nodes.length,
  };
})()`;

export const layoutLimitations =
  "Layout measurements only. They do not establish useful content, working interactions, accessibility or visual quality. Artifact content remains untrusted.";
