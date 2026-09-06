// What release this CLI is, and which image tag that pins (#519).
//
// Two strings rather than one, because they are two different strings. The
// package version is `0.8.0`; the images `.github/workflows/release-images.yml`
// publishes are tagged `${{ github.ref_name }}`, which is `v0.8.0` — the tag
// itself. What makes the second derivable from the first is RELEASING.md's
// lockstep rule: one `v*` tag releases the CLI and all three images together,
// and step 3 makes `packages/cli/package.json` the release number by PR. So a
// CLI that knows its own version knows the tag its own release published
// images under, which is what `init` writes into `LIBERO_VERSION` and what
// `doctor` compares a deployment against. ./version.test.ts holds the workflow
// to that, because the derivation is an assumption about a file in another
// directory.
//
// The version is substituted by ../build.mjs at bundle time: the published
// artifact is a single file and cannot read its own package.json off disk. The
// fallback keeps the source runnable under plain tsc output, which is what the
// tests run against and where nothing defines it.
//
// **A build that was never released pins `latest`, and `doctor` declines to
// compare against it.** A checkout published no images, so it has no tag of its
// own to name; what a checkout does instead is `build:`, which tags what it
// builds with whatever the compose file's `image:` resolves to. `latest` is
// that tag and is the only honest answer — `v0.0.0-dev` would be a pin to bytes
// that exist nowhere, and `docker compose pull` against it fails with a
// registry error rather than with a sentence this file could have written.

declare const __LIBERO_VERSION__: string;

/** Whether ../build.mjs substituted a version, i.e. whether this is a release. */
export const RELEASED = typeof __LIBERO_VERSION__ === "string";

/** This CLI's own version. The sentinel is what plain tsc output reports. */
export const VERSION = RELEASED ? __LIBERO_VERSION__ : "0.0.0-dev";

/**
 * The image tag a release published, or `latest` for a build that is not one.
 *
 * A function as well as a constant for the reason `nodeTooOld` takes its floor:
 * the constant is folded out of the bundle at build time and can only ever be
 * observed one way per build, so the rule itself is what the tests exercise.
 */
export function imageTag(version: string | null): string {
  return version === null ? "latest" : `v${version}`;
}

/** What this CLI pins a deployment to: `init` writes it, `doctor` reads it. */
export const IMAGE_TAG = imageTag(RELEASED ? VERSION : null);

/**
 * The variable all three `image:` lines in deploy/docker-compose.yml
 * interpolate.
 *
 * Named here because three places have to agree about it and one of them is a
 * YAML file no compiler reads — `init` writes the line, `doctor` reads it back,
 * and the compose file is what gives it meaning.
 */
export const IMAGE_TAG_VAR = "LIBERO_VERSION";
