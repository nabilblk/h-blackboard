export type CapabilityPack = "general" | "web-3d";
export type AuthoringPack = {
  label: string;
  description: string;
  buildkit: string | null;
};
export const AUTHORING_PACKS: Readonly<
  Record<CapabilityPack, Readonly<AuthoringPack>>
>;
export function authoringPack(
  pack?: CapabilityPack,
): AuthoringPack & { pack: CapabilityPack };
