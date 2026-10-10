import type { Brief, BriefField } from "../src/application/contracts/drafting";
import type { MissionDefinition } from "../src/application/contracts/node";
export const briefFields: readonly BriefField[];
export const briefLabels: Record<BriefField, string>;
export function emptyBrief(): Brief;
export function draftDefinition(brief: Brief, policy: MissionDefinition["policy"]): MissionDefinition;
export function briefReadiness(brief: Brief, policy: MissionDefinition["policy"]): { valid: boolean; errors: string[]; suggestions: string[]; openDecisions: number };
