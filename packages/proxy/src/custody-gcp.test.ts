// The GCP backend, run against the contract.
//
// A harness and one call, which is what #482's seam is for: seventy-six cases
// that the file backend already passes, asserting the same things about a store
// that is two HTTP servers away and shares no code with it below ./custody.ts.
// No assertion here — an assertion added to this file would be a claim about
// one backend masquerading as a claim about the contract.
//
// The fake is ./fake-secret-manager.ts, and its header says what it does and
// does not prove. What only a real project can answer — IAM, quotas,
// replication, eventual consistency — is not answered here, and #483 shipped
// without one.

import { afterEach, describe, it } from "node:test";
import { expect } from "expect";
import { openGcpCustody, openGcpVaultAdmin } from "./custody-gcp.js";
import { runCustodyConformance } from "./custody-conformance.js";
import type { CustodyFixture } from "./custody-conformance.js";
import type { Custody } from "./custody.js";
import { startFakeSecretManager } from "./fake-secret-manager.js";
import type { FakeSecretManager } from "./fake-secret-manager.js";

const PROJECT = "libero-test";

let fakes: FakeSecretManager[] = [];

afterEach(async () => {
  await Promise.all(fakes.map(async fake => fake.close()));
  fakes = [];
});

runCustodyConformance({
  name: "gcp secret manager",

  reveal: secret => secret.reveal(),

  async open(deps = {}): Promise<CustodyFixture> {
    const fake = await startFakeSecretManager();
    fakes.push(fake);

    // A prefix per fixture, so a case that leaks state into another shows up as
    // a failure rather than as a passing test sharing a namespace.
    const prefix = `t${Math.random().toString(36).slice(2, 10)}`;
    const options = { project: PROJECT, prefix, endpoints: fake.endpoints };

    const opened: Custody[] = [];
    const stores = await openGcpCustody(options, deps);
    const admin = await openGcpVaultAdmin(options);

    return {
      stores,
      admin,

      async reopen(): Promise<Custody> {
        const handle = await openGcpCustody(options, deps);
        opened.push(handle);
        return handle;
      },

      // The client's own closed set. `denied` is the one the file backend has
      // no equivalent of, and the one an operator meets first.
      failureWords: [
        "unreachable",
        "timed_out",
        "denied",
        "redirected",
        "too_large",
        "malformed_response"
      ],

      sever(): void {
        // Every call answers 503 from here on. An open vault must still answer
        // from what it holds, which is the freshness clause under test.
        fake.failWith = 503;
      },

      corrupt(): void {
        fake.malformed = true;
      },

      async dispose(): Promise<void> {
        for (const handle of opened) handle.close();
        stores.close();
        admin.close();
        await fake.close();
        fakes = fakes.filter(entry => entry !== fake);
      }
    };
  }
});

// Not contract claims — these are true of *this* backend and would be false of
// the file one, which is why they are here rather than in the conformance
// suite.
describe("what the gcp backend does that the contract does not ask", () => {
  const open = async () => {
    const fake = await startFakeSecretManager();
    fakes.push(fake);
    const prefix = `t${Math.random().toString(36).slice(2, 10)}`;
    return { fake, options: { project: PROJECT, prefix, endpoints: fake.endpoints } };
  };

  it("carries the metadata server's token on every Secret Manager call", async () => {
    const { fake, options } = await open();
    const admin = await openGcpVaultAdmin(options);
    await admin.set("github_token", "ghp_value");
    admin.close();

    expect(fake.requests).toContain("/computeMetadata/v1/instance/service-accounts/default/token");
    expect(fake.bearers.length).toBeGreaterThan(0);
    expect(new Set(fake.bearers)).toEqual(new Set([`Bearer ${fake.accessToken}`]));
  });

  // One token however many calls follow: the metadata leg is asked once and
  // cached, which is what keeps a startup that accesses N secrets from making
  // 2N requests.
  it("fetches one access token for a whole open", async () => {
    const { fake, options } = await open();
    const admin = await openGcpVaultAdmin(options);
    for (const name of ["one", "two", "three"]) await admin.set(name, `value_${name}`);
    admin.close();

    const before = fake.requests.filter(path => path.endsWith("/token")).length;
    const custody = await openGcpCustody(options);
    const after = fake.requests.filter(path => path.endsWith("/token")).length;
    expect(custody.vault.size).toBe(3);
    expect(after - before).toBe(1);
    custody.close();
  });

  // Replace-not-stack as add-version / destroy-old: the superseded value stops
  // being retrievable rather than merely stopping being latest. The file
  // backend cannot make this claim — it overwrites the whole blob.
  it("destroys the predecessor version rather than leaving it enabled", async () => {
    const { fake, options } = await open();
    const admin = await openGcpVaultAdmin(options);
    await admin.set("github_token", "ghp_first");
    await admin.set("github_token", "ghp_second");
    admin.close();

    const destroyed = fake.requests.filter(path => path.endsWith(":destroy"));
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toContain("/versions/1:destroy");

    const custody = await openGcpCustody(options);
    const found = custody.vault.lookup("github_token");
    expect(found.status === "found" && found.secret.reveal()).toBe("ghp_second");
    custody.close();
  });

  // A dot is a legal CredentialName and not a legal secret id. Refused on the
  // way in, at the one place an operator can fix it — never a silent miss on a
  // name that looked storable. See ./custody-gcp.ts's header.
  it("refuses a credential name a secret id cannot spell", async () => {
    const { options } = await open();
    const admin = await openGcpVaultAdmin(options);
    await expect(admin.set("stripe.live", "sk_live_value")).rejects.toThrow(
      expect.objectContaining({ reason: "invalid_name" })
    );
    admin.close();
  });

  // The word ./custody.ts reserved before anything could produce it: a call
  // without the right bearer is IAM, not the network, and an operator told
  // "unreachable" would go and check their VPC.
  it("reports a refused call as unauthorized rather than unreachable", async () => {
    const { fake, options } = await open();
    fake.failWith = 403;

    await expect(openGcpCustody(options)).rejects.toThrow(
      expect.objectContaining({ reason: "denied", failure: "unauthorized" })
    );
  });

  it("walks every page of a listing", async () => {
    const { fake, options } = await open();
    const admin = await openGcpVaultAdmin(options);
    for (let index = 0; index < 7; index += 1) await admin.set(`cred_${index}`, `value_${index}`);
    fake.pageSize = 2;

    expect(await admin.names()).toHaveLength(7);
    admin.close();

    const custody = await openGcpCustody(options);
    expect(custody.vault.size).toBe(7);
    custody.close();
  });

  // A grant's value is never read at open — `size` is a count, and reading
  // every grant would be paying for values the engine re-reads at mint anyway.
  it("lists grant names at open without accessing their values", async () => {
    const { fake, options } = await open();
    const custody = await openGcpCustody(options);
    await custody.tokens.putGrant("notion_grant", {
      issuer: "https://as.example",
      clientId: "https://getlibero.com/client.json",
      refreshToken: "rt_live_value",
      scopes: ["mcp.read"],
      obtainedAt: 1_700_000_000_000
    });
    custody.close();

    const reopened = await openGcpCustody(options);
    const accessed = fake.requests.filter(path => path.endsWith(":access"));
    expect(reopened.tokens.size).toBe(1);
    expect(accessed.some(path => path.includes("-grant-"))).toBe(false);
    reopened.close();
  });

  // `secretmanager.secrets.create` is project-level, so an operator may keep it
  // from the serving principal and create the signing secret by hand. The
  // create is attempted and its denial is not fatal; what would be fatal is the
  // version write, which is where a deployment that did neither finds out.
  it("fills a signing secret it was not allowed to create", async () => {
    const { fake, options } = await open();
    // The operator's own act: the secret exists and holds no version.
    const admin = await openGcpVaultAdmin(options);
    admin.close();
    const created = await fetch(
      `${fake.endpoints.secretManager}/v1/projects/${PROJECT}/secrets?secretId=${options.prefix}-signing-dpop`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${fake.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ replication: { automatic: {} }, labels: { "libero-kind": "signing" } })
      }
    );
    expect(created.status).toBe(200);

    fake.denyCreate = true;
    const custody = await openGcpCustody(options);
    const key = await custody.signing.signingKey();
    // And the same key on the next open, which is the whole point of filling
    // the operator's secret rather than holding a key only in memory.
    const reopened = await openGcpCustody(options);
    expect((await reopened.signing.signingKey()).thumbprint).toBe(key.thumbprint);
    custody.close();
    reopened.close();
  });

  it("reports a signing key it may neither create nor write as denied", async () => {
    const { fake, options } = await open();
    fake.denyCreate = true;
    const custody = await openGcpCustody(options);

    await expect(async () => custody.signing.signingKey()).rejects.toThrow(
      expect.objectContaining({ reason: "denied", failure: "unauthorized" })
    );
    custody.close();
  });
});

// #529. The contract's "adopts one key when two handles ask" is a conformance
// case and it failed here about once in twenty-five runs, which is a suite
// saying something true and saying it too quietly to act on. These are the
// properties that make the race impossible rather than unlikely, each asserted
// on its own so that a regression names which one went.
//
// They are backend-specific by nature: the file backend has `O_EXCL` and the
// AWS one has a `CreateSecret` that carries the first value, so neither has a
// version to choose between. Only this backend writes in two calls.
describe("what makes the gcp signing key converge when two handles mint (#529)", () => {
  const open = async () => {
    const fake = await startFakeSecretManager();
    fakes.push(fake);
    const prefix = `t${Math.random().toString(36).slice(2, 10)}`;
    return { fake, options: { project: PROJECT, prefix, endpoints: fake.endpoints } };
  };

  /** The signing secret's id, spelled as `custody-gcp.ts` spells it. */
  const signingSecret = (prefix: string): string => `${prefix}-signing-dpop`;

  /** The operator's own act: the secret exists and holds no version. */
  const precreate = async (fake: FakeSecretManager, prefix: string): Promise<void> => {
    const created = await fetch(
      `${fake.endpoints.secretManager}/v1/projects/${PROJECT}/secrets?secretId=${signingSecret(prefix)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${fake.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ replication: { automatic: {} }, labels: { "libero-kind": "signing" } })
      }
    );
    expect(created.status).toBe(200);
  };

  /** A version written behind the store's back, as a second process would. */
  const appendVersion = async (
    fake: FakeSecretManager,
    prefix: string,
    value: string
  ): Promise<void> => {
    const added = await fetch(
      `${fake.endpoints.secretManager}/v1/projects/${PROJECT}/secrets/${signingSecret(prefix)}:addVersion`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${fake.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          payload: { data: Buffer.from(value, "utf8").toString("base64") }
        })
      }
    );
    expect(added.status).toBe(200);
  };

  // The read is by number, and this is the property the convergence rests on:
  // whatever a racer wrote afterwards, every process answers with version 1.
  it("reads version 1, so a version written after it cannot change the answer", async () => {
    const { fake, options } = await open();
    const custody = await openGcpCustody(options);
    const minted = await custody.signing.signingKey();
    custody.close();

    // A second process's key, landing after the first. Under `latest` this is
    // the value every later open would adopt, and every grant bound to the
    // first would be stranded with no record of why.
    await appendVersion(fake, options.prefix, "a second process's material");

    const reopened = await openGcpCustody(options);
    expect((await reopened.signing.signingKey()).thumbprint).toBe(minted.thumbprint);
    reopened.close();

    expect(fake.requests.some(path => path.endsWith("/versions/1:access"))).toBe(true);
    expect(
      fake.requests.some(
        path => path.includes(signingSecret(options.prefix)) && path.endsWith("/versions/latest:access")
      )
    ).toBe(false);
  });

  // The arbiter, where there is one. A secret that already existed is one
  // somebody else owns, so the second handle adopts rather than writing — which
  // is what keeps the stacked version above a rarity rather than the norm.
  it("writes nothing when it lost the create", async () => {
    const { fake, options } = await open();
    const first = await openGcpCustody(options);
    const minted = await first.signing.signingKey();

    const before = fake.requests.filter(path => path.endsWith(":addVersion")).length;
    const second = await openGcpCustody(options);
    expect((await second.signing.signingKey()).thumbprint).toBe(minted.thumbprint);
    expect(fake.requests.filter(path => path.endsWith(":addVersion")).length).toBe(before);

    first.close();
    second.close();
  });

  // The residual, **driven rather than waited for**. The conformance case caught
  // this by luck about once in twenty-five runs, which is why the barrier is
  // here: both handles are held at the write until both have arrived, so the
  // interleaving that used to strand a key is the one this case always takes.
  //
  // The two arrive there at all because the secret is pre-created and empty —
  // the operator's shape — so neither wins the create and neither finds a
  // version. Convergence is then by construction rather than by ordering: both
  // versions survive the write, and version 1 is what both read back.
  it("adopts one key when both handles write, because both read version 1", async () => {
    const { fake, options } = await open();
    await precreate(fake, options.prefix);

    let arrived = 0;
    let release = (): void => {};
    const both = new Promise<void>(resolve => {
      release = resolve;
    });
    // Wrapping `fetch` rather than gating the fake: the seam already exists for
    // exactly this, and a knob on the fake would be a second way to express one
    // test's ordering.
    const held: typeof globalThis.fetch = async (input, init) => {
      if (String(input).endsWith(":addVersion")) {
        arrived += 1;
        if (arrived === 2) release();
        await both;
      }
      return fetch(input, init);
    };
    const gated = { ...options, fetch: held };

    const a = await openGcpCustody(gated);
    const b = await openGcpCustody(gated);
    const [first, second] = await Promise.all([a.signing.signingKey(), b.signing.signingKey()]);

    expect(second.thumbprint).toBe(first.thumbprint);
    // Both wrote — the control. Without it this asserts convergence on a race
    // that did not happen, which is the one way it could pass for the wrong
    // reason, and it is how the conformance case was passing most days.
    expect(arrived).toBe(2);
    expect(
      fake.requests.filter(
        path => path.includes(signingSecret(options.prefix)) && path.endsWith(":addVersion")
      ).length
    ).toBe(2);
    // And neither key was destroyed under its holder. Version 2 is inert:
    // nothing reads it, and nothing later adds to it.
    expect(fake.requests.some(path => path.endsWith(":destroy"))).toBe(false);

    a.close();
    b.close();
  });
});
