// The AWS backend, run against the contract.
//
// A harness and one call, ./custody-file.test.ts's shape and ./custody-gcp.test.ts's
// — the same seventy-six cases, against a third store that shares no code with
// either below ./custody.ts. No contract assertions here.
//
// The fake is ./fake-secrets-manager.ts and it verifies every signature, so the
// cases below are also the first thing that would fail if SigV4 were wrong.
// `packages/aws-conformance` runs the same suite against LocalStack, which is an
// independent implementation of the API and *not* of the signing.

import { afterEach, describe, it } from "node:test";
import { expect } from "expect";
import { openAwsCustody, openAwsVaultAdmin } from "./custody-aws.js";
import { runCustodyConformance } from "./custody-conformance.js";
import type { CustodyFixture } from "./custody-conformance.js";
import type { Custody } from "./custody.js";
import { startFakeSecretsManager } from "./fake-secrets-manager.js";
import type { FakeSecretsManager } from "./fake-secrets-manager.js";

let fakes: FakeSecretsManager[] = [];

afterEach(async () => {
  await Promise.all(fakes.map(async fake => fake.close()));
  fakes = [];
});

const started = async () => {
  const fake = await startFakeSecretsManager();
  fakes.push(fake);
  const prefix = `t${Math.random().toString(36).slice(2, 10)}`;
  return { fake, options: { region: fake.region, prefix, endpoints: fake.endpoints } };
};

runCustodyConformance({
  name: "aws secrets manager",

  reveal: secret => secret.reveal(),

  async open(deps = {}): Promise<CustodyFixture> {
    const { fake, options } = await started();

    const opened: Custody[] = [];
    const stores = await openAwsCustody(options, deps);
    const admin = await openAwsVaultAdmin(options);

    return {
      stores,
      admin,

      async reopen(): Promise<Custody> {
        const handle = await openAwsCustody(options, deps);
        opened.push(handle);
        return handle;
      },

      failureWords: [
        "unreachable",
        "timed_out",
        "denied",
        "redirected",
        "too_large",
        "malformed_response"
      ],

      sever(): void {
        fake.failWith = "InternalServiceError";
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

// True of *this* backend and false of the other two, which is why they are here
// rather than in the conformance suite.
describe("what the aws backend does that the contract does not ask", () => {
  it("signs every call, and the fake would refuse one that did not recompute", async () => {
    const { fake, options } = await started();
    const admin = await openAwsVaultAdmin(options);
    await admin.set("github_token", "ghp_value");
    admin.close();

    expect(fake.actions.length).toBeGreaterThan(0);
    expect(fake.rejectedSignatures).toBe(0);
  });

  // IMDSv2's whole difference from v1: an unauthenticated GET is refused, so
  // the credentials cannot be read by a request forged somewhere else that
  // cannot first do a PUT.
  it("takes credentials over IMDSv2, token first", async () => {
    const { fake, options } = await started();
    const custody = await openAwsCustody(options);
    custody.close();

    expect(fake.metadataPaths[0]).toBe("/latest/api/token");
    expect(fake.metadataPaths).toContain("/latest/meta-data/iam/security-credentials/");
  });

  it("acquires credentials once for a whole open", async () => {
    const { fake, options } = await started();
    const admin = await openAwsVaultAdmin(options);
    for (const name of ["one", "two", "three"]) await admin.set(name, `value_${name}`);
    admin.close();

    const before = fake.metadataPaths.length;
    const custody = await openAwsCustody(options);
    expect(custody.vault.size).toBe(3);
    // Three IMDS legs — the PUT, the role, the credentials — and no more.
    expect(fake.metadataPaths.length - before).toBe(3);
    custody.close();
  });

  // **The divergence from AWS convention, asserted.** `PutSecretValue` leaves
  // the superseded value readable as `AWSPREVIOUS`; this backend strips the
  // label so it stops being retrievable, which is what GCP's destroy-old buys
  // and what a rotated refresh token needs.
  it("strips AWSPREVIOUS, so a superseded value stops being retrievable", async () => {
    const { fake, options } = await started();
    const prefix = options.prefix;
    const admin = await openAwsVaultAdmin(options);
    await admin.set("github_token", "ghp_first");
    await admin.set("github_token", "ghp_second");
    admin.close();

    expect(fake.actions).toContain("UpdateSecretVersionStage");
    const stages = Object.values(fake.stagesOf(`${prefix}/vault/github_token`));
    expect(stages.filter(labels => labels.includes("AWSCURRENT"))).toHaveLength(1);
    expect(stages.some(labels => labels.includes("AWSPREVIOUS"))).toBe(false);

    const custody = await openAwsCustody(options);
    const found = custody.vault.lookup("github_token");
    expect(found.status === "found" && found.secret.reveal()).toBe("ghp_second");
    custody.close();
  });

  // Where the GCP backend has to refuse a dotted name, this one does not:
  // Secrets Manager names allow the character. A deployment moving from GCP to
  // AWS gains names; one moving the other way may have to rename.
  it("stores a credential name a GCP secret id could not spell", async () => {
    const { options } = await started();
    const admin = await openAwsVaultAdmin(options);
    await admin.set("stripe.live", "sk_live_value");
    expect(await admin.names()).toContain("stripe.live");
    admin.close();

    const custody = await openAwsCustody(options);
    expect(custody.vault.lookup("stripe.live").status).toBe("found");
    custody.close();
  });

  // `ForceDeleteWithoutRecovery`: the name is reusable immediately. With AWS's
  // default recovery window this second `set` would fail for up to thirty days.
  it("frees the name immediately, so remove and re-set works", async () => {
    const { options } = await started();
    const admin = await openAwsVaultAdmin(options);
    await admin.set("github_token", "ghp_first");
    expect(await admin.remove("github_token")).toBe(true);
    await admin.set("github_token", "ghp_second");
    admin.close();

    const custody = await openAwsCustody(options);
    const found = custody.vault.lookup("github_token");
    expect(found.status === "found" && found.secret.reveal()).toBe("ghp_second");
    custody.close();
  });

  it("reports a refused call as unauthorized rather than unreachable", async () => {
    const { fake, options } = await started();
    fake.failWith = "AccessDeniedException";

    await expect(openAwsCustody(options)).rejects.toThrow(
      expect.objectContaining({ reason: "denied", failure: "unauthorized" })
    );
  });

  // A signing mistake arrives as `denied` rather than anywhere quieter, which
  // is the direction that makes hand-rolled SigV4 acceptable.
  it("reports a refused signature as denied", async () => {
    const { fake, options } = await started();
    fake.failWith = "InvalidSignatureException";

    await expect(openAwsCustody(options)).rejects.toThrow(
      expect.objectContaining({ reason: "denied", failure: "unauthorized" })
    );
  });

  it("walks every page of a listing", async () => {
    const { fake, options } = await started();
    const admin = await openAwsVaultAdmin(options);
    for (let index = 0; index < 7; index += 1) await admin.set(`cred_${index}`, `value_${index}`);
    fake.pageSize = 2;

    expect(await admin.names()).toHaveLength(7);
    admin.close();

    const custody = await openAwsCustody(options);
    expect(custody.vault.size).toBe(7);
    custody.close();
  });

  it("lists grant names at open without reading their values", async () => {
    const { fake, options } = await started();
    const custody = await openAwsCustody(options);
    await custody.tokens.putGrant("notion_grant", {
      issuer: "https://as.example",
      clientId: "https://getlibero.com/client.json",
      refreshToken: "rt_live_value",
      scopes: ["mcp.read"],
      obtainedAt: 1_700_000_000_000
    });
    custody.close();

    const before = fake.actions.length;
    const reopened = await openAwsCustody(options);
    expect(reopened.tokens.size).toBe(1);
    // Two listings and nothing else: no `GetSecretValue` for the grant.
    expect(fake.actions.slice(before)).toEqual(["ListSecrets", "ListSecrets"]);
    reopened.close();
  });
});
