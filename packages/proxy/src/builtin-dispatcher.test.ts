import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MESSAGE_STORE_SCHEMA_VERSION, openMessageStore } from "@getlibero/memory";
import type { MessageStore } from "@getlibero/memory";
import type { ResolvedToolCall } from "@getlibero/schema";
import { createBuiltinDispatcher } from "./builtin-dispatcher.js";
import type { BuiltinDispatcher, Dispatch } from "./dispatch.js";
import type { CallLimits } from "./enforce.js";
import { createSilentLogger } from "./log.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";

/** Roomy, so a case that is not about truncation is not accidentally about it. */
const LIMITS: CallLimits = { maxResultChars: 100_000 };

let root: string;
let store: MessageStore;
let dispatcher: BuiltinDispatcher;

function callWith(args: Record<string, unknown>, channel = CHANNEL): ResolvedToolCall {
  return {
    id: "toolu_01",
    server: "libero",
    tool: "search_channel_history",
    arguments: args,
    requestingUser: "U0ASKER",
    task: "b9d5a2f0-0000-4000-8000-000000000001",
    channel
  };
}

/** The `ran` result's text, or a failure that names what came back instead. */
function textOf(dispatch: Dispatch): string {
  if (dispatch.outcome !== "ran") throw new Error(`expected ran, got ${dispatch.outcome}`);
  return dispatch.result.content;
}

function search(args: Record<string, unknown>, limits = LIMITS, channel = CHANNEL): Dispatch {
  return dispatcher.run(callWith(args, channel), "search_channel_history", limits);
}

function stored(ts: string, text: string, extra: Record<string, unknown> = {}): void {
  store.append({
    ts,
    threadTs: null,
    userId: "U0ALICE",
    displayName: "Alice",
    text,
    at: 1_700_000_000_000,
    ...extra
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-builtin-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
  dispatcher = createBuiltinDispatcher({ storeRoot: root, logger: createSilentLogger() });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("search_channel_history", () => {
  it("finds a message and renders its date, author, and text", () => {
    stored("1700000000.000100", "we decided to ship the vault behind the sheet");

    expect(textOf(search({ query: "vault" }))).toBe(
      "2023-11-14 @Alice: we decided to ship the vault behind the sheet"
    );
  });

  // The tokenizer is `porter`, chosen so a model's question matches a human's
  // answer. Asserted here because the tool's description promises it.
  it("matches across word endings, as the description says it does", () => {
    stored("1700000000.000100", "we decided to ship the vault");

    expect(textOf(search({ query: "decide vault" }))).toContain("we decided to ship the vault");
  });

  it("falls back to the user id when the author had no display name", () => {
    stored("1700000000.000100", "anonymous note about the vault", { displayName: null });

    expect(textOf(search({ query: "vault" }))).toBe("2023-11-14 @U0ALICE: anonymous note about the vault");
  });

  // This process holds no Slack token, so a mention cannot be resolved and
  // inventing a name would be worse than showing the id. The description tells
  // the model so; this keeps it true.
  it("leaves a mention token in the text as an id", () => {
    stored("1700000000.000100", "<@U012AB3CD> can you check the vault");

    expect(textOf(search({ query: "vault" }))).toContain("<@U012AB3CD> can you check the vault");
  });

  it("says so when nothing matched", () => {
    stored("1700000000.000100", "an unrelated message");

    expect(textOf(search({ query: "vault" }))).toBe("No messages in this channel matched that search.");
  });

  // A provisioned channel that has not yet had a message is ordinary, and it is
  // a different sentence from "nothing matched" because it is a different fact.
  it("says something different when the channel has no store at all", () => {
    mkdirSync(join(root, OTHER));

    expect(textOf(search({ query: "vault" }, LIMITS, OTHER))).toBe(
      "No messages have been stored for this channel yet."
    );
  });

  it("does not create a store for a channel that has none", () => {
    mkdirSync(join(root, OTHER));
    search({ query: "vault" }, LIMITS, OTHER);

    expect(() => openMessageStore({ channel: OTHER, root }).close()).not.toThrow();
  });

  it("honours an explicit limit", () => {
    for (let i = 1; i <= 5; i += 1) stored(`170000000${i}.000100`, `vault note ${i}`);

    expect(textOf(search({ query: "vault", limit: 2 })).split("\n")).toHaveLength(2);
  });
});

// The acceptance criterion, in the place it is actually enforced. `.strict()`
// on the argument parser is what makes "no argument the model controls can
// widen the search beyond the calling channel" a shape rather than a check.
describe("what the model may send", () => {
  it("refuses an argument naming a channel, and says which key", () => {
    const dispatch = search({ query: "vault", channel: OTHER });

    expect(dispatch).toMatchObject({ outcome: "ran", result: { isError: true } });
    expect(textOf(dispatch)).toContain("channel");
  });

  it("searches only the calling channel even when another has the same words", () => {
    stored("1700000000.000100", "the vault in this channel");

    mkdirSync(join(root, OTHER));
    const other = openMessageStore({ channel: OTHER, root });
    other.append({
      ts: "1700000000.000200",
      threadTs: null,
      userId: "U0BOB",
      displayName: "Bob",
      text: "the vault in another channel",
      at: 1_700_000_000_000
    });
    other.close();

    const text = textOf(search({ query: "vault" }));
    // The positive control: without it this passes on a search that found
    // nothing at all, which is every assertion below made vacuous.
    expect(text).toContain("the vault in this channel");
    expect(text).not.toContain("another channel");
  });

  it.each([
    ["no query", {}],
    ["an empty query", { query: "" }],
    ["a non-string query", { query: 7 }],
    ["a zero limit", { query: "vault", limit: 0 }],
    ["a limit past the store's ceiling", { query: "vault", limit: 500 }],
    ["an unknown key", { query: "vault", root: "/etc" }]
  ])("refuses %s as an error result rather than a refusal", (_label, args) => {
    // An error result and not a `ToolRefusal`: that union is a closed set of
    // governance decisions with no free-text member, and bad arguments is
    // neither. MCP servers answer the same way, so the model sees one shape.
    expect(search(args)).toMatchObject({ outcome: "ran", result: { isError: true } });
  });
});

// Whole messages, never a cut one. A dropped entry is a short answer that
// admits it; a truncated entry is half a sentence attributed by name to a real
// person, which is a misquote the model then reasons over.
describe("the channel's result bound", () => {
  beforeEach(() => {
    for (let i = 1; i <= 5; i += 1) {
      stored(`170000000${i}.000100`, `vault note number ${i} with enough text to measure`);
    }
  });

  it("drops whole messages and says how many", () => {
    const text = textOf(search({ query: "vault" }, { maxResultChars: 160 }));
    const lines = text.split("\n");

    expect(text.length).toBeLessThanOrEqual(160);
    expect(lines.at(-1)).toMatch(/^\(\d+ more matches omitted to fit this channel's result limit\)$/);
    // Every surviving line is a whole message, so none of them is a misquote.
    for (const line of lines.slice(0, -1)) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2} @Alice: vault note number \d with enough text to measure$/);
    }
  });

  it("counts one omitted match in the singular", () => {
    const full = textOf(search({ query: "vault" }));
    const text = textOf(search({ query: "vault" }, { maxResultChars: full.length - 5 }));

    expect(text).toContain("(1 more match omitted");
  });

  it("stays inside the bound rather than exceeding it to report staying inside it", () => {
    for (const maxResultChars of [40, 80, 120, 200, 300]) {
      const text = textOf(search({ query: "vault" }, { maxResultChars }));
      expect(text.length, `bound ${maxResultChars}`).toBeLessThanOrEqual(maxResultChars);
    }
  });

  // One message longer than the whole bound is the only way nothing fits, and
  // answering with the notice alone would be a search that found something and
  // showed none of it. This is the one place a message is cut, and `truncate`
  // from ./mcp-bounds.ts is reused so #130's off-by-one is not reintroduced.
  it("truncates rather than showing nothing when a single message exceeds the bound", () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, CHANNEL), { recursive: true });
    store = openMessageStore({ channel: CHANNEL, root });
    stored("1700000000.000100", `vault ${"x".repeat(500)}`);

    const text = textOf(search({ query: "vault" }, { maxResultChars: 60 }));

    expect(text.length).toBeLessThanOrEqual(60);
    expect(text).toContain("vault");
  });

  it("returns everything when the bound is roomy", () => {
    expect(textOf(search({ query: "vault" })).split("\n")).toHaveLength(5);
  });
});

// An operator fault — two builds disagreeing about the schema, a Node without
// FTS5, an unreadable mount — is loud rather than degraded. `server.ts` catches
// it, writes an `unanswered` audit row and answers a constant 500, which is
// what that word is for and is honest in a way `unavailable` would not be.
describe("a store this build cannot read", () => {
  it("throws rather than answering the model, and logs a reason code", () => {
    const lines: { event: string; reason?: string }[] = [];
    const loud = createBuiltinDispatcher({
      storeRoot: root,
      logger: { log: (_level, fields) => lines.push(fields) }
    });

    const file = join(root, CHANNEL, "store.db");
    store.close();
    bumpVersion(file, MESSAGE_STORE_SCHEMA_VERSION + 1);

    expect(() => loud.run(callWith({ query: "vault" }), "search_channel_history", LIMITS)).toThrow(
      /schema version/
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "builtin_failed", channel: CHANNEL, tool: "search_channel_history" })
    );
    // A reason code, never the message: that one holds the file path.
    expect(JSON.stringify(lines)).not.toContain(root);

    // Put it back, only so afterEach has something to close.
    bumpVersion(file, MESSAGE_STORE_SCHEMA_VERSION);
    store = openMessageStore({ channel: CHANNEL, root });
  });
});

/** Reaching past the store's API on purpose: nothing else can forge a version. */
function bumpVersion(file: string, version: number): void {
  const db = new DatabaseSync(file);
  try {
    db.prepare("UPDATE schema_version SET version = ?").run(version);
  } finally {
    db.close();
  }
}
