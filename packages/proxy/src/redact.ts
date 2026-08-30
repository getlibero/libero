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
// **A tool result's binary payloads are searched twice, and the second search
// cannot repair what it finds** (#501). Every byte of a response passes the
// streaming scan below as wire text, base64 payloads included, so a credential
// spelled literally anywhere in the JSON is already replaced. What that cannot
// see is a credential inside the *decoded* bytes — a screenshot of a terminal
// with a token on it, say — because no spelling of the value appears in the
// base64 of those pixels. `findSecret` is the second search, run over the
// decoded payload in ./mcp-bounds.ts, and it answers rather than edits: a
// replacement inside a PNG is a corrupt image, so a match fails the whole result
// closed. It closes one more shape of the careless-upstream leak; the paragraph
// above is unchanged, and a *transformed* value is as invisible decoded as it is
// encoded.
//
// Pure string work, deliberately: no `Secret`, no vault, no I/O. Custody lives
// in ./outbound.ts, which is the only file that can produce a value to pass in
// here, and keeping the rules apart from the custody is what lets the rules be
// property-tested without standing anything up. That holds for the decoded scan
// too: what leaves ./outbound.ts is a `SecretScan`, so no second module ever
// holds the value.

/** What replaces a match. Names the credential; never any part of the value. */
export function redactionMarker(name: string): string {
  return `[redacted:${name}]`;
}

/**
 * Why a redaction could not be performed.
 *
 * A closed set for the same reason `VaultFailure` is one: this runs on the path
 * that holds a secret, so a caller reports something chosen from a list rather
 * than a string that came back from somewhere.
 *
 * `binary_payload` is the second member and it is a different kind of thing
 * from the first (#501). `empty_value` is a redaction that could not be
 * *attempted*. `binary_payload` is one that was attempted, found a credential,
 * and could not be *performed* — see `findSecret` for why a match inside a
 * decoded payload has no repair.
 */
export type RedactionFailure = "empty_value" | "binary_payload";

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
    // `{1,2}`, not `+`: base64 padding is at most two characters by
    // construction, and the bounded form is linear where `=+$` backtracks
    // quadratically on a run of `=` — input here is a vault credential, so
    // that was a CodeQL finding about robustness rather than an attack
    // surface, but the precise pattern costs nothing and documents itself.
    base64.replace(/={1,2}$/, ""),
    base64url,
    base64url.replace(/={1,2}$/, ""),
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
 *
 * **Both halves are named separately below, and this is their composition.**
 * #156 needed the needles built once and applied many times, so the rules split
 * into `redactionPasses` (which spellings, and the empty-value refusal) and
 * `applyPasses` (the two orderings above). Everything this comment describes is
 * still what happens; the streaming path shares it rather than restating it,
 * which is what keeps "what matches" a single answer.
 */
export function redactSecrets(text: string, secrets: readonly SecretValue[]): string {
  return applyPasses(text, redactionPasses(secrets));
}

/**
 * One secret's marker and every spelling of it worth searching for.
 *
 * Split out of `redactSecrets` for #156: a streamed body redacts many times
 * against the same secret, and `encodingsOf` is fifteen encodings and a sort per
 * call. Building the needles once and carrying them is the difference between
 * that cost being paid per response and per chunk.
 *
 * **The empty-value refusal moved here with them, and that is the point rather
 * than a side effect.** `StreamingRedactor` cannot fail closed halfway through a
 * body it has already emitted the front of, so the one failure this file has is
 * raised while building the passes — before a byte flows — and every caller gets
 * it at the same place `redactSecrets` always raised it.
 */
export interface RedactionPass {
  /** What replaces a match. Names the credential; never any part of the value. */
  readonly marker: string;
  /** Longest first, per `encodingsOf`. */
  readonly needles: readonly string[];
}

/**
 * The passes for a set of secrets, in the order the scan must apply them.
 *
 * Throws `RedactionError` on an empty value, per `redactSecrets`'s fail-closed
 * note — which is now the only place that check lives.
 */
export function redactionPasses(secrets: readonly SecretValue[]): RedactionPass[] {
  return secrets.map(secret => {
    if (secret.value.length === 0) throw new RedactionError("empty_value");
    return { marker: redactionMarker(secret.name), needles: encodingsOf(secret.value) };
  });
}

/**
 * The same needles, asked a different question: is one of them in here at all?
 *
 * **Why detection and not replacement (#501).** Everything else in this file
 * scrubs text on its way to the agent, and the reason that works is that a
 * scrubbed string is still a string — a debug field with `[redacted:github]`
 * where a token was is a perfectly good debug field. A tool result's binary
 * payload is not like that. Replacing bytes inside a PNG produces a corrupt
 * image rather than a scrubbed one, at a length the container's own headers no
 * longer describe, and the model is handed something that fails to decode with
 * no explanation. There is no edit to make, so the caller's only honest move is
 * to refuse the whole result — which is what `RedactionError("binary_payload")`
 * is for and why the failure vocabulary grew a member rather than reusing one.
 *
 * **What this catches, and what it cannot.** The wire scan already covers
 * everything spelled literally in the response body, payloads included: a
 * base64 blob is text on the wire and goes through `StreamingRedactor` like any
 * other. What it cannot see is the credential *inside* the payload — a tool
 * that screenshots its own terminal with a token on screen writes those pixels,
 * and no spelling of the value appears in the base64 of them. Decoding first is
 * what puts a payload's actual bytes in front of the same needles. It closes
 * one more shape of the careless-upstream leak and it is still a backstop, not
 * a boundary: this file's opening note is unchanged, and a *transformed* value
 * is as invisible decoded as it is encoded.
 *
 * Returns the marker of the first credential found — which names it and carries
 * no part of its value, so the answer is safe to log — or `null`.
 *
 * Needles are compared as latin1 text over the decoded bytes, so a byte
 * sequence matches when it spells the credential in any of `encodingsOf`'s
 * spellings that survive being bytes. A payload is not text and has no
 * encoding, so this is a byte search wearing a string's interface rather than a
 * claim about how the payload was encoded.
 */
export function findSecret(text: string, passes: readonly RedactionPass[]): string | null {
  for (const pass of passes) {
    for (const needle of pass.needles) {
      if (text.includes(needle)) return pass.marker;
    }
  }
  return null;
}

/**
 * A scan closed over the credentials it looks for, answering the marker of what
 * it found.
 *
 * **The passes travel as a function so the value does not travel at all.** A
 * needle is a spelling of a credential, so handing `RedactionPass[]` up to the
 * caller that decodes payloads would put the value in a second module — and the
 * single-reveal-site argument in ./outbound.ts is worth more than the
 * convenience. ./outbound.ts builds this where it already holds the secret;
 * ./mcp-bounds.ts holds nothing but the ability to ask.
 */
export type SecretScan = (text: string) => string | null;

/** Apply prebuilt passes to a whole string. Each pass is fully applied before the next begins. */
export function applyPasses(text: string, passes: readonly RedactionPass[]): string {
  let out = text;
  for (const pass of passes) {
    for (const needle of pass.needles) {
      out = out.replaceAll(needle, pass.marker);
    }
  }
  return out;
}


/**
 * The same scan, over a body that is still arriving.
 *
 * **What it is for.** Until #156 the proxy read every upstream response to
 * completion before anything parsed it, which made "every byte passes
 * `redactSecrets` before anything parses it" a single readable statement — and
 * cost the two things #128 accepted at the time: an SSE stream left open after
 * the result was delivered hit the timeout instead of returning, and progress
 * notifications were read only after the whole body landed. This is what lets
 * the bytes move without giving that statement up.
 *
 * **The guarantee, stated exactly.** For any way a text is chopped into chunks,
 * every needle occurrence in the concatenation is replaced in the concatenated
 * output. Not "every chunk is scanned" — a chunk boundary is chosen by an
 * upstream's TCP writes, so a scan that only ever saw one chunk at a time would
 * let a credential through by being split across two of them. That is the whole
 * difficulty here and it is the only one.
 *
 * **How.** Text is final once no later byte can change how it redacts. Two
 * things can, and each gets its own guard in `push`:
 *
 * - a match the arrived text could still *grow* into, which is any suffix that
 *   is a proper prefix of a needle. `#partialTail` measures it rather than
 *   assuming the worst case, for the reason argued there — assuming it is
 *   correct and makes streaming pointless.
 * - a match already whole that the cut happens to land inside. The tail above
 *   does not catch it, because what follows the cut is then the *middle* of a
 *   needle rather than a prefix of one. So the cut is walked backward past any
 *   such match, which puts the whole occurrence in the held-back region for the
 *   next round to replace.
 *
 * **What it is not.** It is not a second set of rules. Everything about *what*
 * matches is `redactionPasses`, shared with the buffered path, and the suite
 * pins the two against each other across every split of a body rather than
 * asserting them separately. The one divergence is the marker cascade
 * `redactSecrets` already documents — a credential whose value is a substring
 * of a marker written by an earlier secret — because a marker is text this scan
 * inserts rather than text the needles were built from. Absurd as a real
 * credential, and it over-redacts in both paths; it is named here only so the
 * equivalence test's exclusion is not a mystery.
 *
 * Not a `TransformStream`: the caller is a byte reader that already owns its
 * loop, and handing it a second stream to plumb would buy nothing.
 */
export class StreamingRedactor {
  readonly #passes: readonly RedactionPass[];
  #carry = "";

  constructor(passes: readonly RedactionPass[]) {
    this.#passes = passes;
  }

  /**
   * The length of the longest suffix of `pending` that is a proper prefix of
   * some needle — which is exactly how much of it a later chunk could still
   * turn into a match, and therefore exactly how much must be held.
   *
   * **Measured rather than assumed, and that is what makes streaming worth
   * doing.** Holding a fixed `longestNeedle - 1` is also correct and was the
   * first version of this; it is useless in practice, because the longest needle
   * is the fully-`\uXXXX`-escaped spelling at six characters per character of
   * the credential — 150 for a modest token. An SSE event is often shorter than
   * that, so every event would sit in the hold-back until the body ended, and a
   * stream left open after the result was delivered would hang exactly as the
   * buffered read did. The measured tail is nearly always zero, because ordinary
   * body text does not end mid-credential.
   *
   * Scanned from the earliest candidate forward, so the first hit is the longest
   * tail that needle can claim, and only over positions that would improve on
   * what another needle already claimed. The character-by-character compare
   * bails on the first mismatch, so the common case costs one comparison per
   * position rather than a slice.
   */
  #partialTail(pending: string): number {
    let hold = 0;
    for (const pass of this.#passes) {
      for (const needle of pass.needles) {
        const first = needle.charCodeAt(0);
        const from = Math.max(0, pending.length - (needle.length - 1));
        const limit = pending.length - hold;
        for (let at = from; at < limit; at += 1) {
          if (pending.charCodeAt(at) !== first) continue;
          let k = 1;
          while (at + k < pending.length && pending.charCodeAt(at + k) === needle.charCodeAt(k)) k += 1;
          if (at + k === pending.length) {
            hold = pending.length - at;
            break;
          }
        }
      }
    }
    return hold;
  }

  /** Redacted text that is final. May be `""` while a tail is held. */
  push(text: string): string {
    // No secrets, nothing to hold: the fast path is also the common one, since
    // an upstream with no credential in its sheet redacts against nothing.
    if (this.#passes.length === 0) return text;

    const pending = this.#carry + text;
    let cut = pending.length - this.#partialTail(pending);

    // The tail above covers a match this text could still *grow* into. This
    // covers a match already whole that the cut happens to land inside — which
    // the tail does not catch, because the part after the cut is the middle of a
    // needle rather than a prefix of one. `lastIndexOf` with a `fromIndex` finds
    // the latest occurrence starting at or before it, which is the only one that
    // can straddle. Moving the cut can expose another straddler behind it, so
    // this repeats; it always settles, because the cut only ever decreases.
    for (let moved = true; moved && cut > 0; ) {
      moved = false;
      for (const pass of this.#passes) {
        for (const needle of pass.needles) {
          const at = pending.lastIndexOf(needle, cut - 1);
          if (at >= 0 && at + needle.length > cut) {
            cut = at;
            moved = true;
          }
        }
      }
    }

    if (cut <= 0) {
      this.#carry = pending;
      return "";
    }

    this.#carry = pending.slice(cut);
    return applyPasses(pending.slice(0, cut), this.#passes);
  }

  /**
   * The held-back tail, redacted. Call once, when the body has ended.
   *
   * Nothing is held after this, so a caller that flushes early and keeps
   * pushing gets a correct scan of each part and no scan across the seam. The
   * one caller ends the body here.
   */
  flush(): string {
    if (this.#carry.length === 0) return "";
    const rest = applyPasses(this.#carry, this.#passes);
    this.#carry = "";
    return rest;
  }
}
