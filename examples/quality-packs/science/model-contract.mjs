// A tiny executable example; use subject-specific models and scene adapters.
export const contractVersion = 1;
export function numericInput(value, { min, max, label, unit }) {
  if (typeof value !== "number" || !Number.isFinite(value))
    return {
      ok: false,
      feedback: `${label} must be a finite number (${unit}).`,
    };
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
    throw new Error("Invalid model bounds");
  if (value < min || value > max)
    return {
      ok: false,
      feedback: `${label} must be between ${min} and ${max} ${unit}.`,
    };
  return { ok: true, value };
}
export function averageSpeed({ distance, time }) {
  const d = numericInput(distance, {
    min: 0,
    max: 1000,
    label: "Distance",
    unit: "m",
  });
  const t = numericInput(time, { min: 0, max: 3600, label: "Time", unit: "s" });
  const invalid = !d.ok
    ? d.feedback
    : !t.ok
      ? t.feedback
      : time === 0
        ? "Choose a time greater than zero to calculate average speed."
        : !Number.isFinite(distance / time)
          ? "This time is too small to give a finite reading. Choose a measurable interval."
          : null;
  if (invalid)
    return {
      status: "invalid",
      feedback: invalid,
      readings: [{ label: "Average speed", unit: "m/s", value: null }],
      scene: null,
    };
  return {
    status: "ready",
    feedback: `${distance} metres travelled in ${time} seconds. This is average speed, not a claim of constant instantaneous speed.`,
    readings: [{ label: "Average speed", unit: "m/s", value: distance / time }],
    scene: { distance, time },
  };
}
export function readingText(reading) {
  return `${reading.label}: ${!Number.isFinite(reading.value) ? "not available" : `${reading.value} ${reading.unit}`}`;
}
