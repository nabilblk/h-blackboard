// Keep generated code in an opaque frame, with no network or parent privileges.
// The host document also denies frame navigations (frame-src 'none').
export const artifactCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
export const previewDocument = (source) =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${artifactCsp}">${source}`;

export function dataTable(source, mediaType) {
  const maxRows = 100,
    maxColumns = 20;
  if (source.length > 150000) return null;
  let rows,
    truncated = false;
  if (mediaType === "application/json") {
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      return null;
    }
    if (!Array.isArray(value) || !value.length) return null;
    if (
      value.every(
        (row) => row && typeof row === "object" && !Array.isArray(row),
      )
    ) {
      const keys = [...new Set(value.flatMap((row) => Object.keys(row)))];
      truncated = value.length > maxRows || keys.length > maxColumns;
      const columns = keys.slice(0, maxColumns);
      rows = [
        columns,
        ...value
          .slice(0, maxRows)
          .map((row) => columns.map((key) => row[key] ?? "")),
      ];
    } else if (value.every(Array.isArray)) rows = value;
    else return null;
  } else if (mediaType === "text/csv") {
    rows = [];
    let row = [],
      field = "",
      quoted = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '"') {
        if (quoted && source[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = !quoted;
      } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
        row.push(field);
        field = "";
        if (c !== ",") {
          rows.push(row);
          row = [];
          if (c === "\r" && source[i + 1] === "\n") i++;
        }
      } else field += c;
    }
    if (quoted) return null;
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
  } else return null;
  if (!rows.length) return null;
  const render = (value) =>
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return {
    headers: rows[0].slice(0, maxColumns).map(render),
    rows: rows
      .slice(1, maxRows + 1)
      .map((row) => row.slice(0, maxColumns).map(render)),
    truncated:
      truncated ||
      rows.length > maxRows + 1 ||
      rows.some((r) => r.length > maxColumns),
  };
}
