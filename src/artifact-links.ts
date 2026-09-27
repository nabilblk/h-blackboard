import type { ArtifactRevision } from "./resources";

export const artifactHref = (
  channelId: string,
  artifactId: string,
  revisionId?: string,
) =>
  `/artifacts/${encodeURIComponent(channelId)}/${encodeURIComponent(artifactId)}${revisionId ? `?revision=${encodeURIComponent(revisionId)}` : ""}`;

export function primaryFile(revision: ArtifactRevision) {
  return (
    revision.files.find((f) => f.name === revision.entrypoint) ||
    revision.files.find(
      (f) => f.name === "index.html" && f.mediaType === "text/html",
    ) ||
    revision.files.find((f) => f.mediaType === "text/html") ||
    revision.files.find((f) => f.mediaType === "text/markdown") ||
    revision.files[0]
  );
}

export function artifactAction(revision: ArtifactRevision) {
  const type = primaryFile(revision)?.mediaType;
  if (type === "text/html") return "Open app";
  if (
    type === "text/markdown" ||
    revision.kind === "report" ||
    revision.kind === "plan"
  )
    return "Read";
  if (revision.kind === "data") return "Preview data";
  return "View files";
}

export const artifactKinds: Record<string, string> = {
  application: "Application",
  report: "Report",
  plan: "Plan",
  code: "Code",
  data: "Data",
  validation: "Validation",
  other: "Other",
};
export const reviewLabels = {
  unreviewed: "Not reviewed",
  self_reviewed: "Self-reviewed",
  verified: "Verified",
  changes_requested: "Changes requested",
  inconclusive: "Inconclusive review",
  needs_recheck: "Needs recheck",
};
