import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { rpc } from "./client";
import { Text } from "./ui";
import { primaryFile } from "./artifact-links";
import { dataTable, previewDocument } from "../shared/artifact-preview.mjs";
import type { ArtifactFile, ArtifactRevision } from "./resources";

export function ArtifactFiles({
  revision,
  channelId,
  fullPage = false,
}: {
  revision: ArtifactRevision;
  channelId: string;
  fullPage?: boolean;
}) {
  const [fileName, setFileName] = useState(primaryFile(revision).name);
  const [data, setData] = useState<{
    file: ArtifactFile;
    bytes: Uint8Array<ArrayBuffer>;
    source: string;
    image?: string;
  } | null>(null);
  const [error, setError] = useState(""),
    [sourceVisible, setSourceVisible] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    setSourceVisible(false);
    rpc<ArtifactFile & { content: string }>("artifact_file", {
      channel_id: channelId,
      revision_id: revision.id,
      name: fileName,
    })
      .then((file) => {
        if (!active) return;
        const bytes = Uint8Array.from(atob(file.content), (c) =>
          c.charCodeAt(0),
        );
        const source = new TextDecoder().decode(bytes);
        setData({
          file,
          bytes,
          source,
          image: /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(
            file.mediaType,
          )
            ? `data:${file.mediaType};base64,${file.content}`
            : undefined,
        });
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [channelId, revision.id, fileName]);
  const table = useMemo(
    () => (data ? dataTable(data.source, data.file.mediaType) : null),
    [data],
  );
  const html = useMemo(
    () =>
      data?.file.mediaType === "text/html" ? previewDocument(data.source) : "",
    [data],
  );
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([data.bytes], { type: "application/octet-stream" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = data.file.name.split("/").at(-1)!;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const isText =
    !!data &&
    (data.file.mediaType.startsWith("text/") ||
      /json|javascript|xml|yaml/.test(data.file.mediaType));
  return (
    <section
      className={`artifact-files ${fullPage ? "artifact-files-full" : ""}`}
      aria-label="Artifact content"
    >
      <div className="artifact-file-toolbar">
        <select
          aria-label="Artifact file"
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
        >
          {revision.files.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
        <div className="button-row">
          {isText ? (
            <button
              className="text-button"
              aria-pressed={sourceVisible}
              onClick={() => setSourceVisible((v) => !v)}
            >
              {sourceVisible ? "Preview" : "Source"}
            </button>
          ) : null}
          <button
            className="button compact"
            disabled={!data}
            onClick={download}
          >
            <Download size={14} />
            Download
          </button>
        </div>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p className="secondary" role="status">
          Loading file…
        </p>
      ) : (
        <>
          {html && !sourceVisible ? (
            <iframe
              title={`Preview: ${revision.title}`}
              className="artifact-preview"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={html}
            />
          ) : table && !sourceVisible ? (
            <div className="artifact-data">
              <table>
                <thead>
                  <tr>
                    {table.headers.map((h, i) => (
                      <th key={i} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {table.truncated ? (
                <p className="secondary">
                  Showing up to 100 rows and 20 columns. Download for the
                  complete data.
                </p>
              ) : null}
            </div>
          ) : data.file.mediaType === "text/markdown" &&
            data.bytes.length < 150000 &&
            !sourceVisible ? (
            <div className="artifact-content">
              <Text value={data.source} />
            </div>
          ) : data.image && !sourceVisible ? (
            <div className="artifact-image">
              <img src={data.image} alt={data.file.name} />
            </div>
          ) : isText ? (
            <pre className="artifact-source">
              {data.source.slice(0, 150000)}
              {data.source.length > 150000
                ? "\n… Preview truncated. Download the complete file."
                : ""}
            </pre>
          ) : (
            <p className="secondary">
              Download this file to open it in a compatible application.
            </p>
          )}
          {!fullPage ? (
            <details className="artifact-file-info">
              <summary>File information</summary>
              <p className="secondary">
                {data.file.mediaType} · {(data.file.size / 1024).toFixed(1)} KiB
              </p>
              <p className="mono secondary artifact-checksum">
                SHA-256 · {data.file.sha256}
              </p>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
