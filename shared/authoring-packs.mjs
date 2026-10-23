// Local, reviewed software choices. These never grant filesystem or network access.
export const AUTHORING_PACKS = Object.freeze({
  general: Object.freeze({
    label: "General purpose",
    description:
      "Files, Python and standard Linux tools. Choose the deliverable format that fits the mission.",
    buildkit: null,
  }),
  "web-3d": Object.freeze({
    label: "Web & 3D",
    description:
      "Adds Node.js, npm, esbuild and Three.js for browser applications. Internet access stays a separate choice.",
    buildkit: "web-artifact-1",
  }),
});

export function authoringPack(pack = "general") {
  if (!Object.hasOwn(AUTHORING_PACKS, pack))
    throw new Error("Unknown authoring toolkit.");
  return { pack, ...AUTHORING_PACKS[pack] };
}
