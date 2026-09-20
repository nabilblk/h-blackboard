import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export { Text } from "./Markdown";
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <i />
      {children}
    </span>
  );
}
export function ModalFrame({
  title,
  label,
  children,
  close,
}: {
  title: string;
  label: string;
  children: ReactNode;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      className="dialog"
      ref={dialog}
      onCancel={close}
      aria-labelledby="dialog-title"
      onClick={(e) => {
        if (e.target === dialog.current) {
          const r = dialog.current!.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            close();
        }
      }}
    >
      <header className="dialog-heading">
        <span className="label">{label}</span>
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon"
          type="button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={16} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
export function Time({ at }: { at: number }) {
  return (
    <time
      title={new Date(at).toLocaleString()}
      dateTime={new Date(at).toISOString()}
    >
      {new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
export function Runtime({ runtime }: { runtime?: string }) {
  return (
    <span className={`runtime ${runtime === "claude" ? "filled" : ""}`}>
      {runtime === "claude" ? "CC" : runtime === "codex" ? "CX" : "YOU"}
    </span>
  );
}
