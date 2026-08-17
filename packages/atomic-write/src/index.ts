// One recipe, two placements of the exclusive create.
//
// `replaceFileAtomically` is the durable replace: a whole temporary sibling,
// fsynced, renamed over the target, and the directory fsynced after.
// `createFileExclusively` is the same durability for a file that must not
// already exist, with `wx` on the real path instead of on a temporary — see
// ./atomic-write.ts for why that placement is the guarantee rather than a
// detail.
//
// `syncDirectory` is deliberately absent. It is the half of each sequence that
// is easy to forget, and a caller holding it would be a caller assembling its
// own write — which is the thing this package exists to stop happening a fourth
// time. `temporaryNameFor` is absent for the same reason by a different route:
// it is exported from ./atomic-write.ts so its own test can pin the name shape
// three modules in `packages/memory` depend on, and a caller holding it would be
// a caller planting a temporary file the recipe did not plant.

export { createFileExclusively, replaceFileAtomically } from "./atomic-write.js";
