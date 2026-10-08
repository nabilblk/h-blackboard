import type { ReactNode } from "react";

/** A labeled view selector. Uses normal buttons with pressed state because
 * panels may live elsewhere or mount on demand. Every option is tab-reachable;
 * arrows/Home/End additionally move and select within the group. */
export function ViewTabs<T extends string>({
  label,
  value,
  items,
  onChange,
  className = "",
}: {
  label: string;
  value: T;
  items: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <nav className={`hb-view-tabs ${className}`.trim()} aria-label={label}>
      {items.map((item, index) => (
        <button
          type="button"
          key={item.value}
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => {
            const target =
              event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index + items.length - 1) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : null;
            if (target === null) return;
            event.preventDefault();
            const buttons =
              event.currentTarget.parentElement?.querySelectorAll("button");
            buttons?.[target]?.focus();
            onChange(items[target].value);
          }}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
