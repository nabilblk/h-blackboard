import { IconButton } from "../ui/Button";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export const PanelLayout = createContext<"inspector" | "page">("inspector");

export function ContextPanel(props: Parameters<typeof Inspector>[0]) {
  const layout = useContext(PanelLayout);
  const heading = useId();
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(props.close);
  closeRef.current = props.close;
  useEffect(() => {
    if (layout !== "page") return;
    const previous = document.activeElement as HTMLElement | null;
    const page = ref.current;
    page?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (
        page?.contains(document.activeElement) ||
        document.activeElement === document.body
      ) {
        const target =
          previous?.isConnected && previous.checkVisibility()
            ? previous
            : document.querySelector<HTMLElement>(".w-mission-tabs button");
        target?.focus({ preventScroll: true });
      }
    };
  }, [layout, props.title]);
  if (layout === "inspector") return <Inspector {...props} />;
  return (
    <section
      className="w-surface"
      ref={ref}
      tabIndex={-1}
      aria-labelledby={heading}
    >
      <header className="w-surface-title">
        <h2 id={heading}>{props.title}</h2>
        <IconButton aria-label={`Close ${props.title}`} onClick={props.close}>
          <X size={18} />
        </IconButton>
      </header>
      {props.error ? (
        <p className="d-alert" role="alert">
          {props.error}
        </p>
      ) : null}
      {props.children}
    </section>
  );
}

/** A docked, nonmodal inspector on desktop; a modal sheet on narrow windows.
 * The conversation remains mounted, preserving draft, selection and history. */
function Inspector({
  title,
  close,
  children,
  error,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const media = matchMedia("(max-width: 1100px)");
    const show = () => {
      const focused = dialog.contains(document.activeElement)
        ? (document.activeElement as HTMLElement)
        : null;
      dialog.close();
      if (media.matches) dialog.showModal();
      else dialog.show();
      dialog.setAttribute("aria-modal", String(media.matches));
      document.documentElement.classList.add("n-inspector-open");
      focused?.focus({ preventScroll: true });
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    show();
    media.addEventListener("change", show);
    document.addEventListener("keydown", key);
    return () => {
      media.removeEventListener("change", show);
      document.removeEventListener("keydown", key);
      // A user may have clicked another channel-header control while this
      // docked panel was open. Do not steal focus from that new destination.
      const restore =
        document.activeElement === document.body ||
        dialog.contains(document.activeElement);
      dialog.close();
      document.documentElement.classList.remove("n-inspector-open");
      if (restore) {
        // The summary's primary action moves into the inspector and may no
        // longer be mounted. Return to its stable status control in that case.
        const target = previous?.isConnected
          ? previous
          : document.querySelector<HTMLElement>(".n-summary-inspect");
        target?.focus({ preventScroll: true });
      }
    };
  }, []);
  return createPortal(
    <dialog
      className="n-context-panel"
      ref={ref}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <h2 id={heading}>{title}</h2>
        <IconButton onClick={close} aria-label={`Close ${title}`} autoFocus>
          <X size={20} />
        </IconButton>
      </header>
      <div className="n-context-body">
        {error ? (
          <p className="d-alert" role="alert">
            {error}
          </p>
        ) : null}
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
