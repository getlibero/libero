// The embedding provider, faked — and the narrow shape of it is the whole point
// (#308).
//
// This suite fakes exactly the external services it has: the Slack socket, the
// model, and the MCP upstream. An embedding provider is the fourth, and this is
// it. Until #308 the rig wired none, on an argument that ran two things
// together and is worth separating rather than deleting.
//
// **"A second live provider the ESLint block exists to keep out"** — true, and a
// fake is the answer to that rather than an instance of it. Nothing here imports
// a provider SDK or `createEmbeddingClient`; the block bans both, and #308 added
// the second name to it so that reaching for the real factory is a lint error
// rather than a judgement call.
//
// **"A hand-built vector space between an attack and the thing it is
// attacking"** — true only of a fake that *ranks*. So this one does not. It
// answers **the same vector for every text**, which makes it useless for
// demonstrating that retrieval found the right skill and therefore impossible to
// mistake for a demonstration of that. It is an observation point, exactly as
// `FakeMcpServer` is for tool calls: what a case reads is `texts()`, not
// `vectors`.
//
// ## The rule that comes with it
//
// **No case may assert that retrieval reached a skill through the vector leg.**
// With one constant vector every skill is equidistant from every query, so
// `nearest` answers in an order nothing here chose. `e2e/README.md`'s standing
// instruction is unchanged and is now load-bearing rather than incidental: word
// the question to share vocabulary with the skill it should reach, and let the
// lexical leg answer.
//
// ## What it is for
//
// One claim, and it is a real egress claim rather than a plumbing one. The
// skill-embedding pass bounds itself to **the description and never the body**
// (`apps/server/src/session/skill-embed.ts`). A skill body can carry a
// credential — `skill-poisoning.test.ts` plants one there, as the redacted text
// of a failed call — so "a playbook's body never leaves this process by way of
// the embedding provider" is a claim about a real leak path, and it cannot be
// made against a provider that was never called. `texts()` is where it is made,
// with the description's arrival as the positive control that must come first.

import type { EmbeddingClient, EmbeddingRequest } from "@getlibero/agent";

/**
 * The width of the vector this answers with.
 *
 * Three, because the store bakes the width into its `vec0` table at the first
 * embedding and a smaller number is cheaper to read in a failure message than a
 * realistic one. Nothing in this suite has an opinion about the number itself.
 */
const DIMS = 3;

export interface ConstantEmbeddings {
  readonly client: EmbeddingClient;
  /**
   * Every text this provider was asked to embed, in order, across every call.
   *
   * The surface a case asserts on, and the reason this module exists. What
   * reaches an embedding provider leaves the process, so this is a leak surface
   * in the same class as `FakeMcpServer`'s recorded requests and the model's
   * `seen` — and unlike those two it is the only place a skill *body* could
   * appear if the pass ever stopped sending only descriptions.
   */
  texts(): string[];
  /** How many provider calls were made. One pass is one call, however many texts. */
  calls(): number;
}

/**
 * A provider that answers the same vector for every text.
 *
 * Deliberately not a vector space — see the header. `usage` is reported because
 * a real provider reports it and the pass meters what it is told; a rig whose
 * embedding turns silently cost nothing would make the meter assertion vacuous.
 */
export function constantEmbeddings(): ConstantEmbeddings {
  const seen: string[] = [];
  let calls = 0;

  return {
    texts: () => [...seen],
    calls: () => calls,
    client: {
      embed(request: EmbeddingRequest) {
        calls += 1;
        seen.push(...request.texts);
        return Promise.resolve({
          // One per text, in order, which is the response's own contract — the
          // caller matches them positionally.
          vectors: request.texts.map(() => Float32Array.from(new Array<number>(DIMS).fill(1))),
          model: request.model,
          // Non-zero, or `daily_tokens` never moves and the metering claim
          // proves nothing. `TURN_TOKENS`' reason, for the other kind of turn.
          usage: { inputTokens: 11 }
        });
      }
    }
  };
}

/** What one embedding call reports, so a case sizes its assertion off the name. */
export const EMBED_TOKENS = 11;
