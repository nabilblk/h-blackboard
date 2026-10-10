import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";

/** Readable editable prose: expand to the content until the CSS height limit,
 * then scroll inside the control. No transport or application state. */
export function GrowingTextarea({
  className = "",
  ...props
}: ComponentPropsWithoutRef<"textarea">) {
  const control = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = control.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [props.value]);
  useLayoutEffect(() => {
    const element = control.current;
    if (!element) return;
    let width = element.clientWidth;
    const resize = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  return (
    <textarea
      {...props}
      ref={control}
      className={`hb-growing-textarea ${className}`.trim()}
    />
  );
}
