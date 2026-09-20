import { createContext, memo, useContext, useId } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

const plugins = [remarkGfm, remarkBreaks];
const MarkdownId = createContext("");
const components: Components = {
  a: function MarkdownLink({ node: _node, href, children, ...props }) {
    const id = useContext(MarkdownId);
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
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || "View image"}
      </a>
    ) : (
      <span>{alt}</span>
    ),
};

// Live context updates are frequent; parse a message again only when its text
// actually changes. The stored Markdown remains the editable source of truth.
export const Text = memo(function Text({ value }: { value: string }) {
  const id = useId();
  return (
    <div className="reading">
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
    </div>
  );
});
