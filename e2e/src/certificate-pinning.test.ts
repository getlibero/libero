// #79: a leaked client key is revoked without retiring the channel, and the
// replacement is rotated in without a gap in service.
//
// The leak is modelled exactly, and modelling it is most of the point.
// `client-leaked.pem` is minted by the same CA as the real one and carries the
// same subject — `CN=channel:<CHANNEL>` — differing only in the private key
// behind it. Every check before the pin lets it through: the handshake
// verifies, the CN parses, the channel resolves. Before this issue there was
// nothing else, so the only way to stop it was deleting the channel's sheet,
// which stops the channel too.
//
// What is claimed here and nowhere else is the composed half. The proxy's own
// suite drives the pin check in-process; this drives it through a spawned
// proxy, over real TLS, with a real vault, meter and audit file behind it, and
// through `scripts/dev-certs.sh --rotate` / `--promote` — the commands an
// operator actually runs. The last case then does the whole rotation with the
// shipped agent rather than a raw client, which is the only way to say
// "without a restart" and mean the deployment rather than the socket.

import { after as afterAll, before as beforeAll, it } from "node:test";
import { expect } from "expect";
import {
  CANARY_CREDENTIAL,
  CHANNEL,
  auditRows,
  calls,
  lastAuditId,
  rawClient,
  rigOf,
  says,
  startRig
} from "./harness/index.js";
import type { RawClient, Rig } from "./harness/index.js";

const SETUP_MS = 120_000;
const CASE_MS = 30_000;

/** The label of the second certificate for CHANNEL: the key that leaked. */
const LEAKED = "leaked";

let rig: Rig | undefined;
let client: RawClient | undefined;

const permittedCall = (id: string) => ({
  id,
  server: "github",
  tool: "list_prs",
  arguments: { repo: "getlibero/libero" },
  requestingUser: "U024BE7LH",
  task: "task-pinning"
});

function clientOf(): RawClient {
  if (client === undefined) throw new Error("e2e: the rig did not start — the failure above is the real one");
  return client;
}

/** Rewrites CHANNEL's sheet, pinning exactly the certificates named. */
function pin(...fingerprints: string[]): void {
  const { channelsRoot, upstream } = rigOf(rig);
  channelsRoot.write(CHANNEL, {
    url: upstream.url,
    credential: CANARY_CREDENTIAL,
    tools: [{ name: "list_prs", approval: "none" }],
    pins: fingerprints
  });
}

beforeAll(async () => {
  rig = await startRig({
    channels: [CHANNEL],
    // Same CN, same CA, different key. The only thing that separates it from
    // the real certificate is the fingerprint the sheet pins.
    rawCns: [`${LEAKED}=channel:${CHANNEL}`],
    // Two turns for the last case, which is the only one that runs a task.
    script: [calls("list_prs", { repo: "getlibero/libero" }), says("Two are open.")]
  });
  client = rawClient({ url: rig.proxy.url, certs: rig.certs });
}, { timeout: SETUP_MS });

afterAll(async () => {
  await rig?.stop();
}, { timeout: SETUP_MS });

it(
  "serves the pinned certificate, so the refusals below mean something",
  { timeout: CASE_MS },
  async () => {
    const { certs, upstream, auditDb } = rigOf(rig);
    pin(certs.fingerprint(CHANNEL));
    const since = lastAuditId(auditDb);
    const served = upstream.callsTo("tools/call").length;

    const answer = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: CHANNEL,
      body: permittedCall("pin-control")
    });

    // The positive control this whole file rests on. Every "the leaked
    // certificate got nothing" assertion below passes just as well against a
    // proxy refusing everyone, and this is what rules that out: the call ran,
    // reached the upstream, and was written down.
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "ran", id: "pin-control" });
    expect(upstream.callsTo("tools/call")).toHaveLength(served + 1);
    expect(auditRows(auditDb, since)).toMatchObject([{ channel: CHANNEL, outcome: "ran" }]);
  });

it(
  "refuses the leaked certificate while the channel goes on working",
  { timeout: CASE_MS },
  async () => {
    const { certs, upstream, auditDb } = rigOf(rig);
    pin(certs.fingerprint(CHANNEL));
    const since = lastAuditId(auditDb);
    const served = upstream.callsTo("tools/call").length;

    const refused = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: LEAKED,
      body: permittedCall("pin-leaked")
    });

    // 401 rather than a refusal: this never became a channel's request. A
    // refusal is a served call that policy said no to, and there is no policy
    // question here — the connection did not authenticate.
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ error: { code: "unauthenticated" } });

    // Nothing ran, nothing was dialled, nothing was written down. An audit row
    // is a record of a tool call, and this was not one.
    expect(upstream.callsTo("tools/call")).toHaveLength(served);
    expect(auditRows(auditDb, since)).toEqual([]);

    // And the acceptance criterion: no sheet was deleted, so the channel is
    // still working with the certificate it is supposed to be using.
    const served_ok = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: CHANNEL,
      body: permittedCall("pin-still-live")
    });
    expect(served_ok.status).toBe(200);
    expect(served_ok.body).toMatchObject({ outcome: "ran" });
  });

it(
  "gives the leaked certificate nothing else on the listener either",
  { timeout: CASE_MS },
  async () => {
    const { certs } = rigOf(rig);
    pin(certs.fingerprint(CHANNEL));

    // The reason the check is in the identity gate rather than in the tool-call
    // handler. A revoked key that could still enumerate this channel's tools or
    // read its spend would be revoked in name only.
    const responses = await Promise.all([
      clientOf().send({ method: "GET", path: "/health", as: LEAKED }),
      clientOf().send({ method: "GET", path: "/v1/whoami", as: LEAKED }),
      clientOf().send({ method: "GET", path: "/v1/tools", as: LEAKED }),
      clientOf().send({
        method: "POST",
        path: "/v1/spend",
        as: LEAKED,
        body: {
          turn: "3b1f1c8e-1f6a-4c2b-9a1e-7d5c4b3a2f10",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
        }
      })
    ]);

    expect(responses.map(r => r.status)).toEqual([401, 401, 401, 401]);
  });

it(
  "accepts both certificates while two are pinned, which is the rotation's overlap",
  { timeout: CASE_MS },
  async () => {
    const { certs } = rigOf(rig);
    pin(certs.fingerprint(CHANNEL), certs.fingerprint(LEAKED));

    const [first, second] = await Promise.all([
      clientOf().send({ method: "GET", path: "/v1/whoami", as: CHANNEL }),
      clientOf().send({ method: "GET", path: "/v1/whoami", as: LEAKED })
    ]);

    // Two keys, one channel, both accepted — and both answer as the channel
    // their subject names, because the pin decides which key may speak and the
    // CN still decides for whom.
    expect(first).toMatchObject({ status: 200, body: { channel: CHANNEL } });
    expect(second).toMatchObject({ status: 200, body: { channel: CHANNEL } });
  });

it(
  "rotates through the real script, with no restart of either process",
  { timeout: CASE_MS },
  async () => {
    const { agent, certs, channelsRoot, upstream, auditDb } = rigOf(rig);
    pin(certs.fingerprint(CHANNEL));
    const before = certs.fingerprint(CHANNEL);

    // 1. Mint the replacement. Nothing in service changes: the staged material
    //    sits beside what is running and the sheet has not been touched.
    const replacement = certs.rotate(CHANNEL);
    expect(replacement).not.toBe(before);
    expect((await clientOf().send({ method: "GET", path: "/v1/whoami", as: CHANNEL })).status).toBe(200);

    // 2. Promoting before the sheet pins the replacement is the one ordering
    //    that would take the channel offline, so the script refuses to do it.
    expect(() => certs.promote(CHANNEL, channelsRoot.path)).toThrow();

    // 3. Pin both. Now either may speak for the channel.
    pin(before, replacement);

    // 4. Swap the material. The agent process is not restarted and the proxy
    //    is not signalled; both notice on their next request.
    certs.promote(CHANNEL, channelsRoot.path);
    expect(certs.fingerprint(CHANNEL)).toBe(replacement);

    // The whole point, asserted through the shipped agent rather than the raw
    // client: a mention runs a task, the transport presents the certificate
    // that is on disk *now*, and the proxy accepts it — with nothing restarted
    // at any point in this test.
    const since = lastAuditId(auditDb);
    const served = upstream.callsTo("tools/call").length;
    await agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "<@U0BOTBOTB> what is open",
      ts: "1758000000.000700",
      threadTs: "1758000000.000700",
      eventId: "Ev00000079"
    });

    expect(upstream.callsTo("tools/call")).toHaveLength(served + 1);
    expect(auditRows(auditDb, since)).toMatchObject([{ channel: CHANNEL, outcome: "ran" }]);

    // 5. Drop the old fingerprint, and the key that was in service a moment ago
    //    is dead on the next call.
    pin(replacement);
    expect((await clientOf().send({ method: "GET", path: "/v1/whoami", as: LEAKED })).status).toBe(401);
    expect((await clientOf().send({ method: "GET", path: "/v1/whoami", as: CHANNEL })).status).toBe(200);
  });
