// The operator's path through an OAuth grant, for a proxy with no browser.
//
// A fourth entrypoint of the proxy process, beside the vault's, the budget's
// and the audit log's, and here for the vault CLI's reason: the token store is
// in a container volume and the master key is in the container's environment,
// so the grant has to complete where the key already is.
//
//   docker compose run --rm proxy node dist/grant.js add notion_grant
//
// The flow prints an authorization URL for the operator to open in any
// browser, on any machine. The redirect URI is a loopback address nothing
// listens on — the browser fails to load it with the code still in the
// address bar, and the operator pastes that URL back here. PKCE and `state`
// are what make the paste safe, not the channel it travels; the paste is read
// interactively and never from argv, the vault CLI's stdin discipline.
//
// **Nothing here prints a token or a code, on any path.** The refresh token
// is written to the store inside `performAuthorizationGrant`, which never
// returns it; failures are closed words. The one free-ish string an error may
// carry is a filesystem path, as the vault CLI's may.
//
// **The issuer and scopes come from the team sheets**, not from flags: the
// store binds a grant to its issuer byte for byte with no normalization, so
// an issuer re-typed on a command line one byte off the sheet's would store a
// grant the engine can never read — discovered a channel's first call later,
// as `no_grant`. Scanning the sheets keeps the sheet the one place an
// upstream is described. Every sheet naming the credential must agree on the
// issuer; the grant covers the union of their scopes.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  GRANT_REDIRECT_URI,
  GrantEntryError,
  GrantFlowError,
  TokenExchangeError,
  TokenStoreError,
  openTokenStore,
  performAuthorizationGrant
} from "@getlibero/proxy";
import { parseTeamSheet } from "@getlibero/schema";
import { channelsRootFromEnv, vaultFileFromEnv, vaultKeyFromEnv } from "./env.js";
import type { Env } from "./env.js";

export interface GrantCliIo {
  argv: readonly string[];
  env: Env;
  /** One interactive line, prompt shown on stderr. `null` when input closes first. */
  readLine: (prompt: string) => Promise<string | null>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 0 ok, 1 an operator error, 2 a usage error. Nothing else — as the vault CLI. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/**
 * The published Client ID Metadata Document (site/public/client.json). An
 * authorization server fetches it to learn the client's name and redirect
 * URIs; `--client-id` points elsewhere for an operator hosting their own.
 * Product identity, so it lives in the app layer rather than the package.
 */
const DEFAULT_CLIENT_ID = "https://getlibero.com/client.json";

const USAGE = [
  "usage: grant <command>",
  "",
  "  add <name> [--client-id <url>]  complete an OAuth grant for the credential",
  "                                  a team sheet's [mcp_server.auth] block names",
  "",
  "The issuer and scopes come from the team sheets under PROXY_CHANNELS_ROOT:",
  "every sheet naming the credential must agree on the issuer, and the grant",
  "covers the union of their scopes.",
  "",
  "The flow prints an authorization URL to open in any browser. The redirect",
  "will fail to load; paste the full redirect URL back when asked. No token or",
  "code is ever printed, and the grant replaces any predecessor under the name.",
  "",
  "Reads PROXY_VAULT_FILE, PROXY_VAULT_KEY and PROXY_CHANNELS_ROOT."
].join("\n");

/** Carries the sentence to print; never escapes `runGrantCommand`. */
class UsageError extends Error {}

export async function runGrantCommand(io: GrantCliIo): Promise<number> {
  const [command, ...rest] = io.argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (command !== "add") {
    io.err(`grant: unknown command: ${command}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  let name: string;
  let clientId: string;
  try {
    ({ name, clientId } = parseAdd(rest));
  } catch (error) {
    io.err(error instanceof UsageError ? error.message : "grant: bad arguments");
    return EXIT_USAGE;
  }

  let channelsRoot: string;
  let vaultFile: string;
  let key: ReturnType<typeof vaultKeyFromEnv>;
  try {
    channelsRoot = channelsRootFromEnv(io.env);
    vaultFile = vaultFileFromEnv(io.env);
    key = vaultKeyFromEnv(io.env);
  } catch (error) {
    // These messages name the variable and the shape expected, and carry
    // nothing of what was set. See `vaultKeyFromEnv`.
    io.err(messageOf(error));
    return EXIT_ERROR;
  }

  const binding = scanSheets(io, channelsRoot, name);
  if (binding === null) return EXIT_ERROR;

  // Opened before any URL is shown, so a wrong key fails here — not after the
  // operator has signed in and approved. Closing zeroes the retained key.
  let store: ReturnType<typeof openTokenStore>;
  try {
    store = openTokenStore({ vaultFile, key });
  } catch (error) {
    io.err(error instanceof TokenStoreError ? `grant: ${error.reason}` : `grant: ${messageOf(error)}`);
    return EXIT_ERROR;
  }

  try {
    const { replaced } = await performAuthorizationGrant({
      credential: name,
      issuer: binding.issuer,
      scopes: binding.scopes,
      clientId,
      store,
      io: {
        showAuthorizationUrl: url => {
          io.out(
            [
              "Open this URL in a browser and authorize libero:",
              "",
              `  ${url}`,
              "",
              `The browser will then fail to load ${GRANT_REDIRECT_URI}. That is`,
              "expected — nothing listens there. Copy the full address of the failed",
              "page from the address bar."
            ].join("\n")
          );
        },
        promptCallbackUrl: () => io.readLine("Paste the redirect URL: ")
      }
    });
    io.out(`grant: ${replaced ? "replaced" : "stored"} ${name}`);
    return EXIT_OK;
  } catch (error) {
    printFailure(io, error);
    return EXIT_ERROR;
  } finally {
    store.close();
  }
}

function parseAdd(rest: readonly string[]): { name: string; clientId: string } {
  let values: { "client-id"?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: true,
      options: { "client-id": { type: "string" } }
    }));
  } catch (error) {
    // Node's message already names the offending flag; only the capital needs
    // changing to match house style.
    const text = error instanceof Error ? error.message : "bad arguments";
    throw new UsageError(`grant: ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
  }

  const name = positionals[0];
  if (name === undefined || positionals.length > 1) {
    throw new UsageError("grant: add takes one credential name");
  }

  const clientId = values["client-id"] ?? DEFAULT_CLIENT_ID;
  try {
    new URL(clientId);
  } catch {
    throw new UsageError("grant: --client-id must be a URL");
  }

  return { name, clientId };
}

/**
 * Every `[mcp_server.auth]` declaration of the credential across the sheets,
 * folded to one binding, or `null` with the reason already printed.
 *
 * One `readdir` and the schema's own parser — deliberately not a second sheet
 * loader, and deliberately not `TeamSheetStore`, whose no-iteration stance is
 * the serving process's and should stay that way. A sheet that does not parse
 * is warned about and skipped rather than refusing the run: this process
 * cannot know whether the serving proxy still holds a previous valid version
 * of it, and an unrelated channel's typo should not block this credential's
 * grant.
 */
function scanSheets(
  io: GrantCliIo,
  channelsRoot: string,
  credential: string
): { issuer: string; scopes: readonly string[] } | null {
  const declarations: { path: string; issuer: string; scopes: readonly string[] }[] = [];

  let entries: string[];
  try {
    entries = readdirSync(channelsRoot);
  } catch (error) {
    io.err(`grant: ${messageOf(error)}`);
    return null;
  }

  for (const entry of entries.sort()) {
    const sheetPath = join(channelsRoot, entry, "channel.toml");
    let text: string;
    try {
      text = readFileSync(sheetPath, "utf8");
    } catch {
      continue; // not a channel directory
    }
    const parsed = parseTeamSheet(text);
    if (!parsed.ok) {
      io.err(`grant: skipping ${sheetPath}: not a valid team sheet`);
      continue;
    }
    for (const server of parsed.sheet.mcp_server) {
      if (server.transport !== "http" || server.auth === undefined || server.credential !== credential) continue;
      declarations.push({ path: sheetPath, issuer: server.auth.issuer, scopes: server.auth.scopes });
    }
  }

  if (declarations.length === 0) {
    io.err(`grant: no team sheet under ${channelsRoot} declares an oauth credential named ${credential}`);
    return null;
  }

  const issuers = new Set(declarations.map(declaration => declaration.issuer));
  if (issuers.size > 1) {
    // Byte for byte, as the store will bind: a trailing slash is a conflict.
    io.err(`grant: the sheets disagree on the issuer for ${credential}:`);
    for (const declaration of declarations) {
      io.err(`  ${declaration.path}: ${declaration.issuer}`);
    }
    return null;
  }

  const scopes = [...new Set(declarations.flatMap(declaration => declaration.scopes))].sort();
  const first = declarations[0];
  if (first === undefined) return null; // unreachable; for the index signature
  return { issuer: first.issuer, scopes };
}

/**
 * A failure, as one closed word and — where the operator's next act is not
 * obvious from the word — one remedy sentence. Nothing here interpolates the
 * paste, a code, or any value.
 */
function printFailure(io: GrantCliIo, error: unknown): void {
  if (error instanceof GrantFlowError) {
    const suffix = error.failure === "authorization_denied" && error.deniedAs !== undefined ? ` (${error.deniedAs})` : "";
    io.err(`grant: ${error.failure}${suffix}`);
    switch (error.failure) {
      case "state_mismatch":
        io.err("grant: the pasted URL is not from this run — run the grant again and paste the fresh redirect");
        break;
      case "no_refresh_token":
        io.err(
          "grant: the server issued no refresh token, and a headless proxy cannot hold a grant without one — check the server supports the refresh_token grant (some require an offline scope)"
        );
        break;
      case "pkce_unsupported":
        io.err("grant: the server does not advertise S256 PKCE, which this flow requires");
        break;
      case "input_closed":
        io.err("grant: input ended before a redirect URL was pasted");
        break;
    }
    return;
  }
  if (error instanceof TokenExchangeError) {
    io.err(`grant: ${error.failure}`);
    return;
  }
  if (error instanceof TokenStoreError || error instanceof GrantEntryError) {
    io.err(`grant: ${error.reason}`);
    return;
  }
  io.err(`grant: ${messageOf(error)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}
