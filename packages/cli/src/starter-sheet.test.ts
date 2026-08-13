import { parseTeamSheet } from "@getlibero/schema";
import { describe, expect, it } from "vitest";
import { renderStarterSheet } from "./starter-sheet.js";

const FINGERPRINT = "D8:13:B2:93:C1:69:72:BE:CD:36:A1:D1:40:5F:84:05:05:BB:52:D5:E2:DC:2E:F2:32:59:69:3A:09:91:38:7B";

function sheet(overrides: Partial<Parameters<typeof renderStarterSheet>[0]> = {}): string {
  return renderStarterSheet({
    channel: "C024BE91L",
    name: "engineering",
    fingerprint: FINGERPRINT,
    ...overrides
  });
}

describe("renderStarterSheet", () => {
  it("parses as a team sheet, with the fingerprint pinned", () => {
    const parsed = parseTeamSheet(sheet());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sheet.channel.name).toBe("engineering");
    expect(parsed.sheet.channel.certificate_sha256).toEqual([FINGERPRINT]);
  });

  it("grants nothing", () => {
    // The whole point of the generated sheet: a channel that can authenticate
    // and call nothing until somebody decides otherwise in a reviewable edit.
    const parsed = parseTeamSheet(sheet());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sheet.mcp_server).toEqual([]);
    expect(parsed.sheet.builtin).toEqual([]);
    expect(parsed.sheet.egress.allow).toEqual([]);
    expect(parsed.sheet.ambient.enabled).toBe(false);
  });

  it("escapes a name that would otherwise break the file", () => {
    const parsed = parseTeamSheet(sheet({ name: 'the "one" \\ only' }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sheet.channel.name).toBe('the "one" \\ only');
  });

  it("refuses a fingerprint that is not one", () => {
    expect(() => sheet({ fingerprint: "not-a-fingerprint" })).toThrow(/not a certificate fingerprint/);
  });

  it("refuses a channel id that is not one", () => {
    // Checked rather than escaped: the id is a directory name and an
    // interpolation, and both are closed alphabets.
    expect(() => sheet({ channel: "../escape" })).toThrow(/not a channel id/);
  });

  it("carries no secret and no placeholder pin", () => {
    const text = sheet();

    expect(text).not.toContain("00:00:00:00");
    expect(text).toContain("certificate_sha256");
  });
});
