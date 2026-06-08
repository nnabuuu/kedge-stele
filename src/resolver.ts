import type { EntityRef } from "./types.ts";

export interface ResolvedEntity {
  label: string;
  href?: string;
  related?: EntityRef[]; // ontology can surface neighbours; stub returns none
}

export interface EntityResolver {
  resolve(ref: EntityRef): Promise<ResolvedEntity | null>;
}

// POC resolver: shows the bare ref. Functionally complete — only the label is ugly.
// Replacing this with a KedgeOntologyResolver is the ONLY change needed to light up
// "point at any entity and ask how it came to be" across the real ontology.
export const stubResolver: EntityResolver = {
  async resolve(ref: EntityRef): Promise<ResolvedEntity> {
    return { label: `${ref.kind}:${ref.id}` };
  },
};
