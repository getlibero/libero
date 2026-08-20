import { describe, expect, it } from "vitest";
import {
  RedactionError,
  StreamingRedactor,
  encodingsOf,
  redactSecrets,
  redactionMarker,
  redactionPasses
} from "./redact.js";

// The generated tests below are deterministic. A seeded LCG rather than
// Math.random, and rather than a property-testing dependency: the package whose
// one-runtime-dependency list is itself a stated security property should not
// grow a test dep to prove a string function. The tradeoff is no shrinking, so
// every failure reports its seed and the inputs, which is what makes a
// counterexample reproducible by hand.

/** Numerical Recipes' LCG constants. Any decent one would do. */
function lcg(seed: number): () => number {
  let state = (seed * 1_664_525 + 1_013_904_223) >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick(rng: () => number, alphabet: string): string {
  return alphabet[Math.floor(rng() * alphabet.length)] ?? alphabet[0] ?? "";
}

/**
 * Credential-shaped values, plus the shapes an operator actually pastes: base64
 * blobs with padding, PEM-ish text with newlines, and anything with regex
 * metacharacters in it, which is the input a pattern-based implementation would
 * break on.
 */
function randomSecret(rng: () => number): string {
  const alphabets = [
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "abcdefghijklmnopqrstuvwxyz0123456789-_",
    "ABCDEF0123456789",
    "+/=$^*()[]{}|\\.?",
    "abc XYZ\n\t\"'<>&%"
  ];
  const alphabet = alphabets[Math.floor(rng() * alphabets.length)] ?? alphabets[0] ?? "";
  const length = 8 + Math.floor(rng() * 40);
  let out = "";
  for (let i = 0; i < length; i += 1) out += pick(rng, alphabet);
  return out;
}

/** Body text that looks like something an upstream would actually return. */
function randomNoise(rng: () => number): string {
  const fragments = [
    '{"ok":true,"items":[]}',
    "Bearer ",
    "authorization: ",
    '{"error":"request failed with headers ',
    "\n\n",
    "%20",
    "==",
    "0123456789",
    "the quick brown fox"
  ];
  let out = "";
  const count = Math.floor(rng() * 6);
  for (let i = 0; i < count; i += 1) out += fragments[Math.floor(rng() * fragments.length)] ?? "";
  return out;
}

/** Every place an echoing upstream might put the value. */
function plant(secret: string, noise: string, position: number): string {
  switch (position % 5) {
    case 0:
      return secret + noise;
    case 1:
      return noise + secret;
    case 2:
      return `${noise}${secret}${noise}`;
    case 3:
      return `${noise}${secret}${noise}${secret}${noise}`;
    default:
      // Adjacent to itself: a naive single-pass replace can leave the second
      // copy behind, or resynchronise in the middle of it.
      return `${noise}${secret}${secret}${noise}`;
  }
}

describe("the property", () => {
  // The claim: whatever the value and whatever surrounds it, no spelling of the
  // value survives. Run over enough seeds to cover every alphabet and position
  // combination many times.
  it("leaves no encoding of the secret in the output, over 2000 generated cases", () => {
    for (let seed = 0; seed < 2000; seed += 1) {
      const rng = lcg(seed);
      const secret = randomSecret(rng);
      const noise = randomNoise(rng);
      const body = plant(secret, noise, Math.floor(rng() * 5));

      const out = redactSecrets(body, [{ name: "cred", value: secret }]);

      for (const encoding of encodingsOf(secret)) {
        if (out.includes(encoding)) {
          throw new Error(
            `seed ${seed}: encoding survived redaction\n` +
              `  secret:   ${JSON.stringify(secret)}\n` +
              `  encoding: ${JSON.stringify(encoding)}\n` +
              `  output:   ${JSON.stringify(out)}`
          );
        }
      }
    }
  });

  // The same body with the secret planted in each of its encodings, which is
  // the "in raw or encoded form" half of the acceptance criterion.
  it("catches the secret when the upstream re-encoded it before echoing", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const rng = lcg(seed);
      const secret = randomSecret(rng);
      const noise = randomNoise(rng);

      for (const encoding of encodingsOf(secret)) {
        const out = redactSecrets(`${noise}${encoding}${noise}`, [{ name: "cred", value: secret }]);
        if (out.includes(encoding)) {
          throw new Error(
            `seed ${seed}: re-encoded secret survived\n` +
              `  secret:   ${JSON.stringify(secret)}\n` +
              `  encoding: ${JSON.stringify(encoding)}`
          );
        }
      }
    }
  });

  it("never invents a marker in a body that never held the secret", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const rng = lcg(seed);
      const secret = randomSecret(rng);
      const noise = randomNoise(rng);
      // Noise generated independently of the secret; on the rare collision the
      // marker is correct, so only assert when the value is genuinely absent.
      if (encodingsOf(secret).some(e => noise.includes(e))) continue;
      expect(redactSecrets(noise, [{ name: "cred", value: secret }])).toBe(noise);
    }
  });
});

describe("the encodings", () => {
  const SECRET = "ghp_live_token_9c7e42f2";

  it.each([
    ["raw", (s: string) => s],
    ["base64", (s: string) => Buffer.from(s).toString("base64")],
    ["base64 unpadded", (s: string) => Buffer.from(s).toString("base64").replace(/=+$/, "")],
    ["base64url", (s: string) => Buffer.from(s).toString("base64url")],
    ["percent-encoded", (s: string) => encodeURIComponent(s)]
  ])("scrubs the %s form", (_label, encode) => {
    const body = `{"echo":"${encode(SECRET)}"}`;
    const out = redactSecrets(body, [{ name: "github_token", value: SECRET }]);
    expect(out).not.toContain(encode(SECRET));
    expect(out).toContain("[redacted:github_token]");
  });

  // encodeURIComponent emits uppercase hex; plenty of servers emit lowercase,
  // and the raw form must not be case-folded to catch it.
  it("scrubs percent-encoding in either hex case", () => {
    const value = "a b+c/d";
    for (const encoded of [encodeURIComponent(value), encodeURIComponent(value).toLowerCase()]) {
      const out = redactSecrets(`x${encoded}y`, [{ name: "c", value }]);
      expect(out).not.toContain(encoded);
    }
  });

  // A padded base64 string contains its unpadded form, so replacing the short
  // needle first would leave a stray `=` where the long one should have matched.
  it("leaves no padding behind when both base64 forms are present", () => {
    const value = "abcde";
    const padded = Buffer.from(value).toString("base64");
    expect(padded).toMatch(/=$/);
    const out = redactSecrets(`before ${padded} after`, [{ name: "c", value }]);
    expect(out).toBe("before [redacted:c] after");
  });

  it("orders needles longest first", () => {
    const encodings = encodingsOf("abcde");
    const lengths = encodings.map(e => e.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it("lists each spelling once", () => {
    const encodings = encodingsOf("plainvalue");
    expect(new Set(encodings).size).toBe(encodings.length);
  });
});

describe("JSON string escaping", () => {
  // The scan runs on the body as it arrives on the wire. A caller that parses
  // that body and re-emits a field from it un-escapes whatever survived, so an
  // escaped spelling this pass misses is delivered plain. These are the cases
  // that distinguish "the body no longer contains the secret" from "nothing
  // downstream of the body can reconstruct it".

  it("scrubs a value escaped by the upstream's own encoder", () => {
    // Quote and backslash are the characters every JSON encoder escapes, and
    // the ones that make the raw needle fail to match.
    const value = 'ghp_"live"\\token';
    const body = JSON.stringify({ echo: value });

    expect(body).toContain('\\"live\\"');
    const out = redactSecrets(body, [{ name: "github_token", value }]);

    expect(out).not.toContain('\\"live\\"');
    expect(out).toBe('{"echo":"[redacted:github_token]"}');
  });

  it("scrubs a value the upstream escaped character by character", () => {
    const value = "ghp_zebra";
    for (const hex of ["toLowerCase", "toUpperCase"] as const) {
      const escaped = Array.from({ length: value.length }, (_, i) => {
        const code = value.charCodeAt(i).toString(16).padStart(4, "0");
        return `\\u${hex === "toUpperCase" ? code.toUpperCase() : code}`;
      }).join("");

      const out = redactSecrets(`{"echo":"${escaped}"}`, [{ name: "c", value }]);
      expect(out).toBe('{"echo":"[redacted:c]"}');
    }
  });

  // Go's `encoding/json` escapes `&`, `<`, and `>` as `\u00xx` by default, on
  // top of the escapes every encoder writes — and GitHub's MCP server is Go,
  // so this is the spelling the flagship upstream actually produces.
  it("scrubs a value as Go's HTML-safe encoder spells it", () => {
    const value = 'key&<"live">';
    const goSpelling = 'key\\u0026\\u003c\\"live\\"\\u003e';

    const out = redactSecrets(`{"echo":"${goSpelling}"}`, [{ name: "c", value }]);

    expect(out).toBe('{"echo":"[redacted:c]"}');
    expect((JSON.parse(out) as { echo: string }).echo).not.toContain("live");
  });

  // PHP's `json_encode` escapes `/` as `\/` by default, and `/` is a character
  // real secrets contain — anything base64-flavoured, for a start.
  it("scrubs a value as PHP's encoder spells it, slashes escaped", () => {
    const value = "gh/section/token";

    const out = redactSecrets('{"echo":"gh\\/section\\/token"}', [{ name: "c", value }]);

    expect(out).toBe('{"echo":"[redacted:c]"}');
  });

  // The regression that motivates all of the above: reproduce what the MCP
  // client does to a response body, and check the value is not reconstructed.
  it("leaves nothing a JSON parse can turn back into the value", () => {
    const value = 'ghp_"live"\\token';
    const body = JSON.stringify({ content: [{ type: "text", text: `auth was ${value}` }] });

    const redacted = redactSecrets(body, [{ name: "c", value }]);
    const parsed = JSON.parse(redacted) as { content: { text: string }[] };

    expect(parsed.content[0]?.text).toBe("auth was [redacted:c]");
    expect(parsed.content[0]?.text).not.toContain("live");
  });

  it("spells an astral character as the surrogate pair an encoder writes", () => {
    const value = "key-😀";
    const escaped = encodingsOf(value).find(e => e.startsWith("\\u"));

    // Not `ὠ0`, which is not an escape sequence and would match nothing.
    expect(escaped).toContain("\\ud83d\\ude00");
    const out = redactSecrets(`{"echo":"${escaped ?? ""}"}`, [{ name: "c", value }]);
    expect(out).toBe('{"echo":"[redacted:c]"}');
  });

  it("keeps `\\u` lowercase, since `\\U` is not an escape", () => {
    for (const encoding of encodingsOf("secret--value")) {
      expect(encoding).not.toContain("\\U");
    }
  });
});

describe("the marker", () => {
  it("names the credential and carries none of the value", () => {
    const out = redactSecrets("token=s3cr3t_value", [{ name: "github_token", value: "s3cr3t_value" }]);
    expect(out).toBe("token=[redacted:github_token]");
    expect(redactionMarker("github_token")).toBe("[redacted:github_token]");
  });

  it("attributes each secret to the credential it came from", () => {
    const out = redactSecrets("a=AAAA b=BBBB", [
      { name: "first", value: "AAAA" },
      { name: "second", value: "BBBB" }
    ]);
    expect(out).toBe("a=[redacted:first] b=[redacted:second]");
  });

  // A marker is ordinary text to every later secret, so a credential whose
  // value is a substring of one gets replaced inside it. Absurd as a real
  // credential, and the direction is more redaction rather than less — pinned
  // here so the behaviour is a decision rather than a surprise.
  it("over-redacts rather than under-redacts when a value collides with a marker", () => {
    const out = redactSecrets("value-one", [
      { name: "first", value: "value-one" },
      { name: "second", value: "redacted" }
    ]);
    expect(out).toBe("[[redacted:second]:first]");
    expect(out).not.toContain("value-one");
  });

  it("replaces every occurrence, not just the first", () => {
    const out = redactSecrets("t t t", [{ name: "c", value: "t" }]);
    expect(out).toBe("[redacted:c] [redacted:c] [redacted:c]");
  });
});

describe("values that are not ordinary tokens", () => {
  // The input a pattern-based implementation breaks on. There is no RegExp
  // here, so metacharacters are just bytes.
  it.each([
    ["regex metacharacters", ".*+?^${}()|[]\\"],
    ["a newline", "line-one\nline-two"],
    ["a quote and a backslash", 'say "hi"\\'],
    ["unicode", "ключ-🔑-key"]
  ])("treats %s as literal text", (_label, value) => {
    const out = redactSecrets(`before ${value} after`, [{ name: "c", value }]);
    expect(out).toBe("before [redacted:c] after");
  });

  // Useless but safe, and deliberately not guarded: the alternative is
  // returning text known to still carry the value.
  it("over-redacts a one-character value rather than letting it through", () => {
    const out = redactSecrets("abcabc", [{ name: "c", value: "a" }]);
    expect(out).toBe("[redacted:c]bc[redacted:c]bc");
  });
});

describe("fail-closed", () => {
  // replaceAll("") would insert the marker between every character, turning a
  // leak into a garbage response that still looks like it worked.
  it("throws on an empty value rather than shredding the body", () => {
    expect(() => redactSecrets("anything", [{ name: "c", value: "" }])).toThrow(RedactionError);
    expect(() => redactSecrets("anything", [{ name: "c", value: "" }])).toThrow(/empty_value/);
  });

  it("throws even when an earlier secret redacted cleanly", () => {
    expect(() =>
      redactSecrets("has AAAA in it", [
        { name: "ok", value: "AAAA" },
        { name: "broken", value: "" }
      ])
    ).toThrow(RedactionError);
  });

  it("carries no cause, so inspecting it discloses nothing", () => {
    const thrown = (() => {
      try {
        redactSecrets("x", [{ name: "c", value: "" }]);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(RedactionError);
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("nothing to do", () => {
  it("returns the body unchanged when no secrets are given", () => {
    expect(redactSecrets("untouched", [])).toBe("untouched");
  });

  it("returns the body unchanged when the secret is absent", () => {
    expect(redactSecrets("untouched", [{ name: "c", value: "absent" }])).toBe("untouched");
  });

  it("handles an empty body", () => {
    expect(redactSecrets("", [{ name: "c", value: "abc" }])).toBe("");
  });
});

// #156's claim, and the only reason a streamed body is allowed to exist: the
// incremental scan sees a chunk boundary the upstream chose, and must not care
// where it fell.
describe("StreamingRedactor", () => {
  /** Feed a text through in the given pieces and join everything that comes out. */
  function stream(text: string, pieces: readonly string[], secrets: readonly { name: string; value: string }[]) {
    const redactor = new StreamingRedactor(redactionPasses(secrets));
    let out = "";
    for (const piece of pieces) out += redactor.push(piece);
    return out + redactor.flush();
  }

  /** Every way of cutting a string into `parts` pieces, empty pieces included. */
  function splits(text: string, parts: number): string[][] {
    if (parts === 1) return [[text]];
    const out: string[][] = [];
    for (let i = 0; i <= text.length; i += 1) {
      for (const rest of splits(text.slice(i), parts - 1)) out.push([text.slice(0, i), ...rest]);
    }
    return out;
  }

  it("matches the buffered scan across every split into two, three and four", () => {
    const secrets = [{ name: "gh", value: "s3cr3t" }];
    // Short enough to enumerate exhaustively, and every fragment of the secret
    // appears in it so a naive per-chunk scan has many chances to be wrong.
    const body = 'a s3cr3t {"k":"s3cr3t"} s3c s3cr3t';
    const whole = redactSecrets(body, secrets);

    for (const parts of [2, 3, 4]) {
      for (const pieces of splits(body, parts)) {
        expect(stream(body, pieces, secrets), `split ${JSON.stringify(pieces)}`).toBe(whole);
      }
    }
  });

  it("matches the buffered scan on generated bodies, one character at a time", () => {
    const rng = lcg(156);
    for (let i = 0; i < 200; i += 1) {
      const secret = randomSecret(rng);
      const secrets = [{ name: "cred", value: secret }];
      // Planted in every encoding the buffered scan knows, so the split walks
      // through the middle of base64, percent and `\uXXXX` spellings too.
      const body = encodingsOf(secret)
        .map((encoding, position) => plant(encoding, randomNoise(rng), position))
        .join("|");
      const pieces = [...body];
      expect(stream(body, pieces, secrets), `seed 156 case ${i} secret ${JSON.stringify(secret)}`).toBe(
        redactSecrets(body, secrets)
      );
    }
  });

  it("matches the buffered scan with two secrets and ragged chunks", () => {
    const rng = lcg(157);
    for (let i = 0; i < 200; i += 1) {
      const secrets = [
        { name: "one", value: randomSecret(rng) },
        { name: "two", value: randomSecret(rng) }
      ];
      const body =
        plant(secrets[0]?.value ?? "", randomNoise(rng), i) + randomNoise(rng) + plant(secrets[1]?.value ?? "", randomNoise(rng), i + 1);
      const pieces: string[] = [];
      for (let at = 0; at < body.length; ) {
        const size = 1 + Math.floor(rng() * 9);
        pieces.push(body.slice(at, at + size));
        at += size;
      }
      expect(stream(body, pieces, secrets), `seed 157 case ${i}`).toBe(redactSecrets(body, secrets));
    }
  });

  it("holds a secret split across chunks rather than emitting its front half", () => {
    const secrets = [{ name: "gh", value: "abcdefgh" }];
    const redactor = new StreamingRedactor(redactionPasses(secrets));
    // "abcd" is a prefix of the value, so it is held: emitting it here would be
    // the leak. The second chunk completes the match at the buffer's end, which
    // makes it final — so the marker comes out of `push` rather than waiting for
    // `flush`, and `flush` has nothing left.
    expect(redactor.push("abcd")).toBe("");
    expect(redactor.push("efgh")).toBe(redactionMarker("gh"));
    expect(redactor.flush()).toBe("");
  });

  // The reason `#partialTail` measures instead of assuming: an event shorter
  // than the longest needle must still get out, or a server that holds its
  // stream open after delivering the result hangs exactly as the buffered read
  // did — which is the failure #156 exists to remove.
  it("emits an event shorter than the longest needle without waiting for the body to end", () => {
    const secrets = [{ name: "gh", value: "ghp_live_token_do_not_log" }];
    const redactor = new StreamingRedactor(redactionPasses(secrets));
    const event = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1}\n\n";

    // Nothing held: no suffix of this is the start of any spelling of the value.
    expect(redactor.push(event)).toBe(event);
    expect(redactor.flush()).toBe("");
  });

  it("emits nothing that still contains the value, whatever the split", () => {
    const rng = lcg(158);
    for (let i = 0; i < 300; i += 1) {
      const secret = randomSecret(rng);
      const body = plant(secret, randomNoise(rng), i) + secret + randomNoise(rng) + secret;
      const pieces = [...body];
      const out = stream(body, pieces, [{ name: "cred", value: secret }]);
      expect(out.includes(secret), `seed 158 case ${i} secret ${JSON.stringify(secret)}`).toBe(false);
    }
  });

  it("passes text through untouched when there are no secrets", () => {
    const redactor = new StreamingRedactor(redactionPasses([]));
    expect(redactor.push("nothing ")).toBe("nothing ");
    expect(redactor.push("held back")).toBe("held back");
    expect(redactor.flush()).toBe("");
  });

  it("refuses an empty value while building the passes, before a byte flows", () => {
    expect(() => redactionPasses([{ name: "c", value: "" }])).toThrow(RedactionError);
  });
});
