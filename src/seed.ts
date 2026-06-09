// Retired in 0.1.0.
//
// `parseReport` was the 0.0.1 cold-start path that parsed an HTML feature-
// report into the decision graph. Two reasons it's retired:
//   1. The 0.1.0 Decision shape (split type+status, rich `detail` body,
//      `<milestone>/<local>` ids, slot-into-milestone+session bookkeeping)
//      doesn't translate from old HTML cleanly.
//   2. The new write path is `/decision` + `/milestone-report`, not bulk
//      HTML import.
//
// The source file stays in tree for one snapshot in case anyone has
// unmigrated HTML archives — restore the 0.0.7 implementation from git
// history (`git show 0.0.7-snapshot:src/seed.ts`) and adapt by hand.
//
// CLI removes the `stele seed` subcommand; calling `parseReport` directly
// raises this error.
import type { Decision, Edge } from "./types.ts";

export class SeedRetiredError extends Error {
  constructor() {
    super(
      "stele seed is retired in 0.1.0. The 0.0.7 implementation lived at " +
        "src/seed.ts in the 0.0.7-snapshot tag; restore from git history " +
        "and adapt to the new Decision shape if you need HTML cold-start.",
    );
    this.name = "SeedRetiredError";
  }
}

export function parseReport(_path: string): { decisions: Decision[]; edges: Edge[] } {
  throw new SeedRetiredError();
}
