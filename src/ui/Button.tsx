import type { ComponentPropsWithRef } from "react";

type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "secondary" | "primary" | "danger";
  size?: "default" | "compact";
};

export function Button({
  variant = "secondary",
  size = "default",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      data-size={size}
      className={`d-button ${variant === "secondary" ? "" : variant} ${className}`.trim()}
    />
  );
}

export function IconButton({
  className = "",
  type = "button",
  ...props
}: ComponentPropsWithRef<"button"> & { "aria-label": string }) {
  return (
    <button {...props} type={type} className={`d-icon ${className}`.trim()} />
  );
}
