import type { LabelHTMLAttributes } from "react";

/** Wrapping label for a single control. Native label association, fonts and
 * spacing stay consistent without imposing state or a form library. */
export function Field({
  className = "",
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={`d-field ${className}`.trim()} />;
}
