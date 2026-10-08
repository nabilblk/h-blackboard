import type { ReactNode } from "react";
export function Status({
  children,
  muted = false,
  tone = "neutral",
}: {
  children: ReactNode;
  muted?: boolean;
  tone?: "neutral" | "success" | "progress" | "warning" | "danger";
}) {
  return (
    <span className="d-status" data-tone={muted ? "neutral" : tone}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}
