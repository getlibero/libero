import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_USAGE } from "./io.js";
import { VERSION, runCli } from "./cli.js";

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

function run(argv: string[]): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli({
    argv,
    cwd: "/nowhere",
    out: line => void out.push(line),
    err: line => void err.push(line)
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

describe("dispatch", () => {
  it("prints usage on stdout and exits 2 with no arguments", () => {
    const result = run([]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.out.join("\n")).toContain("usage: libero <command>");
    expect(result.err).toEqual([]);
  });

  it.each(["--help", "-h", "help"])("prints usage on stdout and exits 0 for %s", word => {
    const result = run([word]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join("\n")).toContain("usage: libero <command>");
    expect(result.err).toEqual([]);
  });

  it("sends an unknown command to stderr and exits 2", () => {
    const result = run(["provision"]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain("libero: unknown command: provision");
    expect(result.out).toEqual([]);
  });

  it("prints a version", () => {
    const result = run(["--version"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual([`libero ${VERSION}`]);
  });
});

describe("the boundary #98 settled", () => {
  // The vault, the budget meter and the audit log live in named volumes the
  // host cannot open, so they are the proxy's own entrypoints and not commands
  // here. Asserted rather than only written down, because the failure mode is
  // someone adding one and nothing objecting.
  it.each([
    ["vault", "node dist/vault.js"],
    ["budget", "node dist/budget.js"],
    ["audit", "node dist/audit.js"]
  ])("refuses %s, and says where it actually lives", (command, entrypoint) => {
    const result = run([command]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain(`libero: unknown command: ${command}`);
    expect(result.err.join("\n")).toContain(entrypoint);
  });

  it("says in its usage that those three are deliberately elsewhere", () => {
    const result = run(["--help"]);

    expect(result.text).toContain("deliberately not commands");
  });
});
