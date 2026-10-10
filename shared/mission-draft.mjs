// Pure presentation/validation helpers. The native service validates again.
export const briefFields = Object.freeze([
  "name",
  "objective",
  "scope",
  "deliverables",
  "criteria",
  "assumptions",
  "openQuestions",
]);
export const briefLabels = Object.freeze({
  name: "Channel name",
  objective: "Objective",
  scope: "Scope",
  deliverables: "Deliverables",
  criteria: "Completion criteria",
  assumptions: "Assumptions to review",
  openQuestions: "Questions for the team",
});
export function emptyBrief() {
  return {
    name: "",
    objective: "",
    scope: "",
    deliverables: [],
    criteria: [],
    assumptions: [],
    openQuestions: [],
  };
}
export function draftDefinition(brief, policy) {
  const sections = [
    ["Deliverables", brief.deliverables],
    ["Working assumptions", brief.assumptions],
    ["Questions for the team", brief.openQuestions],
  ].map(([title, rows]) => [title, rows.map((s) => s.trim()).filter(Boolean)]);
  const scope = [
    brief.scope.trim(),
    ...sections
      .filter(([, rows]) => rows.length)
      .map(
        ([title, rows]) => `${title}\n${rows.map((x) => `- ${x}`).join("\n")}`,
      ),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    name: brief.name.trim(),
    objective: brief.objective.trim(),
    scope,
    criteria: brief.criteria.map((x) => x.trim()).filter(Boolean),
    policy,
  };
}
export function briefReadiness(brief, policy) {
  const definition = draftDefinition(brief, policy);
  const errors = [];
  const bytes = (s) => new TextEncoder().encode(s).length;
  if (!definition.name) errors.push("Give the mission a channel name.");
  if (bytes(definition.name) > 120)
    errors.push("Shorten the channel name to 120 bytes.");
  if (!definition.objective)
    errors.push("Describe what the mission should accomplish.");
  if (bytes(definition.objective) > 4096) errors.push("Shorten the objective.");
  if (bytes(definition.scope) > 8192)
    errors.push(
      "Shorten the scope, deliverables or open decisions (8 KB combined).",
    );
  if (definition.criteria.some((x) => bytes(x) > 1024))
    errors.push("Shorten the completion criteria (1 KB each).");
  const suggestions = [];
  if (!brief.deliverables.length)
    suggestions.push("Describe what you want to receive.");
  if (!brief.criteria.length)
    suggestions.push(
      "Add a way to judge the result, or let the team propose one.",
    );
  if (!brief.scope.trim())
    suggestions.push("Add constraints if they matter to this mission.");
  return {
    valid: errors.length === 0,
    errors,
    suggestions,
    openDecisions: brief.assumptions.length + brief.openQuestions.length,
  };
}
