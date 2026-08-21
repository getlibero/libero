// The cache in front of `scripts/dev-certs.sh`, and the one way it could be
// dangerous.
//
// A cache that serves certificates is a cache that can make an identity case
// pass for the wrong reason, so what is asserted here is not that it is fast.
// It is that a reused entry is indistinguishable from a fresh mint, and that
// the two operations which exist to produce *new* material — `rotate` and
// `promote` — never touch it.
//
// The unit cases drive `mintCached` with a stub in place of openssl. That is
// deliberate: they are about when the miss path runs, and a real mint would add
// three seconds to say nothing extra. The integration case at the bottom uses
// the real script, because "a rotation does not leak into the cache" is a claim
// about the actual material.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanup, mintCerts } from "./harness/index.js";
import { mintCached } from "./harness/cert-cache.js";

/** A repository root and a stand-in for `dev-certs.sh`, both disposable. */
function scratch(): { repoRoot: string; script: string; dispose: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), "libero-cert-cache-"));
  mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
  const script = join(repoRoot, "dev-certs.sh");
  writeFileSync(script, "#!/usr/bin/env sh\n# v1\n");
  return { repoRoot, script, dispose: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

/** Stands in for a mint: records the call and writes something identifiable. */
function stubMint(dir: string, marker: string, calls: string[]): () => void {
  return () => {
    calls.push(marker);
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(join(dir, "agent", "client.pem"), marker);
  };
}

describe("the mint cache", () => {
  it("mints once for the same request and copies thereafter", () => {
    const { repoRoot, script, dispose } = scratch();
    try {
      const calls: string[] = [];
      const args = ["--channels", "C0AAA0001"];

      const first = mkdtempSync(join(tmpdir(), "libero-cc-a-"));
      mintCached(repoRoot, script, args, first, stubMint(first, "minted", calls));

      const second = mkdtempSync(join(tmpdir(), "libero-cc-b-"));
      mintCached(repoRoot, script, args, second, stubMint(second, "should-not-run", calls));

      expect(calls).toEqual(["minted"]);
      // The second caller still got the material, from the cache rather than
      // from openssl. A cache that skipped the mint and delivered nothing would
      // satisfy the line above and nothing else.
      expect(readFileSync(join(second, "agent", "client.pem"), "utf8")).toBe("minted");

      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    } finally {
      dispose();
    }
  });

  it("treats a different request as a different entry", () => {
    const { repoRoot, script, dispose } = scratch();
    try {
      const calls: string[] = [];

      const first = mkdtempSync(join(tmpdir(), "libero-cc-c-"));
      mintCached(repoRoot, script, ["--channels", "C0AAA0001"], first, stubMint(first, "one", calls));

      const second = mkdtempSync(join(tmpdir(), "libero-cc-d-"));
      mintCached(repoRoot, script, ["--channels", "C0BBB0002"], second, stubMint(second, "two", calls));

      // A raw CN is part of what was asked for, not a detail of how it was
      // delivered — the stolen-identity cases depend on getting the extra
      // certificate they named.
      const third = mkdtempSync(join(tmpdir(), "libero-cc-e-"));
      mintCached(
        repoRoot,
        script,
        ["--channels", "C0AAA0001", "--raw-cn", "impostor=libero-proxy"],
        third,
        stubMint(third, "three", calls)
      );

      expect(calls).toEqual(["one", "two", "three"]);

      for (const dir of [first, second, third]) rmSync(dir, { recursive: true, force: true });
    } finally {
      dispose();
    }
  });

  it("re-mints when the script itself changes", () => {
    const { repoRoot, script, dispose } = scratch();
    try {
      const calls: string[] = [];
      const args = ["--channels", "C0AAA0001"];

      const before = mkdtempSync(join(tmpdir(), "libero-cc-f-"));
      mintCached(repoRoot, script, args, before, stubMint(before, "v1", calls));

      // Editing how material is minted has to invalidate material that was
      // minted the old way. Without this the suite would go on exercising a
      // script that no longer exists in the tree, which is the whole reason
      // `certs.ts` runs the operator's command instead of holding fixtures.
      writeFileSync(script, "#!/usr/bin/env sh\n# v2\n");

      const after = mkdtempSync(join(tmpdir(), "libero-cc-g-"));
      mintCached(repoRoot, script, args, after, stubMint(after, "v2", calls));

      expect(calls).toEqual(["v1", "v2"]);
      expect(readFileSync(join(after, "agent", "client.pem"), "utf8")).toBe("v2");

      rmSync(before, { recursive: true, force: true });
      rmSync(after, { recursive: true, force: true });
    } finally {
      dispose();
    }
  });

  it("hands each caller its own directory, so one caller's writes are private", () => {
    const { repoRoot, script, dispose } = scratch();
    try {
      const calls: string[] = [];
      const args = ["--channels", "C0AAA0001"];

      const first = mkdtempSync(join(tmpdir(), "libero-cc-h-"));
      mintCached(repoRoot, script, args, first, stubMint(first, "minted", calls));

      // What `rotate` does to a rig's directory, in miniature.
      mkdirSync(join(first, "agent", "staged"), { recursive: true });
      writeFileSync(join(first, "agent", "staged", "client.pem"), "rotated");
      writeFileSync(join(first, "agent", "client.pem"), "replaced");

      const second = mkdtempSync(join(tmpdir(), "libero-cc-i-"));
      mintCached(repoRoot, script, args, second, stubMint(second, "should-not-run", calls));

      expect(calls).toEqual(["minted"]);
      expect(existsSync(join(second, "agent", "staged"))).toBe(false);
      expect(readFileSync(join(second, "agent", "client.pem"), "utf8")).toBe("minted");

      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    } finally {
      dispose();
    }
  });
});

describe("a real rotation against the real script", () => {
  // The claim the unit cases cannot make: `rotate` mints through
  // `dev-certs.sh` into the caller's copy, and a later request for the same
  // material gets what was minted originally rather than what the rotation
  // produced. If the cache ever served a mutated directory, this is the case
  // that would notice — a rig would come up already holding a staged
  // replacement it never asked for, and `certificate-pinning.test.ts` would be
  // asserting against a fixture instead of against a rotation.
  it("does not leak a rotation back into the cache", async () => {
    const cleanup = createCleanup();
    try {
      const channel = "C0CACHE001";

      const first = mintCerts(cleanup, { channels: [channel] });
      const original = first.fingerprint(channel);

      const replacement = first.rotate(channel);
      expect(replacement).not.toBe(original);
      expect(existsSync(join(first.dir, "agent", "staged"))).toBe(true);

      const second = mintCerts(cleanup, { channels: [channel] });
      expect(second.dir).not.toBe(first.dir);
      expect(second.fingerprint(channel)).toBe(original);
      expect(existsSync(join(second.dir, "agent", "staged"))).toBe(false);
    } finally {
      await cleanup.drain();
    }
  });
});
