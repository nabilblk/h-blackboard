import { z } from "zod";

const selector = z.string().min(1).max(300);
export const ArtifactBrowserRequest = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    path: z
      .string()
      .min(1)
      .max(240)
      .regex(/\.html?$/i),
    width: z.number().int().min(320).max(1440),
    height: z.number().int().min(400).max(1000),
    reducedMotion: z.boolean().default(false),
    disableWebgl: z.boolean().default(false),
    steps: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("click"), selector }).strict(),
          z
            .object({
              type: z.literal("fill"),
              selector,
              value: z.string().max(1000),
            })
            .strict(),
          z
            .object({
              type: z.literal("select"),
              selector,
              value: z.string().max(1000),
            })
            .strict(),
          z
            .object({
              type: z.literal("press"),
              key: z.enum([
                "Tab",
                "Enter",
                "Space",
                "Escape",
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
              ]),
            })
            .strict(),
          z
            .object({
              type: z.literal("wait"),
              milliseconds: z.number().int().min(0).max(1000),
            })
            .strict(),
        ]),
      )
      .max(8),
  })
  .strict();

// Input is serialized only as data in a trusted fixed script, executed in an
// isolated JS world. No caller-supplied JavaScript or arbitrary URL is accepted.
export function interactionScript(step) {
  return `(() => {
    const step = ${JSON.stringify(step)};
    const el = document.querySelector(step.selector);
    if (!el) return {ok:false, reason:"Element not found", selector:step.selector};
    if (!el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}) || el.disabled || getComputedStyle(el).pointerEvents === "none")
      return {ok:false,reason:"Element is not currently interactive",selector:step.selector};
    el.scrollIntoView({block:"center"}); el.focus();
    if(step.type === "click") el.click();
    else {
      if(!["INPUT","TEXTAREA","SELECT"].includes(el.tagName) || el.readOnly) return {ok:false,reason:"Element cannot accept a value"};
      el.value = step.value;
      el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
    }
    return {ok:true, selector:step.selector, value:el.value ?? null};
  })()`;
}

export const browserObservation = `(() => ({
  title: document.title,
  text: (document.body?.innerText || "").slice(0,12000),
  controls: Array.from(document.querySelectorAll("button,input,select,textarea,a[href]")).slice(0,60).map(el => ({
    tag:el.tagName, id:el.id, type:el.type ?? null,
    label:el.getAttribute("aria-label") || el.innerText?.slice(0,120) || el.labels?.[0]?.innerText?.slice(0,120) || "",
    value:el.value ?? null, disabled:!!el.disabled,
  })),
  focus: document.activeElement?.id || document.activeElement?.tagName,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  viewport: {width:innerWidth,height:innerHeight},
}))()`;
