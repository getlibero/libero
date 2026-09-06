import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { expect } from "expect";
import { IMAGE_TAG, IMAGE_TAG_VAR, RELEASED, VERSION, imageTag } from "./version.js";

describe("the image tag a release pins", () => {
  it("is the version with the v the git tag carries", () => {
    expect(imageTag("0.8.0")).toBe("v0.8.0");
  });

  // A checkout published nothing, so there is no tag of its own to name — and
  // `v0.0.0-dev` would be a pin to bytes that exist in no registry.
  it("is latest for a build that is not a release", () => {
    expect(imageTag(null)).toBe("latest");
  });

  it("is what this build reports, whichever of the two it is", () => {
    expect(IMAGE_TAG).toBe(RELEASED ? `v${VERSION}` : "latest");
  });
});

/**
 * The derivation `imageTag` performs is an assumption about two files in other
 * directories, and neither is one a compiler reads (#519).
 *
 * `init` writes `v<this CLI's version>` into a variable the compose file
 * interpolates into three `image:` lines. That is only a tag an operator can
 * pull because the release workflow publishes `${{ github.ref_name }}` and
 * RELEASING.md keeps `packages/cli/package.json` in lockstep with that ref. Drop
 * the `v` from the workflow's tags, or stop interpolating in the compose file,
 * and every deployment `init` scaffolds pins something that does not exist —
 * with nothing else in the repository to notice.
 */
describe("the lockstep it assumes", () => {
  const workflow = (): string =>
    readFileSync(new URL("../../../.github/workflows/release-images.yml", import.meta.url), "utf8");

  it("publishes every image under the v* tag that triggered it, and latest", () => {
    const tags = [...workflow().matchAll(/ghcr\.io\/getlibero\/(\w+):(.+)$/gm)];
    // Three services, each on two tags, plus nothing else: a fourth image or a
    // third tag is a decision this test asks someone to make on purpose.
    expect(tags.map(match => `${match[1] as string}:${match[2] as string}`)).toEqual([
      "server:${{ github.ref_name }}",
      "server:latest",
      "proxy:${{ github.ref_name }}",
      "proxy:latest",
      "runner:${{ github.ref_name }}",
      "runner:latest"
    ]);
    expect(workflow()).toContain('- "v*"');
  });

  // Four references and not three: the runner names its own image a second
  // time, in RUNNER_IMAGE, because the egress hop is that image with another
  // entrypoint and a container cannot learn its own image from inside itself.
  // A pinned deployment whose hop still said `latest` would be the drift this
  // variable exists to remove, one layer down.
  it("is what every image this project publishes is pulled at", () => {
    const compose = readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
    const at = `\${${IMAGE_TAG_VAR}:-latest}`;
    const named = [...compose.matchAll(/ghcr\.io\/getlibero\/(\S+)$/gm)].map(match => match[1] as string);

    expect(named).toEqual([`server:${at}`, `proxy:${at}`, `runner:${at}`, `runner:${at}`]);
  });
});
