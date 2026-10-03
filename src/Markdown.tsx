import { createContext, memo, useContext, useId } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

const plugins = [remarkGfm, remarkBreaks];
const MarkdownId = createContext("");
const LinkMode = createContext<"links" | "text">("links");
const components: Components = {
  a: function MarkdownLink({ node: _node, href, children, ...props }) {
    const id = useContext(MarkdownId);
    const mode = useContext(LinkMode);
    if (mode === "text" && href && !href.startsWith("#"))
      return (
        <span>
          {children} (<code>{href}</code>)
        </span>
      );
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
}: {
  value: string;
  links?: "links" | "text";
}) {
  const id = useId();
  return (
    <div className="reading">
      <LinkMode.Provider value={links}>
        <MarkdownId.Provider value={id}>
          <Markdown
            remarkPlugins={plugins}
            remarkRehypeOptions={{ clobberPrefix: `${id}-` }}
            components={components}
            skipHtml
          >
            {value}
          </Markdown>
        </MarkdownId.Provider>
      </LinkMode.Provider>
    </div>
  );
});
