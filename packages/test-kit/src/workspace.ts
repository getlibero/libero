// The workspace, read off disk the way `pnpm-workspace.yaml` names it.
//
// Two checks in this package need the same list — `test-scripts.test.ts` asks
// whether every package runs its suite the same way, `ci-partition.test.ts`
// asks whether every package is run by CI at all — and neither can hardcode it,
// because the hazard both exist for is a package nobody remembered to add.
//
// Not exported from the package. `package.json` publishes `.` and `./reporter`
// and nothing else, and this is a helper for two test files rather than a third
// thing `@getlibero/test-kit` offers. It reads the filesystem, which is what
// `each` and `waitFor` deliberately do not.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, from this file's own location under `dist/`. */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface WorkspacePackage {
  readonly name: string;
  readonly manifest: Record<string, unknown>;
}

/**
 * Every workspace package, by the same directories `pnpm-workspace.yaml` names.
 *
 * `e2e` is a member in its own right rather than a child of `packages` or
 * `apps`, so it is appended by name — the one place this list is not derived.
 */
export function workspacePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(read(join(ROOT, group, entry.name)));
    }
  }
  found.push(read(join(ROOT, "e2e")));
  return found;
}

function read(directory: string): WorkspacePackage {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  return { name: String(manifest["name"]), manifest };
}
