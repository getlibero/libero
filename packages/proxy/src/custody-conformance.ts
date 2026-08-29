// The contract every credential backend must satisfy.
//
// ../../agent/src/embedding/conformance.ts's sibling, and the same promise: a
// backend that passes this suite is one a caller cannot tell apart from any
// other. #483's GCP Secret Manager and #484's AWS Secrets Manager ship a
// harness here and no changes to the assertions.
//
// There is one backend today, so this suite runs once. That is worth building
// anyway rather than after the second: the assertions are what say what the
// contract *is*, and writing them against two backends at once is how a
// contract ends up being whatever the first two happened to agree on.
//
// **This module never calls `reveal()`, and the harness supplies the unwrap.**
// outbound.test.ts holds two greps asserting that a value leaves a `Secret` in
// exactly two non-test source files, both in ./outbound.ts. This file is a
// `.ts` that is not a `.test.ts`, so calling `reveal()` here would mean
// widening a security contract to fit a test helper. Taking the unwrap from the
// harness keeps the only call site in ./custody-file.test.ts, where the greps
// already allow it, and costs one field.
//
// **What this suite cannot assert, said here so no reader assumes it is
// total:**
//
// - **"The serving process never writes the vault" is an import list**, proved
//   in ./vault.ts, again by ./custody-backend.ts not importing
//   ./custody-admin.ts, and again by the ESLint block on the composition root.
//   Its contract-level shadow is the structural walk below — a serving `Vault`
//   with no write member — and in a managed backend the fourth proof is IAM,
//   which is a docs claim rather than a test.
// - **Provenance** — that only values an authorization server just issued, for
//   an upstream some team sheet already names, reach the token store — is not
//   knowable to a store, which sees a string. What is asserted here is the
//   *shape* of the write surface: two methods, one requiring a whole
//   `GrantRecord` and one a binding, and no operator path at all. That `rotate`
//   is reachable only from the exchange's `persistRotation` is an import-list
//   claim in ./token-engine.ts.
// - **Persist-before-use's stronger half** — that the access token is withheld
//   until the rotation is durable — belongs to ./token-engine.ts and
//   ./outbound.ts and is asserted there. What is asserted here is the half a
//   store owns: when `rotate` resolves, a fresh handle reads the successor.
// - **The four rejection words** (`invalid_name`, `empty_value`,
//   `value_too_large`, `value_has_nul`) are matched as strings rather than
//   through `EntryRejection`/`GrantRejection`, which are still declared by the
//   two backend modules. They are contract-level in everything but their
//   location.

import { describe, it } from "node:test";
import { inspect } from "node:util";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { MAX_SECRET_BYTES } from "./custody.js";
import type { Custody, CustodyFailure, GrantRecord, Secret } from "./custody.js";
import type { VaultAdmin } from "./custody-admin.js";
import type { LogFields, LogLevel, Logger } from "./log.js";

/**
 * Shaped like real credentials, because the assertions that matter are all
 * negative — that these strings are not in a rendering, a log line, or an
 * error — and a distinctive prefix is what makes `not.toContain` mean
 * something.
 */
const VALUE = "ghp_leaked_value_16C7e42F292c6912E7710c838347Ae178B4a";
const REFRESH = "rt_live_refresh_token_2F292c6912E7710c838347Ae178B4a";
const NAME = "github_token";
const GRANT = "notion_grant";
const ISSUER = "https://as.example";
const BINDING = { issuer: ISSUER, scopes: ["mcp.read"] } as const;

const CUSTODY_FAILURES: readonly CustodyFailure[] = [
  "unreachable",
  "unauthorized",
  "bad_key_or_tampered",
  "malformed",
  "too_large"
];

const grant = (extra: Partial<GrantRecord> = {}): GrantRecord => ({
  issuer: ISSUER,
  clientId: "https://getlibero.com/client.json",
  refreshToken: REFRESH,
  scopes: ["mcp.read"],
  obtainedAt: 1_700_000_000_000,
  ...extra
});

/** One deployment's worth of storage, opened on an empty backing. */
export interface CustodyFixture {
  /** What the serving composition holds. */
  readonly stores: Custody;
  /** The operator's writer, opened separately — never the same handle. */
  readonly admin: VaultAdmin;
  /**
   * A second, independent handle on the same backing, as another process would
   * have. Every handle it returns is disposed by `dispose`.
   */
  reopen(): Promise<Custody>;
  /** Every word this backend's `reason` may carry. */
  readonly failureWords: readonly string[];
  /** Make the backing unreachable. An open store keeps whatever it holds. */
  sever(): void;
  /** Leave the backing present and unusable, so `reopen` fails. */
  corrupt(): void;
  dispose(): Promise<void>;
}

export interface CustodyHarness {
  readonly name: string;
  /**
   * A fresh, empty backing every time. `logger` collects what the backend says
   * while the fixture is used; `now` stamps a rotation.
   */
  open(deps?: { logger?: Logger; now?: () => number }): Promise<CustodyFixture>;
  /** The guarded act, so this module contains no `reveal()`. See the header. */
  reveal(secret: Secret): string;
}

/**
 * Every property name reachable by a caller, own and inherited.
 *
 * Walked rather than `Object.keys`ed because a backend may return a class
 * instance, whose methods are non-enumerable and live on a prototype. What the
 * assertion is about is what a caller can *reach*, which is neither of those
 * distinctions.
 */
function surfaceOf(value: object): readonly string[] {
  const names = new Set<string>();
  for (let cursor: object | null = value; cursor !== null && cursor !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name !== "constructor") names.add(name);
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return [...names].sort();
}

function recordingLogger(): { logger: Logger; text: () => string } {
  const lines: object[] = [];
  return {
    logger: {
      log: (level: LogLevel, fields: LogFields) => {
        lines.push({ level, fields });
      }
    },
    text: () => JSON.stringify(lines)
  };
}

export function runCustodyConformance(harness: CustodyHarness): void {
  describe(`${harness.name} custody conformance`, () => {
    /**
     * Each case opens its own backing and disposes it, rather than sharing one
     * through `beforeEach`. A managed backend's fixture is a namespace someone
     * pays for; making setup and teardown the case's own is what lets a harness
     * decide how to get one.
     */
    const withFixture = async (
      run: (fixture: CustodyFixture) => Promise<void> | void,
      deps?: { logger?: Logger; now?: () => number }
    ): Promise<void> => {
      const fixture = await harness.open(deps);
      try {
        await run(fixture);
      } finally {
        await fixture.dispose();
      }
    };

    // One name is one entry, and one name is one grant. The store's whole
    // addressing scheme, and the thing a backend keyed by anything else — a
    // path, a version, an ARN — has to reduce to.
    describe("keyed by credential name", () => {
      it("finds under the name it was set under, and counts it once", async () => {
        await withFixture(async ({ stores, admin, reopen }) => {
          await admin.set(NAME, VALUE);
          const opened = await reopen();

          const found = opened.vault.lookup(NAME);
          expect(found.status).toBe("found");
          expect(opened.vault.size).toBe(1);
          expect(stores.vault.lookup("not_loaded")).toEqual({ status: "missing" });
        });
      });

      it("replaces rather than stacks, in both stores", async () => {
        await withFixture(async ({ stores, admin, reopen }) => {
          await admin.set(NAME, VALUE);
          await admin.set(NAME, "ghp_second_value_written_over_the_first");
          await stores.tokens.putGrant(GRANT, grant());
          await stores.tokens.putGrant(GRANT, grant({ refreshToken: "rt_second" }));

          const opened = await reopen();
          expect(opened.vault.size).toBe(1);
          expect(opened.tokens.size).toBe(1);
          const read = await opened.tokens.read(GRANT, BINDING);
          expect(read.status === "found" && harness.reveal(read.refreshToken)).toBe("rt_second");
        });
      });

      // What justifies a Map over an object literal. On the latter these return
      // a function where a credential belongs.
      each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
        "misses %j rather than reaching the prototype",
        async name => {
          await withFixture(async ({ admin, reopen }) => {
            await admin.set(NAME, VALUE);
            const opened = await reopen();
            expect(opened.vault.lookup(name)).toEqual({ status: "missing" });
          });
        }
      );

      // Rejected before the store is consulted, so a caller that skipped its
      // own validation cannot reach the backing with a path segment.
      each([
        ["empty", ""],
        ["too long", "a".repeat(65)],
        ["a traversal", "../etc/passwd"],
        ["a separator", "a/b"],
        ["a leading dot", ".hidden"],
        ["a NUL", "name\0"]
      ])("misses %s, which is not a credential name", async (_label, name) => {
        await withFixture(async ({ stores, admin, reopen }) => {
          await admin.set(NAME, VALUE);
          const opened = await reopen();
          expect(opened.vault.lookup(name)).toEqual({ status: "missing" });
          expect(await stores.tokens.read(name, BINDING)).toEqual({
            status: "missing",
            reason: "absent"
          });
        });
      });

      it("is case-sensitive, as the team sheet's names are", async () => {
        await withFixture(async ({ admin, reopen }) => {
          await admin.set(NAME, VALUE);
          const opened = await reopen();
          expect(opened.vault.lookup(NAME.toUpperCase())).toEqual({ status: "missing" });
          expect(opened.vault.lookup(NAME).status).toBe("found");
        });
      });

      it("refuses a grant under a name that is not a credential name", async () => {
        await withFixture(async ({ stores }) => {
          await expect(stores.tokens.putGrant("../escape", grant())).rejects.toThrow(
            expect.objectContaining({ reason: "invalid_name" })
          );
        });
      });

      it("refuses a vault entry under a name that is not a credential name", async () => {
        await withFixture(async ({ admin }) => {
          await expect(async () => admin.set("../escape", VALUE)).rejects.toThrow(
            expect.objectContaining({ reason: "invalid_name" })
          );
        });
      });
    });

    // A name in, at most one secret out. The surface is the claim: a backend
    // cannot ship an `export()` or a `list()` that the type erased.
    describe("no get, and no listing beyond a count", () => {
      it("offers exactly the members the contract declares", async () => {
        await withFixture(({ stores, admin }) => {
          expect(surfaceOf(stores.vault)).toEqual(["lookup", "size"]);
          expect(surfaceOf(stores.tokens)).toEqual(["close", "putGrant", "read", "rotate", "size"]);
          expect(surfaceOf(stores)).toEqual(["close", "tokens", "vault"]);
          expect(surfaceOf(admin)).toEqual(["close", "names", "remove", "set"]);
        });
      });

      it("lists names on the operator path and nothing about them", async () => {
        await withFixture(async ({ admin }) => {
          await admin.set(NAME, VALUE);
          await admin.set("deploy_key", "ghp_a_second_credential_entirely");

          const names = await admin.names();
          expect([...names]).toEqual(["deploy_key", NAME]);
          expect(names.join(" ")).not.toContain("ghp_");
        });
      });

      it("counts what it holds without handing any of it back", async () => {
        await withFixture(async ({ stores, admin, reopen }) => {
          await admin.set(NAME, VALUE);
          await stores.tokens.putGrant(GRANT, grant());
          const opened = await reopen();
          expect(opened.vault.size).toBe(1);
          expect(opened.tokens.size).toBe(1);
        });
      });
    });

    // The custody decision, #254: two stores, two writer sets, no overlap.
    describe("disjoint writer sets", () => {
      it("gives the serving vault no way to write", async () => {
        await withFixture(({ stores }) => {
          for (const member of ["set", "put", "remove", "write", "delete", "rotate"]) {
            expect(surfaceOf(stores.vault)).not.toContain(member);
          }
        });
      });

      it("gives the operator no way to write a grant", async () => {
        await withFixture(({ admin }) => {
          for (const member of ["putGrant", "rotate", "read", "lookup"]) {
            expect(surfaceOf(admin)).not.toContain(member);
          }
        });
      });

      it("carries an operator's write to a vault opened afterwards", async () => {
        await withFixture(async ({ admin, reopen }) => {
          await admin.set(NAME, VALUE);
          expect((await reopen()).vault.lookup(NAME).status).toBe("found");
        });
      });

      it("carries the serving process's own write to a second handle", async () => {
        await withFixture(async ({ stores, reopen }) => {
          await stores.tokens.putGrant(GRANT, grant());
          expect((await reopen()).tokens.size).toBe(1);
        });
      });

      it("removes what the operator asks for, and says when there was nothing", async () => {
        await withFixture(async ({ admin, reopen }) => {
          await admin.set(NAME, VALUE);
          expect(await admin.remove(NAME)).toBe(true);
          expect(await admin.remove(NAME)).toBe(false);
          expect((await reopen()).vault.lookup(NAME)).toEqual({ status: "missing" });
        });
      });
    });

    // "Which store a name resolves in is the scheme's decision, never a
    // fallback." Neither of the two per-store suites can ask this.
    describe("the two stores share one namespace and never fall through", () => {
      it("does not resolve a vault entry as a grant", async () => {
        await withFixture(async ({ stores, admin, reopen }) => {
          await admin.set(NAME, VALUE);
          const opened = await reopen();
          expect(await opened.tokens.read(NAME, BINDING)).toEqual({
            status: "missing",
            reason: "absent"
          });
          expect(stores.vault.size).toBe(0);
        });
      });

      it("does not resolve a grant as a vault entry", async () => {
        await withFixture(async ({ stores, reopen }) => {
          await stores.tokens.putGrant(GRANT, grant());
          expect((await reopen()).vault.lookup(GRANT)).toEqual({ status: "missing" });
        });
      });
    });

    // The record's teeth. All three miss the same way — fail closed, re-grant —
    // but the reasons stay distinguishable because the remedy differs.
    describe("the grant's bindings", () => {
      it("finds no grant under a different issuer", async () => {
        await withFixture(async ({ stores }) => {
          await stores.tokens.putGrant(GRANT, grant());
          expect(
            await stores.tokens.read(GRANT, { ...BINDING, issuer: "https://other.example" })
          ).toEqual({ status: "missing", reason: "issuer_mismatch" });
        });
      });

      // Byte for byte, never normalized: a trailing slash is a different issuer.
      it("compares the issuer byte for byte", async () => {
        await withFixture(async ({ stores }) => {
          await stores.tokens.putGrant(GRANT, grant());
          const read = await stores.tokens.read(GRANT, { ...BINDING, issuer: `${ISSUER}/` });
          expect(read.status).toBe("missing");
        });
      });

      it("finds no grant for scopes wider than the grant holds", async () => {
        await withFixture(async ({ stores }) => {
          await stores.tokens.putGrant(GRANT, grant());
          expect(
            await stores.tokens.read(GRANT, { issuer: ISSUER, scopes: ["mcp.read", "mcp.write"] })
          ).toEqual({ status: "missing", reason: "scopes_exceeded" });
        });
      });

      it("serves scopes narrower than the grant", async () => {
        await withFixture(async ({ stores }) => {
          await stores.tokens.putGrant(GRANT, grant({ scopes: ["mcp.read", "mcp.write"] }));
          expect((await stores.tokens.read(GRANT, { issuer: ISSUER, scopes: [] })).status).toBe(
            "found"
          );
          expect(
            (await stores.tokens.read(GRANT, { issuer: ISSUER, scopes: ["mcp.write"] })).status
          ).toBe("found");
        });
      });

      it("tells absence apart from both refusals", async () => {
        await withFixture(async ({ stores }) => {
          expect(await stores.tokens.read(GRANT, BINDING)).toEqual({
            status: "missing",
            reason: "absent"
          });
        });
      });
    });

    // Two freshness rules, and they are opposite on purpose. The vault answers
    // from what it acquired at open — which is why `lookup` is synchronous —
    // and the token store re-reads, so a grant completed while the proxy runs
    // takes effect at the next mint with no restart.
    describe("freshness", () => {
      it("does not see an operator's write in a vault already open", async () => {
        await withFixture(async ({ stores, admin }) => {
          await admin.set(NAME, VALUE);
          expect(stores.vault.lookup(NAME)).toEqual({ status: "missing" });
        });
      });

      it("sees a grant another writer stored after open", async () => {
        await withFixture(async ({ stores, reopen }) => {
          expect((await stores.tokens.read(GRANT, BINDING)).status).toBe("missing");

          const granting = await reopen();
          await granting.tokens.putGrant(GRANT, grant());

          expect((await stores.tokens.read(GRANT, BINDING)).status).toBe("found");
        });
      });
    });

    describe("severing the backing", () => {
      it("leaves an open vault answering from what it holds", async () => {
        await withFixture(async ({ admin, reopen, sever }) => {
          await admin.set(NAME, VALUE);
          const opened = await reopen();
          sever();
          expect(opened.vault.lookup(NAME).status).toBe("found");
        });
      });
    });

    // The half a store owns: when the write resolves, it is durable. The other
    // half — the access token withheld until it is — is the engine's.
    describe("persist before use", () => {
      it("has the successor readable by a fresh handle once rotate resolves", async () => {
        let clock = 1_700_000_100_000;
        await withFixture(
          async ({ stores, reopen }) => {
            await stores.tokens.putGrant(GRANT, grant());
            clock = 1_700_000_200_000;
            await stores.tokens.rotate(GRANT, BINDING, "rt_successor");

            const read = await (await reopen()).tokens.read(GRANT, BINDING);
            expect(read.status === "found" && harness.reveal(read.refreshToken)).toBe(
              "rt_successor"
            );
          },
          { now: () => clock }
        );
      });

      it("has the grant readable by a fresh handle once putGrant resolves", async () => {
        await withFixture(async ({ stores, reopen }) => {
          await stores.tokens.putGrant(GRANT, grant());
          const read = await (await reopen()).tokens.read(GRANT, BINDING);
          expect(read.status === "found" && harness.reveal(read.refreshToken)).toBe(REFRESH);
        });
      });
    });

    describe("a rotation belongs to one lineage", () => {
      // The successor belongs to the grant that was spent. Merging it over a
      // grant made since would lose the newer one.
      it("drops a rotation whose record was replaced mid-flight", async () => {
        await withFixture(async ({ stores, reopen }) => {
          await stores.tokens.putGrant(GRANT, grant());

          const granting = await reopen();
          await granting.tokens.putGrant(
            GRANT,
            grant({ issuer: "https://new.example", refreshToken: "rt_fresh" })
          );

          await stores.tokens.rotate(GRANT, BINDING, "rt_stale_successor");

          const read = await stores.tokens.read(GRANT, {
            issuer: "https://new.example",
            scopes: ["mcp.read"]
          });
          expect(read.status === "found" && harness.reveal(read.refreshToken)).toBe("rt_fresh");
        });
      });

      it("drops a rotation for a grant that vanished, rather than creating one", async () => {
        await withFixture(async ({ stores }) => {
          await expect(stores.tokens.rotate(GRANT, BINDING, "rt_orphan")).resolves.toBeUndefined();
          expect((await stores.tokens.read(GRANT, BINDING)).status).toBe("missing");
        });
      });

      it("keeps both records when a rotate and a putGrant interleave", async () => {
        await withFixture(async ({ stores, reopen }) => {
          await stores.tokens.putGrant(GRANT, grant());

          await Promise.all([
            stores.tokens.rotate(GRANT, BINDING, "rt_rotated"),
            stores.tokens.putGrant("other_grant", grant({ refreshToken: "rt_other" }))
          ]);

          const again = await reopen();
          const rotated = await again.tokens.read(GRANT, BINDING);
          expect(rotated.status === "found" && harness.reveal(rotated.refreshToken)).toBe(
            "rt_rotated"
          );
          expect((await again.tokens.read("other_grant", BINDING)).status).toBe("found");
        });
      });

      it("survives a refused write without wedging the next one", async () => {
        await withFixture(async ({ stores }) => {
          await expect(stores.tokens.putGrant("bad name!", grant())).rejects.toThrow();
          await stores.tokens.putGrant(GRANT, grant());
          expect((await stores.tokens.read(GRANT, BINDING)).status).toBe("found");
        });
      });
    });

    // One cap on what a stored credential may weigh, wherever it is stored.
    describe("what a value may weigh", () => {
      each([
        ["empty", "", "empty_value"],
        ["oversized", "x".repeat(MAX_SECRET_BYTES + 1), "value_too_large"],
        ["NUL-carrying", "rt\0x", "value_has_nul"]
      ])("refuses %s on every write path", async (_label, value, reason) => {
        await withFixture(async ({ stores, admin }) => {
          await stores.tokens.putGrant(GRANT, grant());

          await expect(
            stores.tokens.putGrant("second_grant", grant({ refreshToken: value }))
          ).rejects.toThrow(expect.objectContaining({ reason }));
          await expect(stores.tokens.rotate(GRANT, BINDING, value)).rejects.toThrow(
            expect.objectContaining({ reason })
          );
          await expect(async () => admin.set(NAME, value)).rejects.toThrow(
            expect.objectContaining({ reason })
          );
        });
      });

      it("accepts a value exactly at the cap", async () => {
        await withFixture(async ({ admin, reopen }) => {
          await admin.set(NAME, "x".repeat(MAX_SECRET_BYTES));
          expect((await reopen()).vault.lookup(NAME).status).toBe("found");
        });
      });
    });

    // Every way JavaScript has of turning an object into text says
    // `[redacted]`, so a credential that reaches a log line or a response body
    // by accident arrives as that rather than as itself.
    describe("a value leaves only as a Secret", () => {
      const renderings: readonly [string, (value: object) => string][] = [
        ["JSON.stringify", value => JSON.stringify(value)],
        ["JSON.stringify of a wrapper", value => JSON.stringify({ credential: value })],
        ["JSON.stringify of an array", value => JSON.stringify([value])],
        ["String()", value => String(value)],
        ["template interpolation", value => `${value}`],
        ["concatenation", value => (value as unknown as string) + ""],
        ["an error message", value => new Error(`${value}`).message],
        ["util.inspect", value => inspect(value, { depth: null, showHidden: true })],
        ["spreading", value => JSON.stringify({ ...value })],
        ["Object.keys", value => JSON.stringify(Object.keys(value))]
      ];

      const secrets = async (fixture: CustodyFixture): Promise<readonly Secret[]> => {
        await fixture.admin.set(NAME, VALUE);
        await fixture.stores.tokens.putGrant(GRANT, grant());
        const opened = await fixture.reopen();

        const found = opened.vault.lookup(NAME);
        const read = await opened.tokens.read(GRANT, BINDING);
        if (found.status !== "found" || read.status !== "found") throw new Error("fixture lost");
        return [found.secret, read.refreshToken];
      };

      it("survives the one path that is meant to work", async () => {
        await withFixture(async fixture => {
          const [credential, refreshToken] = await secrets(fixture);
          expect(harness.reveal(credential as Secret)).toBe(VALUE);
          expect(harness.reveal(refreshToken as Secret)).toBe(REFRESH);
        });
      });

      each(renderings)("does not leak through %s", async (_label, render) => {
        await withFixture(async fixture => {
          for (const secret of await secrets(fixture)) {
            expect(render(secret)).not.toContain("ghp_");
            expect(render(secret)).not.toContain("rt_live");
          }
        });
      });

      it("is frozen, so reveal cannot be swapped for something that logs", async () => {
        await withFixture(async fixture => {
          for (const secret of await secrets(fixture)) {
            expect(Object.isFrozen(secret)).toBe(true);
          }
        });
      });

      it("keeps a whole read out of a rendering of it", async () => {
        await withFixture(async ({ stores, reopen }) => {
          await stores.tokens.putGrant(GRANT, grant());
          const read = await (await reopen()).tokens.read(GRANT, BINDING);
          expect(JSON.stringify(read)).not.toContain("rt_live");
        });
      });
    });

    describe("nothing a backend says carries a value", () => {
      it("keeps every value out of every log line", async () => {
        const { logger, text } = recordingLogger();
        await withFixture(
          async ({ stores, admin, reopen }) => {
            await admin.set(NAME, VALUE);
            await stores.tokens.putGrant(GRANT, grant());
            const opened = await reopen();
            opened.vault.lookup(NAME);
            await opened.tokens.read(GRANT, BINDING);
            await opened.tokens.rotate(GRANT, BINDING, "rt_successor_value");
          },
          { logger }
        );

        expect(text()).not.toContain("ghp_");
        expect(text()).not.toContain("rt_live");
        expect(text()).not.toContain("rt_successor_value");
      });

      each([
        ["String", (error: unknown) => String(error)],
        ["the stack", (error: unknown) => String((error as Error).stack ?? "")],
        [
          "own properties",
          (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error))
        ],
        ["util.inspect", (error: unknown) => inspect(error, { depth: null, showHidden: true })]
      ])("keeps a value out of a refused write rendered through %s", async (_label, render) => {
        await withFixture(async ({ stores }) => {
          let thrown: unknown;
          try {
            await stores.tokens.putGrant("bad name!", grant());
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeDefined();
          expect(render(thrown)).not.toContain("rt_live");
        });
      });
    });

    // The two-level vocabulary. A backend keeps its own closed set — an
    // operator deserves the precise word — and maps it onto the contract's, so
    // a caller that does not know which backend this is has five words rather
    // than a union that grows with every backend.
    describe("the failure vocabulary", () => {
      it("reports a corrupt backing in both vocabularies, and in no other words", async () => {
        await withFixture(async fixture => {
          fixture.corrupt();

          let thrown: unknown;
          try {
            await fixture.reopen();
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeDefined();
          const failure = (thrown as { failure?: unknown }).failure;
          const reason = (thrown as { reason?: unknown }).reason;
          expect(CUSTODY_FAILURES).toContain(failure);
          expect(fixture.failureWords).toContain(reason);
        });
      });

      // `util.inspect` prints the cause chain, and an error thrown out of a
      // crypto library or an SDK can carry buffer contents in it.
      it("attaches no cause, so nothing from underneath is carried along", async () => {
        await withFixture(async fixture => {
          fixture.corrupt();

          let thrown: unknown;
          try {
            await fixture.reopen();
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeDefined();
          expect((thrown as { cause?: unknown }).cause).toBeUndefined();
        });
      });

      it("treats an absent backing as empty rather than as a failure", async () => {
        await withFixture(async ({ stores }) => {
          expect(stores.vault.size).toBe(0);
          expect(stores.tokens.size).toBe(0);
          expect(stores.vault.lookup(NAME)).toEqual({ status: "missing" });
          expect(await stores.tokens.read(GRANT, BINDING)).toEqual({
            status: "missing",
            reason: "absent"
          });
        });
      });
    });

    describe("close", () => {
      it("refuses reads and writes afterwards", async () => {
        await withFixture(async ({ stores }) => {
          stores.close();
          await expect(async () => stores.tokens.read(GRANT, BINDING)).rejects.toThrow();
          await expect(stores.tokens.putGrant(GRANT, grant())).rejects.toThrow();
        });
      });

      it("refuses an operator's writes after the admin closes", async () => {
        await withFixture(async ({ admin }) => {
          admin.close();
          await expect(async () => admin.set(NAME, VALUE)).rejects.toThrow();
          await expect(async () => admin.names()).rejects.toThrow();
        });
      });
    });
  });
}
