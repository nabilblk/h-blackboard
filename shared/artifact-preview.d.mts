export const artifactCsp: string;
export function previewDocument(source: string): string;
export function dataTable(
  source: string,
  mediaType: string,
): { headers: string[]; rows: string[][]; truncated: boolean } | null;
