// The custody contract over AWS Secrets Manager (#484).
//
// ./custody-gcp.ts's sibling, in the shape #483 proved out: ./custody.ts is
// what this implements, ./custody-conformance.ts is what checks it, and
// ./custody-aws-client.ts is the wire. No assertions of its own.
//
// **One secret per credential name**, `<prefix>/vault/<name>` and
// `<prefix>/grant/<name>`, tagged `libero-kind` and `libero-deployment`. Slashes
// rather than the GCP backend's dashes because AWS allows them in a name and
// they are what the console groups on, and because a slash cannot appear in a
// `CredentialName` — so the separator can never be part of a name, which is
// what makes the mapping reversible without escaping.
//
// **Two differences from the GCP backend that an operator will notice.**
//
// *A dot is fine here.* Secrets Manager names allow `[A-Za-z0-9/_+=.@-]`, which
// covers every `CredentialName`, so the restriction ./custody-gcp.ts has to
// impose does not exist on this backend. A deployment moving from GCP to AWS
// gains names; one moving the other way may have to rename.
//
// *Removal is irreversible.* `DeleteSecret` defaults to a recovery window of up
// to thirty days, during which the name cannot be reused — which turns
// `vault remove x` followed by `vault set x` into a failure with no workaround.
// This backend passes `ForceDeleteWithoutRecovery`, so `remove` means gone. The
// operator act it was always paired with — revoking the credential at the
// service that issued it — is not undoable either.
//
// **The signing key is a third kind of secret here too** (#504),
// `<prefix>/signing/dpop`, tagged `signing` so it lists with neither of the
// others. `CreateSecret` carries a first value and refuses a name that exists,
// which makes create-if-absent one call rather than the GCP backend's three —
// the one place this backend's API is the better shape for what #504 needs.
//
// What it shares with GCP, and what makes both worth having: names are metadata
// here too, so the credential inventory the file backend hides behind whole-set
// encryption is visible to anyone holding `secretsmanager:ListSecrets`, bought
// back by a resource-scoped policy the file backend cannot express. And there is
// no master key — Secrets Manager encrypts at rest under a KMS key — so
// `vaultKeyFromEnv` is never reached on this branch.

import {
  GrantEntryError,
  VaultEntryError,
  credentialNameRejection,
  credentialValueRejection,
  grantBindingHolds,
  makeSecret,
  parseGrantRecord,
  readGrant
} from "./custody.js";
import type {
  Custody,
  CredentialLookup,
  GrantBinding,
  GrantRead,
  GrantRecord,
  TokenStore,
  Vault
} from "./custody.js";
import type { VaultAdmin } from "./custody-admin.js";
import { AwsCustodyError, createSecretsManagerClient } from "./custody-aws-client.js";
import type { AwsClientOptions, SecretsManagerClient } from "./custody-aws-client.js";
import type { Logger } from "./log.js";
import { openSigningKeyStore } from "./signing-key.js";

/** ./custody-gcp.ts's batch, for its reason. */
const OPEN_CONCURRENCY = 8;

const KIND_TAG = "libero-kind";
const DEPLOYMENT_TAG = "libero-deployment";

/**
 * A deployment's own slice of an account.
 *
 * Constrained to what a tag value and a name segment both accept, and checked
 * at config time: a bad prefix would otherwise be a `ListSecrets` filter that
 * matches nothing, which looks exactly like an empty vault.
 */
const PREFIX = /^[a-z][a-z0-9_-]{0,30}$/;

export interface AwsCustodyOptions extends AwsClientOptions {
  readonly prefix: string;
}

export interface AwsCustodyDeps {
  readonly logger?: Logger;
  readonly now?: () => number;
}

export function assertUsablePrefix(prefix: string): void {
  if (!PREFIX.test(prefix)) {
    throw new Error(
      "proxy: PROXY_AWS_SECRET_PREFIX must be lowercase letters, digits, dash or underscore, starting with a letter"
    );
  }
}

/** ./custody-gcp.ts's three kinds, and its `SIGNING_NAME`, for its reasons. */
type SecretKind = "vault" | "grant" | "signing";

const SIGNING_NAME = "dpop";

const leadFor = (prefix: string, kind: SecretKind): string => `${prefix}/${kind}/`;

/**
 * `null` when this is not a name this backend could have written.
 *
 * Unlike the GCP backend there is no character to refuse: every
 * `CredentialName` is a legal segment of a Secrets Manager name.
 */
function secretName(prefix: string, kind: SecretKind, name: string): string | null {
  if (credentialNameRejection(name) !== null) return null;
  return `${leadFor(prefix, kind)}${name}`;
}

function nameOf(prefix: string, kind: SecretKind, secret: string): string | null {
  const lead = leadFor(prefix, kind);
  if (!secret.startsWith(lead)) return null;
  const name = secret.slice(lead.length);
  return credentialNameRejection(name) === null ? name : null;
}

const tagsFor = (prefix: string, kind: SecretKind): Record<string, string> => ({
  [KIND_TAG]: kind,
  [DEPLOYMENT_TAG]: prefix
});

async function getAll(
  client: SecretsManagerClient,
  names: readonly string[]
): Promise<ReadonlyMap<string, string>> {
  const values = new Map<string, string>();
  for (let start = 0; start < names.length; start += OPEN_CONCURRENCY) {
    const batch = names.slice(start, start + OPEN_CONCURRENCY);
    const answers = await Promise.all(batch.map(async name => [name, await client.get(name)] as const));
    for (const [name, value] of answers) {
      if (value !== null) values.set(name, value);
    }
  }
  return values;
}

/**
 * Open both stores against Secrets Manager.
 *
 * ./custody-gcp.ts's shape, for its reasons: the vault is read whole here and
 * once, because `Vault.lookup` is synchronous and answers from state acquired
 * at open with no I/O on the serving path; grant *names* are listed for the
 * count and their values are never read, because the engine re-reads them at
 * mint anyway.
 */
export async function openAwsCustody(
  options: AwsCustodyOptions,
  deps: AwsCustodyDeps = {}
): Promise<Custody> {
  assertUsablePrefix(options.prefix);
  const { prefix } = options;
  const logger = deps.logger;
  const now = deps.now ?? Date.now;
  const client = createSecretsManagerClient({
    ...options,
    ...(logger !== undefined ? { logger } : {})
  });

  const wanted: string[] = [];
  for (const secret of await client.list(leadFor(prefix, "vault"))) {
    if (nameOf(prefix, "vault", secret.name) !== null) wanted.push(secret.name);
  }
  const values = await getAll(client, wanted);

  const entries = new Map<string, string>();
  for (const [secret, value] of values) {
    const name = nameOf(prefix, "vault", secret);
    if (name !== null) entries.set(name, value);
  }
  logger?.log("info", { event: "vault_opened", count: entries.size });

  const grants = new Set<string>();
  for (const secret of await client.list(leadFor(prefix, "grant"))) {
    const name = nameOf(prefix, "grant", secret.name);
    if (name !== null) grants.add(name);
  }
  logger?.log("info", { event: "token_store_opened", count: grants.size });

  const vault: Vault = {
    lookup(name: string): CredentialLookup {
      if (credentialNameRejection(name) !== null) return { status: "missing" };
      const value = entries.get(name);
      return value === undefined ? { status: "missing" } : { status: "found", secret: makeSecret(value) };
    },
    get size() {
      return entries.size;
    }
  };

  // The store's one mutex, ./custody-gcp.ts's and ./token-store.ts's. The
  // read-merge-write it exists for in the file backend is gone — one grant is
  // one secret — but a rotation and a grant must still not interleave their
  // read and their write.
  let writing: Promise<void> = Promise.resolve();
  const serialize = (job: () => Promise<void>): Promise<void> => {
    const next = writing.then(job);
    writing = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const readRecord = async (name: string): Promise<GrantRecord | undefined> => {
    const secret = secretName(prefix, "grant", name);
    if (secret === null) return undefined;
    const raw = await client.get(secret);
    if (raw === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AwsCustodyError("malformed_response");
    }
    const record = parseGrantRecord(parsed);
    if (record === null) throw new AwsCustodyError("malformed_response");
    return record;
  };

  const store = async (name: string, record: GrantRecord): Promise<void> => {
    const secret = secretName(prefix, "grant", name);
    if (secret === null) throw new GrantEntryError("invalid_name");
    const body = JSON.stringify(record);
    // Create carries the first value, so a new grant is one call rather than
    // two — and `put` is only reached for a name that already existed, which is
    // where stripping `AWSPREVIOUS` has something to strip.
    if (!(await client.create(secret, body, tagsFor(prefix, "grant")))) {
      await client.put(secret, body);
    }
    grants.add(name);
  };

  const tokens: TokenStore = {
    async read(name: string, binding: GrantBinding): Promise<GrantRead> {
      return readGrant(await readRecord(name), binding);
    },

    rotate(name, binding, rotatedRefreshToken): Promise<void> {
      const rejection = credentialValueRejection(rotatedRefreshToken);
      if (rejection !== null) return Promise.reject(new GrantEntryError(rejection));
      return serialize(async () => {
        const record = await readRecord(name);
        if (record === undefined || !grantBindingHolds(record, binding)) {
          logger?.log("warn", { event: "token_rotation_superseded", credential: name });
          return;
        }
        await store(name, { ...record, refreshToken: rotatedRefreshToken, rotatedAt: now() });
      });
    },

    putGrant(name, record): Promise<void> {
      const rejection =
        credentialNameRejection(name) ?? credentialValueRejection(record.refreshToken);
      if (rejection !== null) return Promise.reject(new GrantEntryError(rejection));
      return serialize(() => store(name, record));
    },

    close(): void {
      client.close();
    },

    get size() {
      return grants.size;
    }
  };

  // One secret, `<prefix>/signing/dpop`, created on the first proof and never
  // written over (#504). `CreateSecret` carries the value and answers `false`
  // when the name was already taken, so create-if-absent is one call here and
  // the adoption is a `get` — this backend needs none of the GCP one's
  // re-access dance, because the create is the race's arbiter.
  const signingSecret = secretName(prefix, "signing", SIGNING_NAME);
  const signing = openSigningKeyStore(
    {
      read: async () => (signingSecret === null ? null : client.get(signingSecret)),

      async create(material: string): Promise<string> {
        if (signingSecret === null) throw new AwsCustodyError("malformed_response");
        if (await client.create(signingSecret, material, tagsFor(prefix, "signing"))) {
          return material;
        }
        const existing = await client.get(signingSecret);
        // A name that exists and holds no `AWSCURRENT` value is a store this
        // process cannot reason about. ./custody-gcp.ts's branch and its reason.
        if (existing === null) throw new AwsCustodyError("malformed_response");
        return existing;
      },

      malformed: () => new AwsCustodyError("malformed_response"),

      close: () => {}
    },
    logger !== undefined ? { logger } : {}
  );

  return {
    vault,
    tokens,
    signing,
    close: () => {
      signing.close();
      client.close();
    }
  };
}

/**
 * The operator's writer, on its own client.
 *
 * ./custody-gcp.ts's separation and its reason: in a real deployment these are
 * different processes under different principals, and this one holds the
 * `CreateSecret`, `PutSecretValue` and `DeleteSecret` permissions the serving
 * role does not.
 */
export async function openAwsVaultAdmin(options: AwsCustodyOptions): Promise<VaultAdmin> {
  assertUsablePrefix(options.prefix);
  const { prefix } = options;
  const client = createSecretsManagerClient(options);

  const secretFor = (name: string): string => {
    const secret = secretName(prefix, "vault", name);
    if (secret === null) throw new VaultEntryError("invalid_name");
    return secret;
  };

  return {
    async names(): Promise<readonly string[]> {
      const found: string[] = [];
      for (const secret of await client.list(leadFor(prefix, "vault"))) {
        const name = nameOf(prefix, "vault", secret.name);
        if (name !== null) found.push(name);
      }
      return found.sort();
    },

    async set(name: string, value: string): Promise<void> {
      const rejection = credentialNameRejection(name) ?? credentialValueRejection(value);
      if (rejection !== null) throw new VaultEntryError(rejection);
      const secret = secretFor(name);
      if (!(await client.create(secret, value, tagsFor(prefix, "vault")))) {
        await client.put(secret, value);
      }
    },

    async remove(name: string): Promise<boolean> {
      return client.remove(secretFor(name));
    },

    close(): void {
      client.close();
    }
  };
}
