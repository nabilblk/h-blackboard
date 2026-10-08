import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import { Field } from "../ui/Field";
import { useApplication } from "./ApplicationProvider";
import { useState } from "react";

import type {
  ArtifactDetail,
  ArtifactDocument,
  ArtifactKind,
  ArtifactStage,
  MissionView,
  WorkstreamView,
} from "../application/contracts/node";
import type { Perform } from "./ui";
const logicalPath = (file: File) =>
  file.webkitRelativePath?.split("/").slice(1).join("/") || file.name;
export function ArtifactPublish({
  mission,
  detail,
  conversation,
  streams,
  busy,
  perform,
  done,
  cancel,
}: {
  mission: MissionView;
  detail: ArtifactDetail | null;
  conversation: string;
  streams: WorkstreamView[];
  busy: boolean;
  perform: Perform;
  done: (id: string) => Promise<void>;
  cancel: () => void;
}) {
  const { missions: node } = useApplication();
  const [control] = useState(mission.lifecycle.revision);
  const [parents] = useState(detail?.artifact.heads ?? []);
  const [files, setFiles] = useState<File[]>([]);
  const [retained, setRetained] = useState(
    detail?.document.files.map((f) => f.path) ?? [],
  );
  const [progress, setProgress] = useState("");
  const [channel, setChannel] = useState(
    detail?.artifact.conversation ?? conversation,
  );
  const existing = detail?.document;
  const choices = [...retained, ...files.map(logicalPath)];
  const [entrypoint, setEntrypoint] = useState(existing?.entrypoint ?? "");
  const preferred = choices.includes(entrypoint)
    ? entrypoint
    : (choices.find((p) => /\.html?$/i.test(p)) ?? choices[0] ?? "");
  const selectFiles = (list: FileList | null) => {
    const next = Array.from(list ?? []);
    setFiles(next);
    setRetained((old) =>
      old.filter((path) => !next.some((f) => logicalPath(f) === path)),
    );
  };
  return (
    <form
      className="n-fields n-artifact-publish"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const document: ArtifactDocument = {
          title: String(form.get("title")).trim(),
          summary: String(form.get("summary")).trim(),
          kind: String(form.get("kind")) as ArtifactKind,
          stage: String(form.get("stage")) as ArtifactStage,
          limitations: String(form.get("limitations")).trim(),
          entrypoint: String(form.get("entrypoint")) || null,
          inputs: String(form.get("inputs")).split(/\s+/).filter(Boolean),
          files: [],
        };
        void perform(async () => {
          const uploads: string[] = [];
          try {
            if (files.reduce((n, f) => n + f.size, 0) > 32 * 1024 * 1024)
              throw new Error("An artifact can contain up to 32 MiB of files.");
            for (const file of files) {
              if (file.size > 16 * 1024 * 1024)
                throw new Error("Each file can be up to 16 MiB.");
              const { upload } = await node.artifactTransfer(mission.id, {
                type: "begin",
                control,
                conversation: channel,
                path: logicalPath(file),
                media_type: file.type || "application/octet-stream",
                size: file.size,
              });
              if (!upload) throw new Error("File upload did not start.");
              uploads.push(upload);
              for (let offset = 0; offset < file.size; offset += 48 * 1024) {
                setProgress(
                  `Saving ${file.name} · ${Math.round((offset / file.size) * 100)}%`,
                );
                const bytes = new Uint8Array(
                  await file.slice(offset, offset + 48 * 1024).arrayBuffer(),
                );
                const hex = Array.from(bytes, (b) =>
                  b.toString(16).padStart(2, "0"),
                ).join("");
                await node.artifactTransfer(mission.id, {
                  type: "chunk",
                  upload,
                  offset,
                  hex,
                });
              }
            }
            setProgress("Publishing this revision…");
            const result = await node.artifactTransfer(mission.id, {
              type: "publish",
              control,
              conversation: channel,
              artifact: detail?.artifact.id ?? null,
              parents,
              document,
              uploads,
              retain: detail
                ? retained.map((path) => ({ revision: detail.revision, path }))
                : [],
            });
            if (!result.event)
              throw new Error(
                "Publication was not confirmed. Inspect the artifact list before retrying.",
              );
            await done(result.event);
          } finally {
            for (const upload of uploads)
              await node
                .artifactTransfer(mission.id, { type: "cancel", upload })
                .catch(() => {});
            setProgress("");
          }
        });
      }}
    >
      <h2>{detail ? "Publish a revision" : "Publish an artifact"}</h2>
      <p className="d-field-help">
        Save a usable output for this conversation. Publication, review and
        human acceptance stay separate.
      </p>
      {parents.length > 1 ? (
        <p className="d-alert">
          This revision will reconcile {parents.length} current versions. Review
          each before publishing.
        </p>
      ) : null}
      <Field>
        Title
        <input
          name="title"
          required
          maxLength={240}
          defaultValue={existing?.title}
        />
      </Field>
      <Field>
        What is this for?
        <textarea
          name="summary"
          required
          rows={2}
          maxLength={2048}
          defaultValue={existing?.summary}
          placeholder="A short description for the person opening it."
        />
      </Field>
      <div className="n-artifact-fields">
        <Field>
          Kind
          <select name="kind" defaultValue={existing?.kind ?? "report"}>
            {["application", "report", "plan", "data", "code", "document"].map(
              (k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ),
            )}
          </select>
        </Field>
        <Field>
          Stage
          <select name="stage" defaultValue={existing?.stage ?? "draft"}>
            <option value="draft">Draft</option>
            <option value="complete">Complete contribution</option>
          </select>
        </Field>
      </div>
      {!detail ? (
        <Field>
          Conversation
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="main">Main</option>
            {streams.map((s) => (
              <option key={s.id} value={`workstream:${s.id}`}>
                # {s.name}
              </option>
            ))}
            {conversation.startsWith("private:") ? (
              <option value={conversation}>This private conversation</option>
            ) : null}
          </select>
        </Field>
      ) : null}
      <Field>
        Files
        <input
          type="file"
          multiple
          onChange={(e) => selectFiles(e.target.files)}
        />
        <span className="d-field-help">
          Up to 32 files, 16 MiB each, 32 MiB total. HTML should include its
          assets and work offline.
        </span>
      </Field>
      <Field>
        Or choose an application folder
        <input
          type="file"
          multiple
          {...{ webkitdirectory: "" }}
          onChange={(e) => selectFiles(e.target.files)}
        />
        <span className="d-field-help">
          Relative asset paths are preserved. Select a built, offline
          application, not a source repository.
        </span>
      </Field>
      {files.length ? (
        <p className="d-field-help">{files.map(logicalPath).join(" · ")}</p>
      ) : null}
      {existing?.files.map((f) => (
        <label className="n-check" key={f.path}>
          <input
            type="checkbox"
            checked={retained.includes(f.path)}
            disabled={files.some((x) => logicalPath(x) === f.path)}
            onChange={(e) =>
              setRetained((old) =>
                e.target.checked
                  ? [...old, f.path]
                  : old.filter((p) => p !== f.path),
              )
            }
          />
          Keep {f.path}
        </label>
      ))}
      <Field>
        Open first
        <select
          name="entrypoint"
          value={preferred}
          onChange={(e) => setEntrypoint(e.target.value)}
        >
          <option value="">Choose a file</option>
          {choices.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        Limitations
        <textarea
          name="limitations"
          maxLength={4096}
          rows={3}
          defaultValue={existing?.limitations}
          placeholder="What remains incomplete or untested?"
        />
      </Field>
      <Disclosure title={<>Input revisions</>}>
        <Field>
          Exact revision references
          <textarea
            name="inputs"
            rows={2}
            defaultValue={existing?.inputs.join("\n")}
            placeholder="Copy revision references from the artifacts this output depends on."
          />
        </Field>
        <p className="d-field-help">
          A changed input flags this output for review.
        </p>
      </Disclosure>
      {progress ? <p role="status">{progress}</p> : null}
      {control !== mission.lifecycle.revision ? (
        <p className="d-alert">
          Mission instructions changed. Close this form and review them before
          publishing.
        </p>
      ) : null}
      <div className="n-action-row">
        <Button
          variant="primary"
          type="submit"
          disabled={
            busy || !choices.length || control !== mission.lifecycle.revision
          }
        >
          Publish
        </Button>
        <Button type="button" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
