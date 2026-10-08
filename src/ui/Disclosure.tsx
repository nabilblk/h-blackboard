import type { DetailsHTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

type DisclosureProps = Omit<
  DetailsHTMLAttributes<HTMLDetailsElement>,
  "title"
> & {
  title: ReactNode;
  count?: number;
  variant?: "section" | "inline" | "sidebar";
};

/** Native disclosure semantics, one keyboard target, one shared visual system.
 * Children stay mounted so expanding a section never destroys a draft. */
export function Disclosure({
  title,
  count,
  variant = "section",
  className = "",
  children,
  ...props
}: DisclosureProps) {
  return (
    <details
      {...props}
      className={`hb-disclosure hb-disclosure--${variant} ${className}`.trim()}
    >
      <summary className="hb-disclosure-trigger">
        <ChevronRight
          className="hb-disclosure-chevron"
          size={14}
          aria-hidden="true"
        />
        <span className="hb-disclosure-title">{title}</span>
        {count != null ? <span className="hb-count">{count}</span> : null}
      </summary>
      <div className="hb-disclosure-content">{children}</div>
    </details>
  );
}
