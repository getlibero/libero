import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { NODE_FLOOR, nodeTooOld } from "./node-version.js";

describe("nodeTooOld", () => {
  each(["24.0.0", "24.13.3", "26.7.0", "v26.7.0"])("accepts %s", version => {
    expect(nodeTooOld(version, ">=24.0.0")).toBeNull();
  });

  each(["22.20.0", "20.11.1", "v18.0.0"])("refuses %s, naming both versions", version => {
    const complaint = nodeTooOld(version, ">=24.0.0");

    expect(complaint).toContain("needs Node 24");
    expect(complaint).toContain(version);
  });

  it("compares the major only, so a patch floor does not reject the .0 release", () => {
    // `engines` is written `>=24.0.0` and the reason the floor is 24 is Node's
    // release lines, not an API added in a patch.
    expect(nodeTooOld("24.0.0", ">=24.13.3")).toBeNull();
  });

  it("says the containers carry their own runtime, because they do", () => {
    expect(nodeTooOld("22.0.0", ">=24.0.0")).toContain("containers");
  });

  it("says nothing about a version it cannot read", () => {
    // A refusal on an unparseable version would be this check breaking the CLI
    // on a runtime it cannot describe, which is worse than not checking.
    expect(nodeTooOld("who knows", ">=24.0.0")).toBeNull();
    expect(nodeTooOld("24.0.0", "whatever")).toBeNull();
  });

  it("falls back to the published floor when the build did not substitute one", () => {
    expect(NODE_FLOOR).toContain("24");
  });
});
