import type { ReactNode } from "react";
import brandMark from "../../public/favicon.svg?url";

export type Perform = (operation: () => Promise<void>) => Promise<boolean>;
export const date = (input: string) =>
  new Date(input).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export { Status } from "../ui/Status";
export function Heading({
  section,
  title,
  children,
  action,
}: {
  section: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="d-heading">
      <div>
        <div className="d-label">{section}</div>
        <h1>{title}</h1>
        {children ? <p>{children}</p> : null}
      </div>
      {action}
    </header>
  );
}
export function Brand() {
  return (
    <div className="d-brand" aria-label="Harakiri">
      <img src={brandMark} width="25" height="25" alt="" />
      <span>
        HARA<span className="d-slash">/</span>KIRI
      </span>
    </div>
  );
}
