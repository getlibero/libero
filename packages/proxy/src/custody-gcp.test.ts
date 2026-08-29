// The GCP backend, run against the contract.
//
// A harness and one call, which is what #482's seam is for: sixty-seven cases
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
});
