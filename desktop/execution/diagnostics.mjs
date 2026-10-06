// Deliberate allowlist, not redaction of arbitrary provider prose. This export
// can be shared without including prompts, logs, paths, identities or auth codes.
const states = new Set([
  "preparing",
  "login_required",
  "ready",
  "reserving",
  "launching",
  "running",
  "waiting",
  "stopping",
  "stopped",
  "recovery_required",
  "failed",
]);
const stateName = (value) => (states.has(value) ? value : "unknown");
const time = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
export function executionDiagnostics(state) {
  return {
    schema: 1,
    observedAt: time(state.observedAt),
    observationAvailable: !state.error,
    status: stateName(state.record?.status),
    savedSession: !!state.record?.session,
    capacity: Number.isSafeInteger(state.capacity) ? state.capacity : null,
    authentication: [
      "starting",
      "waiting",
      "complete",
      "failed",
      "cancelled",
    ].includes(state.authentication?.status)
      ? state.authentication.status
      : null,
    authenticationFailure: ["expired", "denied", "connection"].includes(
      state.authentication?.failure,
    )
      ? state.authentication.failure
      : null,
    transitions: (state.record?.transitions ?? []).slice(-80).map((t) => ({
      at: time(t.at),
      from: stateName(t.from),
      to: stateName(t.to),
    })),
  };
}
