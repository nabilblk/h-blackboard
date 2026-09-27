import { Badge } from "./ui";
import { reviewLabels } from "./artifact-links";
import type { ArtifactRevision } from "./resources";

export function ArtifactStatus({ revision }: { revision: ArtifactRevision }) {
  const status = revision.stale
    ? "needs_recheck"
    : revision.assessment?.status || "unreviewed";
  return (
    <span className="artifact-status">
      {revision.outcome === "draft" ? <Badge>Draft</Badge> : null}
      {revision.outcome === "inconclusive" ? (
        <Badge tone="warning">Inconclusive result</Badge>
      ) : null}
      <Badge
        tone={
          status === "verified"
            ? "success"
            : status === "changes_requested"
              ? "danger"
              : status === "needs_recheck" || status === "inconclusive"
                ? "warning"
                : ""
        }
      >
        {reviewLabels[status]}
      </Badge>
      {revision.assessment?.accepted && !revision.stale ? (
        <Badge tone="success">Human accepted</Badge>
      ) : null}
    </span>
  );
}
