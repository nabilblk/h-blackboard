export const reviewMethods = {
  source_inspection: "Source inspection",
  executed_tests: "Executed tests",
  browser_check: "Browser checks",
  visual_inspection: "Visual inspection",
};

export function checksFromForm(data) {
  return Object.keys(reviewMethods).map((method) => ({
    method,
    result: String(data.get(`check_${method}`)),
    details: String(
      data.get(`details_${method}`) || "Not checked in this review.",
    ).trim(),
  }));
}

// Accept only complete copied references, never IDs extracted from prose. The
// native command still verifies the referenced records and their visibility.
export function reviewReferences(value) {
  const references = [];
  for (const line of value.split(/\r?\n/).map((line) => line.trim())) {
    if (!line) continue;
    const link =
      line.match(/^harakiri:\/\/(?:artifact|message)\/([a-f0-9]{64})$/) ??
      line.match(
        /^\[(?:[^\]\\]|\\.)*\]\(harakiri:\/\/(?:artifact|message)\/([a-f0-9]{64})\)$/,
      );
    const ids = link ? [link[1]] : line.split(/\s+/);
    if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
      throw new Error(
        "Paste a copied message or artifact reference on each line. Move descriptions, filenames and screenshot notes to Review or the check evidence fields, or leave linked records empty.",
      );
    references.push(...ids);
  }
  if (references.length > 16)
    throw new Error("Link at most 16 board records in one review.");
  if (new Set(references).size !== references.length)
    throw new Error(
      "A board record is linked more than once. Remove the repeated reference.",
    );
  return references;
}

export function reviewFromForm(revision, data) {
  return {
    type: "review",
    revision,
    verdict: String(data.get("verdict")),
    summary: String(data.get("summary")).trim(),
    conditions: String(data.get("conditions")).trim(),
    checks: checksFromForm(data),
    evidence: reviewReferences(String(data.get("evidence") || "")),
  };
}
