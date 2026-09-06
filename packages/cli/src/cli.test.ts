import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./io.js";
import { VERSION, runCli } from "./cli.js";

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

async function run(argv: string[], nodeVersion = "24.13.3", cwd = "/nowhere"): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv,
    cwd,
    nodeVersion,
    out: line => void out.push(line),
    err: line => void err.push(line)
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

describe("dispatch", () => {
  it("prints usage on stdout and exits 2 with no arguments", async () => {
    const result = await run([]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.out.join("\n")).toContain("usage: libero <command>");
    expect(result.err).toEqual([]);
  });

  each(["--help", "-h", "help"])("prints usage on stdout and exits 0 for %s", async word => {
    const result = await run([word]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join("\n")).toContain("usage: libero <command>");
    expect(result.err).toEqual([]);
  });

  it("sends an unknown command to stderr and exits 2", async () => {
    const result = await run(["provision"]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain("libero: unknown command: provision");
    expect(result.out).toEqual([]);
  });

  it("prints a version", async () => {
    const result = await run(["--version"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual([`libero ${VERSION}`]);
  });
});

describe("the runtime floor", () => {
  it("refuses an unsupported Node before reading anything, and exits 1", async () => {
    // `engines` is advisory — npm warns and runs the package regardless — so
    // an unsupported runtime is refused here or it is not refused at all.
    const result = await run(["init"], "22.20.0");

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("\n")).toContain("needs Node 24");
    expect(result.out).toEqual([]);
  });

  it("does not get in the way on a supported one", async () => {
    const result = await run(["--version"], "26.7.0");

    expect(result.code).toBe(EXIT_OK);
  });
});

describe("the boundary #98 settled", () => {
  // The vault, the budget meter and the audit log live in named volumes the
  // host cannot open, so they are the proxy's own entrypoints and not commands
  // here. Asserted rather than only written down, because the failure mode is
  // someone adding one and nothing objecting.
  each([
    ["vault", "node dist/vault.js"],
    ["budget", "node dist/budget.js"],
    ["audit", "node dist/audit.js"]
  ])("refuses %s, and says where it actually lives", async (command, entrypoint) => {
    const result = await run([command]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain(`libero: unknown command: ${command}`);
    expect(result.err.join("\n")).toContain(entrypoint);
  });

  it("says in its usage that those three are deliberately elsewhere", async () => {
    const result = await run(["--help"]);

    expect(result.text).toContain("deliberately not commands");
  });
});

describe("the compose file it names", () => {
  // #516: the three command lines above used to say deploy/docker-compose.yml
  // whatever the operator's file was, and `findCompose` accepts four filenames
  // in two directories — so the advice named a file half of them do not have.
  const dirs: string[] = [];

  function withCompose(at: string): string {
    const dir = mkdtempSync(join(tmpdir(), "libero-cli-usage-"));
    dirs.push(dir);
    mkdirSync(join(dir, at), { recursive: true });
    writeFileSync(join(dir, at, at === "." ? "compose.yaml" : "docker-compose.yml"), "services: {}\n");
    return dir;
  }

  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("names deploy/docker-compose.yml in a checkout of this repository", async () => {
    const result = await run(["--help"], "24.13.3", withCompose("deploy"));

    expect(result.text).toContain("docker compose -f deploy/docker-compose.yml run --rm proxy");
  });

  it("drops the -f when the compose file is the working directory's own", async () => {
    const result = await run(["--help"], "24.13.3", withCompose("."));

    expect(result.text).toContain("docker compose run --rm proxy");
    expect(result.text).not.toContain("deploy/docker-compose.yml");
  });

  it("names no file at all when there is none to find", async () => {
    // `libero --help` outside a deployment. A bare `docker compose` is right
    // wherever it is run from; a guessed path is right nowhere.
    const result = await run(["--help"]);

    expect(result.text).toContain("docker compose run --rm proxy");
    expect(result.text).not.toContain("-f ");
  });

  it("says it on the unknown-command hint too", async () => {
    const result = await run(["vault"], "24.13.3", withCompose("."));

    expect(result.err.join("\n")).toContain("docker compose run --rm proxy node dist/vault.js");
  });
});
