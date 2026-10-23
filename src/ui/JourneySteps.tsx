/** Read-only orientation; reaching a step never grants approval or starts work. */
export function JourneySteps({
  steps,
  current,
  label,
}: {
  steps: string[];
  current: number;
  label: string;
}) {
  return (
    <ol className="hb-journey-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li
          key={step}
          aria-current={index === current ? "step" : undefined}
          data-past={index < current}
        >
          <span aria-hidden="true">{index + 1}</span>
          {step}
        </li>
      ))}
    </ol>
  );
}
