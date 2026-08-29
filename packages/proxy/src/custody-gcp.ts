// The custody contract over Google Secret Manager (#483).
//
// ./custody.ts is what this implements and ./custody-conformance.ts is what
// checks it — this file adds no assertions of its own, which is the point of
// the seam #482 built. ./custody-gcp-client.ts is the wire; nothing here knows
// what an HTTP status is.
//
// **One secret per credential name.** `<prefix>-vault-<name>` and
// `<prefix>-grant-<name>`, labelled `libero-kind` and `libero-deployment`, so
// one project can hold several deployments and IAM can be written per
// credential — `secretAccessor` on the vault's secrets, `secretAccessor` plus
// `secretVersionAdder` on the grants', and the write roles the serving process
// lacks held by the operator's principal. That is what makes writer separation
// an IAM policy here rather than an import list, which is the stronger form of
// the same claim.
//
// **Two costs of that shape, stated rather than discovered.**
//
// *Names are metadata.* The file backend encrypts the whole entry set, so a
// list of credential names — an inventory of what the deployment reaches — is
// hidden from anyone who cannot decrypt. Secret Manager names are visible to
// anyone with `secretmanager.secrets.list`, which is a real regression against
// the vault's own argument. What buys it back is that the accessor role can be
// granted per secret, which the file backend cannot express at all.
//
// *A dot is not a secret id.* `CredentialName` allows `[A-Za-z0-9][A-Za-z0-9._-]*`
// and a Secret Manager id allows `[A-Za-z0-9_-]{1,255}`. The gap is one
// character. Encoding it would either collide (`a.b` and `a_b` mapping to one
// id) or make every id unreadable to the operator who has to `gcloud secrets
// create` it, and a collision between two credentials is the worse failure. So
// a dotted name is refused as `invalid_name` on the way in, loudly, at
// `vault set` and `grant add` — the one place it can be fixed — and a sheet
// naming one finds nothing, which fails closed. `deploy/README.md` says so.
//
// **What is not here.** No master key: Secret Manager holds the plaintext and
// encrypts at rest under Google-managed keys, so `vaultKeyFromEnv` is never
// reached on this branch — #261's "the files disappear entirely and the KMS
// question becomes moot for the entries the backend holds." CMEK is a project
// setting an operator applies to the secrets, not a thing this code passes.

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
import { GcpCustodyError, createSecretManagerClient } from "./custody-gcp-client.js";
import type { GcpClientOptions, SecretManagerClient } from "./custody-gcp-client.js";
import type { Logger } from "./log.js";

/**
 * How many secrets to access at once while opening the vault.
 *
 * Sequential would make startup linear in the credential count against a
 * network; unbounded would open a socket per secret at the moment the process
 * is least able to spare one. The proxy's own default upstream concurrency,
 * for the same reason it has one.
 */
const OPEN_CONCURRENCY = 8;

const KIND_LABEL = "libero-kind";
const DEPLOYMENT_LABEL = "libero-deployment";

/**
 * A deployment's own slice of a project.
 *
 * Constrained to what a Secret Manager *label value* accepts — lowercase,
 * digits, dash, underscore — rather than to what an id accepts, because it is
 * both half of every id and the label every list filters on. Checked at config
 * time so a bad one is a startup failure rather than a filter that quietly
 * matches nothing, which would look exactly like an empty vault.
 */
const PREFIX = /^[a-z][a-z0-9_-]{0,30}$/;

export interface GcpCustodyOptions extends GcpClientOptions {
  readonly prefix: string;
}

export interface GcpCustodyDeps {
  readonly logger?: Logger;
  readonly now?: () => number;
}

export function assertUsablePrefix(prefix: string): void {
  if (!PREFIX.test(prefix)) {
    throw new Error(
      "proxy: PROXY_GCP_SECRET_PREFIX must be lowercase letters, digits, dash or underscore, starting with a letter"
    );
  }
}

/** `null` when this name cannot be a secret id on this backend. See the header. */
function secretId(prefix: string, kind: "vault" | "grant", name: string): string | null {
  if (credentialNameRejection(name) !== null) return null;
  if (name.includes(".")) return null;
  return `${prefix}-${kind}-${name}`;
}

function nameOf(prefix: string, kind: "vault" | "grant", id: string): string | null {
  const lead = `${prefix}-${kind}-`;
  if (!id.startsWith(lead)) return null;
  const name = id.slice(lead.length);
  return credentialNameRejection(name) === null ? name : null;
}

const labelsFor = (prefix: string, kind: "vault" | "grant"): Record<string, string> => ({
  [KIND_LABEL]: kind,
  [DEPLOYMENT_LABEL]: prefix
});

/** Access many secrets without opening a socket per credential. */
async function accessAll(
  client: SecretManagerClient,
  ids: readonly string[]
): Promise<ReadonlyMap<string, string>> {
  const values = new Map<string, string>();
  for (let start = 0; start < ids.length; start += OPEN_CONCURRENCY) {
    const batch = ids.slice(start, start + OPEN_CONCURRENCY);
    const answers = await Promise.all(batch.map(async id => [id, await client.access(id)] as const));
    for (const [id, value] of answers) {
      // `null` is a secret whose every version has been destroyed — what
      // `remove` leaves behind if a delete half-completed. Not an entry.
      if (value !== null) values.set(id, value);
    }
  }
  return values;
}

/**
 * Open both stores against Secret Manager.
 *
 * The vault is read whole, here, once: `Vault.lookup` is synchronous because
 * the contract says the vault answers from state acquired at open with no I/O
 * on the serving path, and this is the shape that pays for it — a list plus one
 * access per credential at startup, and nothing per tool call. Secret Manager
 * charges per access, so that is also the cheap direction.
 *
 * The grant names are listed too, and only the names: `TokenStore.size` is a
 * count, and reading every grant at open would be paying for values the engine
 * re-reads at mint anyway. Nothing here reads a grant's value.
 */
export async function openGcpCustody(
  options: GcpCustodyOptions,
  deps: GcpCustodyDeps = {}
): Promise<Custody> {
  assertUsablePrefix(options.prefix);
  const { prefix } = options;
  const logger = deps.logger;
  const now = deps.now ?? Date.now;
  const client = createSecretManagerClient({
    ...options,
    ...(logger !== undefined ? { logger } : {})
  });

  const listed = await client.list(labelsFor(prefix, "vault"));
  const wanted: string[] = [];
  for (const secret of listed) {
    // A secret carrying our labels whose id is not a name we could have written
    // is somebody else's; skipped rather than guessed at.
    if (nameOf(prefix, "vault", secret.secretId) !== null) wanted.push(secret.secretId);
  }
  const values = await accessAll(client, wanted);

  const entries = new Map<string, string>();
  for (const [id, value] of values) {
    const name = nameOf(prefix, "vault", id);
    if (name !== null) entries.set(name, value);
  }
  logger?.log("info", { event: "vault_opened", count: entries.size });

  const grants = new Set<string>();
  for (const secret of await client.list(labelsFor(prefix, "grant"))) {
    const name = nameOf(prefix, "grant", secret.secretId);
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

  // Writes serialize behind this chain, ./token-store.ts's one mutex and for
  // its reason: a rotation and a grant must not interleave their read and their
  // write. What the file backend also needs it for — a read-merge-write over
  // one file — is gone, because one grant is one secret and `addVersion` is
  // atomic at the backend. The residual cross-process race is the file
  // backend's, priced the same: one lost refresh token, one loud re-grant.
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
    const id = secretId(prefix, "grant", name);
    if (id === null) return undefined;
    const raw = await client.access(id);
    if (raw === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new GcpCustodyError("malformed_response");
    }
    const record = parseGrantRecord(parsed);
    if (record === null) throw new GcpCustodyError("malformed_response");
    return record;
  };

  const store = async (name: string, record: GrantRecord): Promise<void> => {
    const id = secretId(prefix, "grant", name);
    if (id === null) throw new GrantEntryError("invalid_name");
    await client.create(id, labelsFor(prefix, "grant"));
    await client.addVersion(id, JSON.stringify(record));
    grants.add(name);
  };

  const tokens: TokenStore = {
    async read(name: string, binding: GrantBinding): Promise<GrantRead> {
      // Re-read per call, the contract's freshness rule for this store: a grant
      // completed while the proxy runs takes effect at the next mint.
      return readGrant(await readRecord(name), binding);
    },

    rotate(name, binding, rotatedRefreshToken): Promise<void> {
      const rejection = credentialValueRejection(rotatedRefreshToken);
      if (rejection !== null) return Promise.reject(new GrantEntryError(rejection));
      return serialize(async () => {
        // Fresh read inside the mutex, then the binding again: the `read` that
        // fed the exchange enforced it, and if it no longer holds the record
        // was replaced mid-flight and this successor belongs to a dead lineage.
        // Dropped, never merged over the newer grant.
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
      // Replace-not-stack is the backend's now: `addVersion` then destroy the
      // predecessor, so one name is one grant and the superseded refresh token
      // stops being retrievable rather than merely stopping being latest.
      return serialize(() => store(name, record));
    },

    close(): void {
      client.close();
    },

    get size() {
      return grants.size;
    }
  };

  return {
    vault,
    tokens,
    close: () => {
      client.close();
    }
  };
}

/**
 * The operator's writer, on its own client.
 *
 * Its own rather than the serving composition's, so closing one does not stop
 * the other — the same separation ./custody-file.test.ts's harness makes by
 * parsing the master key twice. In a real deployment they are different
 * processes under different principals, which is where the separation actually
 * lives: this one needs `secretmanager.secrets.create`, `addVersion` and
 * `delete`, which the serving service account does not have.
 */
export async function openGcpVaultAdmin(
  options: GcpCustodyOptions,
  deps: GcpCustodyDeps = {}
): Promise<VaultAdmin> {
  assertUsablePrefix(options.prefix);
  const { prefix } = options;
  const client = createSecretManagerClient({
    ...options,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {})
  });

  const idFor = (name: string): string => {
    const id = secretId(prefix, "vault", name);
    if (id === null) throw new VaultEntryError("invalid_name");
    return id;
  };

  return {
    async names(): Promise<readonly string[]> {
      const found: string[] = [];
      for (const secret of await client.list(labelsFor(prefix, "vault"))) {
        const name = nameOf(prefix, "vault", secret.secretId);
        if (name !== null) found.push(name);
      }
      return found.sort();
    },

    async set(name: string, value: string): Promise<void> {
      const rejection = credentialNameRejection(name) ?? credentialValueRejection(value);
      if (rejection !== null) throw new VaultEntryError(rejection);
      const id = idFor(name);
      await client.create(id, labelsFor(prefix, "vault"));
      await client.addVersion(id, value);
    },

    async remove(name: string): Promise<boolean> {
      // Deleting the secret rather than destroying its versions: `remove` means
      // the name is gone, and a secret with no live version would still be
      // listed, which is an inventory entry for a credential that no longer
      // exists.
      return client.deleteSecret(idFor(name));
    },

    close(): void {
      client.close();
    }
  };
}
