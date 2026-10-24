import type {
  ArtifactAction,
  ReviewCheck,
  ReviewMethod,
} from "../src/application/contracts/node";

export const reviewMethods: Record<ReviewMethod, string>;
export function checksFromForm(data: FormData): ReviewCheck[];
export function reviewReferences(value: string): string[];
export function reviewFromForm(
  revision: string,
  data: FormData,
): Extract<ArtifactAction, { type: "review" }>;
