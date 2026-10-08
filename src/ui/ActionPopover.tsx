import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./Button";

/** A group of ordinary action buttons, not an ARIA menu with hidden arrow-key
 * requirements. Tab, outside click and Escape retain their usual meanings. */
export function ActionPopover({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <div
      className={`hb-action-popover ${className}`.trim()}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Button
        ref={trigger}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      <div
        id={id}
        className="hb-action-popover-content"
        role="group"
        aria-label={label}
        hidden={!open}
        onClick={(event) => {
          if ((event.target as Element).closest("button:not(:disabled)"))
            setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
