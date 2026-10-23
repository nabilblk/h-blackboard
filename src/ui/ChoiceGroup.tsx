import { useId } from "react";

/** Native radios retain keyboard behavior, form semantics and accessible names. */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="hb-choice-group" disabled={disabled}>
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <label
            key={option.value}
            className="hb-choice"
            data-selected={value === option.value}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
