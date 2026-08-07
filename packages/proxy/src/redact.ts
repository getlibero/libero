// Scrubbing known secret values out of text on its way to the agent.
//
// This closes one leak class and only one: an upstream that **echoes** a
// credential it was given. A tool that reflects its own `Authorization` header
// in a debug field, or quotes the failing request in an error body, hands the
// agent the value the proxy exists to keep from it. That is a real and common
// shape, and it is the one this file catches.
//
// **What no scan can catch, stated plainly rather than implied away.** An
// upstream that *transforms* the value is invisible here: a hash of it, a
// substring, a re-chunked base64 of a blob that merely contains it, an
// encryption of it, or the same secret spelled with different capitalisation
// than it was stored in. A *partially* escaped mixture evades for the same
// reason — `encodingsOf` generates whole spellings, so a body escaping only the
// three characters an encoder felt strongly about is a spelling nothing in the
// list matches. Searching for a value only finds the value. Redaction
// is therefore a backstop for a careless upstream, not a boundary — the
// boundary is that the agent process never holds a credential in the first
// place, which is what `vault.ts` and the mTLS split are for. Anyone tempted to
// describe this as "the thing that stops secrets leaking" should read that
// sentence again.
//
// Pure string work, deliberately: no `Secret`, no vault, no I/O. Custody lives
// in ./outbound.ts, which is the only file that can produce a value to pass in
// here, and keeping the rules apart from the custody is what lets the rules be
// property-tested without standing anything up.

/** What replaces a match. Names the credential; never any part of the value. */
export function redactionMarker(name: string): string {
  return `[redacted:${name}]`;
}

/**
 * Why a redaction could not be performed.
 *
 * One member, and a closed set for the same reason `VaultFailure` is one: this
 * runs on the path that holds a secret, so a caller reports something chosen
 * from a list rather than a string that came back from somewhere.
 */
export type RedactionFailure = "empty_value";

/**
 * A redaction that could not be completed.
 *
 * Separate from `UpstreamError` on purpose. An upstream failure is a tool
 * failing, which the model should see and may recover from; a redaction failure
 * is the proxy being unable to guarantee its own boundary, and the two must not
 * be handled by the same `catch`. `http-dispatcher.ts` converts one and
 * rethrows the other.
 *
 * No `cause`, per `VaultError`: the values in scope here are the ones that must
 * not end up in a log line.
 */
export class RedactionError extends Error {
  readonly failure: RedactionFailure;

  constructor(failure: RedactionFailure) {
    super(`proxy redaction: ${failure}`);
    this.name = "RedactionError";
    this.failure = failure;
  }
}

/** A credential to scrub, by name and by value. */
export interface SecretValue {
  /** The team-sheet name. Goes into the marker, so it reaches the agent. */
  readonly name: string;
  readonly value: string;
}

/**
 * Uppercase the hex of every `\uXXXX` escape, leaving everything else alone.
 *
 * The `u` stays lowercase — `\U0041` is not an escape in JSON, so uppercasing
 * the whole sequence would produce a needle that matches nothing.
 */
function upperHexEscapes(text: string): string {
  return text.replace(/\\u[0-9a-f]{4}/g, match => `\\u${match.slice(2).toUpperCase()}`);
}

/**
 * Go's `encoding/json` in its default HTML-safe mode: `&`, `<`, `>`, U+2028,
 * and U+2029 become `\uXXXX` escapes on top of what every JSON encoder writes.
 *
 * Applied to the already-JSON-escaped spelling, not the raw value, because
 * that is where Go applies it too — a quote in the value is `\"` first, and
 * the HTML escapes land on the characters that remain literal.
 */
function htmlSafeEscapes(jsonEscaped: string): string {
  return jsonEscaped
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * Every spelling of a value worth searching for.
 *
 * The issue's "cheap encodings", enumerated rather than gestured at:
 *
 * - the value itself;
 * - base64, standard alphabet, padded and unpadded — an upstream that
 *   round-trips a header through a JSON transport often base64s it, and the
 *   padding depends on the length, so both are generated rather than guessed;
 * - base64url, padded and unpadded — the same, for anything that put the value
 *   in a URL or a JWT-shaped field;
 * - percent-encoding, in both hex cases, for a value reflected back inside a
 *   query string. `encodeURIComponent` emits uppercase hex; plenty of servers
 *   emit lowercase, and a case-insensitive scan over the whole body would be
 *   wrong for the raw form, so the two are listed as separate needles instead;
 * - JSON string escaping, in both hex cases — the minimal form an encoder
 *   produces (`\"`, `\\`, and `\uXXXX` for control characters), and the
 *   paranoid form where every character is spelled `\uXXXX`. Some encoders
 *   escape far more than they have to; both ends of that range are cheap to
 *   generate and neither is guessable from the other;
 * - the two defaults that sit between those ends, because they are defaults
 *   rather than options: Go's `encoding/json` HTML-safe mode, which also
 *   spells `&`, `<`, `>`, U+2028, and U+2029 as `\uXXXX` — GitHub's MCP
 *   server is Go, so this is the spelling the flagship upstream actually
 *   writes — and PHP's `json_encode`, which also spells `/` as `\/`, and `/`
 *   is a character real secrets contain.
 *
 * **Why the JSON forms are not optional.** A caller that hands the body
 * straight to the agent leaks an escaped value in escaped form, which is bad
 * but self-limiting. A caller that `JSON.parse`s the body and re-emits a field
 * from it — which is what the MCP client does — *un-escapes* it, so a needle
 * that missed the escaped spelling delivers the plain credential. The scan has
 * to cover the spelling on the wire, not the spelling after parsing, because
 * by then this function has already run.
 *
 * The fully-escaped form iterates UTF-16 code units rather than code points, so
 * an astral character yields the surrogate pair a JSON encoder would actually
 * write (`😀`) rather than the `ὠ0` that is not an escape.
 *
 * Duplicates are expected and harmless — a value with no percent-escapable
 * characters encodes to itself — and are removed so the replace pass does not
 * run twice for nothing.
 */
export function encodingsOf(value: string): string[] {
  const raw = Buffer.from(value, "utf8");
  const base64 = raw.toString("base64");
  const base64url = raw.toString("base64url");
  const percent = encodeURIComponent(value);
  // Slice off the quotes `JSON.stringify` wraps the string in: the needle is
  // the escaped body, which appears inside an upstream's own quoting.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  const htmlSafe = htmlSafeEscapes(jsonEscaped);
  const slashEscaped = jsonEscaped.replaceAll("/", "\\/");
  const fullyEscaped = Array.from(
    { length: value.length },
    (_, i) => `\\u${value.charCodeAt(i).toString(16).padStart(4, "0")}`
  ).join("");

  const candidates = [
    value,
    base64,
    base64.replace(/=+$/, ""),
    base64url,
    base64url.replace(/=+$/, ""),
    percent,
    // Lowercase only the escape sequences, not the whole string: the
    // surrounding characters are the value and must not be case-folded.
    percent.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()),
    jsonEscaped,
    upperHexEscapes(jsonEscaped),
    htmlSafe,
    upperHexEscapes(htmlSafe),
    slashEscaped,
    upperHexEscapes(slashEscaped),
    fullyEscaped,
    upperHexEscapes(fullyEscaped)
  ];

  // Longest first. A padded base64 string contains its unpadded form, so
  // replacing the short one first would leave a stray `=` behind where the long
  // one should have matched.
  return [...new Set(candidates)].sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of every secret, in every encoding, with its marker.
 *
 * `replaceAll` on a string needle, not a `RegExp`: a credential is arbitrary
 * bytes and may contain regex metacharacters, so building a pattern from one
 * would either need escaping that is easy to get subtly wrong or would match
 * the wrong thing. There is no pattern here to get wrong.
 *
 * Order matters twice. Longest-encoding-first within a secret, per
 * `encodingsOf`. And each secret is fully applied before the next begins.
 *
 * That second ordering has one pathological consequence worth naming rather
 * than discovering later: a marker already written into the text is ordinary
 * text to every subsequent secret, so a credential whose *value* happens to be
 * a substring of one — the literal string `redacted`, say — will match inside
 * it and be replaced again, yielding `[[redacted:second]:first]`. Absurd as a
 * real credential, and the outcome is more redaction rather than less, so it is
 * left alone: the failure direction is safe, and a two-phase substitution to
 * avoid it would add machinery whose own bugs would not be.
 *
 * **Fail-closed on an empty value.** `setEntry` rejects `empty_value`
 * (`vault-file.ts`), so this should be unreachable from a vault written by the
 * CLI — but `replaceAll("")` inserts the marker between every character of the
 * body, turning a leak into a garbage response that still looks like it
 * worked. A hand-edited or corrupt vault is exactly the case where quiet
 * nonsense is worse than a refusal to answer.
 *
 * A short-but-nonempty value is *not* guarded. A one-character credential makes
 * this over-redact the body, which is useless but safe, and the operator
 * problem it signals is not one this function should paper over by returning
 * text it knows may still carry the value.
 */
export function redactSecrets(text: string, secrets: readonly SecretValue[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.value.length === 0) throw new RedactionError("empty_value");
    const marker = redactionMarker(secret.name);
    for (const needle of encodingsOf(secret.value)) {
      out = out.replaceAll(needle, marker);
    }
  }
  return out;
}
