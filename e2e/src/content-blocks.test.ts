// A payload crosses as a payload, or it does not cross at all (#503, part of #160).
//
// #501 taught the proxy to relay an upstream's image, audio and binary-resource
// blocks instead of naming them, and #502 taught the loop and both adapters to
// carry them. Each of those has its own suite, and neither can answer the
// question this file asks: **what does the model actually get handed, across two
// processes, when a real upstream returns a screenshot?**
//
// The property has three halves and the third is the one worth the file.
//
// **It crosses.** With the cap raised, the bytes the upstream produced arrive at
// the model as an `image` block, byte for byte. That is asserted before anything
// is claimed about where they did not go — the positive-control rule this suite
// runs on, applied to a payload rather than to a credential. A run where the
// image never crossed at all passes every negative assertion below, and passes
// it for the worst possible reason.
//
// **Everything else degrades, and degrades to a sentence rather than to base64.**
// Asserted as "no block the model was handed contains the payload", not as
// "the placeholder is present" — those are different claims, and only the first
// one fails when something starts inlining.
//
// What degrades here is what the *wire* has no member for, which is a narrower
// set than what a provider cannot take. `ToolResultBlock` is closed, so a
// `resource_link`, a block from a newer revision and a payload that is not
// base64 each cost a sentence; an audio clip and a binary resource are members
// and cross whole. What a *provider* cannot be handed — audio at Anthropic,
// anything but text at chat completions — is that adapter's question, asserted
// against a real adapter in `packages/agent`. This rig fakes at the
// `CompletionClient` seam, so the same claim here would be a claim about the
// fake.
//
// **Two of those degradations are only reachable on the legacy era**, and that
// is a finding rather than a fixture detail — see the third block below.
//
// **A credential inside a payload does not cross.** #501 decided that a binary
// block is scanned decoded and that a match fails the whole result closed,
// because there is no edit to make — a replacement inside a PNG is a corrupt
// image rather than a scrubbed one. That decision is a paragraph in `redact.ts`
// until something checks it, and this is the check: a canary the wire scan
// cannot see, because no spelling of it appears in the base64 of the bytes that
// hold it.
//
// No Docker daemon. Nothing here starts a runtime.

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "expect";
import { completeResult } from "@getlibero/proxy";
import type { FakeMcpServer } from "@getlibero/proxy";
import { resultText } from "@getlibero/schema";
import type { ToolResultBlock } from "@getlibero/schema";
import {
  CANARY,
  CANARY_CREDENTIAL,
  CHANNEL,
  auditRows,
  calls,
  expectCanaryReachedUpstream,
  expectNoCanary,
  rigOf,
  says,
  startRig,
  surface
} from "./harness/index.js";
import type { Rig, SheetInput } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

/**
 * A payload big enough that the default cap would refuse it, and unique enough
 * that finding it anywhere is a fact rather than a coincidence.
 *
 * 4,000 base64 characters is 3,000 decoded bytes — under the raised cap below
 * and well over the notice-sized text every other case in this suite moves. The
 * prefix is what the negative assertions actually search for: base64 of a
 * repeated byte would appear by accident in anything long enough.
 */
const IMAGE_PAYLOAD = `libero503${"A".repeat(3991)}`;

/** The same, decoded, for the size the placeholder should name. */
const IMAGE_BYTES = Buffer.from(IMAGE_PAYLOAD, "base64").length;

/** The text block the image travels beside, and its utf8 length. */
const CAPTION = "Here is the failing check.";
const TEXT_BYTES = Buffer.byteLength(CAPTION, "utf8");

/**
 * The cap a channel would have to raise to relay an image, raised.
 *
 * The default of 32,768 is what makes "nothing binary reaches a model until an
 * operator raises a number" true, and the degradation cases below rely on it by
 * leaving it alone. Only the channel that wants a payload to cross says
 * otherwise, which is the shape an operator's own sheet takes.
 */
const RELAYS_IMAGES: SheetInput = {
  credential: CANARY_CREDENTIAL,
  maxResultChars: 100_000,
  tools: [{ name: "list_prs", approval: "none" as const }]
};

/** The blocks the model was handed for the one tool result in a transcript. */
function blocksHandedToModel(seen: readonly { messages: readonly unknown[] }[]): ToolResultBlock[] {
  for (const request of seen) {
    for (const message of request.messages) {
      const entry = message as { role?: string; content?: unknown };
      if (entry.role === "tool") return entry.content as ToolResultBlock[];
    }
  }
  throw new Error("e2e: the model was never handed a tool result — the case proves nothing");
}

/** Make the upstream answer every `tools/call` with these content blocks. */
function answersWith(upstream: FakeMcpServer, content: readonly Record<string, unknown>[]): void {
  upstream.respond = request => {
    if (request.rpc?.method !== "tools/call") return null;
    return {
      message: {
        jsonrpc: "2.0",
        id: request.rpc.id ?? 0,
        // `completeResult` rather than a bare object, per skill-poisoning.ts:
        // the 2026-07-28 envelope makes `resultType` mandatory, and a hand-built
        // result without it fails as "could not be read as MCP" on every call
        // rather than exercising the block being tested.
        result: completeResult({ content })
      }
    };
  };
}

describe("a tool result's content blocks, across both processes", () => {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      script: [calls("list_prs", { repo: "getlibero/libero" }), says("Looked at it.")],
      sheets: { [CHANNEL]: RELAYS_IMAGES }
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  /** One mention, from a clean model transcript. Returns what the model saw. */
  async function ask(at: string): Promise<ToolResultBlock[]> {
    const { agent, model } = rigOf(rig);
    model.seen.length = 0;
    await agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "<@U0BOTBOTB> what is open",
      ts: at,
      threadTs: at,
      eventId: `Ev${at.replace(".", "")}`
    });
    return blocksHandedToModel(model.seen);
  }

  // The positive control, and it comes first for the reason canary.ts gives
  // about credentials: every "no base64 reached the model" assertion below
  // passes just as well on a rig where no payload ever crossed anything.
  it(
    "hands the model the upstream's image as an image block, byte for byte",
    { timeout: CASE_MS },
    async () => {
      const { upstream, auditDb } = rigOf(rig);
      const before = auditRows(auditDb).length;
      answersWith(upstream, [
        { type: "text", text: CAPTION },
        { type: "image", data: IMAGE_PAYLOAD, mimeType: "image/png" }
      ]);

      const blocks = await ask("1758000000.000200");

      // Two blocks and not one: the join into a single string is what #501
      // removed, and a proxy that re-flattened would still satisfy a check for
      // the text alone.
      expect(blocks).toEqual([
        { type: "text", text: CAPTION },
        { type: "image", data: IMAGE_PAYLOAD, mimeType: "image/png" }
      ]);

      // The audit row says what crossed and of what kind, which is the operator's
      // half of the same fact. The text block pays its utf8 bytes; the image's
      // are decoded, never the four-thirds base64 spells it in.
      const rows = auditRows(auditDb).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result_bytes).toBe(TEXT_BYTES + IMAGE_BYTES);
      expect(JSON.parse(rows[0]?.result_bytes_by_type ?? "{}")).toEqual({
        text: TEXT_BYTES,
        image: IMAGE_BYTES
      });
    }
  );

  // The rest of the union, on the same control. `image` above is the one #160
  // is named for, and a suite that asserted only it would not notice a proxy
  // that had promoted exactly one type.
  it("hands over an audio clip and a binary resource the same way", { timeout: CASE_MS }, async () => {
    const { upstream } = rigOf(rig);
    answersWith(upstream, [
      { type: "audio", data: IMAGE_PAYLOAD, mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///report.zip", blob: IMAGE_PAYLOAD, mimeType: "application/zip" } }
    ]);

    expect(await ask("1758000000.000300")).toEqual([
      { type: "audio", data: IMAGE_PAYLOAD, mimeType: "audio/wav" },
      { type: "resource", uri: "file:///report.zip", mimeType: "application/zip", blob: IMAGE_PAYLOAD }
    ]);
  });

  // What the proxy degrades is what the *wire* has no member for, which is a
  // narrower set than what a provider cannot take: `ToolResultBlock` is closed,
  // so a `resource_link` and a block from a protocol revision this tree does not
  // know each cost a sentence rather than the whole call. What a provider cannot
  // be handed — audio at Anthropic, anything but text at chat completions — is
  // that adapter's own question, asserted against a real adapter in
  // `packages/agent`; this rig fakes at the `CompletionClient` seam, so the same
  // claim here would be a claim about the fake.
  it("degrades what the wire has no member for, without inlining it", { timeout: CASE_MS }, async () => {
    const { upstream } = rigOf(rig);

    const cases: { block: Record<string, unknown>; expect: string }[] = [
      {
        // `name` beside the uri: the specification requires it, and the SDK
        // validates a result against that before any schema of this proxy's
        // sees it. A block missing it fails the whole call rather than reaching
        // the placeholder — the same narrowing the legacy-era block below is
        // about, met here as a shape rather than as a type.
        block: { type: "resource_link", uri: "https://example.test/a", name: "a" },
        expect: "[resource: https://example.test/a]"
      },
    ];

    let at = 310;
    for (const scenario of cases) {
      answersWith(upstream, [scenario.block]);
      const blocks = await ask(`1758000000.000${String(at)}`);
      at += 1;

      expect(blocks.every(block => block.type === "text")).toBe(true);
      expect(resultText(blocks)).toBe(scenario.expect);
      // The claim that matters, and it is not "the placeholder is present": a
      // proxy that named the payload *and* inlined it beside itself would
      // satisfy that and fail this.
      expect(JSON.stringify(blocks)).not.toContain("libero503");
    }
  });
});

// The placeholder for a block type this tree does not know, on the era where it
// is reachable — and the record of why that is not every era.
//
// `ToolResultBlock` is closed so that a forward-revision block costs a sentence
// rather than the whole call, and `mcp-client.ts` sends `tools/call` as a raw
// `request` against a permissive envelope precisely to keep that true. On the
// modern era it is not true anyway: the SDK validates a result against the
// specification's own closed content union before any caller schema sees it, so
// an unknown block fails the whole call as `protocol_error`. That is the same
// narrowing `mcp-catalog.test.ts` pins for a listing page, one layer over, and
// this rig is where it was observed for a *result*.
//
// So the branch is asserted on `2025-11-25`, which is the era every upstream in
// production today negotiates — and the case is written this way rather than
// deleted so the next reader meets the narrowing instead of re-finding it.
describe("an upstream on the legacy era", () => {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      script: [calls("list_prs", { repo: "getlibero/libero" }), says("Nothing to show.")],
      sheets: { [CHANNEL]: RELAYS_IMAGES },
      upstream: { protocol: "legacy" }
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  const cases: { what: string; block: Record<string, unknown>; expect: string }[] = [
    {
      what: "a block type from a newer revision",
      block: { type: "hologram", data: IMAGE_PAYLOAD },
      expect: "[unsupported content block: hologram]"
    },
    {
      // The branch #501 added, and the reason it is not decoration: the agent
      // parses what this proxy emits, so a payload that is not base64 has to
      // become a sentence here or become a lost call over there.
      what: "a payload that is not base64",
      block: { type: "image", data: "libero503 not base64 !!", mimeType: "image/png" },
      expect: "[image omitted: image/png, 17 bytes]"
    }
  ];

  let at = 600;
  for (const scenario of cases) {
    const ts = `1758000000.000${String(at)}`;
    at += 1;

    it(`costs ${scenario.what} a sentence rather than the answer`, { timeout: CASE_MS }, async () => {
      const { agent, upstream, model } = rigOf(rig);
      model.seen.length = 0;
      answersWith(upstream, [{ type: "text", text: "Two are open." }, scenario.block]);

      await agent.slack.deliverMention({
        teamId: "T024BE7LD",
        channelId: CHANNEL,
        userId: "U024BE7LH",
        text: "<@U0BOTBOTB> what is open",
        ts,
        threadTs: ts,
        eventId: `Ev${ts.replace(".", "")}`
      });

      const blocks = blocksHandedToModel(model.seen);
      // Beside the ordinary text, which is the half that matters: the
      // placeholder exists so one unreadable block does not cost the blocks
      // around it.
      expect(resultText(blocks)).toBe(`Two are open.\n${scenario.expect}`);
      expect(JSON.stringify(blocks)).not.toContain("libero503");
    });
  }
});

// The operator's switch, asserted on the setting every deployment has rather
// than on a number this file picked: a rig whose sheet says nothing about
// `max_result_chars` keeps the schema's 32,768, and an image does not fit in it.
describe("a channel that has not raised its result cap", () => {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      script: [calls("list_prs", { repo: "getlibero/libero" }), says("Could not show it.")]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it("is handed the sentence and never the payload", { timeout: CASE_MS }, async () => {
    const { agent, upstream, model } = rigOf(rig);
    // Bigger than the default cap and nothing else: the same image the raised
    // channel above received whole.
    const screenshot = `libero503${"A".repeat(59_991)}`;
    answersWith(upstream, [{ type: "image", data: screenshot, mimeType: "image/png" }]);

    await agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "<@U0BOTBOTB> what is open",
      ts: "1758000000.000400",
      threadTs: "1758000000.000400",
      eventId: "Ev00000400"
    });

    const blocks = blocksHandedToModel(model.seen);
    expect(blocks.every(block => block.type === "text")).toBe(true);
    expect(resultText(blocks)).toContain("[image omitted: image/png,");
    expect(JSON.stringify(blocks)).not.toContain("libero503");
  });
});

// The attack leg. Separated because it needs its own rig: the result fails
// closed, so the task ends without a reply, and a shared model transcript would
// carry that across into the cases above.
describe("a credential planted inside a payload", () => {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      script: [calls("list_prs", { repo: "getlibero/libero" }), says("Could not read it.")],
      sheets: { [CHANNEL]: RELAYS_IMAGES }
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it(
    "does not cross, and the whole result fails closed rather than one block",
    { timeout: CASE_MS },
    async () => {
      const { agent, upstream, model, auditDb, surfaces } = rigOf(rig);
      const before = auditRows(auditDb).length;

      // The shape the wire scan cannot catch. The credential is in the *decoded*
      // bytes; the base64 of them spells nothing the needles match, which is why
      // the streaming scan in outbound.ts passes this body through untouched and
      // why the decoded pass in mcp-bounds.ts exists.
      const carrying = Buffer.from(`PNG\r\n\n${CANARY}IEND`, "latin1").toString("base64");
      answersWith(upstream, [{ type: "image", data: carrying, mimeType: "image/png" }]);

      await agent.slack.deliverMention({
        teamId: "T024BE7LD",
        channelId: CHANNEL,
        userId: "U024BE7LH",
        text: "<@U0BOTBOTB> what is open",
        ts: "1758000000.000500",
        threadTs: "1758000000.000500",
        eventId: "Ev00000500"
      });

      // The control this file's own header is about, and the one canary.ts
      // insists on: the credential really did leave the proxy on this call, so
      // the upstream really was in a position to echo it back.
      expectCanaryReachedUpstream(upstream);

      // The base64 the upstream sent is not what the scan matched on — proof the
      // wire scan could not have caught this, so the decoded pass is what did.
      expect(carrying).not.toContain(CANARY);

      // Closed, and *whole*: no block of the result reached the model, not even
      // the ones that carried nothing. Serving a scrubbed-looking subset would
      // be the proxy asserting a boundary it did not hold.
      const handed = model.seen.flatMap(request =>
        request.messages.filter(message => (message as { role?: string }).role === "tool")
      );
      expect(JSON.stringify(handed)).not.toContain(carrying);

      // The call is a failure the model may recover from rather than a silent
      // gap, so the channel still gets an answer.
      expect(agent.slack.posted).toHaveLength(1);

      // Nowhere the agent process can see, including the reply and the whole
      // model transcript. `expectNoCanary` names the surface it found it on.
      expectNoCanary([...surfaces(), surface("the model transcript", model.seen)]);

      // The proxy could not answer, so the row records a call it never resolved
      // — not a served one with a smaller result.
      const rows = auditRows(auditDb).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "unanswered", result_bytes: null });
    }
  );
});
