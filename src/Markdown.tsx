import { createContext, memo, useContext, useId } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

const plugins = [remarkGfm, remarkBreaks];
// Preserve the stored source. Only plain-text technical identifiers receive a
// compact presentation; code blocks, link destinations and labels stay exact.
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
function readableReferences() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["code", "inlineCode", "link"].includes(node.type))
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        return child.value
          .split(/(\b[a-f0-9]{64}\b)/g)
          .filter(Boolean)
          .map((value) => ({
            type: /^[a-f0-9]{64}$/.test(value) ? "inlineCode" : "text",
            value,
          }));
      });
    };
    visit(tree);
  };
}
const conversationPlugins = [...plugins, readableReferences];
const MarkdownId = createContext("");
const LinkMode = createContext<"links" | "text">("links");
export type ReferenceKind =
  "artifact" | "agent" | "task" | "workstream" | "message" | "thread";
const ReferenceAction = createContext<
  ((kind: ReferenceKind, id: string) => void) | undefined
>(undefined);
const referencePattern =
  /^harakiri:\/\/(artifact|agent|task|workstream|message|thread)\/([a-f0-9]{64})$/;
const safeUrl = (url: string) =>
  referencePattern.test(url) ? url : defaultUrlTransform(url);
const components: Components = {
  code: function MarkdownCode({ node: _node, children, ...props }) {
    const mode = useContext(LinkMode);
    const value = String(children);
    return mode === "text" && /^[a-f0-9]{64}$/.test(value) ? (
      <code {...props} title={`Technical reference: ${value}`}>
        {value.slice(0, 8)}…{value.slice(-4)}
      </code>
    ) : (
      <code {...props}>{children}</code>
    );
  },
  a: function MarkdownLink({ node: _node, href, children, ...props }) {
    const id = useContext(MarkdownId);
    const mode = useContext(LinkMode);
    const open = useContext(ReferenceAction);
    const reference = href?.match(referencePattern);
    if (reference)
      return open ? (
        <button
          type="button"
          className="markdown-reference"
          onClick={() => open(reference[1] as ReferenceKind, reference[2])}
        >
          {children}
        </button>
      ) : (
        <span title={href}>{children}</span>
      );
    if (mode === "text" && href && !href.startsWith("#"))
      return <span title={href}>{children}</span>;
    return href ? (
      <a
        {...props}
        aria-describedby={
          props["aria-describedby"] === "footnote-label"
            ? `${id}-footnote-label`
            : props["aria-describedby"]
        }
        href={href}
        target={href.startsWith("#") ? undefined : "_blank"}
        rel="noopener noreferrer"
        onClick={(event) => {
          // Footnotes stay inside the conversation. The application uses the
          // location hash to select a mission, so ordinary anchor navigation
          // would otherwise switch channels.
          if (href.startsWith("#")) {
            event.preventDefault();
            document
              .getElementById(href.slice(1))
              ?.scrollIntoView({ block: "nearest" });
          }
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  h2: function MarkdownHeading({ node: _node, id, ...props }) {
    const prefix = useContext(MarkdownId);
    return (
      <h2
        {...props}
        id={id === "footnote-label" ? `${prefix}-footnote-label` : id}
      />
    );
  },
  table: ({ children }) => (
    <div
      className="markdown-table"
      role="region"
      aria-label="Scrollable table"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => (
    <pre tabIndex={0} role="region" aria-label="Code block">
      {children}
    </pre>
  ),
  // Keep externally hosted images as explicit links rather than fetching
  // arbitrary URLs whenever an agent's message enters the viewport.
  img: function MarkdownImage({ src, alt }) {
    const mode = useContext(LinkMode);
    if (mode === "text")
      return (
        <span>
          {alt || "Image"}
          {typeof src === "string" && src ? (
            <>
              {" "}
              (<code>{src}</code>)
            </>
          ) : null}
        </span>
      );
    return typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || "View image"}
      </a>
    ) : (
      <span>{alt}</span>
    );
  },
};

// Live context updates are frequent; parse a message again only when its text
// actually changes. The stored Markdown remains the editable source of truth.
export const Text = memo(function Text({
  value,
  links = "links",
  onReference,
}: {
  value: string;
  links?: "links" | "text";
  onReference?: (kind: ReferenceKind, id: string) => void;
}) {
  const id = useId();
  return (
    <div className="reading">
      <LinkMode.Provider value={links}>
        <ReferenceAction.Provider value={onReference}>
          <MarkdownId.Provider value={id}>
            <Markdown
              remarkPlugins={links === "text" ? conversationPlugins : plugins}
              remarkRehypeOptions={{ clobberPrefix: `${id}-` }}
              components={components}
              skipHtml
              urlTransform={safeUrl}
            >
              {value}
            </Markdown>
          </MarkdownId.Provider>
        </ReferenceAction.Provider>
      </LinkMode.Provider>
    </div>
  );
});
