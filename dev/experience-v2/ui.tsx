import {
  useLayoutEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { ArrowUpRight, X, ChevronDown } from "lucide-react";

export function Button({
  primary,
  quiet,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      className={`v-button ${primary ? "primary" : ""} ${quiet ? "quiet" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      className={`v-icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "progress";
}) {
  return (
    <span className={`v-tag ${tone}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}
export function Avatar({
  name,
  coordinator = false,
  small = false,
}: {
  name: string;
  coordinator?: boolean;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`v-avatar ${coordinator ? "coordinator" : ""} ${small ? "small" : ""}`}
    >
      {name === "You" ? "Y" : name.slice(0, 1)}
    </span>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="v-page-title">
      <div>
        {eyebrow ? <p className="v-label">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </header>
  );
}
export function Details({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="v-details">
      <summary>
        <ChevronDown size={16} />
        {title}
      </summary>
      <div>{children}</div>
    </details>
  );
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId(),
    closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="v-modal"
      aria-labelledby={id}
      onCancel={() => closeRef.current()}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <IconButton label="Close dialog" onClick={close}>
          <X size={20} />
        </IconButton>
      </header>
      <div className="v-modal-body">{children}</div>
    </dialog>
  );
}
export function PreviewLink({
  children = "Open timetable",
}: {
  children?: ReactNode;
}) {
  return (
    <a className="v-button" href="/#preview" target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={16} />
    </a>
  );
}
